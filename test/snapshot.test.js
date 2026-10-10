/* The materialised canonical snapshot.
 *
 *   node --test test/snapshot.test.js
 *
 * What this replaces: a full replay of every current envelope on every cold
 * instance — tens of megabytes to draw one dashboard, which exhausted a
 * hosting plan's transfer quota in a day. The properties worth holding are
 * that it is correct (never serves a snapshot the store has moved past) and
 * that it cannot take the app down when its own storage misbehaves.
 */

const test = require('node:test');
const assert = require('node:assert');

const snapshot = require('../lib/store/snapshot');
const pg = require('../lib/store/pg');

/* A fake `docs` table and envelope count, so this runs with no database. */
function fakeDb({ rows = 3, seq = '99' } = {}) {
  const docs = new Map();
  const calls = { marker: 0, read: 0, write: 0 };
  const state = { rows, seq, fail: null };

  const query = async (text, params) => {
    if (state.fail) throw new Error(state.fail);
    if (/FROM envelopes/.test(text)) { calls.marker += 1; return [{ rows: state.rows, seq: state.seq }]; }
    if (/^SELECT value FROM docs/.test(text)) {
      calls.read += 1;
      const value = docs.get(params[0]);
      return value === undefined ? [] : [{ value }];
    }
    if (/^INSERT INTO docs/.test(text)) { calls.write += 1; docs.set(params[0], params[1]); return []; }
    if (/^UPDATE docs/.test(text)) {
      calls.write += 1;
      if (String(docs.get(params[0]) || '').startsWith(params[2])) docs.set(params[0], params[1]);
      return [];
    }
    return [];
  };

  const original = pg.sql;
  pg.sql = () => ({ query });
  return { calls, state, docs, restore() { pg.sql = original; } };
}

const ENTITIES = () => ({
  campaignDays: [{ id: 'c1', spend: 1000 }],
  leads: [{ id: 'l1', channel: 'meta' }],
  deals: [], bookings: [], problems: [],
});

test('the second read comes from the stored row, not a rebuild', async () => {
  const db = fakeDb();
  try {
    let built = 0;
    const build = async () => { built += 1; return ENTITIES(); };

    const first = await snapshot.through('parakkat', { connected: ['meta_ads'], build });
    const second = await snapshot.through('parakkat', { connected: ['meta_ads'], build });

    assert.equal(built, 1, 'the snapshot was rebuilt when nothing had changed');
    assert.deepEqual(second, first);
  } finally { db.restore(); }
});

test('a store that has moved rebuilds rather than serving the old set', async () => {
  const db = fakeDb();
  try {
    let built = 0;
    const build = async () => { built += 1; return ENTITIES(); };

    await snapshot.through('parakkat', { connected: [], build });
    /* A sync wrote: the count and the highest sequence both move. */
    db.state.rows = 4; db.state.seq = '120';
    await snapshot.through('parakkat', { connected: [], build });

    assert.equal(built, 2);
  } finally { db.restore(); }
});

test('superseding a row invalidates even though no sequence rose', async () => {
  /* max(seq) alone is not enough — superseding raises nothing, and compaction
     lowers the count without touching the maximum. */
  const db = fakeDb({ rows: 10, seq: '500' });
  try {
    let built = 0;
    const build = async () => { built += 1; return ENTITIES(); };

    await snapshot.through('parakkat', { connected: [], build });
    db.state.rows = 9;
    await snapshot.through('parakkat', { connected: [], build });

    assert.equal(built, 2);
  } finally { db.restore(); }
});

test('connecting a source invalidates, because it changes what a replay produces', async () => {
  /* Connecting retires that source's demo rows without writing anything, so a
     snapshot built before it describes a workspace that no longer exists. */
  const db = fakeDb();
  try {
    let built = 0;
    const build = async () => { built += 1; return ENTITIES(); };

    await snapshot.through('parakkat', { connected: [], build });
    await snapshot.through('parakkat', { connected: ['telecrm'], build });

    assert.equal(built, 2);
  } finally { db.restore(); }
});

test('the connected set is order-independent', async () => {
  const db = fakeDb();
  try {
    let built = 0;
    const build = async () => { built += 1; return ENTITIES(); };

    await snapshot.through('parakkat', { connected: ['meta_ads', 'telecrm'], build });
    await snapshot.through('parakkat', { connected: ['telecrm', 'meta_ads'], build });

    assert.equal(built, 1, 'the same set produced two markers');
  } finally { db.restore(); }
});

test('two workspaces do not share a snapshot', async () => {
  const db = fakeDb();
  try {
    const build = async () => ENTITIES();
    await snapshot.through('parakkat', { connected: [], build });
    await snapshot.through('kestrel', { connected: [], build });
    assert.equal(db.docs.size, 2);
  } finally { db.restore(); }
});

test('a storage failure falls back to building rather than failing the request', async () => {
  /* The materialised copy is an optimisation, and an optimisation that can
     take the app down when its own storage misbehaves is not one. */
  const db = fakeDb();
  try {
    db.state.fail = 'exceeded the data transfer quota';
    let built = 0;
    const entities = await snapshot.through('parakkat', { connected: [], build: async () => { built += 1; return ENTITIES(); } });

    assert.equal(built, 1);
    assert.deepEqual(entities, ENTITIES());
  } finally { db.restore(); }
});

test('an unreadable stored snapshot is a miss, never an error', async () => {
  const db = fakeDb();
  try {
    let built = 0;
    const build = async () => { built += 1; return ENTITIES(); };
    await snapshot.through('parakkat', { connected: [], build });

    db.docs.set(snapshot.KEY('parakkat'), 'not json at all');
    const entities = await snapshot.through('parakkat', { connected: [], build });

    assert.equal(built, 2);
    assert.deepEqual(entities, ENTITIES());
  } finally { db.restore(); }
});

test('the stored row is compressed, not raw JSON', async () => {
  /* The whole saving is here: an entity set gzips by about an order of
     magnitude, and one row replaces tens of thousands. */
  const db = fakeDb();
  try {
    const big = { leads: Array.from({ length: 2000 }, (_, i) => ({ id: `l${i}`, name: 'Asha R', stage: 'Fresh', channel: 'meta' })) };
    await snapshot.through('parakkat', { connected: [], build: async () => big });

    const stored = JSON.parse(db.docs.get(snapshot.KEY('parakkat')));
    const size = Object.values(stored.parts).reduce((n, part) => n + part.length, 0);
    const raw = JSON.stringify(big).length;
    assert.ok(size < raw / 5, `stored ${size} against ${raw} raw — compression is not happening`);
  } finally { db.restore(); }
});

test('what comes back out is what went in', async () => {
  const db = fakeDb();
  try {
    const original = ENTITIES();
    await snapshot.through('parakkat', { connected: [], build: async () => original });
    const again = await snapshot.through('parakkat', { connected: [], build: async () => { throw new Error('should not rebuild'); } });
    assert.deepEqual(again, original);
  } finally { db.restore(); }
});

test('a collection is only inflated when something reads it', async () => {
  /* The cold-start saving: a page that reads leads must not pay for search
     terms. Proven by breaking one part — reading the others still works, and
     the broken one fails only when it is actually asked for. */
  const db = fakeDb();
  try {
    await snapshot.through('parakkat', { connected: [], build: async () => ENTITIES() });
    const key = snapshot.KEY('parakkat');
    const stored = JSON.parse(db.docs.get(key));
    stored.parts.deals = 'not gzip';
    db.docs.set(key, JSON.stringify(stored));

    const entities = await snapshot.through('parakkat', { connected: [], build: async () => { throw new Error('should not rebuild'); } });
    assert.deepEqual(entities.leads, ENTITIES().leads);
    assert.ok(Object.keys(entities).includes('deals'), 'an undecoded collection must still be listed');
    assert.throws(() => entities.deals);
  } finally { db.restore(); }
});

test('a row in the old single-blob format is still read', async () => {
  /* Rows written before per-collection parts stay readable until the next
     rebuild replaces them; a format change must not cost a replay. */
  const db = fakeDb();
  try {
    const zlib = require('zlib');
    const marker = await snapshot.markerFor('parakkat', [], '');
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(ENTITIES()))).toString('base64');
    db.docs.set(snapshot.KEY('parakkat'), JSON.stringify({ marker, gz }));

    const entities = await snapshot.through('parakkat', { connected: [], build: async () => { throw new Error('should not rebuild'); } });
    assert.deepEqual(entities, ENTITIES());

    /* …and re-saved as parts in the background, so the next cold instance
       gets the lazy read without waiting for a sync to rebuild. */
    for (let i = 0; i < 50 && !JSON.parse(db.docs.get(snapshot.KEY('parakkat'))).parts; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const resaved = JSON.parse(db.docs.get(snapshot.KEY('parakkat')));
    assert.equal(resaved.marker, marker);
    assert.ok(resaved.parts && !resaved.gz, 'the legacy row was not re-saved as parts');
    const again = await snapshot.through('parakkat', { connected: [], build: async () => { throw new Error('should not rebuild'); } });
    assert.deepEqual(again, ENTITIES());
  } finally { db.restore(); }
});

test('a legacy re-save never overwrites a newer snapshot', async () => {
  const db = fakeDb();
  try {
    const zlib = require('zlib');
    const marker = await snapshot.markerFor('parakkat', [], '');
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(ENTITIES()))).toString('base64');
    db.docs.set(snapshot.KEY('parakkat'), JSON.stringify({ marker, gz }));
    await snapshot.through('parakkat', { connected: [], build: async () => ENTITIES() });
    /* A rebuild lands before the background re-save does. */
    const newer = JSON.stringify({ marker: 'newer', parts: {} });
    db.docs.set(snapshot.KEY('parakkat'), newer);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(db.docs.get(snapshot.KEY('parakkat')), newer);
  } finally { db.restore(); }
});

test('narrowing by a period does not read collections nobody asks for', () => {
  const period = require('../lib/metrics/period');
  const lazy = require('../lib/store/lazy');
  const read = new Set();
  const entities = {};
  for (const [key, rows] of Object.entries({
    leads: [{ id: 'a', createdAt: '2026-08-02T00:00:00Z' }, { id: 'b', createdAt: '2026-06-01T00:00:00Z' }],
    deals: [{ id: 'd', updatedAt: '2026-08-03T00:00:00Z' }],
    identity: { links: 1 },
  })) lazy.define(entities, key, () => { read.add(key); return rows; });

  const narrowed = period.within(entities, { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
  assert.deepEqual([...read], [], 'within() decoded collections up front');

  assert.deepEqual(narrowed.leads.map((l) => l.id), ['a']);
  assert.deepEqual([...read], ['leads']);
  assert.deepEqual(narrowed.identity, { links: 1 });
  assert.deepEqual(Object.keys(narrowed).sort(), ['deals', 'identity', 'leads']);
});

test('extend reads like a spread without reading the base', () => {
  const lazy = require('../lib/store/lazy');
  let reads = 0;
  const base = { plain: 1, over: 'base' };
  lazy.define(base, 'heavy', () => { reads += 1; return [1, 2]; });

  const out = lazy.extend(base, { over: 'extra', added: true });
  assert.equal(reads, 0);
  assert.deepEqual(out, { ...base, over: 'extra', added: true });
  assert.equal(reads, 1, 'the base was decoded more than once');
  out.heavy = 'replaced';
  assert.equal(out.heavy, 'replaced');
});
