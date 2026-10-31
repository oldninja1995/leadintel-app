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

  /* The current body of each named record, by external id — a narrow read so
     a sync can consult what it stored last time without replaying the kind. */
  async currentBodies(sourceId, kind, externalIds) {
    if (!externalIds.length) return new Map();
    await ensureSchema();
    const rows = await sql().query(
      `SELECT external_id, body FROM envelopes
        WHERE workspace = $1 AND source = $2 AND kind = $3 AND NOT superseded
          AND external_id = ANY($4)`,
      [this.workspace, sourceId, kind, externalIds]
    );
    return new Map(rows.map((r) => [r.external_id, JSON.parse(r.body)]));
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

    /* When a booking was WON, which TeleCRM does not say: a deal's
       `updated_at` is the lead's last edit, so a March booking whose lead is
       touched in October reads as October's. Every version is still in the
       table, so the earliest one that was already won with this booking ref is
       the closest thing to the won date. Keyed by ref so a returning guest's
       NEW booking on an old lead still dates from when it appeared. */
    /* Whether a lead was EVER marked "Re-enquiry" in TeleCRM — the CRM's own
       mark for a returning guest. The status is overwritten when the lead
       books, so only the history still holds it. */
    if ((!sourceId || sourceId === 'telecrm') && (!kind || kind === 'lead')) {
      const marked = await sql().query(
        `SELECT DISTINCT external_id FROM envelopes
          WHERE workspace = $1 AND source = 'telecrm' AND kind = 'lead'
            AND lower(body::jsonb->>'stage') IN ('re-enquiry', 're enquiry', 'reenquiry')`,
        [this.workspace]
      );
      const reEnquired = new Set(marked.map((r) => r.external_id));
      for (const e of all) {
        if (e.source === 'telecrm' && e.kind === 'lead' && reEnquired.has(e.externalId)) e.body = { ...e.body, ever_reenquiry: true };
      }
    }

    if ((!sourceId || sourceId === 'telecrm') && (!kind || kind === 'deal')) {
      const firsts = await sql().query(
        `SELECT external_id, COALESCE(body::jsonb->>'booking_ref', '') AS ref, MIN(body::jsonb->>'updated_at') AS first
           FROM envelopes
          WHERE workspace = $1 AND source = 'telecrm' AND kind = 'deal' AND body::jsonb->>'outcome' = 'won'
          GROUP BY 1, 2`,
        [this.workspace]
      );
      const firstWon = new Map(firsts.map((r) => [`${r.external_id}|${r.ref}`, r.first]));
      for (const e of all) {
        if (e.source !== 'telecrm' || e.kind !== 'deal' || !e.body || e.body.outcome !== 'won') continue;
        const first = firstWon.get(`${e.externalId}|${e.body.booking_ref || ''}`);
        if (first && (!e.body.updated_at || first < e.body.updated_at)) e.body = { ...e.body, first_won_at: first };
      }

      /* A returning guest's earlier bookings. TeleCRM has no deal object, so a
         deal is keyed by its lead, and a second booking on the same lead
         supersedes the first — which then vanished from every count. Every
         version is still stored, so the lead's history is cut into booking
         episodes: a new one starts when the lead turns won again after not
         being won, its booking ref changes, or TeleCRM's history dates a new
         win (`won_at`) — a returning guest's booking reached while the deal
         row still read won, since the reopened lead in between stores no deal.
         A Won → Hot → Won flip with the same ref (or no ref and the same value)
         is the same booking. Each
         episode before the lead's latest is its own deal (`lead#ref`), from
         its last won version, dated from when it first read won. The latest
         episode is the current row, or — on a lead since lost or reopened —
         stays uncounted, as it always was. */
      const earlier = await sql().query(
        `WITH v AS (
           SELECT seq, external_id,
                  body::jsonb->>'outcome' AS o,
                  COALESCE(body::jsonb->>'booking_ref', '') AS ref,
                  COALESCE(body::jsonb->>'value', '') AS val,
                  body::jsonb->>'updated_at' AS upd,
                  COALESCE(body::jsonb->>'won_at', '') AS wat
             FROM envelopes
            WHERE workspace = $1 AND source = 'telecrm' AND kind = 'deal'
         ), w AS (
           SELECT v.*,
                  lag(o) OVER p AS prev_o,
                  (array_agg(ref) FILTER (WHERE o = 'won') OVER q) AS won_refs,
                  (array_agg(val) FILTER (WHERE o = 'won') OVER q) AS won_vals,
                  (array_agg(wat) FILTER (WHERE o = 'won') OVER q) AS won_wats
             FROM v
           WINDOW p AS (PARTITION BY external_id ORDER BY seq),
                  q AS (PARTITION BY external_id ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
         ), s AS (
           SELECT w.*,
                  CASE WHEN o <> 'won' THEN 0
                       WHEN won_refs IS NULL THEN 1
                       WHEN ref <> '' AND ref = won_refs[array_length(won_refs, 1)] THEN 0
                       WHEN ref <> '' AND won_refs[array_length(won_refs, 1)] <> '' THEN 1
                       WHEN wat <> '' AND won_wats[array_length(won_wats, 1)] <> ''
                            AND wat <> won_wats[array_length(won_wats, 1)] THEN 1
                       WHEN prev_o = 'won' THEN 0
                       WHEN ref = '' AND val = won_vals[array_length(won_vals, 1)] THEN 0
                       ELSE 1 END AS starts
             FROM w
         ), e AS (
           SELECT s.*, sum(starts) OVER (PARTITION BY external_id ORDER BY seq) AS episode,
                  max(seq) OVER (PARTITION BY external_id) AS last_seq
             FROM s
         ), g AS (
           SELECT external_id, episode, max(seq) FILTER (WHERE o = 'won') AS seq, min(upd) FILTER (WHERE o = 'won') AS first,
                  bool_or(seq = last_seq) AS holds_current, max(ref) AS ref
             FROM e WHERE episode > 0 GROUP BY 1, 2
         ), lw AS (
           SELECT external_id, NULLIF(wat, '') AS wat FROM e WHERE seq = last_seq
         )
         SELECT g.external_id, g.episode, g.first, g.ref, n.source, n.kind, n.checksum, n.transport, n.fetched_at, n.pull_window, n.body
           FROM g JOIN envelopes n ON n.seq = g.seq
           LEFT JOIN lw ON lw.external_id = g.external_id
          WHERE NOT g.holds_current
            AND g.episode < (SELECT max(episode) FROM e WHERE e.external_id = g.external_id)
            /* An amount edited on one booking (Won → Hot → Won at a new value)
               is not a second booking: with no win date of its own, an episode
               dated after the lead's only recorded win is that win's booking
               being revised (Sept 2026 counted 46 of these, ₹15.7L). */
            AND NOT (COALESCE(n.body::jsonb->>'won_at', '') = '' AND lw.wat IS NOT NULL
                     AND g.first IS NOT NULL AND g.first::timestamptz >= lw.wat::timestamptz - interval '1 hour')
          ORDER BY g.external_id, g.episode`,
        [this.workspace]
      );
      for (const row of earlier) {
        const e = toEnvelope(row);
        const tag = row.ref || `b${row.episode}`;
        all.push({ ...e, externalId: `${row.external_id}#${tag}`, body: { ...e.body, ...(row.first ? { first_won_at: row.first } : {}) } });
      }
    }

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
