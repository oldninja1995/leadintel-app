/* Audience Analytics, read by revenue.
 *
 *   node --test test/audiences-revenue.test.js
 *
 * The screen described the audience an *ad bought* — ad sets, targeting types,
 * saturation. These four panels describe the audience that *arrived*: whether
 * they had stayed before, what a booking was worth, how much of the money sits
 * with how few people, and which cities send guests rather than traffic.
 *
 * None of it needs a system that is not already connected, and the rule
 * throughout is one line: a won, uncancelled deal is a booking. An open deal is
 * a hope and a cancelled one is a refund, and neither is revenue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');

const deal = (over = {}) => ({
  entity: 'deal', id: 'd1', customer: 'A Guest', revenue: 2500000,
  channel: 'meta', repeat: false, outcome: 'won', bookingStatus: 'confirmed', ...over,
});

const project = (deals, extra = {}) => PROJECTIONS.audiences({
  deals,
  adsetDays: [], campaignDays: [], leads: [], creatives: [], metaDemographicDays: [],
  webCityDays: [], webCityRevenueDays: [], webChannelRevenueDays: [],
  ...extra,
}, {});

/* ── new against returning ───────────────────────────────────────────────── */

test('returning and first-time guests are counted apart, with what each is worth', () => {
  const out = project([
    deal({ id: '1', customer: 'R1', revenue: 4000000, repeat: true }),
    deal({ id: '2', customer: 'R1', revenue: 2000000, repeat: true }),
    deal({ id: '3', customer: 'N1', revenue: 1000000, repeat: false }),
  ]);
  const rows = Object.fromEntries(out.audGuests.map((g) => [g.label, g]));

  assert.equal(rows['Returning guests'].rev, '₹60,000');
  assert.equal(rows['Returning guests'].bookings, '2');
  assert.equal(rows['Returning guests'].avg, '₹30,000');
  assert.equal(rows['First-time guests'].rev, '₹10,000');
});

test('a guest the CRM never flagged is its own row, not folded into either', () => {
  /* Unknown is not first-time. Folding it into whichever group is larger would
     quietly inflate that one, which is the failure this row exists to avoid. */
  const out = project([
    deal({ id: '1', repeat: true, revenue: 1000000 }),
    deal({ id: '2', repeat: null, revenue: 9000000 }),
  ]);
  const labels = out.audGuests.map((g) => g.label);

  assert.ok(labels.includes('Not recorded'));
  const unknown = out.audGuests.find((g) => g.label === 'Not recorded');
  assert.equal(unknown.rev, '₹90,000');
});

test('an open or cancelled deal is not a booking', () => {
  const out = project([
    deal({ id: '1', revenue: 1000000 }),
    deal({ id: '2', revenue: 5000000, outcome: 'open', bookingStatus: '' }),
    deal({ id: '3', revenue: 5000000, bookingStatus: 'cancelled' }),
  ]);

  assert.equal(out.audGuests.reduce((t, g) => t + Number(g.bookings), 0), 1);
});

/* ── booking value bands ─────────────────────────────────────────────────── */

test('bookings fall into value bands, and each band says which channel brought it', () => {
  /* A channel can win on ROAS and lose on the bookings worth having; one
     blended ratio hides that completely. */
  const out = project([
    deal({ id: '1', revenue: 15000000, channel: 'google' }),
    deal({ id: '2', revenue: 12000000, channel: 'google' }),
    deal({ id: '3', revenue: 3000000, channel: 'meta' }),
    deal({ id: '4', revenue: 1000000, channel: 'meta' }),
  ]);
  const bands = Object.fromEntries(out.audValueBands.map((b) => [b.label, b]));

  assert.equal(bands['₹1L and above'].bookings, '2');
  assert.equal(bands['₹1L and above'].rev, '₹2.70L');
  assert.match(bands['₹1L and above'].mix, /Google Ads 100%/);
  assert.equal(bands['₹25k – ₹50k'].bookings, '1');
  assert.match(bands['Under ₹25k'].mix, /Meta Ads 100%/);
});

test('a band nobody landed in is not drawn', () => {
  const out = project([deal({ revenue: 1000000 })]);
  assert.deepEqual(out.audValueBands.map((b) => b.label), ['Under ₹25k']);
});

test('an untagged booking is named untagged rather than assigned', () => {
  const out = project([deal({ revenue: 1000000, channel: null })]);
  assert.match(out.audValueBands[0].mix, /untagged 100%/);
});

/* ── guest concentration ─────────────────────────────────────────────────── */

test('guests rank by revenue, and their bookings add up across the range', () => {
  const out = project([
    deal({ id: '1', customer: 'Anand M', revenue: 3200000, channel: 'meta' }),
    deal({ id: '2', customer: 'Anand M', revenue: 2800000, channel: 'meta' }),
    deal({ id: '3', customer: 'S Krishnan', revenue: 12000000, channel: 'google' }),
  ]);

  assert.deepEqual(out.audTopGuests.map((g) => g.name), ['S Krishnan', 'Anand M']);
  assert.equal(out.audTopGuests[1].rev, '₹60,000');
  assert.equal(out.audTopGuests[1].bookings, '2');
  assert.equal(out.audTopGuests[1].from, 'Meta Ads');
});

test('a booking with no customer is not a top guest, and is counted in the note', () => {
  /* An unnamed guest cannot be a top guest, and dropping them silently would
     leave the concentration figure describing a subset nobody named. */
  const out = project([
    deal({ id: '1', customer: 'Named', revenue: 4000000 }),
    deal({ id: '2', customer: null, revenue: 9000000 }),
  ]);

  assert.deepEqual(out.audTopGuests.map((g) => g.name), ['Named']);
  assert.match(out.audGuestNote, /1 booking\(s\) carry no customer name and are not ranked/);
});

test('the concentration line states the share the top guests hold', () => {
  const out = project([
    deal({ id: '1', customer: 'A', revenue: 9000000 }),
    deal({ id: '2', customer: 'B', revenue: 1000000 }),
  ]);
  assert.match(out.audGuestNote, /Top 2 guests are 100% of the ₹1.00L booked by named guests/);
});

/* ── cities, by what a session is worth ──────────────────────────────────── */

test('a city says what one of its sessions is worth', () => {
  const out = project([], {
    webCityDays: [
      { city: 'Bengaluru', sessions: 8000, date: '2026-08-20' },
      { city: 'Mumbai', sessions: 8000, date: '2026-08-20' },
    ],
    webCityRevenueDays: [
      { city: 'Bengaluru', revenue: 8000000, date: '2026-08-20' },
      { city: 'Mumbai', revenue: 800000, date: '2026-08-20' },
    ],
  });
  const rows = Object.fromEntries(out.audGeo.map((c) => [c.name, c]));

  assert.equal(rows.Bengaluru.perSession, '₹10');
  assert.equal(rows.Mumbai.perSession, '₹1');
  assert.equal(rows.Bengaluru.sessions, '8,000');
});

test('a city GA4 priced nothing for has no value per session', () => {
  /* Printing ₹0 would claim it was measured and came to nothing. */
  const out = project([], {
    webCityDays: [{ city: 'Kochi', sessions: 400, date: '2026-08-20' }],
    webCityRevenueDays: [],
  });

  assert.equal(out.audGeo[0].perSession, '—');
  assert.equal(out.audGeo[0].rev, '400 sessions');
});
