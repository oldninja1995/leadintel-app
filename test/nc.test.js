/* NC — the leads paid media produced that the phone never reached.
 *
 *   node --test        or        npm test
 *
 * Three things are defended here, and each one is a way the number goes quietly
 * wrong rather than visibly missing.
 *
 * That NC means the four call dispositions and nothing adjacent to them: "Not
 * interested" is a lead that WAS reached, and one loose pattern would move it
 * into the same tile.
 *
 * That the count is people rather than enquiries. One unreachable number that
 * writes in every day is one unreachable customer, and the deduplication that
 * makes that true cannot live in the metric — a metric only sees the selected
 * window, and the earlier enquiries are outside it. So it is stamped in
 * canonical.js over the whole store and asserted here end to end.
 *
 * And that both halves of the rate are the same unit. Deduplicating one side
 * only would divide people by enquiries and print a rate wrong by whatever the
 * repeat rate was that month — wrong, and moving, so it would read as a trend.
 */

const test = require('node:test');
const assert = require('node:assert');

const metrics = require('../lib/metrics');
const registry = require('../lib/metrics/registry');
const canonical = require('../lib/ingest/canonical');
const resolve = require('../lib/metrics/resolve');
const scope = require('../lib/metrics/scope');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.parse('2026-08-16T00:00:00.000Z') - msAgo).toISOString();

/* Leads as canonical builds them, straight into the metric layer. */
const lead = (over) => ({
  entity: 'lead', id: 'L', phone: null, email: null, createdAt: iso(0),
  stage: 'Fresh', channel: 'meta', campaign: null, adId: null, ...over,
});

/* The customer stamping is canonical's, so exercise it rather than hand-writing
   `customer` keys the real build might not agree with. */
function stamped(leads) {
  const records = leads.map((l, i) => ({
    source: 'telecrm', kind: 'lead', externalId: l.id || `L-${i}`, checksum: 'x', transport: 'fixture',
    body: {
      lead_id: l.id || `L-${i}`, name: l.name || 'Guest', phone: l.phone, email: l.email,
      created_at: l.createdAt, stage: l.stage, owner: null,
      utm_campaign: l.campaign, ad_id: l.adId, property: null, channel: l.channel,
    },
  }));
  return canonical.build(records).leads;
}

/* ── what counts as NC ──────────────────────────────────────────────────── */

test('the four call dispositions are NC and nothing else is', () => {
  for (const stage of ['Ringing no answer', 'Not available', 'Busy', 'Switched off']) {
    assert.equal(registry.isNotConnected(stage), true, `${stage} should be NC`);
  }
});

test('a lead that was reached and said no is not NC', () => {
  /* The expensive near miss: /not/ would swallow this, and "Not interested" is
     the opposite outcome — a conversation happened. */
  assert.equal(registry.isNotConnected('Not interested'), false);
});

test('un-attempted and junk are each a different finding from unreachable', () => {
  assert.equal(registry.isNotConnected('Fresh'), false);
  assert.equal(registry.isNotConnected('Suspected Spam'), false);
});

test('casing and stray spacing do not change the answer', () => {
  assert.equal(registry.isNotConnected('  RINGING   NO ANSWER '), true);
});

test('an unrecognised status is not NC, so the figure understates', () => {
  assert.equal(registry.isNotConnected('Ringing - no answer'), false);
  assert.equal(registry.isNotConnected(''), false);
  assert.equal(registry.isNotConnected(null), false);
});

/* ── people, not enquiries ──────────────────────────────────────────────── */

test('one unreachable number that enquires four times is one NC customer', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '+91 98765 43210', stage: 'Ringing no answer', createdAt: iso(3 * DAY) }),
    lead({ id: 'L-2', phone: '098765 43210', stage: 'Ringing no answer', createdAt: iso(2 * DAY) }),
    lead({ id: 'L-3', phone: '9876543210', stage: 'Switched off', createdAt: iso(1 * DAY) }),
    lead({ id: 'L-4', phone: '+91 97000 00000', stage: 'Busy', createdAt: iso(1 * DAY) }),
  ]);
  const { values } = metrics.evaluate({ leads, campaignDays: [], bookings: [], payments: [], deals: [] });

  assert.equal(values['leads.nc_customers'], 2, 'three spellings of one number are one person');
  assert.equal(values['leads.ad_customers'], 2);
  assert.equal(values['leads.nc_rate'], 1);
});

test('the same number past the lookback horizon is a new customer', () => {
  /* 400 days apart is not one continuing conversation, and treating it as one
     would deflate every count that follows it. */
  const leads = stamped([
    lead({ id: 'L-1', phone: '9876543210', stage: 'Busy', createdAt: iso(400 * DAY) }),
    lead({ id: 'L-2', phone: '9876543210', stage: 'Busy', createdAt: iso(1 * DAY) }),
  ]);
  assert.notEqual(leads[0].customer, leads[1].customer);
  assert.equal(leads.find((l) => l.id === 'L-2').repeat, false);
});

test('the same number inside the horizon is one customer, and the later lead is a repeat', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9876543210', stage: 'Busy', createdAt: iso(300 * DAY) }),
    lead({ id: 'L-2', phone: '9876543210', stage: 'Busy', createdAt: iso(1 * DAY) }),
  ]);
  const first = leads.find((l) => l.id === 'L-1');
  const second = leads.find((l) => l.id === 'L-2');

  assert.equal(first.customer, second.customer);
  assert.equal(first.repeat, false, 'the first enquiry is nobody\'s repeat');
  assert.equal(second.repeat, true);
  assert.equal(second.firstEnquiryAt, first.createdAt);
});

test('a lead with no phone and no email is its own customer, never merged', () => {
  /* Two anonymous enquiries are not evidence of one person. A shared synthetic
     key would collapse them and under-count. */
  const leads = stamped([
    lead({ id: 'L-1', phone: null, email: null, stage: 'Busy' }),
    lead({ id: 'L-2', phone: null, email: null, stage: 'Busy' }),
  ]);
  assert.notEqual(leads[0].customer, leads[1].customer);

  const { values } = metrics.evaluate({ leads, campaignDays: [], bookings: [], payments: [], deals: [] });
  assert.equal(values['leads.nc_customers'], 2);
});

test('email identifies a person when the phone is missing', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: null, email: 'Guest@Example.com', stage: 'Busy', createdAt: iso(2 * DAY) }),
    lead({ id: 'L-2', phone: null, email: 'guest@example.com', stage: 'Busy', createdAt: iso(1 * DAY) }),
  ]);
  assert.equal(leads[0].customer, leads[1].customer);
});

/* ── ads only ───────────────────────────────────────────────────────────── */

test('an untagged lead is outside the count AND outside the base', () => {
  /* A walk-in that never answered is a real number and a different question.
     Leaving it in the base only would deflate the rate without anybody
     deciding to. */
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', channel: 'meta', stage: 'Busy' }),
    lead({ id: 'L-2', phone: '9000000002', channel: null, stage: 'Busy' }),
    lead({ id: 'L-3', phone: '9000000003', channel: 'meta', stage: 'Interested' }),
  ]);
  const { values } = metrics.evaluate({ leads, campaignDays: [], bookings: [], payments: [], deals: [] });

  assert.equal(values['leads.ad_customers'], 2, 'the untagged lead is not in the base');
  assert.equal(values['leads.nc_customers'], 1);
  assert.equal(values['leads.nc_rate'], 0.5);
});

test('the channel chip narrows it further, so Meta alone is a selection', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', channel: 'meta', stage: 'Busy' }),
    lead({ id: 'L-2', phone: '9000000002', channel: 'google', stage: 'Busy' }),
    lead({ id: 'L-3', phone: '9000000003', channel: 'meta', stage: 'Interested' }),
  ]);
  const entities = { leads, campaignDays: [], bookings: [], payments: [], deals: [], leadEvents: [], inventoryDays: [] };

  const all = metrics.evaluate(entities).values;
  const meta = metrics.evaluate(entities, { at: { dimension: 'channel', value: 'meta' } }).values;

  assert.equal(all['leads.nc_customers'], 2);
  assert.equal(meta['leads.nc_customers'], 1);
  assert.equal(meta['leads.ad_customers'], 2);
});

test('every ad-only metric really does filter on a paid channel', () => {
  /* What keeps the hand-written list in resolve.js honest: each id named there
     must ignore a lead with no channel. Without this the list rots into ids
     that are hidden on Non-ad for no reason anybody can find. */
  const untagged = stamped([lead({ id: 'L-1', phone: '9000000001', channel: null, stage: 'Busy' })]);
  const { values } = metrics.evaluate({ leads: untagged, campaignDays: [], bookings: [], payments: [], deals: [] });

  for (const id of ['leads.ad_customers', 'leads.nc_customers']) {
    assert.equal(values[id], 0, `${id} counted an untagged lead`);
  }
  assert.equal(values['leads.nc_rate'], null, 'a rate over nothing is unknown, not zero');
});

/* ── where the tiles show ───────────────────────────────────────────────── */

test('the NC tiles are hidden on the Non-ad view, where they are a structural zero', () => {
  const payload = {
    kpis: [
      { metric: 'leads.nc_customers', label: 'NC customers', value: '—' },
      { metric: 'leads.nc_rate', label: 'NC rate', value: '—' },
      { metric: 'leads.count', label: 'Leads', value: '—' },
    ],
  };
  const nonAd = resolve.resolve(payload, {
    valuesFor: () => ({}), at: { dimension: 'channel', value: 'non-ad' },
  });
  const labels = (out) => (out.kpis || []).map((c) => c.label);

  assert.deepEqual(labels(nonAd), ['Leads'], 'only the CRM-wide count survives Non-ad');
});

test('they are shown unfiltered and under a paid channel', () => {
  const payload = { kpis: [{ metric: 'leads.nc_customers', label: 'NC customers', value: '—' }] };

  for (const at of [null, { dimension: 'channel', value: 'meta' }]) {
    const out = resolve.resolve(payload, { valuesFor: () => ({}), at });
    assert.equal((out.kpis || []).length, 1, `hidden at ${JSON.stringify(at)}`);
  }
});

test('the metrics are answerable at every grain the leads collection supports', () => {
  for (const id of ['leads.ad_customers', 'leads.nc_customers']) {
    assert.equal(scope.supports(id, 'channel', 'meta'), true);
    assert.equal(scope.supports(id, 'campaign', 'monsoon'), true);
  }
});
