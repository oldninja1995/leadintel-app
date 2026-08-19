/* Whether a cached snapshot is still the store's.
 *
 *   node --test test/freshness.test.js
 *
 * The bug behind this file: on Vercel the lambda that syncs and the lambda that
 * renders are different processes, so the in-process "this snapshot is stale"
 * mark set by a write is never seen by the instance answering pages. It served
 * its warm-up snapshot for hours — Google Ads spend read ₹83,809 for 1–19 Aug
 * while the store held ₹93,427, with nothing down and nothing logged.
 *
 * So the properties worth holding are that a *changed* store is noticed, that
 * an unchanged one costs one small query rather than a replay, and that a
 * database that misbehaves cannot turn into a replay storm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const freshness = require('../lib/store/freshness');

/* A clock the test moves, so throttling is tested rather than waited out. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function probe(marker = 'a') {
  const state = { marker, calls: 0, fail: null };
  return {
    state,
    markerFor: async () => {
      state.calls += 1;
      if (state.fail) throw new Error(state.fail);
      return state.marker;
    },
  };
}

test('a store that has not moved is not rebuilt', async () => {
  const time = clock();
  const p = probe('3:99:google_ads');
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now });

  t.record('parakkat', await t.marker('parakkat'));
  time.advance(20_000);

  assert.equal(await t.moved('parakkat'), false);
});

test('a store that has moved is noticed', async () => {
  const time = clock();
  const p = probe('3:99:google_ads');
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now });

  t.record('parakkat', await t.marker('parakkat'));
  time.advance(20_000);

  /* A backfill lands: more current rows, a higher sequence. */
  p.state.marker = '1129:4821:google_ads';
  assert.equal(await t.moved('parakkat'), true);
});

test('the probe is throttled, so a burst of requests costs one query', async () => {
  const time = clock();
  const p = probe();
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now });

  t.record('parakkat', await t.marker('parakkat'));
  const before = p.state.calls;

  for (let i = 0; i < 20; i += 1) assert.equal(await t.moved('parakkat'), false);
  assert.equal(p.state.calls, before, 'the store was asked more than once inside the window');

  time.advance(15_000);
  await t.moved('parakkat');
  assert.equal(p.state.calls, before + 1, 'the window expired and the store was not asked');
});

test('a probe that throws serves the cached snapshot rather than replaying', async () => {
  /* Turning a database hiccup into a rebuild per request is the read that
     exhausted a transfer quota and took the app down with an HTTP 402. */
  const time = clock();
  const p = probe();
  const errors = [];
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now, onError: (w, e) => errors.push([w, e.message]) });

  t.record('parakkat', await t.marker('parakkat'));
  time.advance(20_000);
  p.state.fail = 'connection terminated';

  assert.equal(await t.moved('parakkat'), false);
  assert.deepEqual(errors, [['parakkat', 'connection terminated']]);
});

test('a snapshot of unknown vintage is rebuilt once rather than adopted', async () => {
  const time = clock();
  const p = probe();
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now });

  /* Nothing recorded: whatever is cached may predate the marker we just read,
     and adopting it would make an old snapshot look current for ever. */
  assert.equal(await t.moved('parakkat'), true);
});

test('forgetting a workspace forces the next read to rebuild', async () => {
  const time = clock();
  const p = probe();
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now });

  t.record('parakkat', await t.marker('parakkat'));
  t.forget('parakkat');

  assert.equal(await t.moved('parakkat'), true);
});

test('the marker is read before the rebuild, so a write during one is not claimed', async () => {
  /* Stamping the marker taken *after* the build would say the entities include
     a sync that landed while they were being built. The next probe would then
     see no change and the write would stay invisible until the one after. */
  const time = clock();
  const p = probe('3:99:');
  const t = freshness.tracker({ markerFor: p.markerFor, ttl: 15_000, now: time.now });

  const marker = await t.marker('parakkat');   // read first
  p.state.marker = '4:120:';                   // a sync lands mid-build
  t.record('parakkat', marker);

  time.advance(20_000);
  assert.equal(await t.moved('parakkat'), true, 'a write during the rebuild was swallowed');
});

test('with no marker to ask for — the file store — nothing is probed', async () => {
  const t = freshness.tracker({ markerFor: null, ttl: 15_000 });
  assert.equal(await t.moved('parakkat'), false);
  assert.equal(await t.marker('parakkat'), null);
});
