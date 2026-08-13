/* The Postgres connection, and the schema it expects.
 *
 * Why this exists at all: `var/` is the database. Eleven modules keep state in
 * files under it — the raw store, the run log, the audit log, the fire log,
 * connections, webhooks, attribution, definitions, evaluations and dispatches.
 * A serverless function has no persistent disk and no instance affinity, so all
 * eleven have to move or the app silently forgets everything between requests.
 *
 * **The fs implementations are not replaced.** Each store keeps its file-backed
 * class exactly as it was — that is what every existing test exercises, and what
 * a local run still uses — and gains a Postgres sibling implementing the same
 * interface. `lib/store/index.js` picks. The only change asked of callers is an
 * `await`, which is a no-op against the synchronous fs returns.
 *
 * The driver is `@neondatabase/serverless` over HTTP rather than `pg`: a
 * connection pool in a function that may be frozen mid-request is how you
 * exhaust a database's connection limit, and the HTTP driver has no pool to
 * exhaust. It needs Node 19+; the engines field asks for 20.
 */

const { neon } = require('@neondatabase/serverless');

/* Lazily constructed. `neon()` throws when DATABASE_URL is unset, and this
   module is required by the factory on every boot — including local runs and
   the test suite, which have no database and must not be broken by its
   absence. */
let _sql = null;

function sql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — the Postgres store cannot be used');
    _sql = neon(url);
  }
  return _sql;
}

function configured() {
  return Boolean(process.env.DATABASE_URL);
}

/* ── schema ─────────────────────────────────────────────────────────────────
 *
 * Three tables, because the stores are three shapes and not one.
 *
 * `envelopes` is the raw store and is deliberately NOT a generic line log. Its
 * read path (`replay`) wants the latest version of each external id, and on the
 * volume this is replacing that was 3,000 or so current rows buried in 0.6 GB
 * of superseded churn — Meta re-reports the same ad-day every fifteen minutes
 * with a new spend figure, so each row is re-appended ~96 times a day. Reading
 * all of it to return a thousandth of it is what made pages take a minute.
 *
 * So supersession is recorded rather than inferred: a partial unique index
 * keeps exactly one *current* row per (workspace, source, kind, external_id),
 * and `replay` reads only those. The superseded rows stay in the same table —
 * the store still never forgets, and a restatement can still be traced to the
 * delivery that caused it — they are simply never on the read path. Compaction
 * later is a DELETE with a horizon, which the file store could not offer at
 * all.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS envelopes (
     seq         BIGSERIAL PRIMARY KEY,
     workspace   TEXT NOT NULL,
     source      TEXT NOT NULL,
     kind        TEXT NOT NULL,
     external_id TEXT NOT NULL,
     checksum    TEXT NOT NULL,
     fetched_at  TIMESTAMPTZ NOT NULL,
     -- Not "window": that is a reserved word in Postgres (window functions),
     -- and quoting it at every call site is a worse tax than a clearer name.
     pull_window TEXT,
     transport   TEXT,
     -- TEXT, not JSONB, and this is not an oversight. Stage 1 requires raw
     -- payloads stored verbatim for replay, and jsonb does not round-trip a
     -- document: it sorts object keys (by length, then bytewise), so
     -- {campaign_id, spend, name} reads back as {name, spend, campaign_id}.
     -- Nothing queries inside a body -- every reader goes through
     -- canonical.build in JS -- so the only thing jsonb would buy here is an
     -- infidelity in the one store whose contract is fidelity.
     body        TEXT NOT NULL,
     superseded  BOOLEAN NOT NULL DEFAULT FALSE
   )`,

  /* The heart of it: one current row per external id. Also what makes the
     append idempotent — a re-pull of an unchanged payload conflicts and does
     nothing, which is the property the checksum gave the file store. */
  `CREATE UNIQUE INDEX IF NOT EXISTS envelopes_current
     ON envelopes (workspace, source, kind, external_id) WHERE NOT superseded`,

  `CREATE INDEX IF NOT EXISTS envelopes_read
     ON envelopes (workspace) WHERE NOT superseded`,

  /* History lookups (`envelopes()`) are rare and always scoped to one kind. */
  `CREATE INDEX IF NOT EXISTS envelopes_history
     ON envelopes (workspace, source, kind)`,

  /* Append-only line logs: runs, audit, fires. Kept as text rather than jsonb
     because every reader parses the line itself and round-tripping through
     jsonb would reorder keys — harmless for these three, but the raw store
     learned that lesson the expensive way and there is no reason to relearn
     it. */
  `CREATE TABLE IF NOT EXISTS lines (
     seq  BIGSERIAL PRIMARY KEY,
     key  TEXT NOT NULL,
     -- What the log's derived reads group by: the source for a run, the
     -- workspace for an audit entry, the rule for a fire. Denormalised out of
     -- the payload so those reads are an index lookup rather than a parse of
     -- every line.
     tag  TEXT,
     -- Only the run log uses this, and only so "the last SUCCESSFUL run" can be
     -- answered by the index. A source down for six hours has its last success
     -- far outside any recent window, and hydrating without it would report a
     -- long-broken source as never-synced.
     ok   BOOLEAN,
     line TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS lines_key ON lines (key, seq)`,
  `CREATE INDEX IF NOT EXISTS lines_tag ON lines (key, tag, seq)`,

  /* Whole-document stores: connections, webhooks, attribution, definitions —
     and the two directory-shaped ones, evaluations and dispatches, where the
     key carries what was the filename. One table, because they differ only in
     their key prefix. */
  `CREATE TABLE IF NOT EXISTS docs (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS docs_prefix ON docs (key text_pattern_ops)`,

  /* Sessions and rate-limit counters. In-process Maps are correct on one
     always-on node and wrong the moment there are two: a session minted on one
     instance is unknown to the next, which reads to a user as being logged out
     at random. */
  `CREATE TABLE IF NOT EXISTS sessions (
     token      TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS rate_hits (
     bucket   TEXT NOT NULL,
     hit_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS rate_hits_bucket ON rate_hits (bucket, hit_at)`,
];

/* Run once per process, not once per request. Every statement is
   IF NOT EXISTS, so a cold start that races another one is harmless; the
   promise is cached so the second caller waits on the first rather than
   issuing the batch again. */
let _ready = null;

function ensureSchema() {
  if (!_ready) {
    const q = sql();
    /* `.query()` rather than calling `q` directly: the driver accepts a bare
       call only as a tagged template, and these are literal DDL strings with no
       interpolation. */
    _ready = (async () => {
      for (const statement of SCHEMA) await q.query(statement);
    })().catch((err) => {
      /* A failed migration must not be cached as done — the next request
         should try again rather than run against a half-built schema. */
      _ready = null;
      throw err;
    });
  }
  return _ready;
}

/* Test seam: drops the cached connection and schema promise so a test can
   point at a different database. */
function reset() {
  _sql = null;
  _ready = null;
}

module.exports = { sql, ensureSchema, configured, reset, SCHEMA };
