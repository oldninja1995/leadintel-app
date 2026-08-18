/* Phase 7 — the AI reasoning layer.
 *
 *   node --test        or        npm test
 *
 * The exit criteria are unusually checkable: every claim resolves to a registry
 * metric and a time window, no unsourced assertion, and the suppression rule is
 * enforced rather than advisory. So most of what follows tests the *refusals* —
 * what the layer declines to say, which is the part a fluent generator would
 * get wrong.
 */

const test = require('node:test');
const assert = require('node:assert');

const explain = require('../lib/ai/explain');
const { createReasoner } = require('../lib/ai/reasoner');

const W = (label) => ({ label, from: '2026-08-01T00:00:00.000Z', to: '2026-08-06T00:00:00.000Z' });

/* Spend steady, revenue up: ROAS improves for a real reason. */
const before = { values: { 'roas.net': 3.0, 'revenue.net': 3000000, 'ads.spend': 1000000 }, over: W('30d') };
const after = { values: { 'roas.net': 4.5, 'revenue.net': 4500000, 'ads.spend': 1000000 }, over: W('7d') };

const healthy = { match: { rate: 1, pct: '100%' }, problems: 0, sampleSize: 200 };

/* ── the six steps ──────────────────────────────────────────────────────── */

test('an explanation follows the six-step contract, in order', () => {
  const e = explain.explain('roas.net', { before, after, ...healthy });
  assert.deepEqual(e.steps.map((s) => s.claim),
    ['change', 'drivers', 'related', 'cause', 'recommendation', 'confidence']);
});

test('step one names both windows, not just the change', () => {
  /* "Revenue is up 12%" without saying up from when is the commonest unsourced
     assertion in analytics. */
  const [change] = explain.explain('roas.net', { before, after, ...healthy }).steps;
  assert.equal(change.window, '7d');
  assert.equal(change.comparedTo, '30d');
  assert.equal(change.from, '3.0x');
  assert.equal(change.to, '4.5x');
  assert.equal(change.change, '+50.0%');
});

test('direction is read through favourability, not through the sign', () => {
  const up = explain.explain('roas.net', { before, after, ...healthy }).steps[0];
  assert.equal(up.direction, 'better');

  /* Cost per lead rising is worse, though the number went up. */
  const cheap = { values: { 'cost.per_lead': 30000, 'ads.spend': 300000, 'leads.count': 10 }, over: W('30d') };
  const dear = { values: { 'cost.per_lead': 60000, 'ads.spend': 600000, 'leads.count': 10 }, over: W('7d') };
  const worse = explain.explain('cost.per_lead', { before: cheap, after: dear, ...healthy }).steps[0];
  assert.equal(worse.direction, 'worse');
});

/* ── drivers, quantified or declared ────────────────────────────────────── */

test('a ratio is decomposed into shares that sum to the whole move', () => {
  const [, drivers] = explain.explain('roas.net', { before, after, ...healthy }).steps;
  assert.equal(drivers.quantified, true);
  const total = drivers.parts.reduce((t, p) => t + p.shareValue, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares summed to ${total}, not 1`);
});

test('the share names the metric that actually moved', () => {
  const [, drivers] = explain.explain('roas.net', { before, after, ...healthy }).steps;
  const revenue = drivers.parts.find((p) => p.metric === 'revenue.net');
  const spend = drivers.parts.find((p) => p.metric === 'ads.spend');
  assert.equal(revenue.share, '100%');
  assert.equal(spend.share, '0%', 'steady spend was credited with part of the move');
});

test('a base metric declares that it cannot be decomposed, rather than guessing', () => {
  /* "Unquantifiable drivers are declared, not estimated." */
  const [, drivers] = explain.explain('revenue.net', { before, after, ...healthy }).steps;
  assert.equal(drivers.quantified, false);
  assert.match(drivers.text, /cannot decompose it further/);
  assert.match(drivers.text, /unquantified/);
});

test('an unknown input blocks decomposition instead of producing a number', () => {
  const broken = { values: { 'roas.net': null, 'revenue.net': null, 'ads.spend': 1000000 }, over: W('7d') };
  const [, drivers] = explain.explain('roas.net', { before, after: broken, ...healthy }).steps;
  assert.equal(drivers.quantified, false);
  assert.match(drivers.text, /Declared, not estimated/);
});

test('a zero denominator does not produce an infinite share', () => {
  const none = { values: { 'roas.net': null, 'revenue.net': 4500000, 'ads.spend': 0 }, over: W('7d') };
  const [, drivers] = explain.explain('roas.net', { before, after: none, ...healthy }).steps;
  assert.equal(drivers.quantified, false);
});

/* ── related, and cause vs mix ──────────────────────────────────────────── */

test('related metrics come off the dependency graph, not a judgement', () => {
  const related = explain.related(require('../lib/metrics/registry').get('revenue.net'));
  assert.ok(related.feeds.includes('roas.net'));
  /* `booking.value` used to be here. It became a source metric when it learned
     to fall back to the CRM's won deals where there is no PMS folio, and the
     registry forbids a source and dependencies together — so it left the graph
     rather than declaring a lineage it no longer computes through. ADR and
     RevPAR still derive from revenue.net and are the assertion now. */
  assert.ok(related.feeds.includes('rate.adr'));
  assert.ok(related.feeds.includes('rate.revpar'));
  assert.deepEqual(related.dependsOn, []);
});

test('a move driven by the numerator is called real, not composition', () => {
  const [, , , cause] = explain.explain('roas.net', { before, after, ...healthy }).steps;
  assert.equal(cause.verdict, 'efficiency');
  assert.match(cause.text, /Mostly real/);
});

test('a move driven by the denominator is called composition', () => {
  /* Same revenue, spend halved — ROAS doubles because the base changed. */
  const cheaper = { values: { 'roas.net': 6.0, 'revenue.net': 3000000, 'ads.spend': 500000 }, over: W('7d') };
  const [, , , cause] = explain.explain('roas.net', { before, after: cheaper, ...healthy }).steps;
  assert.equal(cause.verdict, 'composition');
  assert.match(cause.text, /base changed rather than the performance/);
});

test('an undecomposable metric will not claim either', () => {
  const [, , , cause] = explain.explain('revenue.net', { before, after, ...healthy }).steps;
  assert.equal(cause.verdict, 'undetermined');
});

/* ── confidence, and the suppression rule ───────────────────────────────── */

test('confidence is built from observations the product already makes', () => {
  const c = explain.confidence({ match: { rate: 0.5, pct: '50%' }, problems: 3, sampleSize: 2, unknowns: 0 });
  assert.ok(c.components.some((x) => x.factor === 'identity match rate'));
  assert.ok(c.components.some((x) => x.factor === 'normalisation problems'));
  assert.ok(c.components.some((x) => x.factor === 'sample size'));
  assert.ok(c.score < 60);
});

test('a healthy pipeline with a real sample scores high', () => {
  const c = explain.confidence({ match: { rate: 1, pct: '100%' }, problems: 0, sampleSize: 200, unknowns: 0 });
  assert.equal(c.score, 100);
});

test('an unknown match rate is penalised, not assumed perfect', () => {
  const c = explain.confidence({ match: null, problems: 0, sampleSize: 200, unknowns: 0 });
  assert.ok(c.score < 100);
  assert.equal(c.components[0].value, 'unknown');
});

test('below 60% the recommendation is suppressed and the gap stated', () => {
  /* Enforced, not advisory — the rule lives in the layer, not in the caller. */
  const thin = { match: { rate: 0.5, pct: '50%' }, problems: 4, sampleSize: 2 };
  const e = explain.explain('roas.net', { before, after, ...thin });

  assert.ok(e.confidence < explain.SUPPRESS_BELOW);
  assert.equal(e.suppressed, true);
  const recommendation = e.steps.find((s) => s.claim === 'recommendation');
  assert.equal(recommendation.suppressed, true);
  assert.match(recommendation.text, /No recommendation/);
  assert.match(recommendation.text, /below the 60% floor/);
});

test('above the floor a recommendation names a lever and an expected effect', () => {
  const e = explain.explain('roas.net', { before, after, ...healthy });
  const recommendation = e.steps.find((s) => s.claim === 'recommendation');
  assert.equal(recommendation.suppressed, false);
  assert.equal(recommendation.lever, 'revenue.net');
  assert.match(recommendation.text, /Expected effect/);
  assert.match(recommendation.text, /assuming the other input holds/);
});

test('confidence declares its sources, never an unsourced percentage', () => {
  const e = explain.explain('roas.net', { before, after, ...healthy });
  const confidence = e.steps.find((s) => s.claim === 'confidence');
  assert.deepEqual(confidence.sources, ['CRM', 'PMS', 'ADS']);
  assert.match(confidence.text, /Confidence \d+% — sources: CRM, PMS, ADS/);
});

/* ── no unsourced assertion ─────────────────────────────────────────────── */

test('every claim carries its metric, and every numeric claim its window', () => {
  for (const id of ['roas.net', 'revenue.net', 'cost.per_lead', 'occupancy.rate']) {
    const e = explain.explain(id, { before, after, ...healthy });
    assert.deepEqual(explain.assertSourced(e), [], `${id} produced an unsourced claim`);
  }
});

test('an unsourced claim is withheld, not shipped with a warning', () => {
  const reasoner = createReasoner('registry');
  const e = reasoner.explain('roas.net', { before, after, ...healthy });
  assert.equal(e.reasoner, 'registry');

  /* assertSourced is what the reasoner enforces; prove it catches a gap. */
  const tampered = { steps: [{ claim: 'change', metric: 'roas.net' }] };
  assert.deepEqual(explain.assertSourced(tampered), [{ claim: 'change', missing: 'window' }]);
});

test('a metric outside the registry cannot be explained', () => {
  assert.throws(() => explain.explain('ghost.metric', { before, after }), /no metric/);
});

test('unknown is not the same as unchanged', () => {
  /* This shipped wrong once: a metric that could not be computed in either
     window produced "did not move. No action indicated." — a confident
     sentence about nothing. */
  const blank = { values: { 'roas.net': null, 'revenue.net': null, 'ads.spend': null }, over: W('7d') };
  const e = explain.explain('roas.net', { before: blank, after: blank, ...healthy });

  assert.equal(e.steps[0].direction, 'unknown');
  const recommendation = e.steps.find((s) => s.claim === 'recommendation');
  assert.equal(recommendation.suppressed, true);
  assert.match(recommendation.text, /could not be computed/);
  assert.doesNotMatch(recommendation.text, /did not move\./);
});

test('genuinely unchanged is still reported as unchanged', () => {
  const same = { values: { 'roas.net': 3.0, 'revenue.net': 3000000, 'ads.spend': 1000000 }, over: W('7d') };
  const e = explain.explain('roas.net', { before, after: same, ...healthy });
  assert.equal(e.steps[0].direction, 'flat');
  assert.match(e.steps.find((s) => s.claim === 'recommendation').text, /did not move/);
});

/* ── the reasoner seam ──────────────────────────────────────────────────── */

test('the model-backed reasoner says why it is not implemented', () => {
  assert.throws(() => createReasoner('model').explain('roas.net', {}),
    /no API key, no reviewed prompt, and no evaluation/);
});

test('an unknown reasoner is refused', () => {
  assert.throws(() => createReasoner('vibes'), /unknown reasoner/);
});
