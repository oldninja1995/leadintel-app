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

/* ── a card about one grain ─────────────────────────────────────────────── */

/* The screen is the workspace; the tile is one channel. Evaluated the way
   server.js does it, so what these assert is what renders. */
const atPayload = () => ({
  miniKpis: [
    { metric: 'ads.spend', at: { dimension: 'channel', value: 'meta' }, label: 'Meta spend', value: '₹7.6L' },
    { metric: 'ads.spend', at: { dimension: 'channel', value: 'google' }, label: 'Google spend', value: '₹3.3L' },
    { metric: 'ads.spend', label: 'Ad spend', value: '₹10.9L' },
  ],
});

const entities = () => ingest.snapshot({ store: ingest.storeFor('parakkat') });

const scopedResolve = (extra = {}) => {
  const e = entities();
  const workspace = metrics.evaluate(e);
  return resolve.resolve(atPayload(), {
    values: workspace.values,
    notApplicable: workspace.notApplicable,
    useRegistryValues: true,
    valuesAt: (at) => metrics.evaluate(e, { at }),
    ...extra,
  });
};

test('a card declaring a grain takes that grain\'s figure, not the workspace\'s', () => {
  const out = scopedResolve().miniKpis;
  const meta = out[0];
  const google = out[1];
  const blended = out[2];

  assert.equal(meta.valueSource, 'registry');
  assert.equal(google.valueSource, 'registry');
  assert.notEqual(meta.value, blended.value, 'the Meta tile printed the workspace total');
  assert.notEqual(google.value, blended.value, 'the Google tile printed the workspace total');
  assert.equal(meta.metricAt, 'channel:meta', 'the tile did not state which slice it is');
  assert.equal(google.metricAt, 'channel:google');
});

test('the split adds back up to the blended figure', () => {
  /* The reason this metric could be split at all: `ads.spend` sums campaign
     days, every campaign day carries a platform, and the two channels
     partition them. A tile pair that did not reconcile with the total on the
     Marketing dashboard would be worse than the one tile it replaced. */
  const e = entities();
  const total = metrics.evaluate(e).values['ads.spend'];
  const meta = metrics.evaluate(e, { at: { dimension: 'channel', value: 'meta' } }).values['ads.spend'];
  const google = metrics.evaluate(e, { at: { dimension: 'channel', value: 'google' } }).values['ads.spend'];

  assert.equal(meta + google, total, 'Meta and Google spend do not sum to total ad spend');
});

test('a card with a grain keeps its definition and the one registry entry', () => {
  const out = scopedResolve().miniKpis;
  /* Two cards, one definition — that is the whole point of not minting
     `ads.spend.meta`. */
  assert.equal(out[0].metric, 'ads.spend');
  assert.equal(out[1].metric, 'ads.spend');
  assert.equal(out[0].metricName, out[1].metricName);
  assert.equal(out[0].metricOwner, 'Marketing Director');
});

test('the previous-period comparison is narrowed to the same grain', () => {
  /* Meta this period against the workspace last period would report a change
     nobody made — and would do it in the direction that flatters whichever
     platform is smaller. */
  const seen = [];
  scopedResolve({
    valuesAt: (at) => {
      seen.push(at.value);
      return {
        ...metrics.evaluate(entities(), { at }),
        /* A deliberately distinctive figure: if the card compares against the
           workspace's previous instead, the delta cannot come out at this. */
        previous: { 'ads.spend': 0 },
      };
    },
  });
  assert.deepEqual(seen, ['meta', 'google'], 'the scoped evaluation was not asked for per card');
});

test('a card whose grain cannot be evaluated falls back rather than inventing one', () => {
  /* `valuesAt` returning null is a screen that could not narrow — the card
     drops to the workspace evaluation it would have had before, never to a
     blank or a zero. */
  const out = resolve.resolve(atPayload(), {
    values: { 'ads.spend': 27991774 },
    useRegistryValues: true,
    valuesAt: () => null,
  }).miniKpis;

  assert.equal(out[0].value, out[2].value, 'a card that could not be narrowed did not fall back');
  assert.equal(out[0].metricAt, undefined, 'a card claimed a grain it was never evaluated at');
});
