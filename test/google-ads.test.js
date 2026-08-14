/* The Google Ads connector.
 *
 * Stubbed, like the Meta one, and for the same reason. What is worth checking
 * here beyond the Meta set is the token exchange — it is the step Meta does not
 * have, it is where most real failures land, and it is cached, which is the
 * kind of thing that works in a test and leaks between them if left alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const google = require('../lib/ingest/http/google-ads');
const httpConnectors = require('../lib/ingest/http');
const { httpTransport } = require('../lib/ingest/transport');
const connectors = require('../lib/ingest/connectors');
const { QUERIES } = google;
const { EXTERNAL_ID } = connectors;
const canonical = require('../lib/ingest/canonical');
const sources = require('../lib/ingest/sources');

const CREDS = {
  customerId: '123-456-7890',
  developerToken: 'devtoken2222222222222',
  refreshToken: '1//refresh',
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'secret',
};

const GOOGLE = sources.get('google_ads');

test.beforeEach(() => google.clearTokenCache());

/* A stub standing in for both the OAuth endpoint and the reporting endpoint. */
function stub({ rows = [], token = 'ya29.access', tokenStatus = 200, tokenBody = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url === google.TOKEN_URL) {
      return {
        ok: tokenStatus === 200,
        status: tokenStatus,
        json: async () => tokenBody || { access_token: token, expires_in: 3600 },
      };
    }
    return { ok: true, status: 200, json: async () => [{ results: rows }] };
  };
  return { fetchImpl, calls };
}

const ROW = {
  campaign: { id: '778899', name: 'search | Munnar Resort — JUL' },
  segments: { date: '2026-07-14' },
  customer: { currencyCode: 'INR' },
  metrics: { costMicros: '4200000000', impressions: '90100', clicks: '2210', conversions: '17' },
};

/* ── the request ────────────────────────────────────────────────────────── */

test('reporting posts a GAQL query to searchStream', async () => {
  const { fetchImpl } = stub();
  const built = await google.request({ kind: 'campaign_day', window: null, credentials: CREDS, fetchImpl });

  /* `/googleAds` is part of the path. This asserted the URL without it, which
     is how the mistake survived: the test agreed with the connector and both
     were wrong, and Google answered every scheduled pull with a 404 of HTML.
     The spelling here is the discovery document's, verbatim:
     `POST v25/customers/{customersId}/googleAds:searchStream`. */
  assert.equal(built.url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream');
  assert.equal(built.method, 'POST');
  assert.match(JSON.parse(built.body).query, /^SELECT campaign\.id/);
});

/* The two calls in this file address the same service and must agree on how it
   is spelled. They did not, and only the one nobody was watching was wrong. */
test('reporting and the account listing use the same service segment', async () => {
  const { fetchImpl } = stub();
  const { url } = await google.request({ kind: 'campaign_day', window: null, credentials: CREDS, fetchImpl });

  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'ingest', 'http', 'google-ads.js'), 'utf8');

  assert.match(url, /\/googleAds:searchStream$/);
  for (const call of source.match(/customers\/\$\{[^}]+\}[^`]*/g) || []) {
    assert.match(call, /\/googleAds:(search|searchStream)/,
      `"${call}" does not name the googleAds service`);
  }
});

test('the customer id is reduced to digits, since dashes are rejected', () => {
  assert.equal(google.customerPath('123-456-7890'), '1234567890');
  assert.throws(() => google.customerPath(''), /customer id/);
});

test('every required header is present and named exactly', async () => {
  const { fetchImpl } = stub();
  const { headers } = await google.request({ kind: 'campaign_day', window: null, credentials: CREDS, fetchImpl });

  assert.equal(headers.authorization, 'Bearer ya29.access');
  assert.equal(headers['developer-token'], 'devtoken2222222222222');
});

/* Sending it when it does not apply is itself an error. */
test('login-customer-id is sent only when a manager id is given', async () => {
  const { fetchImpl } = stub();

  const without = await google.request({ kind: 'campaign_day', window: null, credentials: CREDS, fetchImpl });
  assert.equal(without.headers['login-customer-id'], undefined);

  google.clearTokenCache();
  const with_ = await google.request({
    kind: 'campaign_day', window: null, fetchImpl,
    credentials: { ...CREDS, loginCustomerId: '999-888-7777' },
  });
  assert.equal(with_.headers['login-customer-id'], '9998887777');
});

/* The same off-by-one as Meta: BETWEEN is inclusive, our windows are not. */
test('a half-open window becomes an inclusive BETWEEN, one day back', () => {
  assert.deepEqual(google.dateRange({ from: '2026-07-01', to: '2026-07-15' }), { since: '2026-07-01', until: '2026-07-14' });
  assert.match(google.queryFor('campaign_day', { from: '2026-07-01', to: '2026-07-15' }), /BETWEEN '2026-07-01' AND '2026-07-14'/);
});

test('no window uses a short preset rather than all of history', () => {
  assert.match(google.queryFor('campaign_day', null), /DURING LAST_7_DAYS/);
});

/* Without segments.date these are not per-day rows at all. */
test('every day-query segments by date and asks for the currency', () => {
  for (const kind of ['campaign_day', 'adgroup_day', 'keyword_day']) {
    const query = google.queryFor(kind, null);
    assert.match(query, /segments\.date/, `${kind} must segment by date`);
    assert.match(query, /customer\.currency_code/, `${kind} must ask for the currency`);
  }
});

test('a kind with no query is refused rather than pulled as empty', () => {
  assert.throws(() => google.queryFor('creative', null), /no request shape/);
});

/* ── the token exchange ─────────────────────────────────────────────────── */

test('the refresh token is exchanged once and reused across kinds', async () => {
  const { fetchImpl, calls } = stub({ rows: [ROW] });

  await connectors.get('google_ads').pull(null, httpTransport({ credentials: CREDS, fetchImpl }));

  const exchanges = calls.filter((c) => c.url === google.TOKEN_URL);
  assert.equal(exchanges.length, 1, 'three kinds must share one access token');
});

test('the exchange posts the documented form parameters', async () => {
  const { fetchImpl, calls } = stub();
  await google.accessTokenFor(CREDS, fetchImpl);

  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), '1//refresh');
  assert.equal(body.get('client_id'), CREDS.clientId);
});

/* The failure everybody hits. "invalid_grant" alone tells nobody anything. */
test('a revoked refresh token is explained, not echoed', async () => {
  const { fetchImpl } = stub({ tokenStatus: 400, tokenBody: { error: 'invalid_grant' } });

  await assert.rejects(
    () => google.accessTokenFor(CREDS, fetchImpl),
    /revoked, expired, or was issued for a different OAuth client/
  );
});

test('an expired cached token is exchanged again', async () => {
  const { fetchImpl, calls } = stub({ tokenBody: { access_token: 'short', expires_in: 0 } });

  await google.accessTokenFor(CREDS, fetchImpl);
  await google.accessTokenFor(CREDS, fetchImpl);

  assert.equal(calls.length, 2, 'a token already past its margin must not be reused');
});

/* ── failures, told apart ───────────────────────────────────────────────── */

test('a test-level developer token is named as the cause, not "permission denied"', () => {
  assert.throws(
    () => google.checkForError({ error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }, { ok: false, status: 403 }),
    /test-account access cannot read a production account/
  );
});

test('a quota limit is not reported as a credential problem', () => {
  assert.throws(
    () => google.checkForError({ error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, { ok: false, status: 429 }),
    /quota limit, not a credential problem/
  );
});

test('the useful message nested in details is surfaced', () => {
  assert.throws(
    () => google.checkForError({
      error: {
        message: 'Request contains an invalid argument.',
        status: 'INVALID_ARGUMENT',
        details: [{ errors: [{ message: 'Unrecognized field in the query: metrics.nonsense' }] }],
      },
    }, { ok: false, status: 400 }),
    /Unrecognized field in the query/
  );
});

/* A successful searchStream answers with an array; a failure answers with an
   object. Confusing the two would swallow every error. */
test('a successful array response is not mistaken for an error', () => {
  assert.doesNotThrow(() => google.checkForError([{ results: [] }], { ok: true, status: 200 }));
});

/* …except that searchStream wraps its failures in an array as well. Reading
   `.error` off the object form alone meant a refused stream matched nothing and
   fell through to the bare status line — the screen read "HTTP 403 Forbidden"
   for weeks while the sentence naming the cause sat in the parsed body. */
test('an error wrapped in an array is read, not skipped', () => {
  assert.throws(
    () => google.checkForError([{
      error: {
        message: 'The caller does not have permission',
        status: 'PERMISSION_DENIED',
        details: [{ errors: [{ message: 'Developer token is not approved for production access.' }] }],
      },
    }], { ok: false, status: 403 }),
    /Developer token is not approved for production access/
  );
});

test('an array-wrapped refusal still explains a test-only developer token', () => {
  assert.throws(
    () => google.checkForError(
      [{ error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }],
      { ok: false, status: 403 }),
    /test-account access cannot read a production account/
  );
});

/* ── the shape reaching the rest of the pipeline ────────────────────────── */

test('chunks are flattened and there is no cursor to follow', async () => {
  const { rows, nextCursor } = google.extract([{ results: [ROW] }, { results: [ROW] }]);
  assert.equal(rows.length, 2);
  assert.equal(nextCursor, null);
});

test('a nested live row keys the same way a flat fixture row does', async () => {
  const { fetchImpl } = stub({ rows: [ROW] });
  const pulled = await connectors.get('google_ads').pull(null, httpTransport({ credentials: CREDS, fetchImpl }));

  const campaignDay = pulled.find((r) => r.kind === 'campaign_day');
  assert.equal(campaignDay.externalId, '778899:2026-07-14');
});

test('stage 2 reads the nested camelCase shape', () => {
  const mapped = canonical.MAPPERS.google_ads.campaign_day(ROW);

  assert.equal(mapped.date.value, '2026-07-14');
  /* 4,200,000,000 micros = ₹4,200 = 420000 paise. */
  assert.equal(mapped.spend.value, 420000);
  assert.equal(mapped.leads.value, 17);
  /* "search" is not one of the platform tokens `campaignName` strips — those
     are the vendor names — so it stays part of the campaign's identity. */
  assert.equal(mapped.campaign.value, 'search munnar resort jul');
});

test('the flat fixture spelling still maps, so replay is unaffected', () => {
  const mapped = canonical.MAPPERS.google_ads.campaign_day({
    campaign_id: '778899', campaign_name: 'search | Munnar Resort — JUL',
    date: '2026-07-14', currency: 'INR', cost_micros: 4200000000,
    impressions: 90100, clicks: 2210, conversions: 17,
  });

  assert.equal(mapped.spend.value, 420000);
  assert.equal(mapped.leads.value, 17);
});

test('a metric absent entirely is unknown, not zero', () => {
  const mapped = canonical.MAPPERS.google_ads.campaign_day({
    campaign: { id: '1', name: 'x' }, segments: { date: '2026-07-14' },
    customer: { currencyCode: 'INR' }, metrics: { costMicros: '1000000' },
  });
  assert.equal(mapped.leads.value, null);
});

test('both ad platforms and the CRM now have a request shape', () => {
  assert.deepEqual(httpConnectors.list().sort(), ['google_ads', 'meta_ads', 'telecrm']);
});

/* ── OAuth refusals, each of which is repaired somewhere different ────────
 *
 * These arrive as a single word from Google. Echoed alone they send somebody to
 * search results; `deleted_client` in particular is not about the token at all —
 * the client is gone, so re-minting against the old one fails identically, which
 * is exactly the loop a bare error code invites.
 */

const oauthRefusal = (error) => ({
  ok: false,
  status: 400,
  json: async () => ({ error }),
});

const exchangeWith = (error) => google.accessTokenFor(
  { clientId: 'c.apps.googleusercontent.com', clientSecret: 's', refreshToken: '1//r' },
  async () => oauthRefusal(error),
);

test('deleted_client says the client is gone, not the token', async () => {
  google.clearTokenCache();
  await assert.rejects(exchangeWith('deleted_client'), /no longer exists.*all three/s);
});

test('invalid_client names the id and secret as a matched pair', async () => {
  google.clearTokenCache();
  await assert.rejects(exchangeWith('invalid_client'), /matched pair/);
});

test('unauthorized_client names the client type', async () => {
  google.clearTokenCache();
  await assert.rejects(exchangeWith('unauthorized_client'), /Desktop app/);
});

test('access_denied names the test-user list', async () => {
  google.clearTokenCache();
  await assert.rejects(exchangeWith('access_denied'), /Test users/);
});

/* The one everybody hits must keep its existing wording. */
test('invalid_grant still says the token must be generated again', async () => {
  google.clearTokenCache();
  await assert.rejects(exchangeWith('invalid_grant'), /generated again/);
});

/* An error nobody has written a hint for must still name itself rather than
   being swallowed into a generic sentence. */
test('an unrecognised refusal still carries Google’s own code', async () => {
  google.clearTokenCache();
  await assert.rejects(exchangeWith('some_new_error'), /some_new_error/);
});

/* ── the kinds added for per-platform Campaign Analytics ─────────────────── */

test('every kind the source declares has a query, and every query is per-day', () => {
  /* `segments.date` missing from any one of these means Google returns a single
     aggregate row for the whole range and that day-kind becomes a lie — the
     trap this connector already fell into once. Asserted across all of them
     rather than per query, so a kind added later cannot skip it. */
  const declared = sources.get('google_ads').kinds;
  for (const kind of declared) {
    assert.ok(QUERIES[kind], `no GAQL query for declared kind "${kind}"`);
    assert.match(QUERIES[kind], /segments\.date/, `${kind} is not segmented by date`);
    assert.match(QUERIES[kind], /customer\.currency_code/, `${kind} does not ask for the currency`);
  }
});

test('the ad level exists, so Google is not shallower than Meta', () => {
  /* The gap that prompted the split: ad groups and keywords were pulled and
     ads were not, so the Google screen could never show what Meta's showed. */
  assert.ok(sources.get('google_ads').kinds.includes('ad_day'));
  assert.match(QUERIES.ad_day, /FROM ad_group_ad/);
});

test('campaign rows carry the channel type the keyword view needs', () => {
  /* App, Performance Max and Shopping campaigns have no keywords. Without this
     field the screen cannot tell "no keywords" from "keywords do not apply". */
  assert.match(QUERIES.campaign_day, /campaign\.advertising_channel_type/);
});

test('conversions can be split by the action that produced them', () => {
  /* Undivided, metrics.conversions is a fractional double summed across every
     action an account defines — the 18,395.989782 "leads" figure. */
  assert.match(QUERIES.conversion_day, /segments\.conversion_action_name/);
});

test('a search term is identified by its text, ad group and day', () => {
  /* Google gives search terms no id — the string is the identity — and the same
     phrase in two ad groups is two rows of spend. */
  const id = EXTERNAL_ID.search_term_day({
    search_term_view: { search_term: 'munnar resort with pool' },
    ad_group: { id: '123' },
    segments: { date: '2026-08-13' },
  });
  assert.match(id, /munnar resort with pool/);
  assert.match(id, /123/);
  assert.match(id, /2026-08-13/);
});

test('two conversion actions on one campaign-day stay separate rows', () => {
  /* If the action were left out of the key, the split this kind exists to make
     would be undone by its own identity rule. */
  const row = (name) => EXTERNAL_ID.conversion_day({
    segments: { conversion_action_name: name, date: '2026-08-13' },
    campaign: { id: '77' },
  });
  assert.notEqual(row('Booking enquiry'), row('Phone click'));
});
