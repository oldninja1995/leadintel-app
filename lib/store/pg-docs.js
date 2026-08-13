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

  async append(entry) {
    await ensureSchema();
    await sql().query('INSERT INTO lines (key, line) VALUES ($1, $2)', [this.key, JSON.stringify(entry)]);
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

  async clear() {
    await ensureSchema();
    await sql().query('DELETE FROM lines WHERE key = $1', [this.key]);
  }
}

module.exports = { PgDocs, PgLineLog };
