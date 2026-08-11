/* Phase 4 sub-phase 4.6 — the ingested repository driver.
 *
 *   node --test        or        npm test
 *
 * The projections are pure functions of canonical entities, so most of this
 * runs on a hand-built entity set rather than the fixtures: a test that broke
 * whenever someone edited a fixture would stop being a test of the projection.
 * The two integration tests at the end deliberately do use the real store,
 * because "every screen renders and the schema passes" is the sub-phase's
 * stated exit criterion and cannot be checked against a stub.
 */

const test = require('node:test');
const assert = require('node:assert');

const { PROJECTIONS, coverage, money, count, NONE } = require('../lib/repository/projections');
const { IngestedRepository } = require('../lib/repository/ingested');
const { createRepository } = require('../lib/repository');
const campaignSchema = require('../schemas/campaigns.json');
const leadSchema = require('../schemas/leads.json');

/* Two days of one campaign, a lead the CRM attributed to it, and the booking
   that lead became — the shortest path that exercises the whole join. */
const entities = () => ({
  campaignDays: [
    { entity: 'campaignDay', campaign: 'munnar honeymoon jul', label: 'Munnar Honeymoon Jul', date: '2026-07-15', platform: 'meta_ads', spend: 682050, impressions: 141900, clicks: 2980, leads: 19 },
    { entity: 'campaignDay', campaign: 'munnar honeymoon jul', label: 'Munnar Honeymoon Jul', date: '2026-07-14', platform: 'meta_ads', spend: 700000, impressions: 148200, clicks: 3140, leads: 21 },
    { entity: 'campaignDay', campaign: 'brand search', label: 'Brand Search', date: '2026-07-14', platform: 'google_ads', spend: 203000, impressions: 14100, clicks: 1640, leads: 14 },
  ],
  leads: [
    { entity: 'lead', id: 'L-1', name: 'George Kurien', phone: '+919847000001', property: 'Munnar Hillside', campaign: 'munnar honeymoon jul', owner: 'Vivek S', stage: 'Booked' },
    { entity: 'lead', id: 'L-2', name: 'Anjali Menon', phone: '+919847000002', property: 'Munnar Hillside', campaign: 'munnar honeymoon jul', owner: 'Reshma K', stage: 'Qualified' },
  ],
  bookings: [
    { entity: 'booking', id: 'B-1', leadId: 'L-1', revenue: { value: 4280000 }, settled: { value: 4280000 } },
  ],
  payments: [],
});

/* ── money and scale ────────────────────────────────────────────────────── */

test('money reads paise, because that is what canonical entities carry', () => {
  assert.equal(money(4280000), '₹42,800', 'a ₹42,800 folio rendered as something else');
  assert.equal(money(34600), '₹346');
  assert.equal(money(1500000000), '₹150.00L', 'lakh notation broke on a large figure');
  assert.equal(money(null), NONE, 'a missing figure was rendered as ₹0');
});

test('a hundred-times error would be visible, not plausible', () => {
  /* The first version of this file formatted paise as rupees. Every figure was
     100x too large and every one of them still looked like a real number. */
  assert.notEqual(money(4280000), '₹42.80L');
});

test('counts stay counts — impressions are not money', () => {
  assert.equal(count(290100), '2.9L');
  assert.equal(count(14100), '14,100');
});

/* ── campaigns ──────────────────────────────────────────────────────────── */

test('a campaign totals its days', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  const munnar = campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  assert.equal(munnar.spend, '₹13,821', '682050 + 700000 paise is ₹13,820.50');
  assert.equal(munnar.leads, '40');
  assert.equal(munnar.impr, '2.9L');
});

test('CTR and CPL are computed, not carried', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  const munnar = campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  assert.equal(munnar.ctr, '2.11%', '6120 clicks over 290100 impressions');
  assert.equal(munnar.cpl, '₹346', '₹13,820.50 over 40 leads');
});

test('revenue reaches a campaign only through the CRM lead', () => {
  /* The ad platform never sees a booking and the PMS never sees a campaign. */
  const { campRows } = PROJECTIONS.campaigns(entities());
  const munnar = campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  assert.equal(munnar.bookings, '1');
  assert.equal(munnar.rev, '₹42,800');
  assert.equal(munnar.roas, '3.1x');
});

test('a campaign with no booking says so rather than reporting zero', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  const brand = campRows.find((r) => r.name === 'Brand Search');
  assert.equal(brand.rev, NONE, 'no closed booking was reported as ₹0 revenue');
  assert.equal(brand.roas, NONE, 'a campaign with no revenue was given a ROAS');
});

test('a booking whose lead is unknown is not credited to a campaign', () => {
  const e = entities();
  e.bookings[0].leadId = null;
  const munnar = PROJECTIONS.campaigns(e).campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  assert.equal(munnar.bookings, NONE);
});

test('two platforms on one campaign are both named', () => {
  const e = entities();
  e.campaignDays.push({ ...e.campaignDays[0], platform: 'google_ads', date: '2026-07-16' });
  const munnar = PROJECTIONS.campaigns(e).campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  assert.equal(munnar.platform, 'Meta + Google');
});

/* ── sparklines ─────────────────────────────────────────────────────────── */

test('a sparkline is finite even for a single day', () => {
  const e = entities();
  const brand = PROJECTIONS.campaigns(e).campRows.find((r) => r.name === 'Brand Search');
  const numbers = brand.spark.split(/[ ,]/).map(Number);
  assert.ok(numbers.every(Number.isFinite), `single-day sparkline produced ${brand.spark}`);
});

test('a sparkline is scaled to the series, not drawn in rupees', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  const ys = campRows.flatMap((r) => r.spark.split(' ').map((p) => Number(p.split(',')[1])));
  assert.ok(ys.every((y) => y >= 0 && y <= 30), `a point fell outside the 0–30 viewbox: ${Math.min(...ys)}..${Math.max(...ys)}`);
});

test('a sparkline runs forward in time whatever order the store replayed', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  const munnar = campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  const [first, second] = munnar.spark.split(' ').map((p) => Number(p.split(',')[1]));
  /* Jul 14 spent more than Jul 15, and a lower y is a higher value. */
  assert.ok(first < second, 'the later day was plotted first');
});

/* ── leads ──────────────────────────────────────────────────────────────── */

test('a lead shows the campaign label, not the join key', () => {
  const { leadRows } = PROJECTIONS.leads(entities());
  assert.equal(leadRows[0].campaign, 'Munnar Honeymoon Jul');
  assert.ok(!leadRows.some((r) => r.campaign === 'munnar honeymoon jul'), 'a raw join key reached the screen');
});

test('a lead\'s value is its booking\'s settled revenue, or nothing', () => {
  const { leadRows } = PROJECTIONS.leads(entities());
  assert.equal(leadRows.find((r) => r.name === 'George Kurien').value, '₹42,800');
  assert.equal(leadRows.find((r) => r.name === 'Anjali Menon').value, NONE, 'a lead with no booking was given a value');
});

test('the platform is joined through the campaign', () => {
  const { leadRows } = PROJECTIONS.leads(entities());
  assert.equal(leadRows[0].platform, 'Meta');
});

/* ── declining, rather than borrowing ───────────────────────────────────── */

test('a field the entities cannot answer is declined, never filled in', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  for (const field of ['status', 'objective', 'health', 'pace', 'paceLabel']) {
    assert.equal(campRows[0][field], NONE, `${field} was given a value the entities cannot support`);
  }
  const { leadRows } = PROJECTIONS.leads(entities());
  for (const field of ['score', 'room', 'prob', 'check', 'followup']) {
    assert.equal(leadRows[0][field], NONE, `${field} was given a value the entities cannot support`);
  }
});

test('coverage is counted from the rows, not declared by hand', () => {
  const report = coverage(PROJECTIONS.campaigns(entities()));
  const rows = report.find((c) => c.collection === 'campRows');
  assert.equal(rows.rows, 2);
  assert.deepEqual(rows.declined.sort(), ['health', 'objective', 'pace', 'paceLabel', 'status']);
});

/* ── the schema still has to pass ───────────────────────────────────────── */

test('every schema-declared field is present on a derived row', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());
  for (const field of campaignSchema.fields.campRows.item) {
    assert.ok(field in campRows[0], `campRows is missing ${field} — the view would render a blank cell`);
  }
  const { leadRows } = PROJECTIONS.leads(entities());
  for (const field of leadSchema.fields.leadRows.item) {
    assert.ok(field in leadRows[0], `leadRows is missing ${field}`);
  }
});

/* ── the driver ─────────────────────────────────────────────────────────── */

const stub = () => ({
  name: 'stub',
  calls: [],
  async screens() { this.calls.push('screens'); return [{ slug: '', view: 'dashboard', name: 'Dash', icon: 'i' }]; },
  async navigation() { this.calls.push('navigation'); return ['nav']; },
  async subviewGroups() { this.calls.push('subviewGroups'); return ['groups']; },
  async resources() { return ['campaigns']; },
  async read(resource) { return { fromStatic: true, resource, campRows: [{ name: 'authored' }] }; },
});

test('structure comes from the design, not from the sources', async () => {
  const fallback = stub();
  const repo = new IngestedRepository(fallback);
  assert.deepEqual(await repo.navigation('x'), ['nav']);
  assert.deepEqual(await repo.subviewGroups('dashboard'), ['groups']);
  assert.ok(fallback.calls.includes('navigation') && fallback.calls.includes('subviewGroups'));
});

test('a resource with no projection passes through untouched', async () => {
  const repo = new IngestedRepository(stub());
  const payload = await repo.read('reports', {});
  assert.equal(payload.fromStatic, true);
  assert.equal(payload.resource, 'reports');
});

test('a projected resource keeps the design\'s scaffolding and replaces the rows', async () => {
  const repo = new IngestedRepository(stub());
  repo._entities = entities();
  const payload = await repo.read('campaigns', {});
  assert.equal(payload.fromStatic, true, 'the screen lost the structure the design supplies');
  assert.ok(!payload.campRows.some((r) => r.name === 'authored'), 'an authored row survived into an ingested screen');
  assert.equal(payload.campRows.length, 2);
});

/* ── exit criterion, against the real store ─────────────────────────────── */

test('LEADINTEL_REPO=ingested answers every resource the static driver does', async () => {
  const ingested = createRepository({ driver: 'ingested' });
  const fallback = createRepository({ driver: 'static' });

  for (const resource of await fallback.resources()) {
    const payload = await ingested.read(resource, {});
    assert.ok(payload !== null, `ingested returned nothing for "${resource}"`);
  }
});

test('the real fixtures produce the folio figure the 4.4 precedence test settled on', async () => {
  /* Told that nothing is connected, because that is the state this asserts
     about: the fixtures. A connected source retires its demo rows, so on a
     machine where Meta happens to be connected — every deployed one — the
     fixture campaign this reads is correctly gone, and the test would be
     failing about the wrong thing. */
  const repo = createRepository({ driver: 'ingested', connections: { configured: () => new Set() } });
  const { campRows } = await repo.read('campaigns', {});
  const munnar = campRows.find((r) => r.name === 'Munnar Honeymoon Jul');
  /* B-1001 settles at the PMS folio's ₹42,800, not the CRM's ₹46,000 — the
     precedence decision made in 4.4, now visible on a screen. */
  assert.equal(munnar.rev, '₹42,800');
});

/* ── a connected source stops serving demo data ─────────────────────────── */

/* Waiting for real rows was not enough. Google Ads was connected and refused on
   every attempt, so it had none — and two invented campaigns stayed in the
   table beside three real ones, under a banner saying Google was down. */
test('connecting a source retires its demo rows before it ever succeeds', async () => {
  const asked = createRepository({
    driver: 'ingested',
    connections: { configured: () => new Set(['google_ads']) },
  });
  const { campRows } = await asked.read('campaigns', {});

  assert.ok(!campRows.some((r) => /Brand Search|Kumarakom/i.test(r.name)),
    'a connected source still served invented campaigns');
});

test('an unconnected source keeps its demo rows, which is what demo mode is', async () => {
  const repo = createRepository({ driver: 'ingested', connections: { configured: () => new Set() } });
  const { campRows } = await repo.read('campaigns', {});

  assert.ok(campRows.some((r) => /Brand Search/i.test(r.name)),
    'nothing is connected, so the fixtures should still show');
});

/* ── which campaign the drill-down is about ─────────────────────────────── */

/* `metricScope` sets the grain every KPI card on the drill-down is evaluated
   at, and it was a constant in the authored data pointing at a demo campaign.
   Once the demo rows stopped replaying, that page read Spend ₹0 over a name
   from the fixtures — and every row linked to it without saying which campaign
   it meant, so all of them opened the same dead page. */

test('a campaign row links to itself, not to the bare drill-down', () => {
  const { campRows } = PROJECTIONS.campaigns(entities());

  for (const row of campRows) {
    assert.match(row.go, /[?&]campaign=/, `"${row.name}" does not name itself in its link`);
  }
  const brand = campRows.find((r) => r.name === 'Brand Search');
  assert.equal(brand.go, '/campaigns?v=campDetail&campaign=brand%20search');
});

test('the drill-down is scoped to the campaign the link named', () => {
  const payload = PROJECTIONS.campaigns(entities(), { campaign: 'brand search' });

  assert.deepEqual(payload.metricScope, { dimension: 'campaign', value: 'brand search' });
  assert.equal(payload.dName, 'Brand Search');
});

test('two different campaigns do not open the same page', () => {
  const a = PROJECTIONS.campaigns(entities(), { campaign: 'brand search' });
  const b = PROJECTIONS.campaigns(entities(), { campaign: 'munnar honeymoon jul' });

  assert.notDeepEqual(a.metricScope, b.metricScope);
  assert.notEqual(a.dName, b.dName);
});

test('a stale link opens a campaign rather than an empty panel', () => {
  const payload = PROJECTIONS.campaigns(entities(), { campaign: 'a campaign that was retired' });

  assert.equal(payload.metricScope.dimension, 'campaign');
  assert.ok(payload.metricScope.value, 'fell back to nothing instead of to a campaign');
  assert.equal(payload.dName, 'Munnar Honeymoon Jul', 'the first row, as the creative overlay does');
});

/* The case that caused the bug: no ad data at all. */
test('with no campaigns the cards decline rather than showing the workspace', () => {
  const empty = { ...entities(), campaignDays: [] };
  const payload = PROJECTIONS.campaigns(empty, {});

  assert.deepEqual(payload.campRows, []);
  /* Not absent — an absent scope is workspace grain, which would print total
     spend on a single campaign's page. */
  assert.deepEqual(payload.metricScope, { dimension: 'campaign', value: '' });
});

/* ── the Ad sets tab ────────────────────────────────────────────────────── */

/* It rendered "No ad sets — needs an ads connector that pulls ad-set rows"
   while Meta had been pulling `adset_day` on every sync. The rows existed and
   nothing built a table from them, so the empty state blamed a connector that
   was working. */

const adsetEntities = () => {
  const canonical = require('../lib/ingest/canonical');
  const day = (id, name, date, spend, impr, clicks) => ({
    source: 'meta_ads', kind: 'adset_day', externalId: `${id}:${date}`,
    body: {
      adset_id: id, adset_name: name, campaign_id: '120215', date_start: date,
      account_currency: 'INR', spend: String(spend), impressions: String(impr),
      clicks: String(clicks), actions: [{ action_type: 'lead', value: '9' }],
    },
  });

  return canonical.build([
    day('AS1', 'Broad | Kerala', '2026-08-01', 1200, 40000, 600),
    day('AS1', 'Broad | Kerala', '2026-08-02', 1300, 42000, 640),
    day('AS2', 'All 60 Days KL', '2026-08-01', 800, 15000, 300),
    {
      source: 'meta_ads', kind: 'adset', externalId: 'AS2',
      body: { id: 'AS2', name: 'All 60 Days KL', targeting: { custom_audiences: [{ id: 'A9' }] } },
    },
    {
      source: 'meta_ads', kind: 'audience', externalId: 'A9',
      body: { id: 'A9', name: '50% Watchers 60 days', retention_days: 60 },
    },
  ]);
};

test('an ad set becomes a row, with its days totalled', () => {
  const { adsetRows } = PROJECTIONS.campaigns(adsetEntities(), {});

  assert.equal(adsetRows.length, 2, 'one row per ad set, not per day');
  const broad = adsetRows.find((r) => r.name === 'Broad | Kerala');
  assert.equal(broad.spend, '₹2,500', 'two days of spend added');
  assert.equal(broad.ctr, '1.51%');
  assert.equal(broad.leads, '18');
});

test('the audience is the ad set’s own, named where the audience was fetched', () => {
  const { adsetRows } = PROJECTIONS.campaigns(adsetEntities(), {});
  const warm = adsetRows.find((r) => r.name === 'All 60 Days KL');

  assert.equal(warm.audience, '50% Watchers 60 days');
});

test('columns nothing measured decline rather than reading zero', () => {
  const { adsetRows } = PROJECTIONS.campaigns(adsetEntities(), {});

  for (const row of adsetRows) {
    /* Frequency is impressions over reach and reach does not add across days;
       bookings and revenue need the CRM and the PMS. */
    assert.equal(row.freq, NONE, 'frequency cannot be derived from daily rows');
    assert.equal(row.placement, NONE);
    assert.equal(row.bookings, NONE);
    assert.equal(row.rev, NONE);
    assert.equal(row.roas, NONE);
  }
});

test('ad set days narrow with the date range, like campaign days', () => {
  const period = require('../lib/metrics/period');
  const narrowed = period.within(adsetEntities(), { from: '2026-08-02', to: '2026-08-03' });
  const { adsetRows } = PROJECTIONS.campaigns(narrowed, {});

  assert.equal(adsetRows.length, 1, 'only the ad set that ran that day');
  assert.equal(adsetRows[0].spend, '₹1,300');
});

test('a stacked ad set is named by its largest pool, not by all of them', () => {
  const canonical = require('../lib/ingest/canonical');
  const e = canonical.build([
    {
      source: 'meta_ads', kind: 'adset_day', externalId: 'AS3:2026-08-01',
      body: {
        adset_id: 'AS3', adset_name: 'All 60 Days KL', date_start: '2026-08-01',
        account_currency: 'INR', spend: '900', impressions: '20000', clicks: '300',
      },
    },
    {
      source: 'meta_ads', kind: 'adset', externalId: 'AS3',
      body: { id: 'AS3', name: 'All 60 Days KL', targeting: { custom_audiences: [{ id: 'HOT' }, { id: 'BIG' }] } },
    },
    {
      source: 'meta_ads', kind: 'audience', externalId: 'HOT',
      body: { id: 'HOT', name: '75% Watchers 30 Days', retention_days: 30, approximate_count_lower_bound: 3900 },
    },
    {
      source: 'meta_ads', kind: 'audience', externalId: 'BIG',
      body: { id: 'BIG', name: '50% Watchers 60 days', retention_days: 60, approximate_count_lower_bound: 53400 },
    },
  ]);

  const [row] = PROJECTIONS.campaigns(e, {}).adsetRows;
  /* The larger, older pool — the one the ad set actually delivers to. */
  assert.equal(row.audience, '50% Watchers 60 days +1 more');
});

/* ── the Ads tab ────────────────────────────────────────────────────────── */

/* Same story as the Ad sets tab: `creatives` is already a canonical collection
   joining the ads edge to ad-level insights — the Creative Intelligence screen
   reads it — and the campaign screen's Ads tab declined anyway. */

const adEntities = () => {
  const canonical = require('../lib/ingest/canonical');
  const adDay = (id, name, date, spend, impr, clicks) => ({
    source: 'meta_ads', kind: 'ad_day', externalId: `${id}:${date}`,
    body: {
      ad_id: id, ad_name: name, adset_id: 'AS1', date_start: date, account_currency: 'INR',
      spend: String(spend), impressions: String(impr), clicks: String(clicks),
    },
  });

  return canonical.build([
    {
      source: 'meta_ads', kind: 'creative', externalId: 'AD1',
      body: { id: 'AD1', name: 'Monsoon 15s', object_type: 'VIDEO', image_url: 'https://x/i.jpg' },
    },
    {
      source: 'meta_ads', kind: 'creative', externalId: 'AD2',
      body: { id: 'AD2', name: 'Cliff villa still', object_type: 'PHOTO' },
    },
    adDay('AD1', 'Monsoon 15s', '2026-08-01', 900, 30000, 450),
    adDay('AD1', 'Monsoon 15s', '2026-08-02', 1100, 34000, 520),
    adDay('AD2', 'Cliff villa still', '2026-08-01', 400, 12000, 150),
  ]);
};

test('an ad becomes a card, with its days totalled', () => {
  const { adRows } = PROJECTIONS.campaigns(adEntities(), {});

  assert.equal(adRows.length, 2);
  assert.equal(adRows[0].name, 'Monsoon 15s');
  assert.equal(adRows[0].spend, '₹2,000');
  assert.equal(adRows[0].ctr, '1.52%');
});

test('the biggest spender is first, and nothing is truncated', () => {
  const { adRows } = PROJECTIONS.campaigns(adEntities(), {});
  const spends = adRows.map((a) => a.spend);

  assert.deepEqual(spends, ['₹2,000', '₹400']);
  assert.equal(adRows.length, 2, 'the design draws three cards; the account decides how many exist');
});

test('a video and an image are told apart by Meta’s own object type', () => {
  const { adRows } = PROJECTIONS.campaigns(adEntities(), {});

  assert.equal(adRows.find((a) => a.name === 'Monsoon 15s').type, 'Video');
  assert.equal(adRows.find((a) => a.name === 'Cliff villa still').type, 'Image');
});

test('a still is proxied into the card, and an ad without one keeps the gradient', () => {
  const { adRows } = PROJECTIONS.campaigns(adEntities(), {});

  assert.match(adRows.find((a) => a.name === 'Monsoon 15s').grad, /^url\('\/creatives\/AD1\/thumbnail\?v=/);
  /* Degrades to a coloured card rather than to a broken-image icon. */
  assert.match(adRows.find((a) => a.name === 'Cliff villa still').grad, /^linear-gradient/);
});

test('ad copy and engagement are declined, not invented', () => {
  const { adRows } = PROJECTIONS.campaigns(adEntities(), {});

  for (const ad of adRows) {
    /* The copy lives in `object_story_spec`, which no request asks for. */
    assert.equal(ad.body, NONE);
    assert.equal(ad.cta, NONE);
    assert.equal(ad.comments, NONE);
    assert.equal(ad.shares, NONE);
    assert.equal(ad.freq, NONE);
    assert.equal(ad.rev, NONE);
  }
});
