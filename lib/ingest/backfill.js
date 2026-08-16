/* Planning a backfill walk.
 *
 * A wide window cannot be asked for in one request. TeleCRM caps a page at 100
 * rows and this workspace creates ~260 leads a day, so a year is thousands of
 * sequential round trips against a 60-second function ceiling — two attempts at
 * `days=365` simply timed out. So the walk goes backwards a week at a time,
 * stops when the invocation budget is nearly spent, and reports the date it
 * reached; pressing again resumes from there and the raw store deduplicates the
 * overlap, so a double press costs time and never correctness.
 *
 * The arithmetic lives here rather than inside the route because it has one
 * property worth stating and defending, and it was wrong in production:
 *
 *   **repeated presses must converge.**
 *
 * They did not. The floor was measured from wherever the press resumed, so each
 * one moved the finish line back by the full ask — the walk advanced two weeks
 * and the target retreated two weeks with it. The log read
 *
 *   back to 2026-07-05 — 31 week(s) left
 *   back to 2026-06-21 — 32 week(s) left
 *
 * progress and remaining work rising together, and `done` unreachable however
 * many times anybody clicked. "365 days" is a span of history ending now, so
 * now is the only thing it can be anchored to.
 */

const CHUNK_DAYS = 7;
const MAX_DAYS = 400;
const DEFAULT_DAYS = 365;
const DAY_MS = 86400000;

/* Where this press starts and where the whole walk ends.
 *
 * `before` is the cursor the previous press handed back; absent means start at
 * now. `now` is passed in rather than read, so a test can state the property
 * without a clock. */
function plan({ before = null, days = null, now = Date.now() } = {}) {
  const asked = Math.min(Number(days) || DEFAULT_DAYS, MAX_DAYS);
  const startAt = Date.parse(before);
  return {
    asked,
    cursor: Number.isFinite(startAt) ? startAt : now,
    /* Anchored to now, never to the cursor — see above. */
    floor: now - asked * DAY_MS,
  };
}

/* One chunk's window, clamped so the last one does not overshoot the floor. */
function chunk(cursor, floor) {
  return {
    from: new Date(Math.max(cursor - CHUNK_DAYS * DAY_MS, floor)).toISOString(),
    to: new Date(cursor).toISOString(),
  };
}

/* How much is left, because "press again to continue" without a number is an
   unbounded ask. A source with six kinds fits about one week into an invocation
   and a light one fits ten, so the count is the only honest way to say how long
   this is going to take. */
function weeksLeft(cursor, floor) {
  return Math.max(0, Math.ceil((cursor - floor) / (CHUNK_DAYS * DAY_MS)));
}

const done = (cursor, floor) => cursor <= floor;

module.exports = { plan, chunk, weeksLeft, done, CHUNK_DAYS, MAX_DAYS, DEFAULT_DAYS };
