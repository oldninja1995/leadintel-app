/* Phase 6 sub-phase 6.5 — evaluating the registry at a grain.
 *
 *   node --test        or        npm test
 *
 * The point under test is not filtering. It is that a metric which cannot be
 * narrowed by the requested dimension comes back marked **not applicable**,
 * rather than as zero or as the workspace figure quietly reused. A campaign
 * page showing workspace occupancy would be wrong in a way nobody would catch,
 * which is exactly the class of error this file exists to prevent.
 */

const test = require('node:test');
const assert = require('node:assert');

const scope = require('../lib/metrics/scope');
const metrics = require('../lib/metrics');
const registry = require('../lib/metrics/registry');
const ingest = require('../lib/ingest');

const entities = () => ({
  campaignDays: [
    { campaign: 'munnar', label: 'Munnar', platform: 'meta_ads', spend: 700000, impressions: 100000, clicks: 2000, leads: 20 },
    { campaign: 'brand', label: 'Brand', platform: 'google_ads', spend: 300000, impressions: 20000, clicks: 1000, leads: 10 },
  ],
  leads: [
    { id: 'L-1', campaign: 'munnar', property: 'Munnar Hillside', createdAt: '2026-07-14T00:00:00.000Z' },
    { id: 'L-2', campaign: 'brand', property: 'Kumarakom Retreat', createdAt: '2026-07-14T00:00:00.000Z' },
  ],
  bookings: [
    { id: 'B-1', leadId: 'L-1', property: 'Munnar Hillside', nights: 3, revenue: { value: 4280000 }, bookingStatus: 'Checked_in' },
    { id: 'B-2', leadId: null, property: 'Munnar Hillside', nights: 2, revenue: { value: 0 }, bookingStatus: 'Cancelled' },
  ],
  inventoryDays: [
    { id: 'P-MUN:2026-07-14', propertyId: 'P-MUN', property: 'Munnar Hillside', available: 42, sold: 33 },
    { id: 'P-ALP:2026-07-14', propertyId: 'P-ALP', property: null, available: 28, sold: 21 },
  ],
  leadEvents: [{ id: 'E-1', leadId: 'L-1', type: 'first_response', at: '2026-07-14T00:38:00.000Z' }],
  payments: [],
  problems: [],
});

/* ── what each metric reads ─────────────────────────────────────────────── */

test('the derived reads map matches what the metrics actually use', () => {
  /* `READS` is derived by running each source against a recording proxy, which
     would miss a collection read only inside a conditional. This explicit map
     is the safety net that makes that trick safe rather than merely clever —
     if it ever disagrees, the derivation is wrong, not this list. */
  const expected = {
    'ads.spend': ['campaignDays'],
    'ads.impressions': ['campaignDays'],
    'ads.clicks': ['campaignDays'],
    'ads.reported_leads': ['campaignDays'],
    'revenue.net': ['bookings'],
    'bookings.confirmed': ['bookings'],
    'bookings.all': ['bookings'],
    'bookings.cancelled': ['bookings'],
    'stay.room_nights': ['bookings'],
    'leads.count': ['leads'],
    'leads.open': ['leads'],
    'leads.lost': ['leads'],
    'leads.unanswered': ['leadEvents', 'leads'],
    'inventory.available': ['inventoryDays'],
    'inventory.sold': ['inventoryDays'],
    'lead.response_minutes': ['leadEvents', 'leads'],
  };

  for (const [id, collections] of Object.entries(expected)) {
    assert.deepEqual(scope.READS[id], collections, `${id} reads something other than expected`);
  }
});

test('a derived metric reads the union of what it depends on', () => {
  assert.deepEqual(scope.READS['roas.net'], ['bookings', 'campaignDays']);
  assert.deepEqual(scope.READS['rate.revpar'], ['bookings', 'inventoryDays']);
});

/* ── where a metric is answerable ───────────────────────────────────────── */

test('occupancy is not a campaign question', () => {
  /* A property's rooms are not attributable to the ad that sold one of them. */
  assert.equal(scope.supports('occupancy.rate', 'campaign'), false);
  assert.equal(scope.supports('occupancy.rate', 'property'), true);
});

test('ad spend is not a property question', () => {
  assert.equal(scope.supports('ads.spend', 'property'), false);
  assert.equal(scope.supports('ads.spend', 'campaign'), true);
  assert.equal(scope.supports('ads.spend', 'channel'), true);
});

test('a metric spanning two collections is answerable only where both are', () => {
  /* ROAS reads bookings and campaignDays. Bookings can be narrowed by
     property, campaign days cannot — so ROAS by property is not a question
     this registry answers. */
  assert.equal(scope.supports('roas.net', 'campaign'), true);
  assert.equal(scope.supports('roas.net', 'property'), false);
  assert.equal(scope.supports('roas.net', 'channel'), false);
});

test('a ratio is never computed from one narrowed and one workspace-wide input', () => {
  for (const metric of registry.list()) {
    for (const dimension of scope.DIMENSIONS) {
      if (!scope.supports(metric.id, dimension)) continue;
      for (const collection of scope.READS[metric.id]) {
        assert.ok((scope.SCOPEABLE[collection] || []).includes(dimension),
          `${metric.id} claims to answer by ${dimension} while reading ${collection}, which cannot be narrowed by it`);
      }
    }
  }
});

/* ── narrowing ──────────────────────────────────────────────────────────── */

test('a campaign narrows its own days and leads', () => {
  const narrowed = scope.scope(entities(), 'campaign', 'munnar');
  assert.deepEqual(narrowed.campaignDays.map((d) => d.campaign), ['munnar']);
  assert.deepEqual(narrowed.leads.map((l) => l.id), ['L-1']);
});

test('a booking reaches a campaign only through its lead', () => {
  /* B-2 has no lead, so no campaign can claim it — the same join stage 3
     makes, and the same reason an unresolved booking is uncredited revenue. */
  const narrowed = scope.scope(entities(), 'campaign', 'munnar');
  assert.deepEqual(narrowed.bookings.map((b) => b.id), ['B-1']);
});

test('a property narrows bookings and inventory on the same key', () => {
  /* The bug this caught: inventory rows carry the property id (`P-MUN`) and
     bookings carry the name, so occupancy for a property read zero available
     rooms until canonical resolved one to the other. */
  const narrowed = scope.scope(entities(), 'property', 'Munnar Hillside');
  assert.deepEqual(narrowed.bookings.map((b) => b.id), ['B-1', 'B-2']);
  assert.equal(narrowed.inventoryDays.length, 1, 'inventory did not join on the property name');
  assert.equal(narrowed.inventoryDays[0].available, 42);
});

test('a channel narrows ad days and nothing else', () => {
  const narrowed = scope.scope(entities(), 'channel', 'google');
  assert.deepEqual(narrowed.campaignDays.map((d) => d.campaign), ['brand']);
  assert.deepEqual(narrowed.inventoryDays, [], 'inventory was narrowed by a dimension it does not have');
});

test('an unknown dimension is refused', () => {
  assert.throws(() => scope.scope(entities(), 'room_type', 'Suite'), /unknown dimension/);
});

/* ── evaluating there ───────────────────────────────────────────────────── */

test('a campaign gets its own figures, not the workspace totals', () => {
  const e = entities();
  const whole = metrics.evaluate(e).values;
  const munnar = metrics.evaluate(e, { at: { dimension: 'campaign', value: 'munnar' } }).values;

  assert.equal(whole['ads.spend'], 1000000);
  assert.equal(munnar['ads.spend'], 700000, 'the campaign page would have shown workspace spend');
  assert.equal(munnar['leads.count'], 1);
});

test('a derived metric follows its inputs down to the grain, knowing nothing about campaigns', () => {
  const munnar = metrics.evaluate(entities(), { at: { dimension: 'campaign', value: 'munnar' } }).values;
  /* ₹42,800 of revenue over ₹7,000 of spend, both narrowed. */
  assert.equal(munnar['roas.net'], 4280000 / 700000);
});

test('a metric that is not a question at this grain is marked, not zeroed', () => {
  const { values, notApplicable } = metrics.evaluate(entities(), { at: { dimension: 'campaign', value: 'munnar' } });
  assert.ok(notApplicable.includes('occupancy.rate'));
  assert.equal(values['occupancy.rate'], null);
  assert.notEqual(values['occupancy.rate'], 0, 'a meaningless metric was answered with zero');
});

test('the report says which metrics are applicable', () => {
  const report = metrics.report(entities(), { at: { dimension: 'property', value: 'Munnar Hillside' } });
  const spend = report.metrics.find((m) => m.id === 'ads.spend');
  const occupancy = report.metrics.find((m) => m.id === 'occupancy.rate');

  assert.equal(spend.applicable, false);
  assert.equal(occupancy.applicable, true);
  assert.equal(occupancy.display, '79%');
});

test('an unscoped evaluation marks nothing inapplicable', () => {
  const { notApplicable } = metrics.evaluate(entities());
  assert.deepEqual(notApplicable, []);
});

/* ── grains on offer ────────────────────────────────────────────────────── */

test('only grains the entities actually hold are offered', () => {
  const grains = scope.available(entities());
  assert.deepEqual(grains.campaign.map((c) => c.key).sort(), ['brand', 'munnar']);
  assert.deepEqual(grains.channel.map((c) => c.key), ['google', 'meta']);
});

test('a property with no resolved name is not offered as a grain', () => {
  /* P-ALP appears in inventory but on no booking, so it has no name — listing
     the raw id beside real names would read as a fourth property. */
  const grains = scope.available(entities());
  assert.deepEqual(grains.property.map((p) => p.key), ['Munnar Hillside']);
  assert.ok(!grains.property.some((p) => p.key === 'P-ALP'));
});

/* ── against the real store ─────────────────────────────────────────────── */

test('the real fixtures scope to a campaign that matches the projection', () => {
  const e = ingest.snapshot({ store: ingest.storeFor('parakkat') });
  const at = { dimension: 'campaign', value: 'munnar honeymoon jul' };
  const report = metrics.report(e, { at });

  /* The same ₹13,821 and 3.1x the ingested campaigns table shows. */
  assert.equal(report.metrics.find((m) => m.id === 'ads.spend').display, '₹13,821');
  assert.equal(report.metrics.find((m) => m.id === 'roas.net').display, '3.1x');
});

test('the real fixtures scope to a property with inventory attached', () => {
  const report = metrics.report(ingest.snapshot({ store: ingest.storeFor('parakkat') }), { at: { dimension: 'property', value: 'Munnar Hillside' } });
  assert.equal(report.metrics.find((m) => m.id === 'inventory.available').display, '42');
  assert.equal(report.metrics.find((m) => m.id === 'occupancy.rate').display, '79%');
});

test('leads narrow by channel, so a cost per lead can be per platform', () => {
  /* The CRM holds organic leads beside paid ones, so blended CPL divided paid
     spend by all of them — a figure that improves when the website has a good
     week. */
  assert.ok(scope.SCOPEABLE.leads.includes('channel'));
  assert.equal(scope.supports('cost.per_lead', 'channel'), true);
});

test('an untagged lead belongs to no channel at all', () => {
  const entities = {
    campaignDays: [], leads: [
      { id: 'a', channel: 'meta' }, { id: 'b', channel: null }, { id: 'c', channel: 'google' },
    ], bookings: [], leadEvents: [], inventoryDays: [], payments: [], problems: [],
  };
  assert.deepEqual(scope.scope(entities, 'channel', 'meta').leads.map((l) => l.id), ['a']);
  assert.deepEqual(scope.scope(entities, 'channel', 'google').leads.map((l) => l.id), ['c']);
});

test('a deal carries the channel of the lead it came from, and narrows by it', () => {
  /* A deal has no channel of its own, and without one "revenue from Meta"
     cannot mean anything. */
  const entities = {
    campaignDays: [], leads: [], bookings: [], leadEvents: [], inventoryDays: [], payments: [], problems: [],
    deals: [{ id: 'd1', channel: 'meta', revenue: 14000 }, { id: 'd2', channel: null, revenue: 9000 }, { id: 'd3', channel: 'google', revenue: 5000 }],
  };
  assert.deepEqual(scope.scope(entities, 'channel', 'meta').deals.map((d) => d.id), ['d1']);
  /* Untagged counts under no channel, the same rule the leads follow. */
  assert.equal(scope.scope(entities, 'channel', 'google').deals.length, 1);
  assert.equal(scope.supports('revenue.reservations', 'channel'), true);
});

test('reservation value is not folded into net revenue', () => {
  /* The precedence table gives settled revenue to the PMS folio. A CRM figure
     answering a question about settled revenue is the merge this avoids. */
  const registry = require('../lib/metrics/registry');
  assert.deepEqual(registry.get('revenue.reservations').sources, ['crm']);
  assert.ok(!registry.get('revenue.net').sources.includes('crm')
    || registry.get('revenue.net').id !== 'revenue.reservations');
});
