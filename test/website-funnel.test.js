/* The website funnel, measured.
 *
 *   node --test test/website-funnel.test.js
 *
 * It showed its first step and its last and dashed the four between — honest,
 * and not useful: "availability checked" and "the rooms viewed" are the numbers
 * a hotel manages, and the report that carries them, GA4 events by name, was not
 * being pulled at all.
 *
 * Two rules this file holds:
 *
 *   1. **Matching is exact.** A funnel step counting the wrong event is worse
 *      than a missing one, because a missing step is visibly missing and a wrong
 *      number is not.
 *   2. **A step with no figure comes off the funnel** and is named beneath it.
 *      A row reading "— · — · drop —" costs a reader a look and gives them
 *      nothing.
 *
 * The steps are this property's journey: check availability, view the rooms,
 * book. It has no guest-details event and no payment event — that checkout is
 * not tagged — so those authored steps are gone rather than dashed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');
const authored = require('../data/website.js');

const ev = (event, count, date = '2026-08-20') => ({ entity: 'webEventDay', event, count, date });

const entitiesWith = (events, sessions = 100000, purchases = 0) => ({
  sessionDays: [{ date: '2026-08-20', sessions, users: 1, newUsers: 1, bounceRate: 0.3, avgSessionSeconds: 60, pageViews: sessions * 2 }],
  webEventDays: events,
  webChannelRevenueDays: purchases
    ? [{ channelGroup: 'Direct', revenue: 100000, reservations: purchases, date: '2026-08-20' }]
    : [],
  webChannelDays: [], webPageDays: [], webLandingDays: [],
  webSourceDays: [], webCityDays: [], webCityRevenueDays: [], deals: [], leads: [],
});

const funnelOf = (events, sessions, purchases) => {
  const out = PROJECTIONS.website(entitiesWith(events, sessions, purchases), {}, authored);
  return { steps: Object.fromEntries(out.webFunnel.map((s) => [s.label, s])), out };
};

/* A step with no figure is off the funnel and named beneath it, rather than
   drawn as a row whose only content is its own absence. */
const absent = (out, label) => !out.webFunnel.some((s) => s.label === label) && out.missingSteps.includes(label);

test('the middle of the funnel is counted from the events GA4 reports', () => {
  const { steps } = funnelOf([
    ev('checkavailabilityclicked', 2635), ev('roomselectionviewed', 3068),
  ], 21195);

  assert.equal(steps['Availability checked'].n, '2,635');
  assert.equal(steps['Room selection viewed'].n, '3,068');
});

test('each step names the event it counted', () => {
  /* So a figure can be checked against the GA4 interface rather than taken on
     trust — the same reason the metric registry explains itself. */
  const { steps } = funnelOf([ev('roomselectionviewed', 3068)]);
  assert.equal(steps['Room selection viewed'].event, 'roomselectionviewed');
});

test('a step falls from the last measured step, not from the row above it', () => {
  /* With a step unmeasured in between, a step-on-step drop would be a fall from
     nothing — and that step is not even drawn now. */
  const { steps } = funnelOf([ev('checkavailabilityclicked', 25000)], 100000, 5000);

  assert.equal(steps['Availability checked'].drop, '−75.0%');
  /* 5,000 of the 25,000 that checked availability, not of the 100,000 that
     landed and not of a step that reported nothing. */
  assert.equal(steps['Booked online'].drop, '−80.0%');
});

test('a step larger than the one above it reads as a rise, not as a double minus', () => {
  /* Room-selection views outnumber availability clicks on this property: a deep
     link, a returning visitor and a second search all reach the rooms without
     the click that precedes them on paper. "−−16.4%" would be a formatting bug
     wearing the clothes of a measurement. */
  const { steps } = funnelOf([ev('checkavailabilityclicked', 2635), ev('roomselectionviewed', 3068)], 21195);

  assert.equal(steps['Room selection viewed'].drop, '+16.4%');
  assert.doesNotMatch(steps['Room selection viewed'].drop, /−−|--/);
});

test('an event the property does not send takes its step off the funnel', () => {
  /* Dashed, the row cost a reader a look and gave them nothing: an empty bar, an
     unknowable fall, and no content but its own absence. */
  const { out } = funnelOf([ev('checkavailabilityclicked', 24000)]);

  for (const label of ['Room selection viewed', 'Booked online']) {
    assert.ok(absent(out, label), `${label} is still drawn, or is not accounted for beneath`);
  }
});

test('two overlapping aliases count once, and the busy one wins', () => {
  /* Summing them would count a visit twice. Which one to keep is decided by
     volume, not by list order: the event a step is really tagged with is the one
     that fires on the journey. */
  const { steps } = funnelOf([ev('view_item', 24000), ev('view_item_list', 31000)]);
  assert.equal(steps['Availability checked'].n, '31,000');
});

test("a stray recommended name does not outrank the engine own event", () => {
  /* Ninety days of this property held three view_item events beside 2,635
     checkavailabilityclicked. Taking the first alias made the step read 3, a
     fall of 100%, and a funnel below it that rose by a million per cent. */
  const { steps } = funnelOf([ev('view_item', 3), ev('checkavailabilityclicked', 2635)], 63764);

  assert.equal(steps['Availability checked'].n, '2,635');
  assert.equal(steps['Availability checked'].event, 'checkavailabilityclicked');
});

test('an engine that names its own events is still matched', () => {
  const { steps } = funnelOf([ev('availability_search', 12000), ev('room_selection_viewed', 4000)]);
  assert.equal(steps['Availability checked'].n, '12,000');
  assert.equal(steps['Room selection viewed'].n, '4,000');
});

test('events nobody claimed are listed, biggest first', () => {
  /* A missing step says nothing about why. The list is what lets a reader name
     the event their engine sends, rather than the tool matching loosely and
     counting the wrong thing. */
  const { out } = funnelOf([ev('checkavailabilityclicked', 2635), ev('user_engagement', 150000), ev('scroll', 80000)]);

  assert.deepEqual(out.unclaimedEvents.map((e) => e.event), ['user_engagement', 'scroll']);
  assert.ok(!out.unclaimedEvents.some((e) => e.event === 'checkavailabilityclicked'), 'a counted event is listed as unclaimed');
});

test('a property with no events at all still reports the step sessions can answer', () => {
  /* The first step comes from the session report and needs no events. */
  const { steps, out } = funnelOf([]);
  assert.equal(steps['Landing page view'].n, '1.0L');
  assert.ok(absent(out, 'Availability checked'));
});

test('the event days are narrowed by the range control', () => {
  /* A collection missing from period.js FIELD is silently never narrowed, and
     the funnel would report a quarter of events against a week of sessions. */
  const { FIELD } = require('../lib/metrics/period');
  assert.equal(FIELD.webEventDays, 'date');
});

test('the connector asks for events by name, and the store can tell two apart', () => {
  const ga = require('../lib/ingest/http/google-analytics');
  const { EXTERNAL_ID } = require('../lib/ingest/connectors');
  const sources = require('../lib/ingest/sources');

  assert.ok(sources.get('google_analytics').kinds.includes('event_day'), 'the source does not declare the kind');
  assert.deepEqual(ga.DIMENSIONS.event_day, ['date', 'eventName']);

  const a = EXTERNAL_ID.event_day({ eventName: 'roomselectionviewed', date: '2026-08-21' });
  const b = EXTERNAL_ID.event_day({ eventName: 'checkavailabilityclicked', date: '2026-08-21' });
  assert.notEqual(a, b, 'two events on one day would overwrite each other');
  assert.match(a, /2026-08-21$/, 'the day is not in the key, so a re-pull would lose history');
});

test('an enquiry form is not a step inside a booking', () => {
  /* The property sends form_start, form_submit, formsubmit and formsubmitclick,
     and every one is the enquiry form — a lead, not a step inside a booking.
     Counting one as the other would put a number in the funnel that describes a
     different journey. */
  const { out } = funnelOf([ev('form_start', 1784), ev('form_submit', 4001)], 21195);

  assert.deepEqual(out.unclaimedEvents.map((e) => e.event).sort(), ['form_start', 'form_submit']);
  assert.ok(!out.webFunnel.some((s) => s.event === 'form_start' || s.event === 'form_submit'));
});

test('the steps are the journey this engine reports, not a checkout it does not', () => {
  /* Guest details and Payment were authored steps describing a checkout this
     property never tags. They are gone from the shape rather than dropped from
     the render on every request. */
  assert.deepEqual(authored.webFunnel.map((s) => s.label), [
    'Landing page view', 'Availability checked', 'Room selection viewed', 'Booked online',
  ]);
});

test('the last step counts online bookings, and says what it leaves out', () => {
  /* "Booking confirmed" was answering a question nobody asked it: whether it
     was ALL bookings. It is not, and the gap is most of them — a guest who rang
     reservations never becomes a session, one who booked through an OTA reaches
     neither book, and a walk-in reaches neither until a PMS holds it. */
  const entities = entitiesWith([ev('checkavailabilityclicked', 2635)], 21195, 8);
  entities.deals = [
    { entity: 'deal', channel: 'google', revenue: 100000, outcome: 'won', bookingStatus: 'confirmed' },
    { entity: 'deal', channel: 'meta', revenue: 200000, outcome: 'won', bookingStatus: 'confirmed' },
    { entity: 'deal', channel: 'meta', revenue: 50000, outcome: 'won', bookingStatus: 'cancelled' },
    { entity: 'deal', channel: 'meta', revenue: 50000, outcome: 'open', bookingStatus: '' },
  ];
  const out = PROJECTIONS.website(entities, {}, authored);

  assert.match(out.bookedNote.text, /CRM recorded 2 won bookings/);
  assert.match(out.bookedNote.text, /OTA/);
  /* Not added together: a guest who booked online and was then entered into the
     CRM is in both books, and nothing can tell those apart. */
  assert.match(out.bookedNote.text, /not added/);
  assert.equal(out.bookedNote.crm, 2, 'a cancelled or open deal was counted as a booking');
});
