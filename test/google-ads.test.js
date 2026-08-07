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

  assert.equal(built.url, 'https://googleads.googleapis.com/v25/customers/1234567890:searchStream');
  assert.equal(built.method, 'POST');
  assert.match(JSON.parse(built.body).query, /^SELECT campaign\.id/);
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

test('both ad platforms now have a request shape', () => {
  assert.deepEqual(httpConnectors.list().sort(), ['google_ads', 'meta_ads']);
});
