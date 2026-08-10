/* How much history a scheduled sync asks for.
 *
 * The bug this pins: the runner passed no window, so every connector fell back
 * to its own cheap default — Meta's is `date_preset=last_30d`. Nothing was
 * wrong with that until the date-range chips started working, at which point
 * the store could not answer the longest period the UI offered and **"90 days"
 * quietly meant "everything we happen to hold"**. It read ₹11,930 above the
 * 30-day figure over sixty extra days, which is exactly the kind of plausible
 * wrong number that gets quoted in a meeting.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SyncRunner, RunLog } = require('../lib/ingest/runner');
const meta = require('../lib/ingest/http/meta-ads');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-window-'));

/* ── the runner resolves its window per run ─────────────────────────────── */

test('a window given as a function is resolved at run time, not at boot', async () => {
  const seen = [];
  const runner = new SyncRunner({
    store: { append: () => {}, read: () => [] },
    log: new RunLog(path.join(temp(), 'runs.jsonl')),
    window: (now) => ({ from: 'F', to: now.toISOString() }),
    transportFor: () => ({
      name: 'test',
      fetch: ({ window }) => { seen.push(window); return []; },
    }),
    clock: () => new Date('2026-08-10T09:00:00.000Z'),
  });

  await runner.runOne('meta_ads');
  assert.ok(seen.length, 'the transport should have been asked for something');
  assert.equal(seen[0].to, '2026-08-10T09:00:00.000Z');
});

/* The reason it must be a function: a process that stays up for weeks would
   otherwise keep asking for the weeks it booted in. */
test('two runs an hour apart ask for different windows', async () => {
  const seen = [];
  let now = new Date('2026-08-10T09:00:00.000Z');
  const runner = new SyncRunner({
    store: { append: () => {}, read: () => [] },
    log: new RunLog(path.join(temp(), 'runs.jsonl')),
    window: (at) => ({ from: 'F', to: at.toISOString() }),
    transportFor: () => ({ name: 'test', fetch: ({ window }) => { seen.push(window.to); return []; } }),
    clock: () => now,
  });

  /* One run asks per kind, so the two runs are separated rather than indexed —
     `seen[1]` was still the first run's second kind. */
  await runner.runOne('meta_ads');
  const first = [...seen];
  seen.length = 0;

  now = new Date('2026-08-10T10:00:00.000Z');
  await runner.runOne('meta_ads');

  assert.ok(first.length && seen.length, 'both runs should have asked for something');
  assert.ok(first.every((t) => t === '2026-08-10T09:00:00.000Z'), 'the first run should ask as of 09:00');
  assert.ok(seen.every((t) => t === '2026-08-10T10:00:00.000Z'), 'the second run should ask as of 10:00');
});

/* A plain object still works, so every existing caller is unaffected. */
test('a window given as an object is passed through unchanged', async () => {
  const seen = [];
  const runner = new SyncRunner({
    store: { append: () => {}, read: () => [] },
    log: new RunLog(path.join(temp(), 'runs.jsonl')),
    window: { from: 'A', to: 'B' },
    transportFor: () => ({ name: 'test', fetch: ({ window }) => { seen.push(window); return []; } }),
    clock: () => new Date('2026-08-10T09:00:00.000Z'),
  });

  await runner.runOne('meta_ads');
  assert.deepEqual(seen[0], { from: 'A', to: 'B' });
});

/* ── the window reaches Meta as a real range, not a preset ──────────────── */

test('a window makes the request carry time_range instead of a 30-day preset', () => {
  const { url } = meta.request({
    kind: 'campaign_day',
    window: { from: '2026-05-13T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' },
    credentials: { accountId: 'act_1', accessToken: 'EAAtest' },
  });
  assert.ok(url.includes('time_range'), 'the pull must state its own range');
  assert.ok(!url.includes('date_preset'), 'a stated range must not also send a preset');
});

/* The half-open/inclusive bridge, in the direction that actually bites: a `to`
   of the start of tomorrow must ask Meta for data through *today*, or today's
   spend never arrives and the "Today" chip reads ₹0 for ever. */
test('a window ending at the start of tomorrow includes today', () => {
  const range = meta.timeRange({ from: '2026-05-13T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' });
  assert.equal(range.until, '2026-08-10', 'until is inclusive, so it must name today');
  assert.equal(range.since, '2026-05-13');
});

/* And the trap it replaced: 90 calendar days, not 89 and not 91. */
test('the range spans the number of days it claims', () => {
  const range = meta.timeRange({ from: '2026-05-13T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' });
  const days = (Date.parse(range.until) - Date.parse(range.since)) / 86400000 + 1;
  assert.equal(days, 90);
});

/* Without a window the connector keeps its cheap default — that path is the
   connection test, and it must not turn into a 90-day pull. */
test('no window still falls back to the connector preset', () => {
  const { url } = meta.request({
    kind: 'campaign_day',
    window: null,
    credentials: { accountId: 'act_1', accessToken: 'EAAtest' },
  });
  assert.ok(url.includes('date_preset=last_30d'));
});
