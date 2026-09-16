/* The canonical snapshot, materialised.
 *
 * The defect this exists to remove: `replay()` selects **every current row's
 * body** — 25,000 of them once the CRM was backfilled, tens of megabytes — and
 * every cold serverless instance did that on its first request. Rendering a
 * dashboard cost fifty megabytes off the database. That is what exhausted a
 * hosting plan's transfer quota in a day and took the whole app down with an
 * HTTP 402, and no amount of caching in front of it fixes the shape: a cache
 * makes a bad read rarer, not cheaper, and every new instance pays full price.
 *
 * So the *result* of the replay is stored rather than recomputed. `canonical`
 * turns 25,000 raw envelopes into an entity set an order of magnitude smaller,
 * that set gzips by another order, and reading it back is one row.
 *
 *   before   ~50 MB   per cold instance
 *   after    ~0.5 MB  per cold instance, plus a two-column freshness check
 *
 * **Freshness is a marker, not a timer.** A TTL would either serve stale
 * figures after a sync or rebuild for nothing when there was none. The marker
 * is what a rebuild would actually depend on — how many current rows exist and
 * the highest sequence among them — which changes if and only if the store
 * changed. It costs one aggregate query against an index, and it is the reason
 * this can be correct rather than approximately fresh.
 *
 * The connected set is in the marker too, because it changes what a replay
 * produces without writing a row: connecting a source retires its demo data
 * (lib/ingest/demo-origin.js), so a snapshot built before a credential was
 * stored describes a workspace that no longer exists.
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const pg = require('./pg');

const KEY = (workspace) => `snapshot:${workspace}`;

/* What a rebuild depends on, in two numbers and a set.
 *
 * `max(seq)` alone is not enough: superseding a row raises no sequence, and
 * compaction lowers the count without touching the maximum. Together they move
 * on any change to the current set, which is exactly what `replay` reads. */
async function markerFor(workspace, connected = [], shape = '') {
  const rows = await pg.sql().query(
    `SELECT count(*)::int AS rows, COALESCE(max(seq), 0)::text AS seq
       FROM envelopes WHERE workspace = $1 AND NOT superseded`,
    [workspace]
  );
  const { rows: n = 0, seq = '0' } = rows[0] || {};
  /* Sorted, so the same set never produces two markers. */
  /* The code's version rides in the key beside the data's. See SHAPE in
     lib/ingest/canonical.js for what happens without it. */
  return `${n}:${seq}:${[...connected].sort().join(',')}:${shape}`;
}

/* Split three ways, because a second spent here has three possible owners and
   they are not fixable in the same way: asking the store whether the snapshot
   is current (`marker`), moving the row across the wire (`fetch`), and
   inflating and parsing it (`parse`). Benchmarked off-platform the last is
   ~50ms for a 7.6MB entity set, so if it dominates on the deployment it is the
   runtime's cold CPU rather than the shape of the data. */
let split = null;

/* Just the row, timed on its own — split out so `through()` can run it
   alongside `markerFor()` instead of after it. The two queries touch
   different tables (`docs`, `envelopes`) and neither's result depends on the
   other's; only the *comparison* below does. Sequentially they were two full
   network round trips end to end, and on this deployment the marker query
   alone was measured over a second — paying that twice, back to back, for no
   reason two independent reads couldn't overlap. */
async function fetchRow(workspace) {
  const t0 = Date.now();
  const rows = await pg.sql().query('SELECT value FROM docs WHERE key = $1', [KEY(workspace)]);
  return { rows, fetchMs: Date.now() - t0 };
}

/* The row and the marker, once both are in hand: parsed, compared, and
   inflated. A snapshot that cannot be parsed, or belongs to a different
   marker, is a cache miss, never an error — the rebuild below is always
   available and always correct. */
async function decode(rows, marker, fetchMs) {
  const t1 = Date.now();
  if (!rows.length) return null;

  let stored;
  try {
    stored = JSON.parse(rows[0].value);
  } catch (err) {
    return null;
  }
  if (!stored || stored.marker !== marker || !stored.gz) return null;

  try {
    const entities = JSON.parse((await gunzip(Buffer.from(stored.gz, 'base64'))).toString('utf8'));
    split = { fetch: fetchMs, parse: Date.now() - t1, kb: Math.round(rows[0].value.length / 1024) };
    return entities;
  } catch (err) {
    return null;
  }
}

/* Kept as one call for anything outside this module that wants the stored
   snapshot without also computing a marker to check it against — `through()`
   itself no longer calls this, for the reason above. */
async function read(workspace, marker) {
  const { rows, fetchMs } = await fetchRow(workspace);
  return decode(rows, marker, fetchMs);
}

async function write(workspace, marker, entities) {
  const gz = (await gzip(Buffer.from(JSON.stringify(entities), 'utf8'), { level: 9 })).toString('base64');
  await pg.sql().query(
    `INSERT INTO docs (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY(workspace), JSON.stringify({ marker, gz })]
  );
  return gz.length;
}

/* Read through: the stored snapshot when the store has not moved, a rebuild
 * when it has.
 *
 * `build` is the expensive path and is passed in rather than imported, so this
 * module knows nothing about ingest and can be tested with a counter.
 *
 * A failure anywhere here falls back to building. That is the whole safety
 * property: the materialised copy is an optimisation, and an optimisation that
 * can take the app down when its own storage misbehaves is not one. */
/* What the last read through here cost, for the Server-Timing note.
 *
 * A slow `entities` mark has two very different causes — reading back half a
 * megabyte and inflating it, or replaying twenty-five thousand envelopes
 * because the store moved — and the duration alone cannot tell them apart.
 * One is the price of the cache and the other is the cache missing. */
let last = null;

function lastRead() {
  return last;
}

async function through(workspace, { connected = [], build, shape = '' }) {
  let marker = null;
  let asked = 0;
  const started = Date.now();
  try {
    split = null;
    /* Fired together, not one after the other: `markerFor` reads `envelopes`,
       `fetchRow` reads `docs`, and until the row is decoded neither result
       needs the other. Whichever is slower now decides the wait, not both
       added together. Each still timed on its own — `Promise.all` settling
       says nothing about which of the two actually cost the time. */
    const markerStarted = Date.now();
    const [markerValue, rowResult] = await Promise.all([
      markerFor(workspace, connected, shape).then((m) => { asked = Date.now() - markerStarted; return m; }),
      fetchRow(workspace),
    ]);
    marker = markerValue;
    const stored = await decode(rowResult.rows, marker, rowResult.fetchMs);
    if (stored) {
      last = { source: 'stored', ms: Date.now() - started, marker: asked, ...(split || {}) };
      return stored;
    }
  } catch (err) {
    console.warn(`snapshot: could not be read for "${workspace}" —`, err.message);
  }

  const entities = await build();
  last = { source: 'rebuilt', ms: Date.now() - started };

  if (marker) {
    try {
      const stored = await write(workspace, marker, entities);
      last = { source: 'rebuilt', ms: Date.now() - started, kb: Math.round(stored / 1024) };
    } catch (err) {
      /* Not fatal, and not silent: a snapshot that never persists means every
         instance pays the full replay, which is the condition this file exists
         to end. It should be visible in the logs rather than inferred from a
         bill. */
      console.warn(`snapshot: could not be written for "${workspace}" —`, err.message);
    }
  }

  return entities;
}

module.exports = { through, markerFor, read, write, lastRead, KEY };
