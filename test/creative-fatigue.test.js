/* Creative fatigue.
 *
 * A score like this is dangerous in a specific way: it looks authoritative, so
 * the failures worth testing are the ones that produce a *confident wrong
 * answer* — a green band on a creative nobody measured, an infinite rise from a
 * zero baseline, a frequency that grows with the length of the window.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fatigue = require('../lib/creative-fatigue');

/* Thirty days of a creative that is doing fine. */
const steady = (overrides = {}) => Array.from({ length: 30 }, (_, i) => ({
  date: `2026-07-${String(i + 1).padStart(2, '0')}`,
  impressions: 10000, clicks: 120, frequency: 1.6, cpm: 200, spend: 1000,
  ...overrides,
}));

/* Recent days worse than the baseline. */
function declining({ clicks = 60, frequency = 3.4, cpm = 260 } = {}) {
  return steady().map((d, i) => (i >= 23 ? { ...d, clicks, frequency, cpm } : d));
}

test('a steady creative scores healthy', () => {
  const worn = fatigue.score(steady());
  assert.equal(worn.band, 'healthy');
  assert.equal(worn.score, 0);
});

test('frequency, falling clicks and rising cost together score as replace', () => {
  const worn = fatigue.score(declining());
  assert.equal(worn.band, 'replace');
  assert.ok(worn.score >= 70, `scored ${worn.score}`);
});

/* One extreme reading must not carry the score alone — the guidance calls a
   creative fatigued when several signals agree. */
test('one signal alone does not reach replace', () => {
  const onlyFrequency = fatigue.score(steady().map((d, i) => (i >= 23 ? { ...d, frequency: 5 } : d)));
  assert.ok(onlyFrequency.score < 70, `frequency alone scored ${onlyFrequency.score}`);
  assert.notEqual(onlyFrequency.band, 'healthy', 'but it is not healthy either');
});

/* The whole point of the column. */
test('too little history is unknown, never healthy', () => {
  assert.equal(fatigue.score(steady().slice(0, 10)), null);
  assert.equal(fatigue.score([]), null);
  assert.equal(fatigue.score(), null);
});

/* A creative with forty impressions did not have its CTR collapse. */
test('days too small to mean anything are excluded', () => {
  const noise = steady({ impressions: 40, clicks: 0 });
  assert.equal(fatigue.score(noise), null, 'a whole window of noise says nothing');
});

/* The bug every naive version of this has. */
test('a zero baseline is not an infinite change', () => {
  const fromNothing = steady().map((d, i) => (i < 23 ? { ...d, clicks: 0 } : d));
  const worn = fatigue.score(fromNothing);
  assert.ok(worn, 'still scores');
  assert.equal(worn.ctrChange, null, 'no baseline to compare against is unknown, not infinite');
});

/* Meta's frequency is already a ratio per day. Summing it would grow with the
   window and mean nothing. */
test('frequency is averaged over the recent days, not summed', () => {
  const worn = fatigue.score(steady().map((d, i) => (i >= 23 ? { ...d, frequency: 3 } : d)));
  assert.equal(Math.round(worn.frequency * 10) / 10, 3, 'seven days at 3 is a frequency of 3, not 21');
});

test('a creative is compared against itself, not an account average', () => {
  /* A retargeting ad that has always run at frequency 4 with steady clicks is
     not fatiguing — it is retargeting. */
  const alwaysHigh = steady({ frequency: 4.2 });
  const worn = fatigue.score(alwaysHigh);
  assert.equal(worn.ctrChange, 0, 'nothing about its clicks changed');
  assert.equal(worn.cpmChange, 0);
});

test('the score explains itself', () => {
  const worn = fatigue.score(declining());
  assert.ok(worn.reasons.length >= 2, 'a score with no reason is a number to distrust');
  assert.ok(worn.reasons.some((r) => /click-through down/.test(r)));
});

test('the score is bounded', () => {
  const awful = fatigue.score(declining({ clicks: 1, frequency: 12, cpm: 900 }));
  assert.ok(awful.score <= 100);
  assert.equal(awful.band, 'replace');
});

/* ── hook and hold ──────────────────────────────────────────────────────── */

test('hook is plays over impressions, hold is completions over plays', () => {
  const c = { impressions: 10000, videoPlays: 3000, videoCompletions: 300 };
  assert.equal(fatigue.hookRate(c), 0.3);
  assert.equal(fatigue.holdRate(c), 0.1);
});

/* An image ad did not fail to hold attention — it has no video to hold it. */
test('an image ad reports neither rate rather than zero', () => {
  const image = { impressions: 10000, videoPlays: null, videoCompletions: null };
  assert.equal(fatigue.hookRate(image), null);
  assert.equal(fatigue.holdRate(image), null);
});

test('a video nobody played holds nothing, which is unknown not zero', () => {
  assert.equal(fatigue.holdRate({ videoPlays: 0, videoCompletions: 0 }), null);
});

/* ── the thresholds are declared, not hidden ────────────────────────────── */

test('the published thresholds are what the code uses', () => {
  assert.equal(fatigue.THRESHOLDS.frequency.replace, 4.0);
  assert.equal(fatigue.THRESHOLDS.ctrDrop.confirmed, 0.20);
  assert.equal(fatigue.THRESHOLDS.cpmRise.warn, 0.18);
});
