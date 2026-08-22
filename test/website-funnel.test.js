/* The website funnel, measured.
 *
 *   node --test test/website-funnel.test.js
 *
 * It showed its first step and its last and dashed the four between — honest,
 * and not useful: "availability checked" and "booking started" are the two
 * numbers a hotel manages. The report that carries them, GA4 events by name,
 * was not being pulled at all.
 *
 * What is worth testing is the *matching*. A funnel step counting the wrong
 * event is worse than a dashed one, because a dash is visibly missing and a
 * wrong number is not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');
const authored = require('../data/website.js');

const ev = (event, count, date = '2026-08-20') => ({ entity: 'webEventDay', event, count, date });

const entitiesWith = (events, sessions = 100000) => ({
  sessionDays: [{ date: '2026-08-20', sessions, users: 1, newUsers: 1, bounceRate: 0.3, avgSessionSeconds: 60, pageViews: sessions * 2 }],
  webEventDays: events,
  webChannelRevenueDays: [], webChannelDays: [], webPageDays: [], webLandingDays: [],
  webSourceDays: [], webCityDays: [], webCityRevenueDays: [], deals: [], leads: [],
});

const funnelOf = (events, sessions) => {
  const out = PROJECTIONS.website(entitiesWith(events, sessions), {}, authored);
  return { steps: Object.fromEntries(out.webFunnel.map((s) => [s.label, s])), out };
};

test('the middle of the funnel is counted from the events GA4 reports', () => {
  const { steps } = funnelOf([
    ev('view_item', 24000), ev('begin_checkout', 9000),
    ev('add_payment_info', 3000), ev('purchase', 1200),
  ]);

  assert.equal(steps['Availability checked'].n, '24,000');
  assert.equal(steps['Booking started'].n, '9,000');
  assert.equal(steps['Payment page'].n, '3,000');
  assert.equal(steps['Booking confirmed'].n, '1,200');
});

test('each step names the event it counted', () => {
  /* So a figure can be checked against the GA4 interface rather than taken on
     trust — the same reason the metric registry explains itself. */
  const { steps } = funnelOf([ev('begin_checkout', 9000)]);
  assert.equal(steps['Booking started'].event, 'begin_checkout');
});

test('a step falls from the last measured step, not from the row above it', () => {
  /* With a step unmeasured in between, a step-on-step drop would be a fall from
     nothing. */
  const { steps } = funnelOf([ev('view_item', 25000), ev('add_payment_info', 5000)], 100000);

  assert.equal(steps['Availability checked'].drop, '−75.0%');
  assert.equal(steps['Guest details entered'].n, '—');
  /* 5,000 of the 25,000 that checked availability, not of the 100,000 that
     landed and not of a step that reported nothing. */
  assert.equal(steps['Payment page'].drop, '−80.0%');
});

test('an event the property does not send leaves its step dashed', () => {
  const { steps } = funnelOf([ev('view_item', 24000)]);

  for (const label of ['Booking started', 'Guest details entered', 'Payment page']) {
    assert.equal(steps[label].n, '—', `${label} was filled from an event that does not exist`);
    assert.equal(steps[label].w, '0%');
  }
});

test('two overlapping aliases count once, not twice', () => {
  /* view_item and view_item_list on one property measure overlapping things.
     Summing them would count a visit twice; the first alias in the list — the
     recommended name — wins. */
  const { steps } = funnelOf([ev('view_item', 24000), ev('view_item_list', 31000)]);
  assert.equal(steps['Availability checked'].n, '24,000');
});

test('an engine that names its own events is still matched', () => {
  const { steps } = funnelOf([ev('availability_search', 12000), ev('booking_started', 4000)]);
  assert.equal(steps['Availability checked'].n, '12,000');
  assert.equal(steps['Booking started'].n, '4,000');
});

test('events nobody claimed are listed, biggest first', () => {
  /* A dashed step says nothing about why. The list is what lets a reader name
     the event their engine actually sends, rather than the tool matching
     loosely and counting the wrong thing. */
  const { out } = funnelOf([ev('view_item', 24000), ev('user_engagement', 150000), ev('scroll', 80000)]);

  assert.deepEqual(out.unclaimedEvents.map((e) => e.event), ['user_engagement', 'scroll']);
  assert.ok(!out.unclaimedEvents.some((e) => e.event === 'view_item'), 'a counted event is not unclaimed');
  assert.ok(out.missingSteps.includes('Booking started'));
});

test('a property with no events at all still reports its first and last step', () => {
  /* The behaviour this replaced must survive the replacement: sessions and
     purchases come from their own reports and do not need events. */
  const { steps } = funnelOf([]);
  assert.equal(steps['Landing page view'].n, '1.0L');
  assert.equal(steps['Availability checked'].n, '—');
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

  const a = EXTERNAL_ID.event_day({ eventName: 'begin_checkout', date: '2026-08-21' });
  const b = EXTERNAL_ID.event_day({ eventName: 'purchase', date: '2026-08-21' });
  assert.notEqual(a, b, 'two events on one day would overwrite each other');
  assert.match(a, /2026-08-21$/, 'the day is not in the key, so a re-pull would lose history');
});
