/* Phase 6 sub-phase 6.4 — screens resolving to registry entries.
 *
 *   node --test        or        npm test
 *
 * The distinction under test is between *carrying a definition* and *taking a
 * value*. A card always gets the first; it only gets the second where the
 * number is genuinely derived. Conflating the two would drop fixture-scale
 * figures into an authored dashboard, which is the failure this sub-phase is
 * shaped to avoid.
 */

const test = require('node:test');
const assert = require('node:assert');

const resolve = require('../lib/metrics/resolve');
const registry = require('../lib/metrics/registry');
const metrics = require('../lib/metrics');
const ingest = require('../lib/ingest');

const payload = () => ({
  title: 'Executive Dashboard',
  heroKpis: [
    { metric: 'revenue.net', label: 'Net revenue', value: '₹52.3L', delta: '+12.4%' },
    { label: 'Occupancy', value: '78%', delta: '−4pt' },
  ],
  miniKpis: [
    { metric: 'cost.per_lead', label: 'CPL', value: '₹427', delta: '−18%' },
    { metric: 'roas.net', label: 'Net ROAS', value: '4.8x', delta: '+0.6x' },
  ],
  /* Rows that are not KPI cards must be left completely alone. */
  campRows: [{ name: 'Munnar Honeymoon', spend: '₹2.10L' }],
  legend: ['Meta', 'Google'],
});

const values = { 'revenue.net': 4280000, 'cost.per_lead': 773775, 'roas.net': 1.38 };

/* ── the definition always travels ──────────────────────────────────────── */

test('a card that names a metric carries its definition, even without values', () => {
  const out = resolve.resolve(payload());
  const card = out.heroKpis[0];

  assert.equal(card.metricName, 'Revenue (net)');
  assert.equal(card.metricOwner, 'Revenue Manager');
  assert.equal(card.metricSources, 'PMS · CRM');
  assert.equal(card.metricFavourability, 'higher');
  assert.ok(card.metricAiContext, 'the AI context did not travel with the card');
});

test('the authored value survives when the registry is not supplying values', () => {
  const out = resolve.resolve(payload(), { values, useRegistryValues: false });
  assert.equal(out.heroKpis[0].value, '₹52.3L');
  assert.equal(out.heroKpis[0].valueSource, 'authored');
  assert.equal(out.heroKpis[0].delta, '+12.4%', 'an authored delta was discarded with no value replacing it');
});

test('a card with no metric is untouched', () => {
  const out = resolve.resolve(payload(), { values, useRegistryValues: true });
  const occupancy = out.heroKpis[1];
  assert.equal(occupancy.value, '78%');
  assert.equal(occupancy.metric, undefined);
  assert.equal(occupancy.valueSource, undefined, 'an unresolved card was labelled as if it had been resolved');
});

test('rows that are not KPI cards are left alone', () => {
  const original = payload();
  const out = resolve.resolve(original, { values, useRegistryValues: true });
  assert.deepEqual(out.campRows, original.campRows);
  assert.deepEqual(out.legend, original.legend);
  assert.equal(out.title, 'Executive Dashboard');
});

/* ── taking a value ─────────────────────────────────────────────────────── */

test('the registry value replaces the authored one when it is genuinely derived', () => {
  const out = resolve.resolve(payload(), { values, useRegistryValues: true });
  const revenue = out.heroKpis[0];

  assert.equal(revenue.value, '₹42,800', 'the registry figure did not reach the card');
  assert.equal(revenue.valueSource, 'registry');
});

test('a registry value formats through the registry, not the card', () => {
  const out = resolve.resolve(payload(), { values, useRegistryValues: true });
  assert.equal(out.miniKpis[0].value, '₹7,738', 'paise were not converted by the metric format');
  assert.equal(out.miniKpis[1].value, '1.4x');
});

test('the band comes from the registry, read through favourability', () => {
  const out = resolve.resolve(payload(), { values, useRegistryValues: true });
  /* ₹7,738 against a ₹350 target on a lower-is-better metric. */
  assert.equal(out.miniKpis[0].metricBand, 'critical');
  assert.equal(out.miniKpis[0].metricFavourable, false);
});

test('an authored delta is dropped when the value is replaced', () => {
  /* Keeping "+12.4%" beside a registry figure would attach a change to a
     number that never changed that way. */
  const out = resolve.resolve(payload(), { values, useRegistryValues: true });
  assert.notEqual(out.heroKpis[0].delta, '+12.4%');
});

test('a metric the registry cannot compute renders as a dash, not a zero', () => {
  const out = resolve.resolve(payload(), { values: { ...values, 'revenue.net': null }, useRegistryValues: true });
  assert.equal(out.heroKpis[0].value, '—');
  assert.equal(out.heroKpis[0].delta, '—');
});

test('a metric absent from the evaluation keeps its authored value', () => {
  const out = resolve.resolve(payload(), { values: {}, useRegistryValues: true });
  assert.equal(out.heroKpis[0].value, '₹52.3L');
  assert.equal(out.heroKpis[0].valueSource, 'authored');
});

test('a card naming a metric the registry does not define is flagged, not ignored', () => {
  const broken = { kpis: [{ metric: 'revenue.imaginary', label: 'Ghost', value: '₹1' }] };
  const out = resolve.resolve(broken, { values, useRegistryValues: true });
  assert.equal(out.kpis[0].metricMissing, true);
  assert.equal(out.kpis[0].value, '₹1', 'a card with no definition had its value replaced anyway');
});

/* ── coverage is counted, not claimed ───────────────────────────────────── */

test('coverage counts resolved cards against every card', () => {
  const cover = resolve.coverage(payload());
  assert.equal(cover.total, 4);
  assert.equal(cover.resolved, 3);
  assert.equal(cover.pct, '75%');
  assert.equal(cover.complete, false);
});

test('coverage names the KPIs that do not resolve', () => {
  const cover = resolve.coverage(payload());
  const hero = cover.collections.find((c) => c.collection === 'heroKpis');
  assert.deepEqual(hero.unresolved, ['Occupancy']);
});

test('a card naming an unknown metric does not count as resolved', () => {
  const cover = resolve.coverage({ kpis: [{ metric: 'revenue.imaginary', label: 'Ghost', value: '₹1' }] });
  assert.equal(cover.resolved, 0);
  assert.deepEqual(cover.collections[0].unknownMetrics, ['revenue.imaginary']);
});

test('a screen with no KPI cards contributes nothing rather than a false 100%', () => {
  const cover = resolve.coverage({ campRows: [{ name: 'x', spend: '₹1' }] });
  assert.equal(cover.total, 0);
  assert.equal(cover.complete, false, 'a screen with no KPIs reported itself as fully covered');
});

/* ── against the real registry and store ────────────────────────────────── */

test('every metric named by the dashboard exists in the registry', () => {
  const dashboard = require('../data/dashboard');
  const named = [...(dashboard.heroKpis || []), ...(dashboard.miniKpis || [])]
    .filter((k) => k.metric)
    .map((k) => k.metric);

  assert.ok(named.length > 0, 'the dashboard names no metrics at all');
  for (const id of named) {
    assert.ok(registry.get(id), `the dashboard names "${id}", which the registry does not define`);
  }
});

test('the dashboard resolves against real ingested values end to end', () => {
  const dashboard = require('../data/dashboard');
  const { values: real } = metrics.evaluate(ingest.snapshot({ store: ingest.storeFor('parakkat') }));
  const out = resolve.resolve({ heroKpis: dashboard.heroKpis, miniKpis: dashboard.miniKpis },
    { values: real, useRegistryValues: true });

  const revenue = out.heroKpis.find((k) => k.metric === 'revenue.net');
  assert.equal(revenue.value, '₹42,800', 'the dashboard did not take the folio figure');
  assert.equal(revenue.valueSource, 'registry');

  /* ADR is revenue over room nights — ₹42,800 across a three-night stay. */
  const adr = out.miniKpis.find((k) => k.metric === 'rate.adr');
  assert.equal(adr.value, '₹14,267');
});
