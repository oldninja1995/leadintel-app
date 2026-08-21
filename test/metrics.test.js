/* Phase 6 sub-phase 6.1 — the metric registry.
 *
 *   node --test        or        npm test
 *
 * Three things are being defended here. That a formula cannot reach past the
 * registry into a query. That calculation order comes from the dependency
 * graph rather than from the order definitions happen to be written in. And
 * that an unknown stays unknown — the failure mode of a metric layer is not a
 * crash, it is a zero that looks like a measurement.
 */

const test = require('node:test');
const assert = require('node:assert');

const metrics = require('../lib/metrics');
const registry = require('../lib/metrics/registry');
const formula = require('../lib/metrics/formula');
const ingest = require('../lib/ingest');
const resolve = require('../lib/metrics/resolve');
const { UP, DOWN } = require('../data/_tokens');

const entities = () => ({
  campaignDays: [{ spend: 700000 }, { spend: 300000 }],
  leads: [{ id: 'L-1' }, { id: 'L-2' }, { id: 'L-3' }, { id: 'L-4' }],
  bookings: [{ id: 'B-1', revenue: { value: 4280000 } }, { id: 'B-2', revenue: { value: 0 } }],
  payments: [],
});

/* ── formulas are arithmetic, not queries ───────────────────────────────── */

test('a formula evaluates arithmetic over metric ids', () => {
  assert.equal(formula.run('a.b / c.d', { 'a.b': 10, 'c.d': 4 }), 2.5);
  assert.equal(formula.run('(a + b) * 2', { a: 3, b: 4 }), 14);
  assert.equal(formula.run('-a + 10', { a: 4 }), 6);
});

test('operator precedence is arithmetic, not left-to-right', () => {
  assert.equal(formula.run('2 + 3 * 4', {}), 14);
  assert.equal(formula.run('(2 + 3) * 4', {}), 20);
});

test('SQL is refused, and told why', () => {
  /* Three different rejections, all of them refusals. Uppercase keywords fail
     the identifier rule; `;` is not an operator; a bare keyword resolves to a
     metric that does not exist. What matters is that none of them evaluate. */
  assert.throws(() => formula.run('SELECT * FROM bookings', {}), /is not a metric id/);
  assert.throws(() => formula.run('revenue.net; DROP TABLE x', {}), /a formula is arithmetic over metric ids, not a query/);
  assert.throws(() => formula.run('revenue.net WHERE x = 1', { 'revenue.net': 1 }), /is not a metric id|unexpected/);
});

test('a formula cannot reach a metric the registry does not define', () => {
  assert.throws(() => formula.run('mystery.metric * 2', {}), /which the registry does not define/);
});

test('an unclosed bracket is an error, not a guess', () => {
  assert.throws(() => formula.run('(a + b', { a: 1, b: 2 }), /unclosed/);
  assert.throws(() => formula.run('a + ', { a: 1 }), /ends where a value was expected/);
  assert.throws(() => formula.run('a b', { a: 1, b: 2 }), /after the end of the expression/);
});

test('dividing by zero is unknown, not infinite', () => {
  /* A ROAS with no spend is not infinitely good. */
  assert.equal(formula.run('a / b', { a: 10, b: 0 }), null);
  assert.notEqual(formula.run('a / b', { a: 10, b: 0 }), Infinity);
});

test('an unknown input makes the whole expression unknown', () => {
  assert.equal(formula.run('a + b', { a: null, b: 5 }), null, 'a null was carried through as zero');
  assert.equal(formula.run('a * b', { a: 4, b: null }), null);
  assert.equal(formula.run('-a', { a: null }), null);
});

test('a formula declares exactly the metrics it uses', () => {
  assert.deepEqual(formula.references(formula.compile('(a.b + c.d) / a.b')), ['a.b', 'c.d']);
});

/* ── the twelve fields ──────────────────────────────────────────────────── */

test('every metric carries all twelve fields', () => {
  for (const metric of registry.list()) {
    for (const field of registry.TWELVE) {
      assert.ok(Object.prototype.hasOwnProperty.call(metric, field), `${metric.id} is missing ${field}`);
    }
  }
});

test('a metric missing a field is refused at definition time', () => {
  const base = { ...registry.get('leads.count') };
  delete base.owner;
  assert.throws(() => registry.assertMetric(base), /missing owner/);
});

test('a metric with no ai_context is refused', () => {
  assert.throws(() => registry.assertMetric({ ...registry.get('leads.count'), aiContext: '' }),
    /the AI would be free to assert anything/);
});

test('a metric must read a source or a formula, never both or neither', () => {
  const derived = registry.get('roas.net');
  assert.throws(() => registry.assertMetric({ ...derived, source: () => 1 }), /not both/);
  const { formula: _f, ...noFormula } = derived;
  assert.throws(() => registry.assertMetric(noFormula), /not neither/);
});

test('declared dependencies must match the formula exactly', () => {
  /* The calculation order comes from one and impact analysis from the other,
     so a disagreement would diverge silently. */
  assert.throws(
    () => registry.assertMetric({ ...registry.get('roas.net'), dependencies: ['revenue.net'] }),
    /declares dependencies .* but its formula uses/
  );
});

test('a base metric cannot claim dependencies it does not have', () => {
  assert.throws(
    () => registry.assertMetric({ ...registry.get('leads.count'), dependencies: ['ads.spend'] }),
    /reads a source directly and cannot also declare dependencies/
  );
});

test('refresh, favourability and format come from fixed vocabularies', () => {
  const m = registry.get('roas.net');
  assert.throws(() => registry.assertMetric({ ...m, refresh: 'sometimes' }), /has refresh/);
  assert.throws(() => registry.assertMetric({ ...m, favourability: 'up' }), /has favourability/);
  assert.throws(() => registry.assertMetric({ ...m, format: { kind: 'vibes' } }), /no valid format/);
});

/* ── dependency order ───────────────────────────────────────────────────── */

test('every metric is evaluated after everything it depends on', () => {
  const order = metrics.order().map((m) => m.id);
  for (const metric of registry.list()) {
    for (const dep of metric.dependencies) {
      assert.ok(order.indexOf(dep) < order.indexOf(metric.id),
        `${metric.id} is evaluated before its dependency ${dep}`);
    }
  }
});

test('a cycle is reported with the ring that closes it', () => {
  const a = { ...registry.get('roas.net'), id: 'a', formula: 'b', dependencies: ['b'] };
  const b = { ...registry.get('roas.net'), id: 'b', formula: 'a', dependencies: ['a'] };
  assert.throws(() => metrics.order([a, b]), /circular dependency: a → b → a/);
});

test('order does not depend on the order definitions are written in', () => {
  const forwards = metrics.order(registry.list()).map((m) => m.id);
  const backwards = metrics.order(registry.list().reverse()).map((m) => m.id);
  for (const metric of registry.list()) {
    for (const dep of metric.dependencies) {
      assert.ok(backwards.indexOf(dep) < backwards.indexOf(metric.id),
        `reversing the registry broke ${metric.id} → ${dep}`);
    }
  }
  assert.equal(forwards.length, backwards.length);
});

/* ── evaluation ─────────────────────────────────────────────────────────── */

test('base metrics read entities and derived metrics read base metrics', () => {
  const { values } = metrics.evaluate(entities());
  assert.equal(values['ads.spend'], 1000000);
  assert.equal(values['revenue.net'], 4280000);
  assert.equal(values['bookings.confirmed'], 1, 'a booking that settled at zero was counted as confirmed');
  assert.equal(values['leads.count'], 4);
  assert.equal(values['roas.net'], 4.28);
});

test('one broken definition costs one number, not the dashboard', () => {
  const broken = { ...registry.get('leads.count'), source: () => { throw new Error('source exploded'); } };
  const others = registry.list().filter((m) => m.id !== 'leads.count');
  const { values, problems } = metrics.evaluate(entities(), { metrics: [...others, broken] });

  assert.equal(values['leads.count'], null);
  assert.equal(problems[0].metric, 'leads.count');
  assert.equal(values['revenue.net'], 4280000, 'an unrelated metric was lost with the broken one');
  assert.equal(values['cost.per_lead'], null, 'a dependent of a failed metric produced a number anyway');
});

/* This test's name was the specification and its first assertion was the bug.
 *
 * It said "a metric with no bookings is unknown, not zero" and then asserted
 * that `bookings.confirmed` was 0 — the only line holding the stated rule was
 * the one about division. On production, where the property management system
 * has never synced, that zero was not academic: `revenue.net` read **₹0** and
 * `roas.net` read **0.0x**, which says "you earned nothing" rather than "we
 * cannot see this", on the same screen as ₹1.25 crore of CRM reservation value.
 *
 * The ratios were always safe — occupancy, ADR, RevPAR and cancellation rate
 * all decline correctly, because dividing by a missing denominator gives null.
 * It was the figures underneath them that claimed a measurement. */
test('a metric with no bookings is unknown, not zero', () => {
  const empty = { ...entities(), bookings: [], inventoryDays: [] };
  const { values } = metrics.evaluate(empty);

  assert.equal(values['bookings.confirmed'], null, 'no PMS is not the same statement as no bookings');
  assert.equal(values['bookings.all'], null);
  assert.equal(values['revenue.net'], null, '₹0 of net revenue is a claim about the business, not about the connector');
  assert.equal(values['roas.net'], null, 'and 0.0x net ROAS reads as a catastrophe rather than a gap');
  assert.equal(values['inventory.available'], null);
  assert.equal(values['stay.room_nights'], null);

  assert.equal(values['cost.per_booking'], null, 'dividing by no bookings produced a cost');
});

/* The other half of the rule, and the reason it is `counted` rather than a bare
   length check: an empty *collection* is unknown, an empty *selection* is a
   real, hard-won zero. A month with forty bookings and no cancellations has
   genuinely cancelled nothing, and reporting that as "unknown" would hide a
   good month exactly as badly as the zero hid a missing connector. */
test('a collection that is there but selects nothing reports a real zero', () => {
  const withBookings = {
    ...entities(),
    bookings: [
      { id: 'B-1', revenue: 4280000, nights: 2, bookingStatus: 'Confirmed', checkIn: '2026-08-02' },
      { id: 'B-2', revenue: 3100000, nights: 1, bookingStatus: 'Confirmed', checkIn: '2026-08-03' },
    ],
  };
  const { values } = metrics.evaluate(withBookings);

  assert.equal(values['bookings.cancelled'], 0, 'nothing cancelled is a measurement, not a gap');
  assert.equal(values['bookings.all'], 2);
  assert.equal(values['bookings.confirmed'], 2);
  assert.equal(values['revenue.net'], 7380000);
});

/* ── presentation the registry owns ─────────────────────────────────────── */

test('money formats from paise', () => {
  assert.equal(metrics.format(registry.get('revenue.net'), 4280000), '₹42,800');
});

test('an unknown renders as a dash, never as zero', () => {
  assert.equal(metrics.format(registry.get('roas.net'), null), '—');
});

test('each format kind renders in its own units', () => {
  assert.equal(metrics.format(registry.get('roas.net'), 4.28), '4.3x');
  assert.equal(metrics.format(registry.get('lead.conversion'), 0.161), '16.1%');
  assert.equal(metrics.format(registry.get('leads.count'), 1847), '1,847');
});

test('a falling cost per lead renders good, and a falling ROAS does not', () => {
  /* The case the favourability field exists for. */
  assert.equal(metrics.band(registry.get('cost.per_lead'), 20000), 'good');
  assert.equal(metrics.band(registry.get('cost.per_lead'), 60000), 'critical');
  assert.equal(metrics.band(registry.get('roas.net'), 5), 'good');
  assert.equal(metrics.band(registry.get('roas.net'), 1), 'critical');
});

test('a metric with no thresholds has no band rather than a wrong one', () => {
  assert.equal(metrics.band(registry.get('ads.spend'), 999), 'none');
  assert.equal(metrics.band(registry.get('roas.net'), null), 'none');
});

test('benchmark comparison respects favourability', () => {
  const cheap = metrics.vsBenchmark(registry.get('cost.per_lead'), 20000);
  assert.equal(cheap.favourable, true, 'coming in under a cost target was reported as unfavourable');

  const weak = metrics.vsBenchmark(registry.get('roas.net'), 2);
  assert.equal(weak.favourable, false);
});

/* ── against the real store ─────────────────────────────────────────────── */

test('the whole registry evaluates against ingested entities with no problems', () => {
  const report = metrics.report(ingest.snapshot({ store: ingest.storeFor('parakkat') }));
  assert.deepEqual(report.problems, []);
  assert.equal(report.metrics.length, registry.list().length);
});

test('net revenue matches the folio figure precedence settled on in 4.4', () => {
  const { values } = metrics.evaluate(ingest.snapshot({ store: ingest.storeFor('parakkat') }));
  assert.equal(values['revenue.net'], 4280000, 'the registry disagrees with the entity it reads');
  assert.equal(metrics.format(registry.get('revenue.net'), values['revenue.net']), '₹42,800');
});

/* ── the change against the previous period ─────────────────────────────── */

/* How a change is expressed depends on what the metric is, and getting it wrong
   is how a dashboard starts lying quietly. */

const resolveOne = (card, value, before) => {
  const payload = resolve.resolve({ kpis: [card] }, {
    values: { [card.metric]: value },
    previous: { [card.metric]: before },
    useRegistryValues: true,
  });
  return payload.kpis[0];
};

test('a count moves in percent', () => {
  const out = resolveOne({ label: 'Impressions', value: '', metric: 'ads.impressions' }, 120, 100);
  assert.equal(out.delta, '+20.0%');
});

test('a rate moves in points, because percent of a percent reads as the rate', () => {
  /* 1.0% → 1.5% rose by 0.5 points and by 50 percent; "+50%" beside a CTR is
     indistinguishable from the CTR itself. */
  const out = resolveOne({ label: 'CTR', value: '', metric: 'ads.ctr' }, 0.015, 0.010);
  assert.equal(out.delta, '+0.50pt');
});

test('a falling cost is good news and says so', () => {
  const out = resolveOne({ label: 'CPL', value: '', metric: 'cost.per_lead' }, 80, 100);
  assert.equal(out.delta, '−20.0%');
  assert.equal(out.deltaColor, UP, 'a cheaper lead rendered as a loss');
});

test('a rising cost is bad news', () => {
  const out = resolveOne({ label: 'CPL', value: '', metric: 'cost.per_lead' }, 120, 100);
  assert.equal(out.deltaColor, DOWN);
});

test('nothing to compare against is not "no change"', () => {
  const out = resolveOne({ label: 'Impressions', value: '', metric: 'ads.impressions' }, 120, null);
  assert.equal(out.delta, '·', 'a metric with no previous figure has not held steady');
});

test('a previous zero declines rather than reading as infinite growth', () => {
  const out = resolveOne({ label: 'Impressions', value: '', metric: 'ads.impressions' }, 120, 0);
  assert.equal(out.delta, '·', 'every first week of spend would otherwise read +∞%');
});

test('identical is stated, not rendered as a measurement', () => {
  const out = resolveOne({ label: 'Impressions', value: '', metric: 'ads.impressions' }, 100, 100);
  assert.equal(out.delta, 'no change');
});

/* ── the money formatter, cached ────────────────────────────────────────────
 *
 * `rupees` used to call `toLocaleString(locale, options)`, which constructs a
 * fresh `Intl.NumberFormat` every time — ~75µs against ~2µs to format through
 * one already built. A table that prices 4,889 search terms across three
 * columns paid for ten thousand constructions per page view. The formatter is
 * now built once per decimal setting, which is only safe because the two are
 * specified to produce the same string; this pins that.
 */
test('the cached money formatter matches the expression it replaced', () => {
  const spend = metrics.registry.get('ads.spend');
  const rupees = (paise, decimals) => '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });

  const values = [0, 1, 7, 99, 100, 101, 999, 1000, 12345, 99999, 100000, 123456789,
    -1, -123456789, 0.5, 1.5, 2.5, -2.5, 1e15, 1e21, Number.MAX_SAFE_INTEGER];
  for (const v of values) {
    assert.equal(metrics.format(spend, v), rupees(v, spend.format.decimals ?? 0), `₹ at ${v}`);
  }
  /* Indian grouping is the whole reason the locale is named — a formatter that
     quietly fell back to en-US would pass every test above but this one. */
  assert.equal(metrics.format(spend, 12345678900), '₹12,34,56,789');
});

test('a repeated format call does not drift from the first', () => {
  const spend = metrics.registry.get('ads.spend');
  const first = metrics.format(spend, 987654321);
  for (let i = 0; i < 1000; i++) assert.equal(metrics.format(spend, 987654321), first);
});
