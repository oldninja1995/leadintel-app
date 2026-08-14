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
const pg = require('../lib/store/pg');

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

/* ── documents and line logs ────────────────────────────────────────────────
 *
 * These shapes did not have to change — they are small and read whole, and the
 * only thing wrong with them on serverless is the disk. So what is asserted is
 * that they behave exactly like the files they replace.
 */

const { PgDocs, PgLineLog } = require('../lib/store/pg-docs');

const uniq = (p) => `test:${p}:${Date.now()}:${process.hrtime()[1]}`;

test('a document round-trips verbatim, key order included', opts, async () => {
  /* Same reason the raw store's body is TEXT: connections.json is read,
     modified and written back, and a store that reorders it is a store that
     rewrites the user's data behind their back. */
  const docs = new PgDocs();
  const key = uniq('doc');
  const value = { meta_ads: { token: 'x' }, google_ads: { id: '1' }, order: ['a', 'b'] };

  await docs.put(key, value);
  assert.equal(JSON.stringify(await docs.get(key)), JSON.stringify(value));
  await docs.remove(key);
});

test('writing a document twice replaces rather than accumulating', opts, async () => {
  const docs = new PgDocs();
  const key = uniq('doc');
  await docs.put(key, { first: true });
  await docs.put(key, { second: true });
  assert.deepEqual(await docs.get(key), { second: true });
  await docs.remove(key);
});

test('a missing document is null, not an error', opts, async () => {
  assert.equal(await new PgDocs().get(uniq('absent')), null);
});

test('getMany fetches several documents in one round trip', opts, async () => {
  /* The hot path asks connections.configured() on essentially every render, so
     the doc reads have to collapse into one query rather than one each. */
  const docs = new PgDocs();
  const a = uniq('doc-a');
  const b = uniq('doc-b');
  await docs.put(a, { n: 1 });
  await docs.put(b, { n: 2 });

  const found = await docs.getMany([a, b, uniq('absent')]);
  assert.equal(found.size, 2, 'an absent key should be omitted, not throw');
  assert.equal(found.get(a).n, 1);
  assert.equal(found.get(b).n, 2);
  await docs.remove(a);
  await docs.remove(b);
});

test('a directory-shaped store lists by prefix', opts, async () => {
  const docs = new PgDocs();
  const prefix = uniq('dispatches');
  await docs.put(`${prefix}/r-2`, { id: 'r-2' });
  await docs.put(`${prefix}/r-1`, { id: 'r-1' });

  const listed = await docs.list(`${prefix}/`);
  assert.deepEqual(listed.map((r) => r.value.id), ['r-1', 'r-2']);
  await docs.clear(prefix);
  assert.deepEqual(await docs.list(`${prefix}/`), []);
});

test('a line log keeps arrival order and appends rather than replacing', opts, async () => {
  const log = new PgLineLog(uniq('runs'));
  for (const n of [1, 2, 3]) await log.append({ n });
  assert.deepEqual((await log.all()).map((r) => r.n), [1, 2, 3]);
  await log.clear();
  assert.deepEqual(await log.all(), []);
});

test('a bounded read returns the newest entries, still in order', opts, async () => {
  /* What the file logs could not express: they parsed the whole file to answer
     "what happened lately". */
  const log = new PgLineLog(uniq('audit'));
  for (const n of [1, 2, 3, 4]) await log.append({ n });
  assert.deepEqual((await log.last(2)).map((r) => r.n), [3, 4]);
  await log.clear();
});

test('two line logs with different keys do not see each other', opts, async () => {
  const a = new PgLineLog(uniq('log-a'));
  const b = new PgLineLog(uniq('log-b'));
  await a.append({ from: 'a' });
  assert.equal((await a.all()).length, 1);
  assert.deepEqual(await b.all(), []);
  await a.clear();
});

/* ── run-log hydration ──────────────────────────────────────────────────────
 *
 * The run log is the one line log whose reads reach arbitrarily far back:
 * `lastSuccess` drives lag, health and due-ness, and a source that has been
 * failing for hours has its last success well outside any recent window. A
 * plain bounded read would therefore have reported a long-broken source as
 * *never-synced* — lag null, "has never run" on the Connections screen — for
 * three of the sources on production right now, which have not succeeded since
 * 2026-08-09 while failing every five minutes since.
 */

const { RunLog } = require('../lib/ingest/runner');
const { SyncRunner } = require('../lib/ingest/runner');

test('hydration keeps the last success even when it is far outside the window', opts, async () => {
  const backend = new PgLineLog(uniq('runs'));
  const log = new RunLog(null, { backend });

  /* One success, then enough failures to push it out of a small window. */
  log.append({ source: 'telecrm', ok: true, startedAt: 'A', finishedAt: '2026-08-09T10:00:00.000Z', pulled: 8, written: 8 });
  for (let i = 0; i < 40; i += 1) {
    log.append({ source: 'telecrm', ok: false, startedAt: 'B', finishedAt: '2026-08-13T09:00:00.000Z', error: 'no credential stored' });
  }
  await log.flush();

  const fresh = new RunLog(null, { backend });
  await fresh.hydrate({ limit: 10 });

  const success = fresh.lastSuccess('telecrm');
  assert.ok(success, 'the last success fell out of the hydration window');
  assert.equal(success.finishedAt, '2026-08-09T10:00:00.000Z');
  await backend.clear();
});

test('a long-failing source reads as down, not never-synced', opts, async () => {
  /* The property the test above protects, stated the way the screen states it. */
  const backend = new PgLineLog(uniq('runs'));
  const log = new RunLog(null, { backend });
  log.append({ source: 'telecrm', ok: true, finishedAt: '2026-08-09T10:00:00.000Z' });
  for (let i = 0; i < 30; i += 1) {
    log.append({ source: 'telecrm', ok: false, finishedAt: '2026-08-13T09:00:00.000Z', error: 'no credential stored' });
  }
  await log.flush();

  const fresh = new RunLog(null, { backend });
  await fresh.hydrate({ limit: 5 });

  const runner = new SyncRunner({ log: fresh, clock: () => new Date('2026-08-13T09:05:00.000Z') });
  assert.equal(runner.health('telecrm'), 'down', 'a source with an old success must not read as never-synced');
  assert.ok(runner.lag('telecrm') > 0, 'lag should be a real number, not null');
  await backend.clear();
});

test('appends are visible to the same instance before they are flushed', opts, async () => {
  /* A runner logs several runs in one tick and reads its own due-ness back. */
  const backend = new PgLineLog(uniq('runs'));
  const log = new RunLog(null, { backend });
  await log.hydrate();

  log.append({ source: 'meta_ads', ok: true, finishedAt: '2026-08-13T09:00:00.000Z' });
  assert.equal(log.all().length, 1, 'the log did not see its own write');
  assert.ok(log.lastSuccess('meta_ads'));

  await log.flush();
  const fresh = new RunLog(null, { backend });
  await fresh.hydrate();
  assert.equal(fresh.all().length, 1, 'the write did not reach Postgres');
  await backend.clear();
});

/* ── which driver, chosen from the URL ──────────────────────────────────── */

/* Neon's HTTP endpoint serves Neon and nothing else, so a Supabase URL handed
   to it fails at connect time with something that reads like a credential
   problem. The choice has to be made from the URL, before either driver is
   asked to do anything. */
test('a Neon URL picks the HTTP driver', () => {
  assert.equal(pg.isNeon('postgresql://u:p@ep-cool-1.us-east-2.aws.neon.tech/db?sslmode=require'), true);
});

test('a Supabase pooler URL does not', () => {
  assert.equal(pg.isNeon('postgresql://postgres.abc:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres'), false);
});

test('a plain Postgres URL does not', () => {
  assert.equal(pg.isNeon('postgresql://user:pass@db.internal:5432/leadintel'), false);
});
