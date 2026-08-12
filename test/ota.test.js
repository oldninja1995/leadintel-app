/* OTA Analytics — the channel side of revenue.
 *
 * What is worth testing here is not that the arithmetic adds up but that the
 * three judgements hold: a cancellation earns a channel nothing, an absent
 * figure is not a zero, and channels rank on net rather than on gross. Each of
 * those is a decision somebody could reasonably reverse, which is what makes it
 * worth pinning.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ota = require('../lib/ota');
const sources = require('../lib/ingest/sources');
const connectors = require('../lib/ingest/connectors');
const canonical = require('../lib/ingest/canonical');
const metrics = require('../lib/metrics');
const { REQUIREMENTS } = require('../lib/connections');
const { RawStore } = require('../lib/ingest/raw-store');
const ingest = require('../lib/ingest');

const tmpStore = () => new RawStore(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-ota-')));

/* Paise, as canonical entities carry money. */
const R = (rupees) => rupees * 100;

const reservation = (over = {}) => ({
  entity: 'otaReservation',
  id: `${over.channel || 'booking_com'}:${over.reference || 'X-1'}`,
  reference: 'X-1',
  channel: 'booking_com',
  channelName: 'Booking.com',
  checkIn: '2026-07-20',
  checkOut: '2026-07-22',
  nights: 2,
  status: 'confirmed',
  gross: R(20000),
  commission: R(3000),
  net: R(17000),
  netDerived: false,
  ...over,
});

/* ── the sources ────────────────────────────────────────────────────────── */

test('all six channels are sources, connectors and credential forms', () => {
  assert.deepEqual(sources.OTA_IDS,
    ['booking_com', 'expedia', 'agoda', 'airbnb', 'makemytrip', 'goibibo']);

  for (const id of sources.OTA_IDS) {
    assert.ok(connectors.get(id), `${id} has no connector`);
    assert.ok(REQUIREMENTS[id], `${id} has no credential form`);
    assert.equal(sources.get(id).system, 'ota');
    assert.deepEqual(sources.get(id).kinds, ['reservation']);
  }
});

test('no OTA claims authority over a precedence field', () => {
  /* The precedence table is the Analytics Engine page's and predates channels
     being a source. An OTA winning `revenue` would outrank the PMS folio on the
     strength of a rule nobody reviewed — see the note in sources.js. */
  for (const id of sources.OTA_IDS) assert.deepEqual(sources.get(id).wins, []);
});

/* ── normalisation ──────────────────────────────────────────────────────── */

test('a channel payload becomes a reservation, with money in paise', async () => {
  const store = tmpStore();
  await ingest.sync('booking_com', { store, window: { from: '2026-06-01T00:00:00.000Z', to: '2026-08-13T00:00:00.000Z' } });
  const rows = ingest.snapshot({ store }).otaReservations;

  const one = rows.find((r) => r.reference === 'BDC-88214');
  assert.equal(one.channel, 'booking_com');
  assert.equal(one.guest, 'Sandeep Rao');
  assert.equal(one.nights, 3);
  /* ₹31,500 — the trap this codebase already paid for once. */
  assert.equal(one.gross, 3150000);
  assert.equal(one.commission, 472500);
});

test('net is derived only when the channel does not state one, and says which', () => {
  const stated = canonical.MAPPERS.booking_com.reservation({
    reservation_id: 'A', check_in: '2026-07-01', check_out: '2026-07-03',
    status: 'confirmed', currency: 'INR',
    gross_amount: '₹10,000', commission_amount: '₹1,500', net_amount: '₹8,000',
  });
  /* Believed as reported, not recomputed to ₹8,500 — a channel that says it
     paid out ₹8,000 has told us about a deduction this app cannot see. */
  assert.equal(stated.net.value, R(8000));

  const derived = canonical.MAPPERS.booking_com.reservation({
    reservation_id: 'B', check_in: '2026-07-01', check_out: '2026-07-03',
    status: 'confirmed', currency: 'INR',
    gross_amount: '₹10,000', commission_amount: '₹1,500',
  });
  assert.equal(derived.net.value, null, 'the mapper reads; build derives');
});

test('an unrecognised status is flagged rather than guessed at', () => {
  const fields = canonical.MAPPERS.agoda.reservation({
    reservation_id: 'C', check_in: '2026-07-01', check_out: '2026-07-02',
    status: 'awaiting_pigeon', currency: 'INR', gross_amount: 100,
  });
  assert.equal(fields.status.value, 'awaiting_pigeon');
  assert.match(fields.status.problem, /unrecognised/);
});

test('nights are counted off the dates when the channel omits them', () => {
  const fields = canonical.MAPPERS.expedia.reservation({
    reservation_id: 'D', check_in: '2026-07-10', check_out: '2026-07-14',
    status: 'confirmed', currency: 'INR', gross_amount: 100,
  });
  assert.equal(fields.nights.value, null);
});

/* ── the rollup ─────────────────────────────────────────────────────────── */

test('a cancellation earns a channel nothing, and is still counted', () => {
  const { rows, totals } = ota.summary([
    reservation({ reference: 'A', gross: R(20000), commission: R(3000), net: R(17000) }),
    reservation({ reference: 'B', status: 'cancelled', gross: R(90000), commission: 0, net: R(90000) }),
  ]);
  const bdc = rows.find((r) => r.channel === 'booking_com');

  /* The whole point: a channel cannot rise up this table on stays that fell
     through, and the ₹90,000 that did not happen is not revenue. */
  assert.equal(bdc.gross, R(20000));
  assert.equal(bdc.net, R(17000));
  assert.equal(bdc.confirmed, 1);
  assert.equal(bdc.cancelled, 1);
  assert.equal(bdc.cancelledGross, R(90000), 'the loss stays visible');
  assert.equal(totals.cancellationRate, 0.5);
});

test('a no-show counts as a cancellation', () => {
  const { totals } = ota.summary([reservation({ status: 'no_show' })]);
  assert.equal(totals.cancelled, 1);
  assert.equal(totals.confirmed, 0);
});

test('a status in neither set is counted in neither, and reported', () => {
  const { totals } = ota.summary([
    reservation({ reference: 'A' }),
    reservation({ reference: 'B', status: 'awaiting_pigeon', gross: R(50000) }),
  ]);
  assert.equal(totals.confirmed, 1);
  assert.equal(totals.cancelled, 0);
  assert.equal(totals.unclassified, 1);
  /* Its money is in no total — silently adding it to either side would decide
     revenue on a guess. */
  assert.equal(totals.gross, R(20000));
});

test('a channel with no reservations reports null, never zero', () => {
  const { rows } = ota.summary([reservation()]);
  const agoda = rows.find((r) => r.channel === 'agoda');

  assert.equal(agoda.reservations, 0);
  assert.equal(agoda.gross, null, 'a channel that sold nothing did not earn ₹0');
  assert.equal(agoda.net, null);
  assert.equal(agoda.adr, null);
  assert.equal(agoda.commissionRate, null);
  assert.equal(agoda.cancellationRate, null);
});

test('every channel keeps a row, even one that reported nothing', () => {
  /* "Airbnb sold nothing" and "Airbnb is not connected" are different facts and
     the screen shows both — so no channel may be dropped here. */
  const { rows } = ota.summary([reservation()]);
  assert.equal(rows.length, sources.OTA_IDS.length);
});

test('channels rank on net, which reverses the gross order', () => {
  /* The reason this screen exists. Airbnb bills 3% and Agoda 20%, so the
     channel that took more money can bank less. */
  const { rows } = ota.summary([
    reservation({ channel: 'agoda', channelName: 'Agoda', reference: 'A', gross: R(100000), commission: R(20000), net: R(80000) }),
    reservation({ channel: 'airbnb', channelName: 'Airbnb', reference: 'B', gross: R(90000), commission: R(2700), net: R(87300) }),
  ]);
  const reporting = rows.filter((r) => r.reservations > 0).map((r) => r.channel);

  assert.deepEqual(reporting, ['airbnb', 'agoda']);
  assert.ok(rows.find((r) => r.channel === 'agoda').gross
    > rows.find((r) => r.channel === 'airbnb').gross, 'Agoda took more');
});

test('the effective commission rate is what was taken, not what was contracted', () => {
  const { rows } = ota.summary([
    reservation({ reference: 'A', gross: R(10000), commission: R(1500) }),
    /* A promotion, a penalty, a waived night — the rate moves and the app can
       only know the arithmetic. */
    reservation({ reference: 'B', gross: R(10000), commission: R(500) }),
  ]);
  assert.equal(rows.find((r) => r.channel === 'booking_com').commissionRate, 0.1);
});

test('shares of net sum to one across the reporting channels', () => {
  const { rows } = ota.summary([
    reservation({ channel: 'agoda', reference: 'A', net: R(30000) }),
    reservation({ channel: 'expedia', reference: 'B', net: R(70000) }),
  ]);
  const total = rows.filter((r) => r.share !== null).reduce((sum, r) => sum + r.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares summed to ${total}`);
});

/* ── the registry ───────────────────────────────────────────────────────── */

test('the OTA metrics read the reservations and agree with the rollup', () => {
  const entities = {
    campaignDays: [], adsetDays: [], leads: [], bookings: [], payments: [],
    inventoryDays: [], leadEvents: [], creatives: [], audiences: {}, problems: [],
    otaReservations: [
      reservation({ reference: 'A', gross: R(20000), commission: R(3000), net: R(17000), nights: 2 }),
      reservation({ reference: 'B', status: 'cancelled', gross: R(50000) }),
    ],
  };

  const { values } = metrics.evaluate(entities, {});
  const { totals } = ota.summary(entities.otaReservations);

  assert.equal(values['ota.gross_revenue'], totals.gross);
  assert.equal(values['ota.commission'], totals.commission);
  assert.equal(values['ota.net_revenue'], totals.net);
  assert.equal(values['ota.reservations'], totals.confirmed);
  assert.equal(values['ota.cancellations'], totals.cancelled);
  assert.equal(values['ota.room_nights'], totals.roomNights);
  assert.equal(values['ota.adr'], totals.adr);
  assert.equal(values['ota.commission_rate'], totals.commissionRate);
});

test('the OTA metrics survive an entity set that has no reservations at all', () => {
  /* lib/metrics/scope.js hands back a narrowed set without this collection, and
     a metric that reached into `undefined` would take the whole registry down
     with it — on a screen scoped to one campaign, which is the least obvious
     place to look. */
  const { values } = metrics.evaluate({
    campaignDays: [], leads: [], bookings: [], payments: [],
    inventoryDays: [], leadEvents: [], problems: [],
  }, {});
  assert.equal(values['ota.reservations'], 0);
  assert.equal(values['ota.gross_revenue'], null);
});

test('an OTA figure is a workspace question, not a per-campaign one', () => {
  /* A channel's commission is not attributable to the ad that sold the room, so
     every dimension must refuse rather than answer with a workspace figure
     under a campaign heading. */
  for (const dimension of ['campaign', 'channel', 'property']) {
    assert.equal(metrics.scope.supports('ota.net_revenue', dimension), false);
    assert.equal(metrics.scope.supports('ota.commission', dimension), false);
  }
});

/* ── credential ≠ connection ────────────────────────────────────────────── */

test('a stored OTA key does not make a channel live, because no shape is written', () => {
  /* The rule the "these figures are synthetic" banner is derived from. Deriving
     it from the credential alone would switch the banner off the moment a key
     was pasted, while the table below carried on showing fixture reservations —
     the screen claiming its numbers were real on the strength of a key nothing
     had used. `liveSources` needs both halves and is the single rule. */
  const connections = { configured: () => new Set(['agoda', 'meta_ads']) };
  const httpConnectors = { has: (id) => id === 'meta_ads' };

  const live = ingest.liveSources({ connections, workspace: 'w', httpConnectors, forced: undefined });
  assert.ok(live.has('meta_ads'), 'Meta has a credential and a shape');
  assert.ok(!live.has('agoda'), 'Agoda has a credential and no shape — still on fixtures');
});

test('no OTA has an http connector yet, and the transport says which half is missing', async () => {
  const httpConnectors = require('../lib/ingest/http');
  for (const id of sources.OTA_IDS) {
    assert.ok(!httpConnectors.has(id), `${id} unexpectedly has a request shape — update the OTA screen's banner`);
  }

  const { httpTransport } = require('../lib/ingest/transport');
  const transport = httpTransport({ credentials: { hotelId: '1', apiKey: 'k' } });
  await assert.rejects(
    () => transport.fetch({ source: sources.get('agoda'), kind: 'reservation', window: null }),
    /no connector/,
    'the error must name the missing request shape, not the credential',
  );
});

/* ── the period ─────────────────────────────────────────────────────────── */

test('reservations are narrowed by the night stayed, not the day booked', () => {
  const rows = [
    /* Booked inside the window, stays outside it. */
    reservation({ reference: 'A', bookedAt: '2026-07-20T00:00:00.000Z', checkIn: '2026-09-05', checkOut: '2026-09-07' }),
    reservation({ reference: 'B', bookedAt: '2026-05-01T00:00:00.000Z', checkIn: '2026-07-22', checkOut: '2026-07-24' }),
  ];
  const narrowed = metrics.period.within({ otaReservations: rows },
    { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });

  assert.deepEqual(narrowed.otaReservations.map((r) => r.reference), ['B']);
});
