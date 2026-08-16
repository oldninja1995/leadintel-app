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

/* Three days, not seven.
 *
 * The chunk is the unit of work a press cannot interrupt, so its size decides
 * whether the budget can be scheduled around or has to be gambled. At ~260
 * leads a day against TeleCRM's 100-row page cap, a seven-day chunk is around
 * eighteen sequential round trips — which measured at 40-60s and put the whole
 * invocation on the platform's 60s ceiling. It returned FUNCTION_INVOCATION_
 * TIMEOUT: no redirect, no cursor, no message, and the walk lost its position.
 *
 * Three days is roughly eight pages. A press now fits two or three of them
 * inside its budget instead of betting everything on one, so the rows fetched
 * per press are similar and the press always answers. Smaller would spend more
 * of each invocation on cold starts and connector setup than on rows. */
const CHUNK_DAYS = 3;
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
 * unbounded ask.
 *
 * Reported in DAYS OF HISTORY rather than in steps or presses. A step is an
 * implementation detail that changed the moment the chunk size did, and how
 * many steps fit in a press depends on how dense that stretch of history is —
 * so both are numbers the operator cannot act on. "Still 281 days short of the
 * 365 you asked for" is the same fact and answers the actual question. */
function daysLeft(cursor, floor) {
  return Math.max(0, Math.ceil((cursor - floor) / DAY_MS));
}

function stepsLeft(cursor, floor) {
  return Math.max(0, Math.ceil((cursor - floor) / (CHUNK_DAYS * DAY_MS)));
}

const done = (cursor, floor) => cursor <= floor;

module.exports = { plan, chunk, daysLeft, stepsLeft, done, CHUNK_DAYS, MAX_DAYS, DEFAULT_DAYS };
