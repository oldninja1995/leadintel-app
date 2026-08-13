/* The raw store, on Postgres.
 *
 * Implements the same interface as `lib/ingest/raw-store.js` — `append`,
 * `replay`, `kinds`, `sources`, `envelopes`, `clear` — so `ingest.storeFor`
 * can hand back either and nothing downstream knows which it got. The file
 * store is untouched and still backs every existing test and every local run.
 *
 * **The one behavioural difference, and it is the point of the exercise.**
 *
 * The file store is append-only and `replay` reads every line ever written in
 * order to return the last one per external id. That is fine while a fixture
 * holds five rows. It stopped being fine when Meta and Google went live: they
 * re-report the same ad-day every fifteen minutes with a new spend figure, so
 * each row is re-appended around ninety-six times a day, and the volume reached
 * 0.6 GB in four days — of which roughly three thousand rows, well under half a
 * percent, were ever read. Every page render parsed all of it.
 *
 * Here supersession is *recorded* rather than derived. A partial unique index
 * keeps exactly one current row per (workspace, source, kind, external_id), and
 * `replay` reads only those. The superseded rows stay in the table, so the store
 * still never forgets and a restatement can still be traced to the delivery that
 * caused it — they are simply never on the read path.
 */

const { checksum } = require('../ingest/raw-store');
const { fromDemo, retiresDemo } = require('../ingest/demo-origin');
const { sql, ensureSchema } = require('./pg');

/* Bodies are stored as text and parsed here, which is what keeps a payload
   byte-identical through a round trip — see the schema for why jsonb is wrong
   for this table. The file store hands back whatever `JSON.parse` produced, so
   this normalises to the same thing and a caller cannot tell the two apart. */
function toEnvelope(row) {
  return {
    source: row.source,
    kind: row.kind,
    externalId: row.external_id,
    checksum: row.checksum,
    fetchedAt: row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at,
    window: row.pull_window ? JSON.parse(row.pull_window) : null,
    transport: row.transport,
    body: JSON.parse(row.body),
  };
}

class PgRawStore {
  /* Takes the workspace itself rather than a path. The file store encodes
     tenancy in its root directory (`var/raw/<workspace>`); here it is a column,
     and every query below filters on it. There is still deliberately no
     default — a store with no workspace would read as empty rather than as a
     mistake. */
  constructor(workspace) {
    if (!workspace) throw new Error('a raw store needs a workspace');
    this.workspace = workspace;
  }

  async append(sourceId, records, { window = null, fetchedAt, transport = null } = {}) {
    if (!records || !records.length) return [];
    await ensureSchema();

    const stamp = fetchedAt || new Date().toISOString();

    /* Deduplicated before the insert, keeping the last occurrence.
     *
     * The file store does this with a Set and would happily write two lines for
     * one external id if a single pull reported it twice with different bodies,
     * leaving `replay` to take the later. The unique index makes that
     * impossible here, so the same rule — last one wins — is applied up front
     * instead of at read time. */
    const byKey = new Map();
    for (const record of records) {
      byKey.set(`${record.kind}:${record.externalId}`, {
        kind: record.kind,
        externalId: String(record.externalId),
        checksum: checksum(record.body),
        body: JSON.stringify(record.body),
      });
    }
    const batch = [...byKey.values()];

    const q = sql();
    const sources = batch.map(() => sourceId);
    const kinds = batch.map((r) => r.kind);
    const ids = batch.map((r) => r.externalId);
    const sums = batch.map((r) => r.checksum);
    const bodies = batch.map((r) => r.body);

    /* Two statements, and they cannot be one.
     *
     * A data-modifying CTE would be the obvious way to write "supersede the old
     * row, then insert the new one" — but statements in a CTE all see the same
     * snapshot, so the INSERT would not observe the UPDATE and would collide
     * with a row it had just marked superseded, silently writing nothing.
     *
     * Set-based rather than a statement per record: a sync carries a few
     * thousand rows and this runs over HTTP, so per-row round trips would make
     * a fifteen-minute cadence a fifteen-minute job. */
    await q.query(
      `UPDATE envelopes e SET superseded = TRUE
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS t(source, kind, external_id, checksum)
        WHERE e.workspace = $1
          AND NOT e.superseded
          AND e.source = t.source
          AND e.kind = t.kind
          AND e.external_id = t.external_id
          AND e.checksum <> t.checksum`,
      [this.workspace, sources, kinds, ids, sums]
    );

    /* Anything whose checksum was unchanged still has a current row, so it
       conflicts and is skipped — which is exactly the idempotence the file
       store got from hashing the body. RETURNING therefore names precisely
       what was new, which is what the caller reports as `written`. */
    const inserted = await q.query(
      `INSERT INTO envelopes
         (workspace, source, kind, external_id, checksum, fetched_at, pull_window, transport, body)
       SELECT $1, t.source, t.kind, t.external_id, t.checksum,
              $6::timestamptz, $7, $8, t.body
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $9::text[])
              AS t(source, kind, external_id, checksum, body)
       ON CONFLICT (workspace, source, kind, external_id) WHERE NOT superseded
       DO NOTHING
       RETURNING source, kind, external_id, checksum, fetched_at, pull_window, transport, body`,
      [
        this.workspace, sources, kinds, ids, sums,
        stamp, window === null ? null : JSON.stringify(window), transport, bodies,
      ]
    );

    return inserted.map(toEnvelope);
  }

  async kinds(sourceId) {
    await ensureSchema();
    const rows = await sql().query(
      'SELECT DISTINCT kind FROM envelopes WHERE workspace = $1 AND source = $2 ORDER BY kind',
      [this.workspace, sourceId]
    );
    return rows.map((r) => r.kind);
  }

  async sources() {
    await ensureSchema();
    const rows = await sql().query(
      'SELECT DISTINCT source FROM envelopes WHERE workspace = $1 ORDER BY source',
      [this.workspace]
    );
    return rows.map((r) => r.source);
  }

  /* Every envelope for a source, superseded ones included, in arrival order.
     This is the "never forgets" read and is deliberately not on any hot path. */
  async envelopes(sourceId, kind = null) {
    await ensureSchema();
    const rows = kind
      ? await sql().query(
        `SELECT * FROM envelopes WHERE workspace = $1 AND source = $2 AND kind = $3 ORDER BY seq`,
        [this.workspace, sourceId, kind]
      )
      : await sql().query(
        `SELECT * FROM envelopes WHERE workspace = $1 AND source = $2 ORDER BY seq`,
        [this.workspace, sourceId]
      );
    return rows.map(toEnvelope);
  }

  /* Current truth: the latest version of each external id, minus any demo rows
     a source has outgrown. The index does the work the file store did by
     reading everything and keeping the last of each. */
  async replay(sourceId = null, kind = null, { connected = null } = {}) {
    await ensureSchema();

    const where = ['workspace = $1', 'NOT superseded'];
    const params = [this.workspace];
    if (sourceId) { params.push(sourceId); where.push(`source = $${params.length}`); }
    if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }

    const rows = await sql().query(
      `SELECT source, kind, external_id, checksum, transport, body
         FROM envelopes WHERE ${where.join(' AND ')} ORDER BY seq`,
      params
    );
    const all = rows.map(toEnvelope);

    /* The demo rule, unchanged from the file store: once a (source, kind) holds
       a record that is real, that kind stops replaying its fixtures — and a
       source somebody has stored a credential for retires them whether or not a
       pull has yet succeeded.
     *
     * Evaluated over current rows rather than over all history. The two differ
     * only if a real row were later superseded by a fixture row, which is the
     * very thing `connected` and the transport marker exist to prevent. */
    const grouped = new Map();
    for (const e of all) {
      const key = `${e.source}:${e.kind}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(e);
    }

    const out = [];
    for (const [key, envelopes] of grouped) {
      const source = key.slice(0, key.indexOf(':'));
      const isConnected = Boolean(connected && connected.has(source));
      const hasReal = isConnected || envelopes.some(retiresDemo);
      for (const e of envelopes) {
        if (hasReal && fromDemo(e)) continue;
        /* fetchedAt is dropped, as it is by the file store — nothing downstream
           may depend on when a payload arrived or replay could not reproduce
           its output. */
        out.push({
          source: e.source,
          kind: e.kind,
          externalId: e.externalId,
          checksum: e.checksum,
          body: e.body,
        });
      }
    }
    return out;
  }

  async clear(sourceId = null) {
    await ensureSchema();
    if (sourceId) {
      await sql().query('DELETE FROM envelopes WHERE workspace = $1 AND source = $2', [this.workspace, sourceId]);
    } else {
      await sql().query('DELETE FROM envelopes WHERE workspace = $1', [this.workspace]);
    }
  }

  /* What the file store could not offer at all: dropping superseded history
     past a horizon. Not called anywhere yet — compaction is the follow-up — but
     it belongs beside the schema that makes it a one-liner. */
  async compact({ keepSuperseded = 0 } = {}) {
    await ensureSchema();
    const rows = await sql().query(
      `DELETE FROM envelopes
        WHERE workspace = $1 AND superseded
          AND seq NOT IN (
            SELECT seq FROM envelopes
             WHERE workspace = $1 AND superseded
             ORDER BY seq DESC LIMIT $2
          )
        RETURNING seq`,
      [this.workspace, keepSuperseded]
    );
    return rows.length;
  }
}

module.exports = { PgRawStore };
