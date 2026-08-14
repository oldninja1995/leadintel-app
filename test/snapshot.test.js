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
    const raw = JSON.stringify(big).length;
    assert.ok(stored.gz.length < raw / 5, `stored ${stored.gz.length} against ${raw} raw — compression is not happening`);
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
