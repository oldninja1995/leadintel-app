/* The Executive Dashboard, derived rather than authored.
 *
 *   node --test        or        npm test
 *
 * Every card on this screen was invented — a funnel ending at "Checked in ·
 * 398", six named campaigns, three properties with occupancy and ADR, four
 * reps with cancellation rates. The front page of the product was the least
 * trustworthy screen in it, and nothing on it said so.
 *
 * What these tests defend is not that the numbers are right — the projection is
 * arithmetic and the arithmetic is easy. It is that the cards which CANNOT be
 * answered decline instead of keeping the fixture underneath. The driver
 * spreads the projection over the authored payload, so every field left
 * undefined silently renders invented content, and that failure looks exactly
 * like success.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const canonical = require('../lib/ingest/canonical');
const projection = require('../lib/repository/dashboard-projection');
const { PROJECTIONS } = require('../lib/repository/projections');

const DAY = 86400000;
const BASE = Date.parse('2026-08-16T00:00:00.000Z');
const iso = (daysAgo) => new Date(BASE - daysAgo * DAY).toISOString();
const NOW = { now: '2026-08-16T00:00:00.000Z' };

const campaignDay = (over = {}) => ({
  source: 'meta_ads', kind: 'campaign_day', externalId: `cd-${over.date}-${over.campaign_name}`,
  checksum: 'x', transport: 'fixture',
  body: {
    campaign_id: 'C', campaign_name: 'Munnar Honeymoon', date: iso(1).slice(0, 10),
    spend: 1000, impressions: 900, clicks: 40, leads: 3, ...over,
  },
});

const leadRec = (over = {}) => ({
  source: 'telecrm', kind: 'lead', externalId: over.lead_id, checksum: 'x', transport: 'fixture',
  body: {
    lead_id: 'L', name: 'Guest', phone: '9000000001', created_at: iso(1), stage: 'Fresh',
    owner: 'Reshma Menon', utm_campaign: 'Munnar Honeymoon', channel: 'meta',
    property: 'Munnar Hillside', ...over,
  },
});

const dealRec = (over = {}) => ({
  source: 'telecrm', kind: 'deal', externalId: over.deal_id, checksum: 'x', transport: 'fixture',
  body: {
    deal_id: 'D', lead_id: 'L', value: 42800, currency: 'INR', stage: 'Won',
    outcome: 'won', booking_status: 'Confirmed', updated_at: iso(1), ...over,
  },
});

const build = (records) => canonical.build(records);
const empty = () => canonical.build([]);

/* ── it is wired in at all ──────────────────────────────────────────────── */

test('the dashboard resource has a projection', () => {
  /* Without this the whole file is dead code and the screen stays authored —
     which is the state it was in, silently, for the life of the driver. */
  assert.equal(typeof PROJECTIONS.dashboard, 'function');
});

/* ── the funnel ─────────────────────────────────────────────────────────── */

test('the funnel counts the CRM stages and DECLINES check-in', () => {
  /* Arriving is a PMS fact. Reusing the won count for it would draw a funnel
     whose last two stages are identical and claim every booked guest turned up. */
  const e = build([
    leadRec({ lead_id: 'L-1', stage: 'Fresh' }),
    leadRec({ lead_id: 'L-2', stage: 'Interested', phone: '9000000002' }),
    leadRec({ lead_id: 'L-3', stage: 'Won/Converted', phone: '9000000003' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-3' }),
  ]);
  const rows = projection.funnel(e);

  assert.deepEqual(rows.map((r) => r.label), ['Leads', 'Contacted', 'Qualified', 'Booked', 'Checked in']);
  assert.equal(rows[0].n, '3');
  assert.equal(rows[1].n, '2', 'two leads have moved off Fresh');
  assert.equal(rows[2].n, '2', 'Interested and Won/Converted both count as qualified');
  assert.equal(rows[3].n, '1');
  assert.equal(rows[4].n, projection.NONE, 'check-in must never borrow the booking count');
});

test('an empty store funnels to dashes, not zeros', () => {
  for (const row of projection.funnel(empty())) {
    assert.equal(row.n, projection.NONE, `${row.label} should decline`);
  }
});

/* ── campaigns ──────────────────────────────────────────────────────────── */

test('a campaign is ranked by spend and its ROAS uses its own leads', () => {
  const e = build([
    campaignDay({ campaign_name: 'Munnar Honeymoon', spend: 1000, date: iso(2).slice(0, 10) }),
    campaignDay({ campaign_name: 'Backwater Weekend', spend: 5000, date: iso(2).slice(0, 10) }),
    leadRec({ lead_id: 'L-1', utm_campaign: 'Munnar Honeymoon' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1', value: 4000 }),
  ]);
  const rows = projection.campaigns(e);

  assert.equal(rows[0].name, 'Backwater Weekend', 'ranked by spend');
  assert.equal(rows[1].name, 'Munnar Honeymoon');
  assert.equal(rows[1].roas, '4.0x', '₹4,000 of reservation value against ₹1,000 of spend');
  assert.equal(rows[1].bookings, 1);
});

test('spend with no lead tagged to it declines every derived column', () => {
  /* Not a CPL of infinity and not zero bookings — an attribution gap. Printing
     0 bookings against real spend reads as a failed campaign when the truth is
     that nothing can be said about it. */
  const e = build([campaignDay({ campaign_name: 'Orphan', spend: 5000 })]);
  const row = projection.campaigns(e)[0];

  assert.equal(row.spend, '₹5,000');
  assert.equal(row.leads, projection.NONE);
  assert.equal(row.cpl, projection.NONE);
  assert.equal(row.bookings, projection.NONE);
  assert.equal(row.roas, projection.NONE);
});

/* ── properties and reps ────────────────────────────────────────────────── */

test('a property declines occupancy and ADR rather than estimating them', () => {
  /* The two figures a GM acts on hardest, and there is no honest way to derive
     either from a CRM. */
  const e = build([
    leadRec({ lead_id: 'L-1', property: 'Munnar Hillside' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1' }),
  ]);
  const row = projection.properties(e)[0];

  assert.equal(row.name, 'Munnar Hillside');
  assert.match(row.meta, /occ — · ADR —/);
  assert.equal(row.rev, '₹42,800');
});

test('a rep is credited through the lead, and the cancel rate declines', () => {
  const e = build([
    leadRec({ lead_id: 'L-1', owner: 'Reshma Menon' }),
    leadRec({ lead_id: 'L-2', owner: 'Arun Kurian', phone: '9000000002' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1', value: 9000 }),
    dealRec({ deal_id: 'D-2', lead_id: 'L-2', value: 1000 }),
  ]);
  const rows = projection.reps(e);

  assert.equal(rows[0].name, 'Reshma Menon', 'ranked by revenue');
  assert.equal(rows[0].init, 'RM');
  assert.match(rows[0].meta, /cancel —/);
});

test('properties and reps return nothing rather than a fabricated row', () => {
  assert.deepEqual(projection.properties(empty()), []);
  assert.deepEqual(projection.reps(empty()), []);
});

/* ── recommendations and alerts ─────────────────────────────────────────── */

test('a recommendation fires on a checkable condition and names it', () => {
  const e = build([
    campaignDay({ campaign_name: 'Orphan', spend: 5000 }),
    leadRec({ lead_id: 'L-1', stage: 'Fresh' }),
  ]);
  const texts = projection.recs(e).map((r) => r.text).join(' ');

  assert.match(texts, /Orphan/, 'the untagged campaign is named');
  assert.match(texts, /first status/, 'untouched leads are counted');
});

test('with nothing to say it says so, rather than inventing three insights', () => {
  const rows = projection.recs(empty());
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /No rule fired/);
});

test('an alert carries its evidence and its window, not a fake timestamp', () => {
  /* "2h ago" on a standing condition is how an alert panel stops being read. */
  const e = build([
    leadRec({ lead_id: 'L-1' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1', value: 0 }),
  ]);
  const rows = projection.alerts(e, { over: { from: '2026-07-17T00:00:00.000Z' } });
  const text = rows.map((r) => r.text).join(' ');

  assert.match(text, /no value entered/, 'a valueless won reservation drags every revenue figure down');
  for (const row of rows) assert.equal(row.when, 'since 2026-07-17');
});

test('spend with no leads at all is an alert', () => {
  const e = build([campaignDay({ spend: 90000 })]);
  assert.match(projection.alerts(e).map((r) => r.text).join(' '), /no leads recorded/);
});

/* ── activity ───────────────────────────────────────────────────────────── */

test('activity is real events, newest first, with real ages', () => {
  const e = build([
    leadRec({ lead_id: 'L-1', created_at: iso(0) }),
    leadRec({ lead_id: 'L-2', created_at: iso(5), phone: '9000000002' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-2', updated_at: iso(1) }),
  ]);
  const rows = projection.activity(e, NOW);

  assert.equal(rows[0].when, 'just now');
  assert.match(rows[1].text, /converted/);
  assert.equal(rows[1].when, 'yesterday');
  assert.equal(rows[2].when, '5d ago');
});

test('a won reservation with no value says so rather than showing a blank', () => {
  const e = build([leadRec({ lead_id: 'L-1' }), dealRec({ deal_id: 'D-1', lead_id: 'L-1', value: 0 })]);
  assert.match(projection.activity(e, NOW).map((r) => r.text).join(' '), /no value entered/);
});

/* ── the chart ──────────────────────────────────────────────────────────── */

test('one day is declined — two points make a line, one makes a claim', () => {
  const e = build([campaignDay({ date: iso(1).slice(0, 10) })]);
  const chart = projection.revenueVsSpend(e);

  assert.equal(chart.empty, true);
  assert.match(chart.reason, /one day/);
});

test('an empty store declines the chart rather than drawing a flat line at zero', () => {
  const chart = projection.revenueVsSpend(empty());
  assert.equal(chart.empty, true);
  assert.match(chart.reason, /no revenue or spend/);
});

test('both series are drawn to one axis, and the peak is the real maximum', () => {
  const e = build([
    campaignDay({ date: iso(3).slice(0, 10), spend: 1000 }),
    campaignDay({ date: iso(2).slice(0, 10), spend: 2000, campaign_name: 'Second' }),
    leadRec({ lead_id: 'L-1' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1', value: 5000, updated_at: iso(2) }),
  ]);
  const chart = projection.revenueVsSpend(e);

  assert.equal(chart.empty, false);
  assert.ok(chart.revPath.startsWith('M'));
  assert.ok(chart.spendPath.startsWith('M'));
  assert.ok(chart.areaPath.endsWith('Z'), 'the fill must close');
  assert.match(chart.peak.text, /rev · /);
  /* Shared axis: the bigger series must sit higher on the page, and in SVG
     higher means a SMALLER y. Revenue of ₹5,000 against spend of ₹20 has to
     draw above it or the chart is flattering the spend line. */
  const firstY = (p) => Number(p.split(' ')[1].replace(/^[ML]/, '').split(',')[1]);
  assert.ok(firstY(chart.revPath) < firstY(chart.spendPath));
});

test('the tooltip is kept inside the viewbox at both ends', () => {
  /* Anchored to a peak on day one it would hang off the left edge. */
  const e = build([
    leadRec({ lead_id: 'L-1' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1', value: 9000, updated_at: iso(4) }),
    campaignDay({ date: iso(4).slice(0, 10) }),
    campaignDay({ date: iso(0).slice(0, 10), campaign_name: 'Second' }),
  ]);
  const chart = projection.revenueVsSpend(e);

  assert.ok(Number(chart.peak.boxX) >= 4);
  assert.ok(Number(chart.peak.boxX) <= 640 - 154);
});

/* ── the whole payload ──────────────────────────────────────────────────── */

test('the projection answers every authored collection on the screen', () => {
  /* A collection left out keeps its fixture, and the reader cannot tell. This
     is the test that catches a card being forgotten. */
  const e = build([
    campaignDay({ date: iso(2).slice(0, 10) }),
    campaignDay({ date: iso(1).slice(0, 10), campaign_name: 'Second' }),
    leadRec({ lead_id: 'L-1' }),
    dealRec({ deal_id: 'D-1', lead_id: 'L-1' }),
  ]);
  const out = projection.dashboard(e, NOW, {});

  for (const key of ['funnel', 'campaigns', 'properties', 'reps', 'recs', 'alerts', 'activity', 'revSpend']) {
    assert.ok(out[key] !== undefined, `${key} was not answered and will render the fixture`);
  }
});

test('no authored figure survives an empty store', () => {
  /* The strongest form of the rule: with nothing ingested, nothing on this
     screen may still read like a measurement. */
  const out = projection.dashboard(empty(), NOW, {});
  const text = JSON.stringify(out);

  for (const invented of ['Munnar Hillside', 'Reshma Menon', '2,554', '₹22.4L', 'Kumarakom', '4471']) {
    assert.ok(!text.includes(invented), `the fixture value ${invented} survived into a derived payload`);
  }
  assert.deepEqual(out.campaigns, []);
  assert.equal(out.revSpend.empty, true);
});
