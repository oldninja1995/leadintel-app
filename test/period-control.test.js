/* The date range control, which until now was decoration.
 *
 * `data/_shell.js` gave each chip a colour and the topbar rendered
 * `data-action=""`, so Today / 7d / 30d / 90d were four unclickable divs above
 * numbers computed over whatever the store held — under a highlighted "30d".
 * That is the worst version of the bug: the screen answered the question the
 * chip asks, wrongly, and nothing on it disagreed.
 *
 * Two things are tested here. The labels the chips need must resolve to real
 * windows, and a narrowed window must actually narrow the entities that both
 * the registry and the repository read — the same function, so the headline
 * and the table under it cannot disagree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const period = require('../lib/metrics/period');

const NOW = '2026-08-10T14:30:00.000Z';

/* ── the labels the chips name ──────────────────────────────────────────── */

test('every chip in the control resolves to a window', () => {
  for (const id of ['today', '7d', '30d', '90d']) {
    const window = period.fromLabel(id, NOW);
    assert.ok(window && window.from && window.to, `${id} should resolve`);
    assert.equal(window.label, id);
  }
});

/* Today is a calendar day, not the last 24 hours — a window that started at
   this time yesterday is not what the chip says. */
test('today starts at midnight UTC, not 24 hours ago', () => {
  const window = period.fromLabel('today', NOW);
  assert.equal(window.from, '2026-08-10T00:00:00.000Z');
  assert.equal(window.to, NOW);
});

test('the rolling windows are as long as they claim', () => {
  const days = (id) => (Date.parse(NOW) - Date.parse(period.fromLabel(id, NOW).from)) / 86400000;
  assert.equal(days('7d'), 7);
  assert.equal(days('30d'), 30);
  assert.equal(days('90d'), 90);
});

test('an unknown label throws rather than quietly selecting everything', () => {
  assert.throws(() => period.fromLabel('6d', NOW), /unknown period/);
});

test('every label is listed, so a caller can enumerate them', () => {
  for (const id of ['today', '7d', '30d', '90d']) assert.ok(period.LABELS.includes(id), `${id} missing from LABELS`);
});

/* ── narrowing, which is what makes the control do anything ─────────────── */

const entities = () => ({
  campaignDays: [
    { date: '2026-08-10', spend: 100 },
    { date: '2026-08-05', spend: 100 },
    { date: '2026-06-01', spend: 100 },
  ],
  /* Dated by the night stayed, which is the choice period.js exists to state. */
  bookings: [
    { checkIn: '2026-08-09', bookedAt: '2026-05-01' },
    { checkIn: '2026-05-02', bookedAt: '2026-08-09' },
  ],
  leads: [{ createdAt: '2026-08-10T09:00:00.000Z' }, { createdAt: '2026-01-01T09:00:00.000Z' }],
});

test('a window keeps only the rows inside it', () => {
  const week = period.within(entities(), period.fromLabel('7d', NOW));
  assert.equal(week.campaignDays.length, 2);
  assert.equal(week.leads.length, 1);
});

test('today keeps today alone', () => {
  const today = period.within(entities(), period.fromLabel('today', NOW));
  assert.deepEqual(today.campaignDays.map((d) => d.date), ['2026-08-10']);
});

test('a wider window keeps what a narrower one dropped', () => {
  const ninety = period.within(entities(), period.fromLabel('90d', NOW));
  assert.equal(ninety.campaignDays.length, 3);
});

/* The load-bearing one: a booking belongs to the night stayed, so a stay in
   May made yesterday is May's revenue however recently it was sold. */
test('a booking is narrowed by the night stayed, not the day it was booked', () => {
  const week = period.within(entities(), period.fromLabel('7d', NOW));
  assert.equal(week.bookings.length, 1);
  assert.equal(week.bookings[0].checkIn, '2026-08-09');
});

/* Collections with no declared date field are left whole rather than emptied —
   narrowing something whose date nobody has decided would be a guess. */
test('a collection with no date field is passed through untouched', () => {
  const source = { ...entities(), creatives: [{ id: 'cr-1' }, { id: 'cr-2' }] };
  const week = period.within(source, period.fromLabel('7d', NOW));
  assert.equal(week.creatives.length, 2);
});

test('no window at all leaves the entities exactly as they were', () => {
  const source = entities();
  assert.equal(period.within(source, null), source);
  assert.equal(period.within(source, { from: null, to: null }), source);
});
