/* Phase 4 sub-phase 4.5 — sync runner, cadence & lag, against its exit criteria.
 *
 *   node --test        or        npm test
 *
 * The clock is injected everywhere below, so nothing here waits on real time —
 * except the one test that drives the tick loop, which mocks setInterval and
 * then yields for the asynchronous work the tick starts.
 *
 * The run log and the raw store both write to disk, so every test gets its own
 * temporary root. A test that wrote to `var/runs.jsonl` would leave the app
 * believing it had synced.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sources = require('../lib/ingest/sources');
const { RawStore } = require('../lib/ingest/raw-store');
const { fixtureTransport } = require('../lib/ingest/transport');
const { SyncRunner, RunLog, LAGGING_AT, DOWN_AT } = require('../lib/ingest/runner');

const T0 = '2026-08-04T09:00:00.000Z';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-run-'));

/* A runner whose clock is a variable. `tick(seconds)` moves it forward; nothing
   moves it on its own, so every assertion below is about a stated moment. */
function harness({ transport = fixtureTransport(), from = T0 } = {}) {
  const root = tmpDir();
  let now = new Date(from);
  const runner = new SyncRunner({
    store: new RawStore(path.join(root, 'raw')),
    log: new RunLog(path.join(root, 'runs.jsonl')),
    transport,
    clock: () => now,
  });
  return { runner, tick: (seconds) => { now = new Date(now.getTime() + seconds * 1000); } };
}

/* A transport that fails for the named sources and behaves for the rest —
   which is the case that matters, since one source being down is ordinary. */
function breaking(ids, inner = fixtureTransport()) {
  return {
    name: 'breaking',
    async fetch(request) {
      if (ids.includes(request.source.id)) throw new Error(`${request.source.id} is unreachable`);
      return inner.fetch(request);
    },
  };
}

/* ── Cadence ────────────────────────────────────────────────────────────── */

test('every source is due before it has ever synced', () => {
  const { runner } = harness();
  assert.deepEqual(runner.due().map((s) => s.id).sort(), sources.list().map((s) => s.id).sort());
});

test('a source is not due again until its own cadence has elapsed', async () => {
  const { runner, tick } = harness();
  await runner.runOne('meta_ads');

  const due = () => runner.due().some((s) => s.id === 'meta_ads');
  assert.equal(due(), false, 'due again immediately after a successful sync');

  tick(sources.get('meta_ads').cadence.every - 1);
  assert.equal(due(), false, 'due a second early');

  tick(1);
  assert.equal(due(), true, 'not due once the cadence had elapsed');
});

test('each source syncs on its own stated cadence, not a shared one', async () => {
  const { runner, tick } = harness();
  await runner.runDue();
  assert.deepEqual(runner.due(), [], 'something was still due after a full run');

  /* 300s is a whole cadence for the two streaming sources and a third of one
     for the pollers. */
  tick(300);
  assert.deepEqual(
    runner.due().map((s) => s.id).sort(),
    sources.list().filter((s) => s.cadence.every <= 300).map((s) => s.id).sort()
  );
});

test('a full run reaches every source', async () => {
  const { runner } = harness();
  const runs = await runner.runDue();
  assert.equal(runs.length, sources.list().length);
  assert.ok(runs.every((r) => r.ok), 'a source failed against the fixtures');
  assert.ok(runs.every((r) => r.written > 0), 'a source pulled nothing');
});

/* ── Run records ────────────────────────────────────────────────────────── */

test('a failed sync is recorded rather than thrown, and does not stop the others', async () => {
  const { runner } = harness({ transport: breaking(['pms']) });
  const runs = await runner.runDue();

  assert.equal(runs.length, sources.list().length, 'one failure cut the run short');
  const failed = runs.filter((r) => !r.ok);
  assert.deepEqual(failed.map((r) => r.source), ['pms']);
  assert.match(failed[0].error, /pms is unreachable/);
  assert.equal(failed[0].written, 0);
});

test('every attempt is recorded, successes and failures alike', async () => {
  const { runner, tick } = harness({ transport: breaking(['pms']) });
  await runner.runOne('pms');
  tick(sources.get('pms').cadence.every);
  await runner.runOne('pms');

  const attempts = runner.log.recent('pms');
  assert.equal(attempts.length, 2, 'a failed attempt left no record');
  assert.ok(attempts.every((r) => r.startedAt && r.finishedAt), 'an attempt has no timing');
});

test('a failure does not count as a sync', async () => {
  const { runner } = harness({ transport: breaking(['pms']) });
  await runner.runOne('pms');

  assert.equal(runner.log.lastSuccess('pms'), null);
  assert.equal(runner.lag('pms'), null, 'a failed attempt was read as a successful one');
  assert.ok(runner.due().some((s) => s.id === 'pms'), 'a failed source stopped being due');
});

/* ── Lag ────────────────────────────────────────────────────────────────── */

test('never having synced is not zero lag', async () => {
  const { runner } = harness();
  assert.equal(runner.lag('pms'), null);
  assert.equal(runner.health('pms'), 'never-synced');

  await runner.runOne('pms');
  assert.equal(runner.lag('pms'), 0, 'a fresh sync did not read as current');
  assert.equal(runner.health('pms'), 'ok');
});

test('lag is seconds since the last success, and a later failure does not reset it', async () => {
  const { runner, tick } = harness({ transport: breaking([]) });
  await runner.runOne('pms');

  tick(120);
  assert.equal(runner.lag('pms'), 120);

  runner.transport = breaking(['pms']);
  await runner.runOne('pms');
  tick(60);
  assert.equal(runner.lag('pms'), 180, 'a failed attempt was treated as a successful sync');
});

test('health degrades at multiples of the source\'s own cadence', async () => {
  const { runner, tick } = harness();
  const every = sources.get('meta_ads').cadence.every;
  await runner.runOne('meta_ads');

  tick(every * LAGGING_AT);
  assert.equal(runner.health('meta_ads'), 'ok', 'degraded at exactly the threshold');

  tick(1);
  assert.equal(runner.health('meta_ads'), 'lagging');

  tick(every * (DOWN_AT - LAGGING_AT));
  assert.equal(runner.health('meta_ads'), 'down');
});

test('the same silence is not the same health for two different cadences', async () => {
  const { runner, tick } = harness();
  await runner.runDue();
  tick(1000);

  /* Sixteen minutes of quiet from a 15-minute poll is normal; from a source
     that streams it is not. */
  assert.equal(runner.health('meta_ads'), 'ok');
  assert.equal(runner.health('telecrm'), 'lagging');
});

/* ── Status ─────────────────────────────────────────────────────────────── */

test('status exposes lag and health for every source', async () => {
  const { runner } = harness();
  const status = runner.status();

  assert.deepEqual(status.map((s) => s.source).sort(), sources.list().map((s) => s.id).sort());
  assert.ok(status.every((s) => s.lagSeconds === null && s.health === 'never-synced' && s.due));

  await runner.runDue();
  assert.ok(runner.status().every((s) => s.health === 'ok' && s.lagSeconds === 0 && !s.due));
});

test('status carries the last error and the failure count', async () => {
  const { runner, tick } = harness({ transport: breaking(['razorpay']) });
  await runner.runDue();
  tick(sources.get('razorpay').cadence.every);
  await runner.runDue();

  const razorpay = runner.status().find((s) => s.source === 'razorpay');
  assert.equal(razorpay.recentFailures, 2);
  assert.match(razorpay.lastError, /razorpay is unreachable/);
  assert.equal(razorpay.lastSuccessAt, null);
  assert.equal(razorpay.health, 'never-synced');

  const pms = runner.status().find((s) => s.source === 'pms');
  assert.equal(pms.recentFailures, 0);
  assert.equal(pms.lastError, null);
});

/* ── The loop ───────────────────────────────────────────────────────────── */

test('the loop syncs what is due when it ticks', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { runner } = harness();
  t.after(() => runner.stop());

  runner.start({ tickSeconds: 60 });
  assert.equal(runner.log.all().length, 0, 'starting the loop synced before its first tick');

  t.mock.timers.tick(60_000);
  /* The tick starts the work; it does not finish it. setTimeout is not mocked. */
  for (let i = 0; i < 100 && runner.log.all().length < sources.list().length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(runner.log.all().length, sources.list().length, 'a tick did not reach every due source');
  assert.ok(runner.log.all().every((r) => r.ok));
});

test('starting a running loop does not schedule a second one', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { runner } = harness();
  t.after(() => runner.stop());

  const timer = runner.start().timer;
  assert.equal(runner.start().timer, timer, 'a second loop was scheduled over the first');

  runner.stop();
  assert.equal(runner.timer, null);
  assert.equal(runner.stop().timer, null, 'stopping an idle loop threw or resurrected it');
});

/* ── Partial failures ───────────────────────────────────────────────────────
 *
 * `connectors.pull` drops a failing kind and keeps the rest, so one refused
 * edge cannot cost an account its spend. That isolation was silent: the
 * failures were attached to the returned array and nothing ever read them, so
 * a source whose `creative` kind failed on **every** sync reported
 * `health: ok`, `recentFailures: 0`, `lastError: null` — indistinguishable
 * from a source with nothing wrong. On production that ran for days: the
 * creative rows were never refreshed, their signed image URLs expired, and all
 * 42 thumbnails served 502 while the status page stayed green.
 */

/* Fails one kind of one source and behaves for everything else. */
function failingKind(kind, ids = ['meta_ads'], inner = fixtureTransport()) {
  return {
    name: 'partial',
    async fetch(request) {
      if (ids.includes(request.source.id) && request.kind === kind) {
        throw new Error(`${kind} refused`);
      }
      return inner.fetch(request);
    },
  };
}

test('a kind that fails while others succeed is recorded rather than swallowed', async () => {
  const { runner } = harness({ transport: failingKind('creative') });
  const run = await runner.runOne('meta_ads');

  /* Still a success: the source fed, and marking it down is the bug the
     isolation exists to prevent. */
  assert.equal(run.ok, true);
  assert.deepEqual(run.partialFailures.map((f) => f.kind), ['creative']);
  assert.match(run.partialFailures[0].reason, /refused/);
});

test('a half-failing source stops reporting as unqualified green', async () => {
  const { runner } = harness({ transport: failingKind('creative') });
  await runner.runOne('meta_ads');

  const meta = runner.status().find((s) => s.source === 'meta_ads');
  assert.deepEqual(meta.partialFailures.map((f) => f.kind), ['creative']);
  /* and is still not down — both halves matter */
  assert.equal(meta.health, 'ok');
  assert.equal(meta.recentFailures, 0);
  assert.equal(meta.lastError, null);
});

test('a clean run reports no partial failures and adds no field to the log', async () => {
  const { runner } = harness();
  const run = await runner.runOne('meta_ads');

  assert.equal('partialFailures' in run, false, 'a clean run should not carry the field');
  assert.deepEqual(runner.status().find((s) => s.source === 'meta_ads').partialFailures, []);
});

test('partial failures are read from the latest run, not the latest good one', async () => {
  /* A source that failed partially and has since started failing wholesale
     must not still be advertising the older run's partial state. */
  const root = tmpDir();
  let now = new Date(T0);
  const log = new RunLog(path.join(root, 'runs.jsonl'));
  const runner = new SyncRunner({
    store: new RawStore(path.join(root, 'raw')),
    log,
    transport: failingKind('creative'),
    clock: () => now,
  });

  await runner.runOne('meta_ads');
  assert.equal(runner.status().find((s) => s.source === 'meta_ads').partialFailures.length, 1);

  runner.transport = breaking(['meta_ads']);
  runner.transportFor = () => runner.transport;
  now = new Date(now.getTime() + 1000);
  await runner.runOne('meta_ads');

  const meta = runner.status().find((s) => s.source === 'meta_ads');
  assert.deepEqual(meta.partialFailures, [], 'the older run’s partial state outlived it');
  assert.ok(meta.lastError, 'a wholesale failure should still be reported');
});

/* ── The scheduler's interval, and a fair queue ─────────────────────────── */

/* A runner told how often it is actually invoked. Everything above leaves this
   unset, which is what a process owning its own timer looks like. */
function scheduled(every, { from = T0 } = {}) {
  const root = tmpDir();
  let now = new Date(from);
  const runner = new SyncRunner({
    store: new RawStore(path.join(root, 'raw')),
    log: new RunLog(path.join(root, 'runs.jsonl')),
    transport: fixtureTransport(),
    clock: () => now,
    scheduledEvery: every,
  });
  return { runner, tick: (seconds) => { now = new Date(now.getTime() + seconds * 1000); } };
}

test('a source is not down for missing a cadence the scheduler cannot offer', async () => {
  /* Meta polls every 15 minutes and Vercel Hobby runs one cron a day. Seven
     hours after a perfect sync the card read "not syncing"; the sync was fine
     and the schedule was the constraint. */
  const daily = 86400;
  const { runner, tick } = scheduled(daily);
  await runner.runOne('meta_ads');
  tick(7 * 3600);

  assert.equal(runner.health('meta_ads'), 'ok', 'a source was called unhealthy for its scheduler’s pace');
  assert.equal(runner.intervalFor('meta_ads'), daily);
});

test('the scheduler loosens health but never tightens a slow cadence', async () => {
  /* A scheduler faster than the cadence must not make a source *more* urgent
     than it asked to be — a 15-minute source polled every minute is not
     lagging fourteen minutes later. */
  const { runner, tick } = scheduled(60);
  await runner.runOne('meta_ads');
  tick(14 * 60);

  assert.equal(runner.intervalFor('meta_ads'), sources.get('meta_ads').cadence.every);
  assert.equal(runner.health('meta_ads'), 'ok');
});

test('a genuinely stopped source still goes down under a slow schedule', async () => {
  /* The forgiveness is bounded. Loosening this into "never red" would trade
     one false alarm for a silent failure, which is the worse of the two. */
  const daily = 86400;
  const { runner, tick } = scheduled(daily);
  await runner.runOne('meta_ads');
  tick(daily * DOWN_AT + 1);

  assert.equal(runner.health('meta_ads'), 'down');
});

test('health is judged as it always was when no schedule is declared', async () => {
  const { runner, tick } = harness();
  await runner.runOne('meta_ads');
  tick(sources.get('meta_ads').cadence.every * DOWN_AT + 1);

  assert.equal(runner.health('meta_ads'), 'down', 'the default behaviour moved');
});

test('status reports what health was measured against', async () => {
  const { runner } = scheduled(86400);
  await runner.runOne('meta_ads');
  const meta = runner.status().find((s) => s.source === 'meta_ads');

  assert.equal(meta.judgedEvery, 86400);
  assert.equal(meta.judgedAgainst, 'schedule', 'a loosened threshold did not say so');
  assert.equal(meta.cadence.every, 900, 'the declared cadence was overwritten rather than reported beside it');
});

test('the due queue puts the most starved source first', async () => {
  /* The bug this exists to prevent: a caller that takes only the head of the
     queue synced `meta_ads` every single tick and never reached the other ten,
     because list order put it first and everything was always due. */
  const { runner, tick } = harness();
  await runner.runOne('meta_ads');
  tick(60);
  await runner.runOne('google_ads');
  tick(sources.get('meta_ads').cadence.every + 1);

  const order = runner.due().map((s) => s.id);
  assert.equal(order[order.length - 1], 'google_ads', 'the most recently synced source was not last');
  assert.ok(order.indexOf('meta_ads') < order.indexOf('google_ads'), 'the staler of two sources did not sort first');
});

test('a source that has never synced sorts ahead of one that is merely stale', async () => {
  const { runner, tick } = harness();
  await runner.runOne('meta_ads');
  tick(sources.get('meta_ads').cadence.every * 100);

  const order = runner.due().map((s) => s.id);
  assert.notEqual(order[0], 'meta_ads', 'a synced source outranked ten that never have');
  assert.equal(runner.lag(order[0]), null);
});

test('taking one source per tick eventually reaches every source', async () => {
  /* What the daily cron does, eleven times over. Before the sort this loop
     synced meta_ads eleven times and nothing else once. */
  const { runner, tick } = harness();
  const seen = new Set();
  for (let i = 0; i < sources.list().length; i += 1) {
    const [next] = runner.due();
    await runner.runOne(next.id);
    seen.add(next.id);
    tick(86400);
  }
  assert.equal(seen.size, sources.list().length, 'the round robin starved a source');
});

test('a source failing every attempt is never ok, however slow the schedule', async () => {
  /* The hole a loosened threshold opens: nine sources fail on every run, their
     last success was a fixture replay a day old, and lag alone called them all
     healthy. Meta's false red must not be paid for with their false green. */
  const daily = 86400;
  const root = tmpDir();
  let now = new Date(T0);
  const runner = new SyncRunner({
    store: new RawStore(path.join(root, 'raw')),
    log: new RunLog(path.join(root, 'runs.jsonl')),
    transport: fixtureTransport(),
    clock: () => now,
    scheduledEvery: daily,
  });

  await runner.runOne('telecrm');
  assert.equal(runner.health('telecrm'), 'ok', 'a fresh successful sync was not ok');

  runner.transport = breaking(['telecrm']);
  runner.transportFor = () => runner.transport;
  now = new Date(now.getTime() + 3600 * 1000);
  await runner.runOne('telecrm');

  assert.notEqual(runner.health('telecrm'), 'ok', 'a source that just failed reported as healthy');
  assert.equal(runner.health('telecrm'), 'lagging');

  now = new Date(now.getTime() + daily * 1000);
  assert.equal(runner.health('telecrm'), 'down', 'a persistently failing source never went down');
});

test('a recovered source stops being unhealthy on its next success', async () => {
  const { runner, tick } = harness({ transport: breaking(['meta_ads']) });
  await runner.runOne('google_ads');
  tick(1);
  await runner.runOne('meta_ads');
  assert.equal(runner.health('meta_ads'), 'never-synced');

  runner.transport = fixtureTransport();
  runner.transportFor = () => runner.transport;
  tick(1);
  await runner.runOne('meta_ads');
  assert.equal(runner.health('meta_ads'), 'ok', 'a recovered source kept its failure');
});

test('a slow schedule does not stop a source being due', async () => {
  /* Due-ness is what a source wants; the schedule is what it gets. Judged
     against a daily interval, a cron arriving nineteen hours after a manual
     sync found nothing due, wasted the tick and let the source drift another
     full day. */
  const { runner, tick } = scheduled(86400);
  await runner.runOne('meta_ads');
  tick(sources.get('meta_ads').cadence.every + 1);

  assert.ok(runner.due().some((s) => s.id === 'meta_ads'), 'the schedule suppressed due-ness');
  assert.equal(runner.health('meta_ads'), 'ok', 'being due was confused with being unhealthy');
});
