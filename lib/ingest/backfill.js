/* Planning a backfill walk.
 *
 * A wide window cannot be asked for in one request. TeleCRM caps a page at 100
 * rows and this workspace creates ~260 leads a day, so a year is thousands of
 * sequential round trips against a 60-second function ceiling — two attempts at
 * `days=365` simply timed out. So the walk goes backwards a chunk at a time,
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

/* How wide a chunk is, and why it CANNOT be one number.
 *
 * The chunk is the unit of work a press cannot interrupt, so its width decides
 * whether the invocation budget can be scheduled around or has to be gambled.
 * Both sources punish getting it wrong and they punish it in OPPOSITE
 * directions, which is what a single constant cannot express:
 *
 *   TeleCRM   caps a page at 100 rows against ~260 leads a day, so width costs
 *             sequential round trips INSIDE one chunk. A seven-day chunk was
 *             ~18 of them, measured at 40-60s, and put the invocation on the
 *             platform's 60s ceiling — FUNCTION_INVOCATION_TIMEOUT, no
 *             redirect, no cursor, and the walk lost its position. It needs
 *             chunks narrow enough to finish.
 *
 *   Meta      has no page problem and a REQUEST-COUNT problem: six kinds, and
 *             an account-level limit that answers `code 17 — User request limit
 *             reached`. Narrow chunks are strictly worse for it, because the
 *             same year costs proportionally more calls. Cutting to three days
 *             for TeleCRM's sake is what rate-limited Meta within one walk.
 *
 * So narrowing is a fix for one and the cause of failure for the other. The
 * default stays narrow because a timeout loses the cursor and a rate limit only
 * costs a retry — the safe direction when a source is not listed. */
const CHUNK_DAYS_BY_SOURCE = {
  telecrm: 3,
  meta_ads: 21,
  google_ads: 21,
  google_analytics: 21,
};

const DEFAULT_CHUNK_DAYS = 3;

const chunkDays = (source) => CHUNK_DAYS_BY_SOURCE[source] || DEFAULT_CHUNK_DAYS;
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

/* One chunk's window, clamped so the last one does not overshoot the floor.
   Its width depends on the source — see CHUNK_DAYS_BY_SOURCE. */
function chunk(cursor, floor, source = null) {
  return {
    from: new Date(Math.max(cursor - chunkDays(source) * DAY_MS, floor)).toISOString(),
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

function stepsLeft(cursor, floor, source = null) {
  return Math.max(0, Math.ceil((cursor - floor) / (chunkDays(source) * DAY_MS)));
}

const done = (cursor, floor) => cursor <= floor;

module.exports = {
  plan, chunk, daysLeft, stepsLeft, done, chunkDays,
  CHUNK_DAYS_BY_SOURCE, DEFAULT_CHUNK_DAYS, MAX_DAYS, DEFAULT_DAYS,
};
