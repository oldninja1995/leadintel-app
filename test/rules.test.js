/* Phase 8 — metric-driven alert rules.
 *
 *   node --test        or        npm test
 *
 * Exit criteria: a rule fires end-to-end to its configured channel, and every
 * rule reports its 90-day fire count and false-positive rate. The tests that
 * matter most are the ones about **not** firing: a rule that cannot be computed
 * is a different state from one whose condition was not met, and a dashboard
 * showing both as quiet would be reassuring about the wrong thing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rules = require('../lib/rules');
const channels = require('../lib/rules/channels');
const { FireLog } = require('../lib/rules/firelog');

const log = () => new FireLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-fires-')), 'fires.jsonl'));
const rule = (id) => rules.get(id);

/* ── the rules are the design's ─────────────────────────────────────────── */

test('the eight rules are the ones the page specifies', () => {
  assert.deepEqual(rules.list().map((r) => r.name), [
    'ROAS below target',
    'Occupancy below forecast',
    'Revenue decline',
    'Booking slowdown',
    'High cancellation rate',
    'Creative fatigue',
    'Sales response breach',
    'Connector down',
  ]);
});

test('a rule evaluates on the cadence of the metric it watches', () => {
  /* The scope's own words — not a schedule of the rule's own. */
  assert.equal(rules.cadenceOf(rule('high-cancellation-rate')), '15min');
  assert.equal(rules.cadenceOf(rule('sales-response-breach')), 'realtime');
  assert.equal(rules.cadenceOf(rule('connector-down')), 'realtime');
});

test('every rule names a metric, or says why it has none', () => {
  for (const r of rules.list()) {
    assert.ok(r.metric || r.unevaluable || r.operational, `${r.name} watches nothing and explains nothing`);
  }
});

/* ── firing ─────────────────────────────────────────────────────────────── */

test('a threshold rule fires when its condition is met', () => {
  const v = rules.evaluate(rule('high-cancellation-rate'), { current: { 'cancellation.rate': 0.5 } });
  assert.equal(v.state, 'fired');
  assert.equal(v.severity, 'critical');
  assert.match(v.reason, /Cancellation rate is 50.0%, above the 3% ceiling/);
});

test('a threshold rule holds when it is not', () => {
  const v = rules.evaluate(rule('high-cancellation-rate'), { current: { 'cancellation.rate': 0.01 } });
  assert.equal(v.state, 'held');
});

test('a response breach fires past two hours, not before', () => {
  assert.equal(rules.evaluate(rule('sales-response-breach'), { current: { 'lead.response_minutes': 38 } }).state, 'held');
  const fired = rules.evaluate(rule('sales-response-breach'), { current: { 'lead.response_minutes': 180 } });
  assert.equal(fired.state, 'fired');
  assert.match(fired.reason, /180 min, past the two-hour breach/);
});

test('a week-on-week rule needs both windows', () => {
  const r = rule('revenue-decline');
  const dropped = rules.evaluate(r, { current: { 'revenue.net': 800000 }, previous: { 'revenue.net': 1000000 } });
  assert.equal(dropped.state, 'fired');
  assert.match(dropped.reason, /fell 20% week on week/);

  const steady = rules.evaluate(r, { current: { 'revenue.net': 990000 }, previous: { 'revenue.net': 1000000 } });
  assert.equal(steady.state, 'held', 'a 1% dip fired a 10% rule');

  const blind = rules.evaluate(r, { current: { 'revenue.net': 800000 }, previous: {} });
  assert.equal(blind.state, 'unevaluable');
});

test('a sustained rule needs the whole window below, not one dip', () => {
  const r = rule('roas-below-target');
  const dip = rules.evaluate(r, { current: { 'roas.net': 3.0 }, sustained: [5.0, 5.0, 3.0] });
  assert.equal(dip.state, 'held', 'a single day below target fired a three-day rule');

  const sustained = rules.evaluate(r, { current: { 'roas.net': 3.0 }, sustained: [3.9, 3.5, 3.0] });
  assert.equal(sustained.state, 'fired');
  assert.match(sustained.reason, /on 3 consecutive days/);
});

test('a sustained rule with too few readings says so rather than firing', () => {
  const v = rules.evaluate(rule('roas-below-target'), { current: { 'roas.net': 3.0 }, sustained: [3.0] });
  assert.equal(v.state, 'unevaluable');
  assert.match(v.reason, /needs 3 consecutive readings; 1 available/);
});

/* ── not firing is three different states ───────────────────────────────── */

test('an unknown metric is unevaluable, never "condition not met"', () => {
  const v = rules.evaluate(rule('high-cancellation-rate'), { current: { 'cancellation.rate': null } });
  assert.equal(v.state, 'unevaluable');
  assert.match(v.reason, /could not be computed/);
});

test('a rule with nothing to compute from says exactly what is missing', () => {
  const forecast = rules.evaluate(rule('occupancy-below-forecast'), {});
  assert.equal(forecast.state, 'unevaluable');
  assert.match(forecast.reason, /no forecast metric/);

  const fatigue = rules.evaluate(rule('creative-fatigue'), {});
  assert.match(fatigue.reason, /no fatigue score exists/);

  const pace = rules.evaluate(rule('booking-slowdown'), {});
  assert.match(pace.reason, /no target or plan series is ingested/);
});

/* ── the operational rule ───────────────────────────────────────────────── */

test('connector down reads the run log, not a registry metric', () => {
  const healthy = rules.evaluate(rule('connector-down'), { status: [{ name: 'Meta Ads', lagSeconds: 60 }] });
  assert.equal(healthy.state, 'held');

  const stale = rules.evaluate(rule('connector-down'), {
    status: [{ name: 'Meta Ads', lagSeconds: 60 }, { name: 'TeleCRM', lagSeconds: 7200 }],
  });
  assert.equal(stale.state, 'fired');
  assert.match(stale.reason, /TeleCRM has not synced in over an hour/);
});

test('a source that has never synced counts as down', () => {
  const v = rules.evaluate(rule('connector-down'), { status: [{ name: 'Razorpay', lagSeconds: null }] });
  assert.equal(v.state, 'fired');
});

/* ── delivery ───────────────────────────────────────────────────────────── */

const fire = { rule: 'high-cancellation-rate', severity: 'critical', reason: 'test', to: ['Owner'], at: '2026-08-06T00:00:00.000Z' };

test('a rule fires end-to-end to a channel that works', () => {
  const lines = [];
  const result = channels.createChannel('log', { sink: { log: (l) => lines.push(l) } }).deliver(fire);
  assert.equal(result.delivered, true);
  assert.match(lines[0], /ALERT \[critical\] high-cancellation-rate: test → Owner/);
});

test('an unconfigured channel reports why, and does not stop the others', () => {
  const results = channels.deliver(fire, ['log', 'email', 'slack'], { sink: { log() {} } });
  assert.equal(results[0].delivered, true);
  assert.equal(results[1].delivered, false);
  assert.match(results[1].error, /no SMTP host/);
  assert.match(results[1].error, /The rule still fired and is recorded/);
  assert.equal(results[2].delivered, false);
});

test('a fire always reaches somewhere readable, whatever it was configured for', () => {
  /* None of the design's channels can be reached from here. A rule firing
     where nobody could see it would meet the letter of "end-to-end" and miss
     the point, so `log` is attempted whether or not the rule asked for it. */
  const results = channels.deliver(fire, ['email', 'whatsapp'], { sink: { log() {} } });
  assert.equal(results[0].channel, 'log');
  assert.equal(results[0].delivered, true);
  assert.ok(results.some((r) => r.delivered), 'a fire was delivered nowhere at all');
});

test('log is not attempted twice when a rule already asked for it', () => {
  const results = channels.deliver(fire, ['log'], { sink: { log() {} } });
  assert.equal(results.filter((r) => r.channel === 'log').length, 1);
});

test('an unknown channel is refused', () => {
  assert.throws(() => channels.createChannel('carrier-pigeon'), /unknown channel/);
});

/* ── fire counts and false positives ────────────────────────────────────── */

const firedAt = (at, id = 'r1') => ({ id: `${at}-${id}`, kind: 'fire', rule: id, at, severity: 'warning', reason: 'x', to: [] });

test('a rule reports its fire count over the window', () => {
  const l = log();
  l.append(firedAt('2026-08-01T00:00:00.000Z'));
  l.append(firedAt('2026-08-02T00:00:00.000Z'));
  const stats = l.stats('r1', '2026-07-01T00:00:00.000Z');
  assert.equal(stats.fired, 2);
});

test('fires outside the window are not counted', () => {
  const l = log();
  l.append(firedAt('2026-01-01T00:00:00.000Z'));
  l.append(firedAt('2026-08-02T00:00:00.000Z'));
  assert.equal(l.stats('r1', '2026-07-01T00:00:00.000Z').fired, 1);
});

test('an unreviewed rule has an unknown false-positive rate, not zero', () => {
  /* Reporting 0% for a rule nobody has reviewed would flatter exactly the
     thresholds that need watching. */
  const l = log();
  l.append(firedAt('2026-08-01T00:00:00.000Z'));
  const stats = l.stats('r1', '2026-07-01T00:00:00.000Z');
  assert.equal(stats.falsePositiveRate, null);
  assert.equal(stats.unreviewed, 1);
});

test('a false positive is recorded when a human says so', () => {
  const l = log();
  const f = firedAt('2026-08-01T00:00:00.000Z');
  l.append(f);
  l.append(firedAt('2026-08-02T00:00:00.000Z'));
  l.judge(f.id, { falsePositive: true, by: 'Reshma K' });

  const stats = l.stats('r1', '2026-07-01T00:00:00.000Z');
  assert.equal(stats.judged, 1);
  assert.equal(stats.falsePositives, 1);
  assert.equal(stats.falsePositiveRate, '100%');
  assert.equal(stats.unreviewed, 1);
});

test('judging annotates rather than rewriting the fire', () => {
  const l = log();
  const f = firedAt('2026-08-01T00:00:00.000Z');
  l.append(f);
  l.judge(f.id, { falsePositive: true });

  const raw = l.all().filter((r) => r.kind !== 'judgement');
  assert.equal(raw.length, 1, 'the original fire was removed');
  assert.equal(raw[0].falsePositive, undefined, 'the fire line was rewritten');
  assert.equal(l.resolved()[0].falsePositive, true);
});

test('somebody may change their mind', () => {
  const l = log();
  const f = firedAt('2026-08-01T00:00:00.000Z');
  l.append(f);
  l.judge(f.id, { falsePositive: true });
  l.judge(f.id, { falsePositive: false });
  assert.equal(l.resolved()[0].falsePositive, false);
});

test('judging a fire that never happened returns nothing', () => {
  assert.equal(log().judge('no-such-fire', { falsePositive: true }), null);
});
