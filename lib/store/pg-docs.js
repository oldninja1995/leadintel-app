/* The two remaining store shapes on Postgres: documents and line logs.
 *
 * The raw store earned a table of its own because its read path had to change.
 * These did not: they are small, they are read whole, and the only thing wrong
 * with them on a serverless runtime is that they live on a disk that will not
 * be there. So the shapes are preserved exactly and only the medium changes.
 *
 * **Documents** — connections.json, webhooks.json, workspace.json,
 * definitions.json, plus the two directory-shaped stores (evaluations/,
 * dispatches/) where what was a filename becomes the tail of the key. One
 * table; they differ only by key prefix.
 *
 * **Line logs** — runs.jsonl, audit.jsonl, fires.jsonl. Append-only, read
 * whole, parsed by the caller.
 *
 * Values are TEXT here for the same reason as in the raw store: jsonb sorts
 * object keys, and a store that quietly rewrites what it was handed is a store
 * you cannot reason about. Nothing queries inside these values.
 */

const { sql, ensureSchema } = require('./pg');

/* A read already performed, waiting to be claimed.
 *
 * The alternative was to rewrite six store classes so each could be handed
 * its rows — six signatures, six call sites, six chances to pass the wrong
 * one. Priming leaves every store's `hydrate()` exactly as it was; it simply
 * finds its answer already there and returns without asking.
 *
 * Each value is consumed once. A second read in the same request still goes
 * to the database, and a prime nobody claimed cannot outlive the request that
 * filled it and answer a later one with stale rows. */
function claim(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  return value;
}

/* ── documents ───────────────────────────────────────────────────────────── */

class PgDocs {
  constructor() {
    /* Keyed by the shape of the read: `getMany` and `list` answer different
       questions and a prime for one must never satisfy the other. */
    this._primed = { many: new Map(), list: new Map() };
  }

  /* The SQL for a read this class would otherwise perform, so a caller can
     batch it. Paired with the prime methods, which hand the rows back. */
  static manyQuery(keys) {
    return { text: 'SELECT key, value FROM docs WHERE key = ANY($1::text[])', params: [keys] };
  }

  static listQuery(prefix) {
    /* `order` is read by pg.batch's folded path, which aggregates the rows
       into JSON and would otherwise be free to reorder them. */
    return { text: 'SELECT key, value FROM docs WHERE key LIKE $1 ORDER BY key', params: [prefix + '%'], order: 'key' };
  }

  primeMany(keys, rows) {
    this._primed.many.set(JSON.stringify([...keys].sort()), rows);
    return this;
  }

  primeList(prefix, rows) {
    this._primed.list.set(prefix, rows);
    return this;
  }

  async get(key) {
    await ensureSchema();
    const rows = await sql().query('SELECT value FROM docs WHERE key = $1', [key]);
    return rows.length ? JSON.parse(rows[0].value) : null;
  }

  /* One round trip for several keys.
   *
   * This exists because of where the doc stores sit: `entitiesFor` asks
   * `connections.configured()` on the hot path, so at least one document is
   * read on essentially every page. Fetching them one at a time would put a
   * network round trip per store in front of every render — the shape of
   * problem this migration is supposed to be ending, reintroduced by the
   * migration itself. */
  async getMany(keys) {
    if (!keys.length) return new Map();
    const primed = claim(this._primed.many, JSON.stringify([...keys].sort()));
    let rows = primed;
    if (rows === undefined) {
      await ensureSchema();
      const q = PgDocs.manyQuery(keys);
      rows = await sql().query(q.text, q.params);
    }
    return new Map(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  async put(key, value) {
    await ensureSchema();
    await sql().query(
      `INSERT INTO docs (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }

  /* The directory read. `evaluations/` and `dispatches/` list their contents;
     the prefix is what the directory name was. */
  async list(prefix) {
    const primed = claim(this._primed.list, prefix);
    let rows = primed;
    if (rows === undefined) {
      await ensureSchema();
      const q = PgDocs.listQuery(prefix);
      rows = await sql().query(q.text, q.params);
    }
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
  }

  async remove(key) {
    await ensureSchema();
    await sql().query('DELETE FROM docs WHERE key = $1', [key]);
  }

  async clear(prefix) {
    await ensureSchema();
    await sql().query('DELETE FROM docs WHERE key LIKE $1', [`${prefix}%`]);
  }
}

/* ── line logs ───────────────────────────────────────────────────────────── */

/* Mirrors the file logs' contract: `all()` returns every entry in arrival
   order, `append` adds one, `clear` empties. The derived reads each log builds
   on top of `all()` — lastSuccess, recent, forWorkspace, resolved, stats —
   stay where they are and keep working, because they only ever needed those
   three. */
class PgLineLog {
  constructor(key) {
    if (!key) throw new Error('a line log needs a key');
    this.key = key;
    this._primed = { last: new Map(), hydrate: new Map() };
  }

  lastQuery(limit) {
    return {
      /* `seq` is selected as well as ordered by: pg.batch's folded path
         aggregates these rows into JSON and orders that aggregate by a column,
         so the column has to survive into the result. Harmless to the caller,
         which reads `line` and ignores the rest. */
      text: 'SELECT line, seq FROM (SELECT line, seq FROM lines WHERE key = $1 ORDER BY seq DESC LIMIT $2) t ORDER BY seq',
      params: [this.key, limit],
      order: 'seq',
    };
  }

  /* The window a hydrate names, as one key.
   *
   * A prime is claimed by shape, not by store: rows fetched for "the last five
   * of each source" must not answer a caller asking for "the last five
   * hundred", or it silently gets a shorter history than it asked for and
   * reports a count over a window it never read. */
  static hydrateKey({ limit = 500, perTag = null } = {}) {
    return perTag ? `per-tag:${perTag}` : `last:${limit}`;
  }

  /* `perTag` — the last N runs **of each source** rather than the last N runs
   * of any source.
   *
   * The flat window is what a history screen wants and is the wrong shape for
   * a page render. Every signed-in route hydrated the last 500 runs so the
   * chrome could print "CRM 24m · Ads 7h": 429 rows and 198KB off the database
   * per request, for twelve sources' latest attempt. It is also subtly wrong
   * in the other direction — a source that syncs rarely can have fewer than
   * twenty of its runs inside a flat window of five hundred, so the count the
   * Connections screen calls "the last twenty runs" was sometimes over five.
   *
   * Partitioned, the row count is bounded by the number of sources rather than
   * by how busy the noisiest one has been, and each source contributes exactly
   * the window asked for. */
  hydrateQuery(limit, { perTag = null } = {}) {
    const recent = perTag
      ? `(SELECT seq, line FROM (
             SELECT seq, line, row_number() OVER (PARTITION BY tag ORDER BY seq DESC) AS n
               FROM lines WHERE key = $1
           ) w WHERE n <= $2)`
      : `(SELECT seq, line FROM lines WHERE key = $1 ORDER BY seq DESC LIMIT $2)`;

    return {
      text: `SELECT seq, line FROM (
           ${recent}
         UNION
           (SELECT DISTINCT ON (tag) seq, line FROM lines
             WHERE key = $1 AND ok IS TRUE ORDER BY tag, seq DESC)
       ) t ORDER BY seq`,
      params: [this.key, perTag || limit],
      order: 'seq',
    };
  }

  primeLast(limit, rows) { this._primed.last.set(limit, rows); return this; }

  primeHydrate(key, rows) { this._primed.hydrate.set(key, rows); return this; }

  async all() {
    await ensureSchema();
    const rows = await sql().query('SELECT line FROM lines WHERE key = $1 ORDER BY seq', [this.key]);
    return rows.map((r) => JSON.parse(r.line));
  }

  /* `tag` and `ok` are lifted out of the entry so the derived reads can be
     index lookups — see the schema. Both are optional; the audit and fire logs
     use only the tag. */
  async append(entry, { tag = null, ok = null } = {}) {
    await ensureSchema();
    await sql().query(
      'INSERT INTO lines (key, tag, ok, line) VALUES ($1, $2, $3, $4)',
      [this.key, tag, ok, JSON.stringify(entry)]
    );
    return entry;
  }

  /* The audit and fire logs are read in full on pages that show them, and the
     run log is read on every status call. Bounded reads exist so a log that has
     been appended to for a year does not have to be parsed whole to answer
     "what happened lately" — the file versions had no way to express this. */
  async last(limit) {
    const primed = claim(this._primed.last, limit);
    let rows = primed;
    if (rows === undefined) {
      await ensureSchema();
      const q = this.lastQuery(limit);
      rows = await sql().query(q.text, q.params);
    }
    return rows.map((r) => JSON.parse(r.line));
  }

  /* What the run log needs to be hydrated with.
   *
   * The naive version — "the last N entries" — is wrong for `lastSuccess`. A
   * source that has been failing for six hours has its last success far outside
   * any recent window, so a bounded read would not contain it and the source
   * would report as never-synced: lag null, health never-synced, and the
   * Connections screen saying it has never run when in fact it ran this
   * morning. Three sources on production are in exactly that state.
   *
   * So the recent window is unioned with the last successful entry per tag,
   * which the partial index answers directly. The result is a superset of what
   * any derived read needs, in arrival order, and the caller filters it exactly
   * as it filtered the file's contents. */
  async hydrate({ limit = 500, perTag = null } = {}) {
    const primed = claim(this._primed.hydrate, PgLineLog.hydrateKey({ limit, perTag }));
    let rows = primed;
    if (rows === undefined) {
      await ensureSchema();
      const q = this.hydrateQuery(limit, { perTag });
      rows = await sql().query(q.text, q.params);
    }
    return rows.map((r) => JSON.parse(r.line));
  }

  async clear() {
    await ensureSchema();
    await sql().query('DELETE FROM lines WHERE key = $1', [this.key]);
  }
}

/* ── sessions ────────────────────────────────────────────────────────────── */

/* An in-process Map is correct on one always-on node and wrong the moment there
 * are two. A session minted on one instance is unknown to the next, and what a
 * user sees is being signed out at random — on a runtime that may hand every
 * request to a different instance, almost immediately.
 *
 * Kept apart from the document store because the lifecycle is different: rows
 * expire, and expiry is the store's job rather than a reader's. */
class PgSessions {
  async get(id, { at = Date.now() } = {}) {
    await ensureSchema();
    const rows = await sql().query(
      'SELECT value FROM sessions WHERE token = $1 AND expires_at > $2',
      [id, new Date(at).toISOString()]
    );
    return rows.length ? JSON.parse(rows[0].value) : null;
  }

  async put(id, value, expiresAt) {
    await ensureSchema();
    await sql().query(
      `INSERT INTO sessions (token, value, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [id, JSON.stringify(value), new Date(expiresAt).toISOString()]
    );
  }

  async remove(id) {
    await ensureSchema();
    await sql().query('DELETE FROM sessions WHERE token = $1', [id]);
  }

  /* The expired rows a reader never revisits. Cheap, indexed, and safe to run
     from any instance. */
  async sweep({ at = Date.now() } = {}) {
    await ensureSchema();
    const rows = await sql().query(
      'DELETE FROM sessions WHERE expires_at <= $1 RETURNING token',
      [new Date(at).toISOString()]
    );
    return rows.length;
  }

  async size() {
    await ensureSchema();
    const rows = await sql().query('SELECT COUNT(*)::int AS n FROM sessions');
    return rows[0].n;
  }
}

module.exports = { PgDocs, PgLineLog, PgSessions };
