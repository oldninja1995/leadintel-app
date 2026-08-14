/* Google Analytics 4 — the Data API request shape.
 *
 *   node --test test/google-analytics.test.js
 *
 * The two mistakes this API punishes hardest are sending the measurement id
 * instead of the property id, and reusing the Google Ads OAuth token — both of
 * which come back as permission errors rather than as what they are.
 */

const test = require('node:test');
const assert = require('node:assert');

const ga = require('../lib/ingest/http/google-analytics');
const httpConnectors = require('../lib/ingest/http');
const canonical = require('../lib/ingest/canonical');
const sources = require('../lib/ingest/sources');

const CREDS = {
  propertyId: '123456789', clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt',
};
const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' };

/* The connector exchanges a refresh token before it can say what the request
   is, so every `request` test needs a stub that answers the token endpoint. */
const withToken = (then) => async (url, init) => {
  if (String(url).includes('oauth2')) return { ok: true, status: 200, async json() { return { access_token: 'at', expires_in: 3600 }; } };
  return then ? then(url, init) : { status: 200, async json() { return {}; } };
};

/* ── the property id ────────────────────────────────────────────────────── */

test('a measurement id is refused by name rather than sent', () => {
  /* Both are called "the property" in different parts of Google's own UI, and
     sending this one gets a 403 that reads as a permissions problem. */
  assert.throws(() => ga.propertyPath({ propertyId: 'G-ABC123' }), /measurement id/);
});

test('a property id is accepted with or without the properties\/ prefix', () => {
  assert.equal(ga.propertyPath({ propertyId: '123456789' }), '123456789');
  assert.equal(ga.propertyPath({ propertyId: 'properties/123456789' }), '123456789');
});

test('a missing property id is named, not sent as an empty path', () => {
  assert.throws(() => ga.propertyPath({}), /needs a property id/);
});

/* ── the window ─────────────────────────────────────────────────────────── */

test('the half-open window becomes GA4\'s inclusive range', () => {
  /* Same correction Meta and Google Ads need: getting it wrong double-counts a
     day on every pull for ever. */
  assert.deepEqual(ga.dateRange(WINDOW), { startDate: '2026-08-01', endDate: '2026-08-07' });
});

test('a pull with no window falls back to a short recent range, for the Test button', async () => {
  /* The Connections screen tests a credential with window: null. Refusing
     failed every test with 'needs a date range', which reads as a broken
     connector rather than a check that was never given a window. */
  const req = await ga.request({ kind: 'session_day', window: null, credentials: CREDS, fetchImpl: withToken() });
  const body = JSON.parse(req.body);
  assert.equal(body.dateRanges.length, 1);
  assert.match(body.dateRanges[0].startDate, /^\d{4}-\d{2}-\d{2}$/);
});

/* ── the request ────────────────────────────────────────────────────────── */

test('a report is a POST whose body carries the query', async () => {
  const req = await ga.request({ kind: 'channel_day', window: WINDOW, credentials: CREDS, fetchImpl: withToken() });
  const body = JSON.parse(req.body);

  assert.equal(req.method, 'POST');
  assert.ok(req.url.endsWith('/properties/123456789:runReport'), req.url);
  assert.equal(req.headers.authorization, 'Bearer at');
  assert.deepEqual(body.dimensions.map((d) => d.name), ['date', 'sessionDefaultChannelGroup']);
  assert.deepEqual(body.dateRanges, [{ startDate: '2026-08-01', endDate: '2026-08-07' }]);
});

test('the channel cut asks Google for its own classification', () => {
  /* Re-deriving "is this paid search" from source/medium is how a screen
     quietly stops agreeing with the GA interface people check it against. */
  assert.ok(ga.DIMENSIONS.channel_day.includes('sessionDefaultChannelGroup'));
});

test('the metric list avoids the names Google has renamed', () => {
  /* An unknown metric fails the whole report, so one wrong name would take
     sessions and users down with it. `conversions` became `keyEvents` and both
     exist in the wild depending on property age. */
  assert.ok(!ga.METRICS.includes('conversions'));
  assert.ok(!ga.METRICS.includes('keyEvents'));
  assert.ok(ga.METRICS.includes('sessions'));
});

test('an unknown kind is refused rather than reported empty', async () => {
  await assert.rejects(
    ga.request({ kind: 'landing_page_day', window: WINDOW, credentials: CREDS, fetchImpl: withToken() }),
    /no request shape/
  );
});

/* ── the response ───────────────────────────────────────────────────────── */

const report = (rows, rowCount) => ({
  dimensionHeaders: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
  metricHeaders: ga.METRICS.map((name) => ({ name })),
  rows,
  rowCount,
});

const row = (date, group, sessions) => ({
  dimensionValues: [{ value: date }, { value: group }],
  metricValues: [{ value: String(sessions) }, { value: '900' }, { value: '700' }, { value: '0.41' }, { value: '96.4' }, { value: '2100' }],
});

test('the compact date becomes a real one', () => {
  /* GA4 returns `20260814`, which sorts correctly and parses as nothing. */
  assert.equal(ga.isoDate('20260814'), '2026-08-14');
  const { rows } = ga.extract(report([row('20260801', 'Paid Search', 421)], 1), { kind: 'channel_day' });
  assert.equal(rows[0].date, '2026-08-01');
});

test('metrics come back as numbers, not the strings the API sends', () => {
  /* Meta's string counts concatenated a month of impressions into a 250-digit
     figure. Same shape of bug, prevented in the same place. */
  const { rows } = ga.extract(report([row('20260801', 'Paid Search', 421)], 1), { kind: 'channel_day' });
  assert.strictEqual(rows[0].sessions, 421);
  assert.strictEqual(rows[0].bounceRate, 0.41);
});

test('paging follows rowCount rather than the page it got', () => {
  const first = ga.extract(report([row('20260801', 'Direct', 10), row('20260801', 'Paid Search', 20)], 5), { kind: 'channel_day' });
  assert.deepEqual(first.nextCursor, { offset: 2 });

  const last = ga.extract(report([row('20260802', 'Direct', 5)], 3), { kind: 'channel_day', cursor: { offset: 2 } });
  assert.equal(last.nextCursor, null);
});

/* ── refusals ───────────────────────────────────────────────────────────── */

test('a 403 names the scope, because the Google Ads token is the likely mistake', () => {
  /* The two credentials look identical and one of them is already stored. */
  assert.throws(
    () => ga.checkForError({ error: { message: 'permission denied' } }, { status: 403 }),
    /analytics.readonly/
  );
});

test('a clean report raises nothing', () => {
  assert.doesNotThrow(() => ga.checkForError({ rows: [], rowCount: 0 }, { status: 200 }));
});

/* ── through the pipeline ───────────────────────────────────────────────── */

test('the registry offers google_analytics a request shape', () => {
  assert.equal(httpConnectors.has('google_analytics'), true);
});

test('the source claims no authority it would lose', () => {
  /* GA's conversion counting disagrees with the ad platforms and the CRM by
     design — different windows, different definitions. Its value is the
     behaviour nothing else can see. */
  assert.deepEqual(sources.get('google_analytics').wins, []);
  assert.equal(sources.get('google_analytics').system, 'web');
});

test('the three cuts stay separate collections', () => {
  /* Summed together they would count every session three times — once
     undimensioned, once per channel, once per source/medium. */
  const entities = canonical.build([
    { source: 'google_analytics', kind: 'session_day', externalId: '2026-08-01', body: { date: '2026-08-01', sessions: 1842, totalUsers: 1531, newUsers: 1188, bounceRate: 0.41, averageSessionDuration: 96.4, screenPageViews: 4310 } },
    { source: 'google_analytics', kind: 'channel_day', externalId: 'Paid Search:2026-08-01', body: { date: '2026-08-01', sessionDefaultChannelGroup: 'Paid Search', sessions: 421, totalUsers: 388, newUsers: 341, bounceRate: 0.49, averageSessionDuration: 74.2, screenPageViews: 902 } },
  ]);

  assert.equal(entities.sessionDays.length, 1);
  assert.equal(entities.sessionDays[0].sessions, 1842);
  assert.equal(entities.webChannelDays.length, 1);
  assert.equal(entities.webChannelDays[0].channelGroup, 'Paid Search');
  assert.equal(entities.webChannelDays[0].sessions, 421);
});

/* ── a measurement id is resolved, not refused ──────────────────────────── */

/* `G-XXXXXXX` is what everybody has to hand — it is in the tag and in every
   setup guide. The numeric id is three clicks deeper. Refusing it is accurate
   and still leaves the reader to go and find the right one. */
const adminStub = ({ summaries, streams, failSummaries = false }) => async (url, init) => {
  if (String(url).includes('oauth2')) {
    return { ok: true, status: 200, async json() { return { access_token: 'at', expires_in: 3600 }; } };
  }
  if (String(url).includes('accountSummaries')) {
    if (failSummaries) return { ok: false, status: 403, async json() { return { error: { message: 'Admin API has not been used' } }; } };
    return { ok: true, status: 200, async json() { return summaries; } };
  }
  if (String(url).includes('/dataStreams')) {
    const id = String(url).match(/properties\/(\d+)\/dataStreams/)[1];
    return { ok: true, status: 200, async json() { return { dataStreams: streams[id] || [] }; } };
  }
  return { ok: true, status: 200, async json() { return {}; } };
};

const SUMMARIES = {
  accountSummaries: [{
    propertySummaries: [
      { property: 'properties/111', displayName: 'Old site' },
      { property: 'properties/222', displayName: 'Resort site' },
    ],
  }],
};
const STREAMS = {
  111: [{ webStreamData: { measurementId: 'G-OTHER11' } }],
  222: [{ webStreamData: { measurementId: 'G-KVJESX8NT5' } }],
};

test('a measurement id resolves to the property that carries it', async () => {
  ga.clearPropertyCache();
  const id = await ga.resolveProperty({ ...CREDS, propertyId: 'G-KVJESX8NT5' },
    adminStub({ summaries: SUMMARIES, streams: STREAMS }));
  assert.equal(id, '222');
});

test('the resolved property is what the report is addressed to', async () => {
  ga.clearPropertyCache();
  const req = await ga.request({
    kind: 'session_day', window: WINDOW, credentials: { ...CREDS, propertyId: 'G-KVJESX8NT5' },
    fetchImpl: adminStub({ summaries: SUMMARIES, streams: STREAMS }),
  });
  assert.ok(req.url.includes('/properties/222:runReport'), req.url);
});

test('a numeric id is used directly, with no lookup', async () => {
  ga.clearPropertyCache();
  let calls = 0;
  const counting = async (url, init) => { calls += 1; return adminStub({ summaries: SUMMARIES, streams: STREAMS })(url, init); };
  await ga.resolveProperty(CREDS, counting);
  assert.equal(calls, 0, 'a numeric property id triggered an Admin API walk');
});

test('a property the credential cannot read does not stop the search', async () => {
  /* An account often holds properties this user was never granted. */
  ga.clearPropertyCache();
  const stub = async (url, init) => {
    if (String(url).includes('properties/111/dataStreams')) {
      return { ok: false, status: 403, async json() { return { error: { message: 'no access' } }; } };
    }
    return adminStub({ summaries: SUMMARIES, streams: STREAMS })(url, init);
  };
  assert.equal(await ga.resolveProperty({ ...CREDS, propertyId: 'G-KVJESX8NT5' }, stub), '222');
});

test('a failed lookup names both fixes rather than repeating the mistake', async () => {
  /* The Admin API is a separate API and needs enabling in the same project. */
  ga.clearPropertyCache();
  await assert.rejects(
    ga.resolveProperty({ ...CREDS, propertyId: 'G-KVJESX8NT5' },
      adminStub({ summaries: SUMMARIES, streams: STREAMS, failSummaries: true })),
    /Admin API|numeric property id/
  );
});

test('a measurement id no readable property carries says which were checked', async () => {
  ga.clearPropertyCache();
  await assert.rejects(
    ga.resolveProperty({ ...CREDS, propertyId: 'G-NOTHERE99' },
      adminStub({ summaries: SUMMARIES, streams: STREAMS })),
    /Resort site/
  );
});
