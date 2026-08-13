/* The Postgres raw store, checked against the file store it has to replace.
 *
 *   node --env-file=.env.local --test test/pg-store.test.js
 *
 * Skipped when DATABASE_URL is unset, which is the normal case: `npm test`
 * must stay runnable with no database, and the file store is what every other
 * test in this suite exercises.
 *
 * The assertions are all *parity* assertions rather than assertions about
 * Postgres. Two stores back the same interface, and the only thing worth
 * proving is that a caller cannot tell which one it was handed — including on
 * the properties that are easy to lose in a round trip: idempotence, key order
 * inside a payload, and the fact that supersession does not delete anything.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RawStore } = require('../lib/ingest/raw-store');
const { PgRawStore } = require('../lib/store/pg-raw-store');

const LIVE = Boolean(process.env.DATABASE_URL);
const opts = { skip: LIVE ? false : 'DATABASE_URL is not set' };

const rec = (kind, externalId, body) => ({ kind, externalId, body });

/* A matched pair of stores, one of each kind, over the same records. */
function pair() {
  const pg = new PgRawStore(`test_${Date.now()}_${Math.floor(process.hrtime()[1])}`);
  const file = new RawStore(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-pg-')));
  return {
    pg,
    file,
    async append(records, at) {
      const p = await pg.append('meta_ads', records, { fetchedAt: at, transport: 'http' });
      const f = file.append('meta_ads', records, { fetchedAt: at, transport: 'http' });
      return { pg: p.length, file: f.length };
    },
  };
}

const shape = (rows) => rows
  .map((r) => `${r.source}/${r.kind}/${r.externalId}=${JSON.stringify(r.body)}`)
  .sort();

const BATCH = [
  rec('campaign_day', 'C-1', { campaign_id: 'C-1', spend: 100, name: 'A' }),
  rec('campaign_day', 'C-2', { campaign_id: 'C-2', spend: 200, name: 'B' }),
  rec('creative', 'AD-1', { id: 'AD-1', title: 't', thumb: 'u' }),
];

test('a first write reports the same count from both stores', opts, async () => {
  const p = pair();
  const n = await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  assert.equal(n.pg, 3);
  assert.equal(n.pg, n.file);
  await p.pg.clear();
});

test('re-pulling an unchanged payload writes nothing, in both', opts, async () => {
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  const again = await p.append(BATCH, '2026-08-13T00:05:00.000Z');
  assert.equal(again.pg, 0, 'the Postgres store re-wrote an unchanged payload');
  assert.equal(again.file, 0);
  await p.pg.clear();
});

test('a changed payload supersedes rather than duplicating', opts, async () => {
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  const changed = await p.append(
    [rec('campaign_day', 'C-1', { campaign_id: 'C-1', spend: 175, name: 'A' })],
    '2026-08-13T00:10:00.000Z'
  );
  assert.equal(changed.pg, 1);

  const replayed = await p.pg.replay();
  assert.equal(replayed.length, 3, 'supersession should not change how many rows are current');
  assert.equal(replayed.find((r) => r.externalId === 'C-1').body.spend, 175);
  await p.pg.clear();
});

test('replay is byte-identical to the file store, key order included', opts, async () => {
  /* The reason `body` is TEXT and not JSONB. jsonb sorts object keys, so this
     same assertion failed with {campaign_id, spend, name} coming back as
     {name, spend, campaign_id} — a store whose contract is verbatim storage
     quietly rewriting what it was given. */
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  await p.append(
    [rec('campaign_day', 'C-1', { campaign_id: 'C-1', spend: 175, name: 'A' })],
    '2026-08-13T00:10:00.000Z'
  );

  assert.deepEqual(shape(await p.pg.replay()), shape(p.file.replay()));
  await p.pg.clear();
});

test('checksums agree across the two stores', opts, async () => {
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  const pg = (await p.pg.replay()).map((r) => r.checksum).sort();
  const file = p.file.replay().map((r) => r.checksum).sort();
  assert.deepEqual(pg, file);
  await p.pg.clear();
});

test('the store still never forgets — superseded rows stay readable', opts, async () => {
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  await p.append(
    [rec('campaign_day', 'C-1', { campaign_id: 'C-1', spend: 175, name: 'A' })],
    '2026-08-13T00:10:00.000Z'
  );

  const history = await p.pg.envelopes('meta_ads', 'campaign_day');
  assert.equal(history.length, 3, 'C-1 twice and C-2 once');
  assert.deepEqual(history.map((e) => e.body.spend), [100, 200, 175]);
  await p.pg.clear();
});

test('kinds and sources match the file store', opts, async () => {
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  assert.deepEqual(await p.pg.kinds('meta_ads'), p.file.kinds('meta_ads').sort());
  assert.deepEqual(await p.pg.sources(), p.file.sources());
  await p.pg.clear();
});

test('compaction drops superseded history and leaves current truth alone', opts, async () => {
  /* The thing the file store could not do at all, and the reason the volume
     reached 0.6 GB in four days. */
  const p = pair();
  await p.append(BATCH, '2026-08-13T00:00:00.000Z');
  await p.append(
    [rec('campaign_day', 'C-1', { campaign_id: 'C-1', spend: 175, name: 'A' })],
    '2026-08-13T00:10:00.000Z'
  );

  const before = await p.pg.replay();
  const removed = await p.pg.compact({ keepSuperseded: 0 });
  assert.equal(removed, 1);
  assert.deepEqual(shape(await p.pg.replay()), shape(before), 'compaction changed current truth');
  await p.pg.clear();
});

test('a workspace sees only its own rows', opts, async () => {
  /* Tenancy is a column here where it was a directory before, so the isolation
     the partitioned store gave for free has to be asserted. */
  const a = new PgRawStore(`test_a_${Date.now()}`);
  const b = new PgRawStore(`test_b_${Date.now()}`);
  await a.append('meta_ads', BATCH, { fetchedAt: '2026-08-13T00:00:00.000Z', transport: 'http' });

  assert.equal((await a.replay()).length, 3);
  assert.deepEqual(await b.replay(), [], 'another tenant saw rows that were not its own');
  await a.clear();
  await b.clear();
});
