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

/* ── documents ───────────────────────────────────────────────────────────── */

class PgDocs {
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
    await ensureSchema();
    if (!keys.length) return new Map();
    const rows = await sql().query('SELECT key, value FROM docs WHERE key = ANY($1::text[])', [keys]);
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
    await ensureSchema();
    const rows = await sql().query(
      'SELECT key, value FROM docs WHERE key LIKE $1 ORDER BY key',
      [`${prefix}%`]
    );
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
  }

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
    await ensureSchema();
    const rows = await sql().query(
      'SELECT line FROM (SELECT line, seq FROM lines WHERE key = $1 ORDER BY seq DESC LIMIT $2) t ORDER BY seq',
      [this.key, limit]
    );
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
  async hydrate({ limit = 500 } = {}) {
    await ensureSchema();
    const rows = await sql().query(
      `SELECT seq, line FROM (
           (SELECT seq, line FROM lines WHERE key = $1 ORDER BY seq DESC LIMIT $2)
         UNION
           (SELECT DISTINCT ON (tag) seq, line FROM lines
             WHERE key = $1 AND ok IS TRUE ORDER BY tag, seq DESC)
       ) t ORDER BY seq`,
      [this.key, limit]
    );
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
