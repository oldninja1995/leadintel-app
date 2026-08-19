/* Phase 6 sub-phase 6.4 — evaluating the registry over a period.
 *
 *   node --test        or        npm test
 *
 * The gap this closes was a quiet one: a card labelled "New leads today"
 * pointed at a period-less metric would print an all-time figure under a
 * period label. So the tests care most about *which date a record belongs to*,
 * and about the clock staying outside the metric layer.
 */

const test = require('node:test');
const assert = require('node:assert');

const period = require('../lib/metrics/period');
const metrics = require('../lib/metrics');

const NOW = '2026-08-06T12:00:00.000Z';

const entities = () => ({
  campaignDays: [
    { campaign: 'munnar', date: '2026-07-14', spend: 700000, impressions: 100, clicks: 10, leads: 5 },
    { campaign: 'munnar', date: '2026-08-06', spend: 300000, impressions: 50, clicks: 5, leads: 2 },
  ],
  leads: [
    { id: 'L-old', campaign: 'munnar', stage: 'Lost', createdAt: '2026-07-01T09:00:00.000Z' },
    { id: 'L-new', campaign: 'munnar', stage: 'Qualified', createdAt: '2026-08-06T09:00:00.000Z' },
    { id: 'L-recent', campaign: 'munnar', stage: 'Lost', createdAt: '2026-08-02T09:00:00.000Z' },
  ],
  bookings: [
    /* Made in June, stayed in August. */
    { id: 'B-1', leadId: 'L-new', checkIn: '2026-08-04', checkOut: '2026-08-06', nights: 2, revenue: { value: 4280000 }, bookingStatus: 'Checked_in' },
    { id: 'B-2', leadId: 'L-old', checkIn: '2026-07-10', checkOut: '2026-07-12', nights: 2, revenue: { value: 1000000 }, bookingStatus: 'Checked_in' },
  ],
  inventoryDays: [
    { id: 'P-MUN:2026-07-14', property: 'Munnar Hillside', date: '2026-07-14', available: 42, sold: 33 },
    { id: 'P-MUN:2026-08-06', property: 'Munnar Hillside', date: '2026-08-06', available: 40, sold: 30 },
  ],
  leadEvents: [{ id: 'E-1', leadId: 'L-new', type: 'first_response', at: '2026-08-06T09:30:00.000Z' }],
  payments: [],
  problems: [],
});

/* ── which date a record belongs to ─────────────────────────────────────── */

test('every collection declares the date it is filtered on', () => {
  for (const collection of ['campaignDays', 'inventoryDays', 'leads', 'leadEvents', 'payments', 'bookings']) {
    assert.ok(period.FIELD[collection], `${collection} has no declared date field`);
  }
});

test('every dated collection canonical produces is declared, not only the ones a screen read', () => {
  /* The guard the Google grains needed and did not have. A collection missing
     from FIELD is *silently* never narrowed — the range control moves, the
     table does not, and nothing throws. That is how the Google Ads screen came
     to answer all-time under every chip while the campaign table beside it
     narrowed correctly: ad groups, ads, keywords, search terms and conversion
     actions were all absent here.
   *
   * Written against canonical's own output rather than a hand-kept list, so a
   * collection added later fails this test instead of quietly joining them. */
  const canonical = require('../lib/ingest/canonical');

  /* What is legitimately not filtered by a date field:
       creatives  — an ad plus its daily series; narrowed by creativesWithin
       audiences  — keyed by id, not a dated row
       problems   — ingest diagnostics, not measurements */
  const exempt = new Set(['creatives', 'audiences', 'problems']);

  const undeclared = Object.keys(canonical.build([]))
    .filter((collection) => !exempt.has(collection) && !period.FIELD[collection]);

  assert.deepEqual(undeclared, [], `these collections would never be narrowed: ${undeclared.join(', ')}`);
});

test("Google's own grains narrow with the range", () => {
  /* Reproduces what production showed: identical ad-group, keyword and
     search-term tables under "Today" and "This year", summing to more spend
     than the whole year held, beneath a campaign table that narrowed. */
  const googleEntities = () => ({
    googleAdGroups: [
      { adgroupId: 'G-1', adgroup: 'brand', date: '2026-07-14', spend: 500000 },
      { adgroupId: 'G-1', adgroup: 'brand', date: '2026-08-06', spend: 200000 },
    ],
    googleAds: [
      { adId: 'A-1', date: '2026-07-14', spend: 100000 },
      { adId: 'A-2', date: '2026-08-06', spend: 100000 },
    ],
    googleKeywords: [
      { keyword: 'munnar resort', date: '2026-07-14', spend: 90000 },
      { keyword: 'munnar resort', date: '2026-08-06', spend: 10000 },
    ],
    googleSearchTerms: [
      { term: 'munnar resort booking', date: '2026-07-14', spend: 40000 },
      { term: 'munnar resort booking', date: '2026-08-06', spend: 60000 },
    ],
    googleConversions: [
      { action: 'Enquiry', date: '2026-07-14', conversions: 3 },
      { action: 'Enquiry', date: '2026-08-06', conversions: 1 },
    ],
  });

  const august = period.within(googleEntities(), { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' });
  for (const collection of ['googleAdGroups', 'googleAds', 'googleKeywords', 'googleSearchTerms', 'googleConversions']) {
    assert.equal(august[collection].length, 1, `${collection} was not narrowed`);
    assert.equal(august[collection][0].date, '2026-08-06');
  }

  const july = period.within(googleEntities(), { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.equal(july.googleAdGroups[0].spend, 500000);
});

test('a booking belongs to the night stayed, not the day booked', () => {
  /* The load-bearing choice: revenue has to sit beside occupancy and RevPAR,
     which come from inventory rows that are per night by construction. */
  assert.equal(period.FIELD.bookings, 'checkIn');

  const august = period.within(entities(), { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(august.bookings.map((b) => b.id), ['B-1']);
});

test('a whole-day date and an instant both compare correctly', () => {
  /* Calendar dates carry no timezone on purpose (stage 2), so they are
     anchored before comparing rather than compared as bare strings. */
  const july = period.within(entities(), { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.deepEqual(july.campaignDays.map((d) => d.date), ['2026-07-14']);
  assert.deepEqual(july.leads.map((l) => l.id), ['L-old']);
});

test('the upper bound is exclusive', () => {
  const upTo = period.within(entities(), { from: null, to: '2026-08-06T00:00:00.000Z' });
  assert.ok(!upTo.campaignDays.some((d) => d.date === '2026-08-06'), 'the end of the window was included');
});

test('an open end is a real question', () => {
  const before = period.within(entities(), { from: null, to: '2026-08-01T00:00:00.000Z' });
  assert.equal(before.leads.length, 1);

  const after = period.within(entities(), { from: '2026-08-01T00:00:00.000Z', to: null });
  assert.equal(after.leads.length, 2);
});

test('no period is a pass-through, not a copy', () => {
  const e = entities();
  assert.equal(period.within(e, null), e);
  assert.equal(period.within(e, { from: null, to: null }), e);
});

test('a record with no date is excluded rather than silently kept', () => {
  const e = entities();
  e.leads.push({ id: 'L-undated', campaign: 'munnar', stage: 'New' });
  const window = period.within(e, { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
  assert.ok(!window.leads.some((l) => l.id === 'L-undated'), 'an undated record was counted inside a window');
});

/* ── relative windows ───────────────────────────────────────────────────── */

test('a relative window needs a reference instant, never the clock', () => {
  /* 6.2's reproducibility rests on evaluation being pure — a metric layer that
     read Date.now() internally could not be replayed. */
  assert.throws(() => period.fromLabel('last-24h'), /needs a reference instant/);
  assert.throws(() => period.fromLabel('last-24h', 'not a time'), /is not a time/);
});

test('the named windows resolve against the reference', () => {
  assert.deepEqual(period.fromLabel('last-24h', NOW), { from: '2026-08-05T12:00:00.000Z', to: NOW, label: 'last-24h' });
  /* `calendar` marks a window that steps back a month or a year rather than
     its own length — see `previous`. */
  assert.deepEqual(period.fromLabel('this-month', NOW), { from: '2026-08-01T00:00:00.000Z', to: NOW, label: 'this-month', calendar: 'month' });
  assert.equal(period.fromLabel('all', NOW), null);
});

test('"older than two hours" is an upper bound, not a window', () => {
  const older = period.fromLabel('last-2h', NOW);
  assert.equal(older.from, null);
  assert.equal(older.to, '2026-08-06T10:00:00.000Z');
});

test('an unknown window is refused', () => {
  assert.throws(() => period.fromLabel('last-fortnight', NOW), /unknown period/);
});

/* ── evaluating over a window ───────────────────────────────────────────── */

test('a metric over a window differs from the same metric over all time', () => {
  const e = entities();
  const all = metrics.evaluate(e).values;
  const august = metrics.evaluate(e, { over: period.fromLabel('this-month', NOW) }).values;

  assert.equal(all['leads.count'], 3);
  assert.equal(august['leads.count'], 2, 'the window did not narrow the leads');
  assert.equal(all['revenue.net'], 5280000);
  assert.equal(august['revenue.net'], 4280000);
});

test('a derived metric follows its inputs into the window', () => {
  const august = metrics.evaluate(entities(), { over: period.fromLabel('this-month', NOW) }).values;
  /* ₹42,800 of revenue over ₹3,000 of August spend. */
  assert.equal(august['roas.net'], 4280000 / 300000);
});

test('"new leads today" is leads.count over the last 24 hours', () => {
  const today = metrics.evaluate(entities(), { over: period.fromLabel('last-24h', NOW) }).values;
  assert.equal(today['leads.count'], 1);
});

test('"untouched > 2h" is unanswered leads older than two hours', () => {
  /* L-new arrived at 09:00 and was answered at 09:30; L-recent and L-old are
     both older than two hours and neither has a first response. */
  const stale = metrics.evaluate(entities(), { over: period.fromLabel('last-2h', NOW) }).values;
  assert.equal(stale['leads.unanswered'], 2);

  const all = metrics.evaluate(entities()).values;
  assert.equal(all['leads.unanswered'], 2, 'the answered lead was counted as unanswered');
});

test('"lost this month" excludes a loss from last month', () => {
  const month = metrics.evaluate(entities(), { over: period.fromLabel('this-month', NOW) }).values;
  assert.equal(month['leads.lost'], 1, 'July’s lost lead was counted in August');
  assert.equal(metrics.evaluate(entities()).values['leads.lost'], 2);
});

/* ── composing with a grain ─────────────────────────────────────────────── */

test('a grain and a window compose', () => {
  const e = entities();
  const both = metrics.evaluate(e, {
    at: { dimension: 'campaign', value: 'munnar' },
    over: period.fromLabel('this-month', NOW),
  });
  assert.equal(both.values['ads.spend'], 300000);
  assert.ok(both.notApplicable.includes('occupancy.rate'), 'the grain stopped applying once a window was added');
  assert.equal(both.over.label, 'this-month');
});

test('the report states the window it was computed over', () => {
  const report = metrics.report(entities(), { over: period.fromLabel('7d', NOW) });
  assert.equal(report.over.label, '7d');
});

/* ── creatives are narrowed by re-totalling their series ────────────────── */

/* A creative is not a dated row. It was absent from FIELD and so was never
   narrowed: Creative Intelligence answered identical figures under "7d" and
   "90d" while the range control above them said otherwise. */

const creativeEntities = () => ({
  campaignDays: [],
  leads: [],
  bookings: [],
  payments: [],
  creatives: [{
    entity: 'creative',
    adId: 'AD1',
    title: 'Monsoon 15s',
    spend: 3000,
    impressions: 90000,
    clicks: 1200,
    leads: 30,
    days: 3,
    series: [
      { date: '2026-08-01', spend: 1000, impressions: 30000, clicks: 400, leads: 10, frequency: 2 },
      { date: '2026-08-02', spend: 1000, impressions: 30000, clicks: 400, leads: 10, frequency: 3 },
      { date: '2026-08-09', spend: 1000, impressions: 30000, clicks: 400, leads: 10, frequency: 4 },
    ],
  }],
});

test('a creative is re-totalled from the days inside the window', () => {
  const { creatives } = period.within(creativeEntities(), { from: '2026-08-01', to: '2026-08-03' });
  const [c] = creatives;

  assert.equal(c.days, 2);
  assert.equal(c.spend, 2000);
  assert.equal(c.impressions, 60000);
  assert.equal(c.leads, 20, 'leads must narrow with spend, not stay at the all-time figure');
});

test('a rate is averaged over the days in the window, never added', () => {
  const { creatives } = period.within(creativeEntities(), { from: '2026-08-01', to: '2026-08-03' });
  assert.equal(creatives[0].frequency, 2.5, 'adding frequencies would grow it with the window');
});

test('a creative that did not run in the window reports null, not zero', () => {
  const { creatives } = period.within(creativeEntities(), { from: '2026-09-01', to: '2026-09-30' });
  const [c] = creatives;

  assert.equal(c.days, 0);
  assert.equal(c.spend, null, 'an ad that did not run did not run badly');
  assert.equal(c.leads, null);
});

test('a window covering everything leaves the creative untouched', () => {
  const before = creativeEntities().creatives[0];
  const { creatives } = period.within(creativeEntities(), { from: '2026-01-01', to: '2027-01-01' });

  assert.deepEqual(creatives[0], before);
});

/* ── the window before this one ─────────────────────────────────────────── */

/* "vs previous period" sat in the topbar since the design was drawn while every
   card rendered a bare "·". This is the window that sentence describes. */

test('the previous period is the same length, ending where this one starts', () => {
  const before = period.previous({ from: '2026-08-04T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' });

  assert.equal(before.to, '2026-08-04T00:00:00.000Z', 'it must end where the current window begins');
  assert.equal(before.from, '2026-07-28T00:00:00.000Z', 'seven days, like the window it precedes');
});

test('no day is counted in both windows', () => {
  const now = { from: '2026-08-04T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' };
  const before = period.previous(now);

  /* Half-open at both ends. An overlap of one day would understate every
     change by about a day's worth and never look wrong. */
  assert.ok(!period.inRange(before.to, before.from, before.to), 'the boundary day fell in both');
  assert.ok(period.inRange(before.to, now.from, now.to), 'the boundary day belongs to the current window');
});

test('all time has nothing before it', () => {
  assert.equal(period.previous(null), null);
  assert.equal(period.previous({ from: null, to: null }), null);
  assert.equal(period.previous({ from: '2026-08-11', to: '2026-08-11' }), null, 'a zero-length window');
});

/* ── a range the reader picked ──────────────────────────────────────────── */

/* The topbar's calendar was a read-only label wearing the icon of a control:
   clicking it did nothing, and the four preset chips were the only ranges the
   product could express. This is what the picker sends. */

test('a picked range covers the last day the reader chose', () => {
  const over = period.fromRange('2026-07-01', '2026-07-31');

  assert.equal(over.from, '2026-07-01T00:00:00.000Z');
  /* Half-open, so the end is advanced by a day. Dropping the 31st is the same
     inclusive-`until` trap both ad connectors had to solve. */
  assert.equal(over.to, '2026-08-01T00:00:00.000Z');
  assert.ok(period.inRange('2026-07-31T09:00:00.000Z', over.from, over.to), 'the last day fell outside its own range');
});

test('a single day is a range of one day', () => {
  const over = period.fromRange('2026-07-15', '2026-07-15');
  assert.ok(period.inRange('2026-07-15T23:59:00.000Z', over.from, over.to));
  assert.ok(!period.inRange('2026-07-16T00:00:00.000Z', over.from, over.to));
});

test('anything unparseable or backwards declines rather than guessing', () => {
  assert.equal(period.fromRange('yesterday', '2026-07-31'), null);
  assert.equal(period.fromRange('2026-07-01', ''), null);
  assert.equal(period.fromRange('2026-07-01T00:00:00Z', '2026-07-31'), null, 'a full timestamp is not a picked day');
  /* Swapping them for the reader would answer a question they did not ask. */
  assert.equal(period.fromRange('2026-07-31', '2026-07-01'), null);
});

test('a picked range has a previous period like any other', () => {
  const before = period.previous(period.fromRange('2026-07-01', '2026-07-31'));

  assert.equal(before.to, '2026-07-01T00:00:00.000Z', 'it ends where the picked range begins');
  /* July has 31 days, so the window is 31 long and the one before it starts on
     31 May — not 1 June, which would be 30 and would compare unequal lengths. */
  assert.equal(before.from, '2026-05-31T00:00:00.000Z');
});

test('two picked ranges are not the same window', () => {
  const june = period.fromRange('2026-06-01', '2026-06-30');
  const july = period.fromRange('2026-07-01', '2026-07-31');

  /* Both were labelled "custom", and the metric cache keyed on the label — so
     June and July shared an entry and the second range asked for answered with
     the first one's figures, to the rupee. */
  assert.notEqual(june.label, july.label);
  assert.notEqual(`${june.from}..${june.to}`, `${july.from}..${july.to}`);
});

/* ── calendar windows ───────────────────────────────────────────────────── */

const REF = '2026-08-14T09:30:00.000Z';

test('last month is the whole of it, not a month ending today', () => {
  /* A window that stopped at the 14th of July would be a figure nobody asked
     for, and would keep changing after July had ended. */
  const w = period.fromLabel('last-month', REF);
  assert.equal(w.from, '2026-07-01T00:00:00.000Z');
  assert.equal(w.to, '2026-08-01T00:00:00.000Z');
});

test('this month runs from the first to now', () => {
  const w = period.fromLabel('this-month', REF);
  assert.equal(w.from, '2026-08-01T00:00:00.000Z');
  assert.equal(w.to, REF);
});

test('this year runs from January the first', () => {
  const w = period.fromLabel('this-year', REF);
  assert.equal(w.from, '2026-01-01T00:00:00.000Z');
  assert.equal(w.to, REF);
});

test('a calendar month compares against the previous calendar month', () => {
  /* July is 31 days, so subtracting its own span lands on 31 May and compares
     July against one day of May plus all of June. Small, wrong, and different
     every month — which is how it would have survived. */
  const july = period.fromLabel('last-month', REF);
  const before = period.previous(july);
  assert.equal(before.from, '2026-06-01T00:00:00.000Z');
  assert.equal(before.to, '2026-07-01T00:00:00.000Z');
});

test('a calendar year compares against the previous calendar year', () => {
  const before = period.previous(period.fromLabel('this-year', REF));
  assert.equal(before.from, '2025-01-01T00:00:00.000Z');
  assert.equal(before.to, '2026-01-01T00:00:00.000Z');
});

test('a rolling window still steps back by its own span', () => {
  const before = period.previous(period.fromLabel('7d', REF));
  assert.equal(before.to, period.fromLabel('7d', REF).from);
  assert.equal(Date.parse(before.to) - Date.parse(before.from), 7 * 86400000);
});

test('January steps back into December of the year before', () => {
  const jan = period.fromLabel('last-month', '2026-01-14T00:00:00.000Z');
  assert.equal(jan.from, '2025-12-01T00:00:00.000Z');
  assert.equal(period.previous(jan).from, '2025-11-01T00:00:00.000Z');
});
