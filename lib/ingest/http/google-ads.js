/* Google Ads — the request shape for a real pull.
 *
 * Confirmed against developers.google.com/google-ads/api (REST design overview,
 * REST auth, developer-token guide), not written from memory: **v25**, host
 * `googleads.googleapis.com`, reporting through `:searchStream` with a GAQL
 * query in the body.
 *
 *   POST https://googleads.googleapis.com/v25/customers/{customerId}:searchStream
 *   Authorization: Bearer <access token>
 *   developer-token: <22-character token>
 *   login-customer-id: <manager id, when the credentials belong to a manager>
 *
 * **Three things make this shaped differently from Meta, not merely longer.**
 *
 * 1. *There is a token exchange.* Meta's system-user token is the credential.
 *    Google's stored credential is a *refresh* token, which buys a short-lived
 *    access token that has to be fetched before the first call and reused until
 *    it expires. Exchanging one per request would work and would be four extra
 *    round trips per pull, so it is cached until just before expiry.
 *
 * 2. *The query language and the response disagree on spelling.* GAQL is
 *    snake_case — `metrics.cost_micros` — while the REST response is nested
 *    lowerCamelCase — `{ metrics: { costMicros } }`. Both appear in this file
 *    and neither is a typo.
 *
 * 3. *`searchStream` does not paginate.* It streams the whole result as an
 *    array of chunks, each with its own `results`. So there is no cursor, and
 *    `extract` flattens chunks rather than following a link.
 *
 * The same `until`-is-inclusive trap as Meta applies: GAQL `BETWEEN` includes
 * both ends and this codebase's windows are half-open, so `to` is stepped back
 * a day. Getting that wrong double-counts one day on every pull for ever.
 */

const VERSION = 'v25';
const HOST = 'https://googleads.googleapis.com';
const TOKEN_URL = 'https://www.googleapis.com/oauth2/v3/token';

/* Refreshed a minute early, so a token that expires mid-pull does not fail the
   call that was already in flight when it lapsed. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/* Access tokens, keyed by the credential that bought them. Module-level because
   a pull asks for four kinds and all four should share one exchange; cleared by
   tests rather than left to leak between them. */
const tokenCache = new Map();

const clearTokenCache = () => tokenCache.clear();

/* Google wants the customer id as digits — the dashes in `123-456-7890` are a
   display convention and are rejected. */
function customerPath(customerId) {
  const digits = String(customerId || '').replace(/[^0-9]/g, '');
  if (!digits) throw new Error('Google Ads needs a customer id');
  return digits;
}

/* Half-open [from, to) into GAQL's inclusive BETWEEN. */
function dateRange(window) {
  if (!window || !window.from || !window.to) return null;
  const until = new Date(Date.parse(window.to) - 86400000);
  if (Number.isNaN(until.getTime())) return null;
  return { since: String(window.from).slice(0, 10), until: until.toISOString().slice(0, 10) };
}

/* One GAQL query per kind. `customer.currency_code` is on every one for the
   same reason Meta's requests ask for `account_currency`: money normalised
   against an assumed currency is wrong the first time an account is not INR.

   `segments.date` is what makes these per-day rows; without it Google returns
   one aggregate row for the whole range and the day-kinds would be a lie. */
const QUERIES = {
  campaign_day: `
    SELECT campaign.id, campaign.name, segments.date, customer.currency_code,
           metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM campaign`,
  adgroup_day: `
    SELECT ad_group.id, ad_group.name, campaign.id, segments.date, customer.currency_code,
           metrics.cost_micros, metrics.impressions, metrics.clicks
    FROM ad_group`,
  keyword_day: `
    SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
           ad_group.id, segments.date, customer.currency_code,
           metrics.cost_micros, metrics.impressions, metrics.clicks
    FROM keyword_view`,
};

function queryFor(kind, window) {
  const base = QUERIES[kind];
  if (!base) throw new Error(`Google Ads: no request shape for "${kind}"`);

  const range = dateRange(window);
  const where = range
    ? `WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`
    /* No window means a connection test. A short preset keeps that cheap
       rather than pulling an account's whole history to prove a token works. */
    : 'WHERE segments.date DURING LAST_7_DAYS';

  return `${base.trim().replace(/\s+/g, ' ')} ${where}`;
}

/* The refresh-token exchange. Its failures are the ones most likely to be hit
   and least likely to be self-explanatory, so they are named rather than passed
   through as "invalid_grant". */
async function accessTokenFor(credentials, fetchImpl) {
  const key = `${credentials.clientId}:${credentials.refreshToken}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
  });

  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`Google Ads: the OAuth token endpoint could not be reached: ${err.message}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    const code = payload.error || `HTTP ${response.status}`;
    /* Google's OAuth errors are single words, and each names a different
       mistake with a different fix. Echoing the word alone sends somebody to
       search engine results for it; naming the fix is the difference between a
       message and a repair.
     *
     * The three that matter here all look alike from the screen — the token was
     * refused — and are repaired in three different places. `deleted_client` in
     * particular is not about the token at all: the *client* is gone, so a new
     * token minted against the old one dies the same way. */
    const HINTS = {
      invalid_grant: ' — the refresh token has been revoked, expired, or was issued for a different OAuth'
        + ' client. It has to be generated again.',
      deleted_client: ' — the OAuth client these credentials belong to no longer exists. Recreating a client'
        + ' issues a new id and secret, and the old refresh token dies with the old client, so all three'
        + ' have to be replaced together.',
      invalid_client: ' — the OAuth client id or secret is wrong, or they are from different clients. They'
        + ' are a matched pair and both come from the same entry in the Cloud console.',
      unauthorized_client: ' — this OAuth client is not allowed to make this grant. A "Web application"'
        + ' client used with a loopback flow does this; the client type has to be Desktop app.',
      /* Consent screen still in Testing with the signing-in account not listed. */
      access_denied: ' — consent was refused. If the app is in Testing mode, the Google account signing in'
        + ' must be listed under Test users on the OAuth consent screen.',
    };
    throw new Error(`Google Ads: could not exchange the refresh token (${code})${HINTS[payload.error] || ''}`);
  }

  tokenCache.set(key, {
    token: payload.access_token,
    /* `??` rather than `||`: an `expires_in` of 0 is falsy, and coalescing it
       to an hour would cache a token that is already dead. */
    expiresAt: Date.now() + (Number(payload.expires_in ?? 3600) * 1000),
  });
  return payload.access_token;
}

/* Which accounts these credentials can actually reach.
 *
 * Typing a ten-digit customer id from memory is the one step of this connection
 * that has no feedback: a wrong one authenticates perfectly and then 404s on
 * every pull, which reads as a broken connector rather than a typo. Google will
 * simply say which accounts the token can see, so the screen offers them.
 *
 * `listAccessibleCustomers` is deliberately the *only* call used here, because
 * it is permitted at every developer-token level — including a Test token that
 * cannot read a single one of the accounts it returns. So the picker works
 * before approval comes through, which is exactly when somebody is setting this
 * up. Names need a second call per account and that one *is* refused at test
 * level, so they are fetched best-effort and the id stands alone when refused.
 */
async function accessibleCustomers(credentials, fetchImpl = fetch) {
  const accessToken = await accessTokenFor(credentials, fetchImpl);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': String(credentials.developerToken || '').trim(),
  };

  const response = await fetchImpl(`${HOST}/${VERSION}/customers:listAccessibleCustomers`, { headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !Array.isArray(payload.resourceNames)) {
    const said = payload && payload.error && payload.error.message;
    throw new Error(`Google Ads: could not list accounts${said ? ` — ${said}` : ` (HTTP ${response.status})`}`);
  }

  const ids = payload.resourceNames.map((name) => String(name).split('/').pop()).filter(Boolean);

  /* Best effort, one call per account, and every failure is swallowed on
     purpose: a name is a convenience and its absence must not cost the picker.
     A Test-level token refuses all of these while listing the ids happily. */
  const named = await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetchImpl(`${HOST}/${VERSION}/customers/${id}/googleAds:search`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'login-customer-id': id },
        body: JSON.stringify({ query: 'SELECT customer.descriptive_name, customer.manager, customer.currency_code FROM customer LIMIT 1' }),
      });
      const body = await res.json().catch(() => null);
      const row = body && body.results && body.results[0] && body.results[0].customer;
      if (!row) return { id, name: null, manager: null, currency: null };
      return { id, name: row.descriptiveName || null, manager: Boolean(row.manager), currency: row.currencyCode || null };
    } catch (err) {
      return { id, name: null, manager: null, currency: null };
    }
  }));

  return named;
}

async function request({ kind, window, credentials, fetchImpl }) {
  const customer = customerPath(credentials.customerId);
  const accessToken = await accessTokenFor(credentials, fetchImpl);

  const headers = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': String(credentials.developerToken || '').trim(),
    'content-type': 'application/json',
  };

  /* Only when the credentials belong to a manager account acting on a client's
     behalf. Sending it when it does not apply is itself an error, so it is set
     only if given. */
  const manager = String(credentials.loginCustomerId || '').replace(/[^0-9]/g, '');
  if (manager) headers['login-customer-id'] = manager;

  return {
    url: `${HOST}/${VERSION}/customers/${customer}:searchStream`,
    method: 'POST',
    headers,
    body: JSON.stringify({ query: queryFor(kind, window) }),
  };
}

/* Google reports failure as an object where success is an array, which makes
   the two easy to tell apart. The useful message is usually nested inside
   `details[].errors[]` rather than at the top. */
function checkForError(payload, response) {
  const error = payload && !Array.isArray(payload) && payload.error;
  if (!error && response && response.ok) return;

  if (error) {
    const parts = [error.message || 'Google Ads refused the request'];

    const details = Array.isArray(error.details) ? error.details : [];
    for (const detail of details) {
      for (const inner of (detail.errors || [])) {
        if (inner.message && inner.message !== error.message) parts.push(inner.message);
      }
    }

    if (error.status) parts.push(`status ${error.status}`);
    if (error.status === 'RESOURCE_EXHAUSTED') {
      parts.push('this is a quota limit, not a credential problem — the pull should be retried later');
    }
    if (error.status === 'PERMISSION_DENIED') {
      parts.push('a developer token with only test-account access cannot read a production account');
    }

    throw new Error(`Google Ads: ${parts.join(' — ')}`);
  }

  throw new Error(`Google Ads: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
}

/* `searchStream` answers with an array of chunks, each carrying its own
   `results`. There is no cursor to follow — the stream is the whole answer — so
   `nextCursor` is always null and the transport's paging loop runs once. */
function extract(payload) {
  const chunks = Array.isArray(payload) ? payload : [payload];
  const rows = [];
  for (const chunk of chunks) {
    if (chunk && Array.isArray(chunk.results)) rows.push(...chunk.results);
  }
  return { rows, nextCursor: null };
}

module.exports = {
  id: 'google_ads',
  requires: ['customerId', 'developerToken', 'refreshToken', 'clientId', 'clientSecret'],
  request,
  extract,
  checkForError,
  queryFor,
  dateRange,
  customerPath,
  accessTokenFor,
  accessibleCustomers,
  clearTokenCache,
  VERSION,
  TOKEN_URL,
  QUERIES,
};
