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
 * **Two drivers, chosen from the URL.**
 *
 * Neon gets `@neondatabase/serverless` over HTTP: a connection pool in a
 * function that may be frozen mid-request is how you exhaust a database's
 * connection limit, and the HTTP driver has no pool to exhaust.
 *
 * Anything else — Supabase, or a plain Postgres — gets `pg`, because that HTTP
 * driver is Neon's own endpoint and speaks to nothing else. The pool is capped
 * at a single connection for the same reason the HTTP driver was preferred: a
 * frozen invocation holding four connections is four a serverless fleet cannot
 * reclaim. **Against Supabase this must be the transaction pooler** (Supavisor,
 * port 6543), not the direct 5432 connection — direct connections are few and
 * long-lived, which is the opposite of what a function fleet does.
 *
 * Both are reduced to one shape: `sql().query(text, params) -> rows`. All 27
 * call sites use only that, which is what made a second driver a small change
 * rather than a rewrite.
 */

const { neon } = require('@neondatabase/serverless');

/* Neon's HTTP endpoint serves Neon. A Supabase or self-hosted URL handed to it
   fails at connect time with something that reads like a credential problem. */
const isNeon = (url) => /\.neon\.tech(\/|:|$)/i.test(String(url)) || /neon\.tech/i.test(String(url));

/* `pg` wrapped to the same `query -> rows` contract the Neon driver has.
 *
 * Required lazily so a deployment on Neon never loads it, and — more to the
 * point — so the test suite and every local run, which have no database at all,
 * do not pay for a driver they will not use. */
function poolFor(url) {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    max: 1,
    /* A managed Postgres presents a certificate chain the function's trust
       store often does not carry. The connection is still TLS; what is skipped
       is the chain check, which is the same posture every hosted driver takes
       by default and the reason `sslmode=require` in these URLs works at all. */
    ssl: { rejectUnauthorized: false },
    /* Do not hold an idle connection across freezes — a serverless instance can
       be paused indefinitely and the far end will have dropped it long before
       it wakes. */
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  return { async query(text, params) { return (await pool.query(text, params)).rows; } };
}

/* Lazily constructed. `neon()` throws when DATABASE_URL is unset, and this
   module is required by the factory on every boot — including local runs and
   the test suite, which have no database and must not be broken by its
   absence. */
let _sql = null;

function sql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — the Postgres store cannot be used');
    _sql = isNeon(url) ? neon(url) : poolFor(url);
  }
  return _sql;
}

/* Tests swap the URL between drivers; without this the first one is cached for
   the life of the process. */
function resetDriver() {
  _sql = null;
}

function configured() {
  return Boolean(process.env.DATABASE_URL);
}

/* Several statements in ONE round trip.
 *
 * The request edge fills eight stores before it serves anything, and it fires
 * them together with `Promise.all` — but Server-Timing on production showed
 * them completing exactly 200ms apart in a staircase, never overlapping. The
 * queries themselves are trivial against tables of a few hundred rows; 200ms
 * is the cost of asking, not of answering. Eight asks, 1.6 seconds, on a page
 * that had not begun rendering.
 *
 * Neon's HTTP driver can carry an array of queries in a single request, which
 * turns those eight asks into one. `sql.query(text, params)` builds a query
 * without sending it; `transaction()` sends them together and returns the
 * results in order.
 *
 * The `pg` pool has no such thing and does not need one — it holds a socket
 * open — so it falls through to sequential. So does any driver that refuses
 * the batch: the fallback IS the behaviour that was there before, which makes
 * this a speed change and never a correctness one. */
/* The same round trip for a driver that has no `transaction()`.
 *
 * This is not hypothetical any more: the deployment moved off Neon's HTTP
 * driver, `poolFor` has only `query`, and every batched read has been quietly
 * falling through to the sequential loop below ever since. Server-Timing said
 * so plainly once it was read — `prefetch;dur=932` on every signed-in route,
 * whatever the route, which is four asks at the ~230ms this deployment pays
 * for one. A route returning four hundred bytes of session JSON paid it too.
 *
 * So the queries are folded into one statement instead: each becomes a
 * `json_agg` over its own subquery, unioned, one row per query in order. The
 * driver returns them together and `batch` unpacks them into the same array of
 * row-arrays the transaction path returns, so nothing upstream can tell which
 * path it took.
 *
 * Ordering is the one thing a fold like this can lose — `json_agg` makes no
 * promise about the order it consumes its input in — so a query whose caller
 * depends on order declares the column (`order`) and it is aggregated by it.
 * A query that declares none is one whose rows are keyed by the caller. */
function combine(queries) {
  const params = [];
  const parts = queries.map(({ text, params: own = [], order = null }, i) => {
    /* Placeholders are renumbered rather than the parameters reordered: each
       query was written against its own `$1`, and they now share one list. */
    const base = params.length;
    const renumbered = String(text).replace(/\$(\d+)/g, (_, d) => `$${base + Number(d)}`);
    params.push(...own);
    return `SELECT ${i} AS i, COALESCE(json_agg(t${order ? ` ORDER BY t.${order}` : ''}), '[]'::json) AS rows FROM (${renumbered}) t`;
  });
  return { text: `${parts.join(' UNION ALL ')} ORDER BY i`, params };
}

async function batch(queries) {
  if (!queries.length) return [];
  const q = sql();

  if (typeof q.transaction === 'function' && typeof q.query === 'function') {
    try {
      return await q.transaction(queries.map(({ text, params }) => q.query(text, params)));
    } catch (err) {
      /* Loud, because silently paying eight round trips per request is exactly
         the condition this exists to end, and it would otherwise resurface as
         "the app is slow again" with nothing to point at. */
      console.warn('store: batched read failed, falling back to one at a time —', err.message);
    }
  } else if (queries.length > 1) {
    try {
      const folded = combine(queries);
      const rows = await q.query(folded.text, folded.params);
      if (Array.isArray(rows) && rows.length === queries.length) {
        return rows.map((r) => (Array.isArray(r.rows) ? r.rows : []));
      }
      console.warn(`store: folded read returned ${rows && rows.length} results for ${queries.length} queries — reading one at a time`);
    } catch (err) {
      console.warn('store: folded read failed, falling back to one at a time —', err.message);
    }
  }

  const out = [];
  for (const { text, params } of queries) out.push(await q.query(text, params));
  return out;
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
      /* Fourteen DDL statements, one round trip.
       *
       * Sequentially they were fourteen — every one `IF NOT EXISTS` and every
       * one a no-op after the first deploy, and still ~230ms apiece on the
       * first request a cold instance served. That is the 17 seconds measured
       * before the first byte of a cold `/`, paid for a schema that was
       * already there.
       *
       * A driver with `transaction()` takes them as a batch; one without takes
       * them as a single multi-statement string, which is legal precisely
       * because there are no parameters here. Either way it is one ask, and
       * the sequential loop remains the fallback. */
      if (typeof q.transaction === 'function') {
        try {
          await q.transaction(SCHEMA.map((statement) => q.query(statement)));
          return;
        } catch (err) {
          console.warn('store: batched migration failed, running one at a time —', err.message);
        }
      } else {
        try {
          await q.query(SCHEMA.join(';\n'));
          return;
        } catch (err) {
          console.warn('store: folded migration failed, running one at a time —', err.message);
        }
      }
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

/* Named for instrumentation: the two drivers have very different round-trip
   costs and which one a deployment is on is otherwise invisible. */
function driver() {
  if (!process.env.DATABASE_URL) return 'none';
  return isNeon(process.env.DATABASE_URL) ? 'neon-http' : 'pg-pool';
}

module.exports = { sql, ensureSchema, batch, combine, driver, configured, reset, resetDriver, isNeon, SCHEMA };
