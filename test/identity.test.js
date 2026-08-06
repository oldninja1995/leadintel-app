/* Phase 5 sub-phase 5.1 — identity resolution and the match-rate metric.
 *
 *   node --test        or        npm test
 *
 * The interesting cases are the ones where the chain is *incomplete*: a booking
 * with no CRM deal, a lead with no ad id, a campaign no ad platform reported.
 * A resolver only tested on records that join cleanly is a resolver that has
 * not been tested.
 */

const test = require('node:test');
const assert = require('node:assert');

const identity = require('../lib/identity');
const alerts = require('../lib/alerts');
const ingest = require('../lib/ingest');

const entities = (over = {}) => ({
  campaignDays: [
    { campaign: 'munnar honeymoon jul', label: 'Munnar Honeymoon Jul', platform: 'meta_ads', spend: 700000 },
    { campaign: 'brand search', label: 'Brand Search', platform: 'google_ads', spend: 203000 },
  ],
  leads: [
    { id: 'L-1', name: 'George', phone: '+918547663311', campaign: 'munnar honeymoon jul', adId: '99201' },
    { id: 'L-2', name: 'Anjali', phone: '+919847012345', campaign: 'munnar honeymoon jul', adId: '99201' },
    { id: 'L-3', name: 'Sneha', phone: '+919847011223', campaign: 'brand search', adId: null },
  ],
  bookings: [
    { id: 'B-1', leadId: 'L-1', phone: '+918547663311', revenue: { value: 4280000 } },
  ],
  ...over,
});

/* ── the ladder ─────────────────────────────────────────────────────────── */

test('a deal-linked booking whose lead carries an ad id is the top rung', () => {
  const [r] = identity.resolve(entities());
  assert.equal(r.rung, 'ad_id');
  assert.equal(r.confidence, 0.98);
  assert.equal(r.lead, 'L-1');
  assert.equal(r.campaign, 'munnar honeymoon jul');
  assert.equal(r.resolved, true);
});

test('a booking with no CRM deal is still reachable by phone', () => {
  /* This is the case the stage exists for — and a real one: fixture booking
     B-1002 has no deal row at all. */
  const e = entities({ bookings: [{ id: 'B-2', leadId: null, phone: '+919847012345', revenue: { value: 0 } }] });
  const [r] = identity.resolve(e);
  assert.equal(r.lead, 'L-2', 'the phone rung did not find the lead');
  assert.equal(r.rung, 'phone_e164');
  assert.equal(r.confidence, 0.92);
  assert.equal(r.resolved, true);
});

test('the rung is the weakest link, not the best fact available', () => {
  /* L-2 carries an ad id, but this booking was only reachable by phone. The
     match is phone-grade and must not be reported as ad-grade. */
  const e = entities({ bookings: [{ id: 'B-2', leadId: null, phone: '+919847012345', revenue: { value: 0 } }] });
  const [r] = identity.resolve(e);
  assert.equal(r.adId, '99201', 'the ad id should still be recorded');
  assert.equal(r.rung, 'phone_e164', 'a phone-grade match was upgraded to ad-grade');
});

test('a lead with no ad id lands on the campaign rung, at the floor', () => {
  const e = entities({ bookings: [{ id: 'B-3', leadId: 'L-3', phone: '+919847011223', revenue: { value: 100000 } }] });
  const [r] = identity.resolve(e);
  assert.equal(r.rung, 'utm_campaign');
  assert.equal(r.confidence, identity.THRESHOLD);
  assert.equal(r.resolved, true, 'a match exactly at the floor was rejected');
});

/* ── where the chain breaks ─────────────────────────────────────────────── */

test('a booking no lead accounts for is unresolved, with a reason', () => {
  const e = entities({ bookings: [{ id: 'B-9', leadId: null, phone: '+910000000000', revenue: { value: 500000 } }] });
  const [r] = identity.resolve(e);
  assert.equal(r.resolved, false);
  assert.equal(r.lead, null);
  assert.match(r.reason, /no CRM lead/);
});

test('a lead naming a campaign no ad platform reported is unresolved', () => {
  const e = entities();
  e.leads[0].campaign = 'a campaign nobody ran';
  const [r] = identity.resolve(e);
  assert.equal(r.resolved, false);
  assert.match(r.reason, /which no ad platform reported/);
});

test('a missing phone never matches another missing phone', () => {
  assert.equal(identity.samePhone(null, null), false, 'two unknown phones were treated as the same person');
  assert.equal(identity.samePhone('', ''), false);
  assert.equal(identity.samePhone('+919847012345', '+919847012345'), true);
});

test('phones are compared exactly — normalisation already ran', () => {
  assert.equal(identity.samePhone('+919847012345', '9847012345'), false,
    'a loose comparison would manufacture matches stage 2 deliberately avoided');
});

/* ── the metric ─────────────────────────────────────────────────────────── */

test('match rate counts bookings, and reports the fraction as well as the percentage', () => {
  const e = entities({
    bookings: [
      { id: 'B-1', leadId: 'L-1', phone: '+918547663311', revenue: { value: 4280000 } },
      { id: 'B-9', leadId: null, phone: '+910000000000', revenue: { value: 500000 } },
    ],
  });
  const rate = identity.matchRate(identity.resolve(e));
  assert.equal(rate.matched, 1);
  assert.equal(rate.total, 2);
  assert.equal(rate.unresolved, 1);
  assert.equal(rate.pct, '50%');
  assert.equal(rate.rate, 0.5);
});

test('match rate breaks down by rung, so a fall to the floor is visible', () => {
  const e = entities({
    bookings: [
      { id: 'B-1', leadId: 'L-1', phone: '+918547663311', revenue: { value: 1 } },
      { id: 'B-2', leadId: null, phone: '+919847012345', revenue: { value: 1 } },
      { id: 'B-3', leadId: 'L-3', phone: '+919847011223', revenue: { value: 1 } },
    ],
  });
  assert.deepEqual(identity.matchRate(identity.resolve(e)).byRung, { ad_id: 1, phone_e164: 1, utm_campaign: 1 });
});

test('no bookings is not a 100% match rate', () => {
  const rate = identity.matchRate([]);
  assert.equal(rate.rate, null, 'an empty pipeline reported itself as fully matched');
  assert.equal(rate.pct, '—');
});

test('unresolved revenue is counted, because that is what makes it matter', () => {
  const e = entities({
    bookings: [
      { id: 'B-1', leadId: 'L-1', phone: '+918547663311', revenue: { value: 4280000 } },
      { id: 'B-9', leadId: null, phone: '+910000000000', revenue: { value: 500000 } },
    ],
  });
  assert.equal(identity.unattributedRevenue(e, identity.resolve(e)), 500000);
});

/* ── exposure ───────────────────────────────────────────────────────────── */

test('unresolved bookings raise an alert naming the uncredited revenue', () => {
  const match = { unresolved: 1, matched: 1, total: 2, pct: '50%', unresolvedDetail: [{ booking: 'B-9', reason: 'no CRM lead carries it' }] };
  const [alert] = alerts.matchAlerts(match, 500000);
  assert.match(alert.title, /1 booking could not be matched/);
  assert.match(alert.meta, /match rate 50% \(1\/2\)/);
  assert.match(alert.meta, /₹5,000 uncredited/);
});

test('a fully matched pipeline raises nothing', () => {
  assert.deepEqual(alerts.matchAlerts({ unresolved: 0, matched: 2, total: 2, pct: '100%', unresolvedDetail: [] }, 0), []);
  assert.deepEqual(alerts.matchAlerts(null, 0), []);
});

/* ── against the real fixtures ──────────────────────────────────────────── */

test('the fixtures resolve on two different rungs', () => {
  const real = ingest.snapshot({ store: ingest.storeFor('parakkat') });
  const resolutions = identity.resolve(real);
  const rate = identity.matchRate(resolutions);

  assert.equal(rate.total, 2);
  assert.equal(rate.matched, 2, `unresolved: ${JSON.stringify(rate.unresolvedDetail)}`);
  /* B-1001 arrives through its deal and its lead's ad id; B-1002 has no deal
     row and is reachable only by phone. Both paths in one fixture set. */
  assert.equal(rate.byRung.ad_id, 1);
  assert.equal(rate.byRung.phone_e164, 1);
});

test('without the phone rung the fixtures would only half match', () => {
  const real = ingest.snapshot({ store: ingest.storeFor('parakkat') });
  const linked = real.bookings.filter((b) => b.leadId).length;
  assert.equal(linked, 1, 'fixture shape changed — B-1002 was supposed to have no deal link');
});
