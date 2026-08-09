/* Best Overall — the funnel-aware business score.
 *
 * The two cases the whole thing exists to get right, and which every change to
 * the weights has to keep passing:
 *
 *   1. A creative with a dearer lead but better downstream performance ranks
 *      above a cheap one. Cost per lead is vanity; interested leads, bookings
 *      and revenue are the business.
 *
 *   2. A top-of-funnel creative is not marked down for booking less than a
 *      retargeting ad. It was bought to be seen by people who have never heard
 *      of the resort, and judging it on conversion asks it to do a job that
 *      belongs to a different ad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const scoring = require('../lib/creative-score');
const goals = require('../lib/creative-goals');

/* A creative in the shape canonical produces, with a funnel stage already
   resolved onto it the way lib/repository/projections.js does. */
const creative = (id, stage, over = {}) => ({
  entity: 'creative',
  adId: id,
  title: id,
  spend: 100000,
  leads: 40,
  clicks: 1000,
  impressions: 100000,
  series: [],
  funnel: stage ? { stage, signal: 'targeting', because: 'test' } : null,
  ...over,
});

/* CRM and PMS rows, from which lib/creative-goals.js walks the closed loop. */
function world(spec) {
  const leads = [];
  const bookings = [];
  for (const [ad, s] of Object.entries(spec)) {
    for (let i = 0; i < s.leads; i += 1) {
      const id = `${ad}-L${i}`;
      leads.push({ id, adId: ad, stage: i < s.interested ? 'qualified' : 'new' });
      if (i < s.bookings) {
        bookings.push({ id: `${ad}-B${i}`, leadId: id, revenue: s.revenuePer, phone: `p${id}`, checkIn: '2026-07-01' });
      }
    }
  }
  return goals.context({ leads, bookings });
}

/* ── the case that matters most ─────────────────────────────────────────── */

test('a dearer lead with better downstream performance wins', () => {
  const ctx = world({
    A: { leads: 100, interested: 8, bookings: 1, revenuePer: 1800000 },
    B: { leads: 100, interested: 25, bookings: 5, revenuePer: 1620000 },
    C: { leads: 100, interested: 15, bookings: 3, revenuePer: 1250000 },
    D: { leads: 100, interested: 12, bookings: 2, revenuePer: 1600000 },
  });

  const rows = scoring.score([
    creative('A', 'Bottom', { spend: 1200000, leads: 100 }),
    creative('B', 'Bottom', { spend: 1800000, leads: 100 }),
    creative('C', 'Bottom', { spend: 1500000, leads: 100 }),
    creative('D', 'Bottom', { spend: 1600000, leads: 100 }),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r]));

  assert.ok(
    byId.B.score > byId.A.score,
    `B (₹180 CPL, 25% interested, 5% booking, 4.5x) must beat A (₹120 CPL, 8%, 1%, 1.5x) — got ${byId.B.score} vs ${byId.A.score}`,
  );
});

/* ── funnel awareness ───────────────────────────────────────────────────── */

test('each stage is scored on its own model', () => {
  assert.deepEqual(
    Object.keys(scoring.WEIGHTS_BY_STAGE).sort(),
    ['BOFU', 'MOFU', 'TOFU', 'UNKNOWN'],
  );

  /* The weights the brief specifies, asserted so a later edit cannot quietly
     change what the business values. */
  assert.equal(scoring.WEIGHTS_BY_STAGE.TOFU.ctr, 0.20);
  assert.equal(scoring.WEIGHTS_BY_STAGE.TOFU.hookRate + scoring.WEIGHTS_BY_STAGE.TOFU.holdRate, 0.30);
  assert.equal(scoring.WEIGHTS_BY_STAGE.MOFU.cpil, 0.30);
  assert.equal(scoring.WEIGHTS_BY_STAGE.BOFU.bookingRate, 0.30);
  assert.equal(scoring.WEIGHTS_BY_STAGE.BOFU.roas, 0.25);
});

test('every stage model is a complete weighting', () => {
  for (const [stage, set] of Object.entries(scoring.WEIGHTS_BY_STAGE)) {
    const total = Object.values(set).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${stage} sums to ${total}`);
  }
});

/* A cold prospecting video books at a fraction of a retargeting ad's rate. It
   is not a worse creative for that; it is a different job. */
test('a top-of-funnel creative is not marked down for booking less', () => {
  const ctx = world({
    T1: { leads: 60, interested: 6, bookings: 1, revenuePer: 200000 },
    T2: { leads: 60, interested: 3, bookings: 0, revenuePer: 0 },
    B1: { leads: 40, interested: 20, bookings: 8, revenuePer: 900000 },
    B2: { leads: 40, interested: 10, bookings: 4, revenuePer: 400000 },
  });

  const rows = scoring.score([
    creative('T1', 'Top', { spend: 600000, leads: 60, clicks: 4200, impressions: 900000, videoPlays: 850000, videoCompletions: 300000 }),
    creative('T2', 'Top', { spend: 600000, leads: 60, clicks: 1800, impressions: 900000, videoPlays: 400000, videoCompletions: 60000 }),
    creative('B1', 'Bottom', { spend: 900000, leads: 40, clicks: 1600, impressions: 200000 }),
    creative('B2', 'Bottom', { spend: 900000, leads: 40, clicks: 1500, impressions: 200000 }),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r]));

  assert.equal(byId.T1.stage, 'TOFU');
  assert.equal(byId.B1.stage, 'BOFU');
  assert.ok(byId.T1.score >= 60, `a strong TOFU creative must score well on its own terms — got ${byId.T1.score}`);
  assert.ok(byId.T1.score > byId.B2.score, 'a strong TOFU beats a weak BOFU');
});

/* Within a stage, the better performer wins outright. */
test('within a stage the stronger creative ranks above the weaker', () => {
  const ctx = world({
    B1: { leads: 50, interested: 25, bookings: 4, revenuePer: 1250000 },
    B2: { leads: 50, interested: 12, bookings: 2, revenuePer: 625000 },
    B3: { leads: 50, interested: 18, bookings: 3, revenuePer: 900000 },
  });

  const rows = scoring.score([
    creative('B1', 'Bottom', { leads: 50 }),
    creative('B2', 'Bottom', { leads: 50 }),
    creative('B3', 'Bottom', { leads: 50 }),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r]));
  assert.ok(byId.B1.score > byId.B2.score, '8% booking + 5x must beat 4% + 2.5x');
});

/* ── confidence ─────────────────────────────────────────────────────────── */

test('the tiers are the ones the business asked for', () => {
  assert.equal(scoring.tierFor(0).key, 'insufficient');
  assert.equal(scoring.tierFor(2).key, 'insufficient');
  assert.equal(scoring.tierFor(3).key, 'low');
  assert.equal(scoring.tierFor(9).key, 'low');
  assert.equal(scoring.tierFor(10).key, 'moderate');
  assert.equal(scoring.tierFor(29).key, 'moderate');
  assert.equal(scoring.tierFor(30).key, 'high');
});

/* The failure this guards: a creative with four leads and a freak cost per
   interested lead taking first place off a proven one. */
test('a tiny sample cannot take first place from a proven creative', () => {
  const ctx = world({
    PROVEN: { leads: 80, interested: 32, bookings: 8, revenuePer: 500000 },
    TINY: { leads: 4, interested: 4, bookings: 1, revenuePer: 900000 },
    C: { leads: 60, interested: 12, bookings: 3, revenuePer: 300000 },
    D: { leads: 50, interested: 8, bookings: 2, revenuePer: 250000 },
  });

  const rows = scoring.score([
    creative('PROVEN', 'Bottom', { spend: 800000, leads: 80 }),
    creative('TINY', 'Bottom', { spend: 30000, leads: 4 }),
    creative('C', 'Bottom', { spend: 600000, leads: 60 }),
    creative('D', 'Bottom', { spend: 500000, leads: 50 }),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r]));

  assert.equal(byId.TINY.confidence.key, 'low');
  assert.ok(byId.TINY.rawScore > byId.TINY.score, 'a thin sample is pulled toward its stage average');
  assert.ok(byId.TINY.score <= byId.PROVEN.score, 'and cannot outrank a proven creative on four leads');
});

/* Suppressing new creatives entirely would make them undiscoverable, which is
   the opposite failure. */
test('a promising new creative is still discoverable', () => {
  const ctx = world({
    NEW: { leads: 5, interested: 5, bookings: 2, revenuePer: 900000 },
    BAD: { leads: 80, interested: 2, bookings: 0, revenuePer: 0 },
    C: { leads: 60, interested: 6, bookings: 1, revenuePer: 200000 },
    D: { leads: 50, interested: 5, bookings: 1, revenuePer: 150000 },
  });

  const rows = scoring.score([
    creative('NEW', 'Bottom', { spend: 40000, leads: 5 }),
    creative('BAD', 'Bottom', { spend: 900000, leads: 80 }),
    creative('C', 'Bottom', { spend: 600000, leads: 60 }),
    creative('D', 'Bottom', { spend: 500000, leads: 50 }),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r]));
  assert.ok(byId.NEW.score > byId.BAD.score, 'a strong new creative must still beat a proven bad one');
});

/* ── missing data ───────────────────────────────────────────────────────── */

/* No CRM, no PMS: the score falls back to what the ad platform can answer, and
   says how much of the intended weight it managed. */
test('with no CRM the score is thinner and says so', () => {
  const rows = scoring.score([
    creative('X', 'Middle', { clicks: 3000 }),
    creative('Y', 'Middle', { clicks: 1000 }),
  ], goals.context({}));

  for (const row of rows) {
    assert.ok(row.score !== null, 'a creative with no CRM is still scored on what is known');
    assert.ok(row.covered < 1, 'and the shortfall is recorded');
    assert.equal(row.metrics.cpil, null, 'never invented');
    assert.equal(row.metrics.roas, null);
    assert.equal(row.metrics.bookingRate, null);
  }
});

test('no metric is ever NaN or Infinity', () => {
  const rows = scoring.score([
    creative('Z', 'Bottom', { spend: 0, leads: 0, clicks: 0, impressions: 0 }),
    creative('W', null, { spend: null, leads: null, clicks: null, impressions: null }),
  ], goals.context({}));

  for (const row of rows) {
    for (const [key, value] of Object.entries(row.metrics)) {
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `${key} is ${value}`);
      }
    }
    assert.ok(row.score === null || Number.isFinite(row.score));
  }
});

test('a creative with leads but none interested is scored at the floor, not excused', () => {
  const ctx = world({
    NONE: { leads: 40, interested: 0, bookings: 0, revenuePer: 0 },
    OK: { leads: 40, interested: 20, bookings: 4, revenuePer: 500000 },
    C: { leads: 40, interested: 10, bookings: 2, revenuePer: 250000 },
  });

  const rows = scoring.score([
    creative('NONE', 'Middle', { leads: 40 }),
    creative('OK', 'Middle', { leads: 40 }),
    creative('C', 'Middle', { leads: 40 }),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r]));
  assert.ok(byId.NONE.score < byId.OK.score, 'interesting nobody is a result, not a missing measurement');
});

/* ── robustness ─────────────────────────────────────────────────────────── */

/* Plain min-max scaling would let one creative at ten times the account rate
   compress everything else into a couple of points. */
test('one extreme outlier does not flatten the ranking', () => {
  const spec = { OUT: { leads: 40, interested: 1, bookings: 0, revenuePer: 0 } };
  for (const id of ['A', 'B', 'C', 'D']) {
    spec[id] = { leads: 40, interested: 20 - 'ABCD'.indexOf(id) * 3, bookings: 4, revenuePer: 400000 };
  }
  const ctx = world(spec);

  const rows = scoring.score([
    creative('OUT', 'Middle', { spend: 50000000, leads: 40 }),
    ...['A', 'B', 'C', 'D'].map((id) => creative(id, 'Middle', { leads: 40 })),
  ], ctx);

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, r.score]));
  const inner = ['A', 'B', 'C', 'D'].map((id) => byId[id]);

  assert.ok(byId.OUT < Math.min(...inner), 'the outlier still ranks last, as it should');
  /* The point of winsorising: the remaining four keep their order and stay
     apart, instead of being squashed into one indistinguishable band by a
     creative spending five hundred times the rest. */
  assert.deepEqual(inner, [...inner].sort((a, b) => b - a), 'the rest keep their order');
  assert.ok(new Set(inner).size === inner.length, `the rest stay distinguishable — got ${inner.join(', ')}`);
});

/* ── the recommendation ─────────────────────────────────────────────────── */

test('the recommendation is one of three and explains itself', () => {
  const ctx = world({
    GOOD: { leads: 60, interested: 30, bookings: 9, revenuePer: 900000 },
    BAD: { leads: 60, interested: 2, bookings: 0, revenuePer: 0 },
    C: { leads: 60, interested: 12, bookings: 3, revenuePer: 300000 },
  });

  const rows = scoring.score([
    creative('GOOD', 'Bottom', { leads: 60 }),
    creative('BAD', 'Bottom', { leads: 60, spend: 900000 }),
    creative('C', 'Bottom', { leads: 60 }),
  ], ctx);

  for (const row of rows) {
    const call = scoring.recommend(row);
    assert.ok(['SCALE', 'WATCH', 'REPLACE'].includes(call.label));
    assert.ok(call.because.length, `${row.creative.adId} gave no reason`);
  }

  const byId = Object.fromEntries(rows.map((r) => [r.creative.adId, scoring.recommend(r)]));
  assert.equal(byId.GOOD.label, 'SCALE');
  assert.equal(byId.BAD.label, 'REPLACE');
});

/* Scaling is a decision to spend more money, and four leads cannot support it
   however good they look. */
test('a thin creative is never told to scale', () => {
  const ctx = world({
    THIN: { leads: 4, interested: 4, bookings: 2, revenuePer: 900000 },
    A: { leads: 60, interested: 10, bookings: 2, revenuePer: 200000 },
    B: { leads: 60, interested: 8, bookings: 1, revenuePer: 150000 },
  });

  const rows = scoring.score([
    creative('THIN', 'Bottom', { spend: 30000, leads: 4 }),
    creative('A', 'Bottom', { leads: 60 }),
    creative('B', 'Bottom', { leads: 60 }),
  ], ctx);

  const thin = rows.find((r) => r.creative.adId === 'THIN');
  assert.notEqual(scoring.recommend(thin).label, 'SCALE');
});

/* Fatigue is a modifier at 5–10% of the score, not a veto. */
test('fatigue cannot on its own condemn a strong business performer', () => {
  const worn = { band: 'act', score: 55, reasons: ['frequency 3.4'], label: 'Act soon' };
  assert.equal(scoring.fatigueComponent(worn), 45);
  assert.equal(scoring.fatigueComponent(null), 50, 'no reading is neither rewarded nor punished');
  assert.ok(scoring.WEIGHTS_BY_STAGE.BOFU.fatigue <= 0.10);
});

/* ── the one-line read ──────────────────────────────────────────────────── */

test('the headline names the stage and the figures that carried the score', () => {
  const ctx = world({
    B1: { leads: 50, interested: 25, bookings: 4, revenuePer: 1250000 },
    B2: { leads: 50, interested: 5, bookings: 1, revenuePer: 200000 },
    B3: { leads: 50, interested: 10, bookings: 2, revenuePer: 400000 },
  });

  const rows = scoring.score([
    creative('B1', 'Bottom', { leads: 50 }),
    creative('B2', 'Bottom', { leads: 50 }),
    creative('B3', 'Bottom', { leads: 50 }),
  ], ctx);

  const line = scoring.headline(rows.find((r) => r.creative.adId === 'B1'));
  assert.match(line, /BOFU performer/);
  assert.match(line, /—/, 'the line must name actual figures, not just a verdict');
});

test('the best at each stage is reported separately from the best overall', () => {
  const ctx = world({
    T: { leads: 40, interested: 8, bookings: 1, revenuePer: 200000 },
    M: { leads: 40, interested: 16, bookings: 3, revenuePer: 400000 },
    B: { leads: 40, interested: 20, bookings: 6, revenuePer: 700000 },
  });

  const rows = scoring.score([
    creative('T', 'Top', { leads: 40 }),
    creative('M', 'Middle', { leads: 40 }),
    creative('B', 'Bottom', { leads: 40 }),
  ], ctx);

  const best = scoring.bestByStage(rows);
  assert.deepEqual(best.map((b) => b.stage), ['TOFU', 'MOFU', 'BOFU']);
});
