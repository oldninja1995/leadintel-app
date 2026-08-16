/* The backfill walk, and the one property it has to have.
 *
 *   node --test        or        npm test
 *
 * The bug this pins was live and invisible to every existing test, because
 * every one of them exercised a SINGLE press. The floor was measured from
 * wherever the press resumed, so each one moved the finish line back by the
 * full ask — the walk advanced two weeks and the target retreated two weeks
 * with it. In production the log read
 *
 *   back to 2026-07-05 — 31 week(s) left
 *   back to 2026-06-21 — 32 week(s) left
 *
 * progress and remaining work rising together. `done` was unreachable however
 * many times anybody pressed the button, and the failure looked exactly like a
 * slow API rather than like arithmetic.
 *
 * So the tests here are about the SEQUENCE, not the step.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const backfill = require('../lib/ingest/backfill');

const DAY = 86400000;
const NOW = Date.parse('2026-08-16T12:00:00.000Z');

/* One press: walk `chunks` chunks from where the last press stopped, the way
   the route does, and hand back what it would put in the redirect. */
function press(before, days, chunks = 3, now = NOW) {
  const { floor } = backfill.plan({ before, days, now });
  let cursor = backfill.plan({ before, days, now }).cursor;
  for (let i = 0; i < chunks && !backfill.done(cursor, floor); i += 1) {
    cursor = Date.parse(backfill.chunk(cursor, floor, 'telecrm').from);
  }
  return {
    before: new Date(cursor).toISOString(),
    stepsLeft: backfill.stepsLeft(cursor, floor, 'telecrm'), daysLeft: backfill.daysLeft(cursor, floor),
    done: backfill.done(cursor, floor),
  };
}

/* ── the property ───────────────────────────────────────────────────────── */

test('repeated presses converge — the walk finishes', () => {
  let state = { before: null, stepsLeft: Infinity, daysLeft: Infinity, done: false };
  let presses = 0;

  while (!state.done) {
    state = press(state.before, 365);
    presses += 1;
    assert.ok(presses < 100, 'the walk never finished — the floor is moving again');
  }

  assert.ok(presses > 1, 'a year cannot fit in one press; this test would prove nothing');
});

test('the work remaining never increases between presses', () => {
  /* The exact shape of the production bug: it went 31 → 31 → 32 → 32. */
  let state = press(null, 365);
  let guard = 0;

  while (!state.done && guard < 200) {
    const next = press(state.before, 365);
    assert.ok(
      next.daysLeft <= state.daysLeft,
      `days left rose from ${state.daysLeft} to ${next.daysLeft} after walking back to ${next.before}`,
    );
    assert.ok(next.stepsLeft <= state.stepsLeft);
    state = next;
    guard += 1;
  }
  assert.equal(state.done, true, 'the walk did not converge inside the guard');
});

test('the floor is anchored to now, not to where the press resumed', () => {
  const fresh = backfill.plan({ before: null, days: 365, now: NOW });
  const resumed = backfill.plan({ before: '2026-05-24T00:00:00.000Z', days: 365, now: NOW });

  assert.equal(resumed.floor, fresh.floor, 'a resumed press must aim at the same date as the first');
  assert.equal(fresh.floor, NOW - 365 * DAY);
});

/* ── the step ───────────────────────────────────────────────────────────── */

test('a press resumes where the last one stopped rather than starting over', () => {
  const resumed = backfill.plan({ before: '2026-06-07T00:00:00.000Z', days: 365, now: NOW });
  assert.equal(resumed.cursor, Date.parse('2026-06-07T00:00:00.000Z'));
});

test('the last chunk stops at the floor instead of overshooting it', () => {
  const floor = NOW - 10 * DAY;
  const cursor = NOW - 9 * DAY;
  /* One day short of the floor, with a multi-day chunk: it must clamp, or the
     walk fetches history nobody asked for and the store pays for it. */
  assert.equal(backfill.chunk(cursor, floor, 'telecrm').from, new Date(floor).toISOString());
});

test('a chunk runs backwards — from is older than to', () => {
  const { from, to } = backfill.chunk(NOW, NOW - 365 * DAY, 'telecrm');
  assert.ok(Date.parse(from) < Date.parse(to));
  assert.equal(Date.parse(to) - Date.parse(from), backfill.chunkDays('telecrm') * DAY);
});

/* ── the chunk width is per source, and must be ─────────────────────────── */

test('Meta walks in wider chunks than TeleCRM', () => {
  /* They fail in opposite directions: TeleCRM times out INSIDE a wide chunk
     because of its 100-row page cap, Meta rate-limits ACROSS narrow ones
     because six kinds times many chunks is too many calls. Cutting the width
     to three days for TeleCRM's sake is what produced Meta's `code 17 — User
     request limit reached` inside a single walk. */
  assert.ok(backfill.chunkDays('meta_ads') > backfill.chunkDays('telecrm'));
});

test('an unlisted source gets the narrow default', () => {
  /* A timeout loses the cursor; a rate limit costs a retry. Narrow is the safe
     side of an unknown source. */
  assert.equal(backfill.chunkDays('pms'), backfill.DEFAULT_CHUNK_DAYS);
  assert.equal(backfill.chunkDays(null), backfill.DEFAULT_CHUNK_DAYS);
  assert.equal(backfill.DEFAULT_CHUNK_DAYS, backfill.chunkDays('telecrm'));
});

test('a wider chunk means fewer steps for the same year', () => {
  const floor = NOW - 365 * DAY;
  assert.ok(backfill.stepsLeft(NOW, floor, 'meta_ads') < backfill.stepsLeft(NOW, floor, 'telecrm'));
  /* Days remaining is the same fact either way — it is history, not steps. */
  assert.equal(backfill.daysLeft(NOW, floor), 365);
});

test('an absent cursor means start at now', () => {
  assert.equal(backfill.plan({ before: null, days: 365, now: NOW }).cursor, NOW);
  assert.equal(backfill.plan({ before: 'not a date', days: 365, now: NOW }).cursor, NOW);
});

/* ── what may be asked for ──────────────────────────────────────────────── */

test('the ask is bounded and defaulted', () => {
  assert.equal(backfill.plan({ days: null, now: NOW }).asked, backfill.DEFAULT_DAYS);
  assert.equal(backfill.plan({ days: 9999, now: NOW }).asked, backfill.MAX_DAYS);
  assert.equal(backfill.plan({ days: '90', now: NOW }).asked, 90);
});

test('a walk already past its floor is done, not negative', () => {
  const floor = NOW - 30 * DAY;
  const cursor = NOW - 400 * DAY;
  assert.equal(backfill.done(cursor, floor), true);
  assert.equal(backfill.stepsLeft(cursor, floor, 'telecrm'), 0);
  assert.equal(backfill.daysLeft(cursor, floor), 0);
});
