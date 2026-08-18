/* Google Analytics 4 — the request shape for a real pull.
 *
 * The Data API, not the old Reporting API and not Universal Analytics:
 *
 *   POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport
 *   Authorization: Bearer <access token>
 *
 * `propertyId` is the numeric GA4 property (Admin → Property Settings), not the
 * `G-XXXXXXX` measurement id that appears in the tag. They are both called "the
 * property" in different parts of Google's own UI, and sending the measurement
 * id gets a 403 that reads like a permissions problem.
 *
 * **The OAuth credential is not the Google Ads one**, even though it is the same
 * shape and probably the same client. Google Ads tokens are granted the adwords
 * scope; this needs `analytics.readonly`, and a token without it is refused with
 * the same `invalid_grant`-shaped message. The token exchange itself is
 * identical, so it is borrowed from the Google Ads connector rather than
 * written twice.
 *
 * Three things about this API worth stating once:
 *
 * 1. *A report is a POST whose body is the query.* Dimensions and metrics are
 *    named in the body; there is no query language and no way to ask for
 *    "everything", so each kind here is a fixed dimension/metric pair chosen
 *    for a screen that needs it.
 *
 * 2. *An unknown metric name fails the whole request*, so the metric list is
 *    deliberately conservative. Google renames these (`conversions` became
 *    `keyEvents`), and one wrong name would take sessions and users down with
 *    it rather than returning them and omitting the rest.
 *
 * 3. *Dates come back as `YYYYMMDD` strings* with no separators, which sort
 *    correctly and parse as nothing. They are converted here, because the store
 *    windows on a real date.
 */

const { accessTokenFor } = require('./google-ads');

const HOST = 'https://analyticsdata.googleapis.com';
const VERSION = 'v1beta';

/* The window a credential test uses when the caller supplies none. */
const TEST_DAYS = 7;

/* GA4's own maximum is 250,000; this is a page size, and a smaller one keeps a
   single invocation bounded on a property with a long history. */
const PAGE = 10000;
const MIN_PAGE = 1000;

/* Metrics every kind reports.
 *
 * Confined to names that have been stable across GA4's renames. `conversions`
 * is deliberately absent: it became `keyEvents`, both spellings exist in the
 * wild depending on property age, and asking for the wrong one fails the entire
 * report rather than that column. Events get their own kind when somebody needs
 * booking-engine starts, and can fail on their own. */
const METRICS = [
  'sessions',
  'totalUsers',
  'newUsers',
  'bounceRate',
  'averageSessionDuration',
  'screenPageViews',
];

/* Revenue, in a kind of its own so that it can fail alone.
 *
 * `totalRevenue` exists only on a property with ecommerce measurement wired up,
 * and — as the note above says — an unknown metric name fails the WHOLE report,
 * not that column. Adding it beside `sessions` would therefore put three
 * working kinds at the mercy of a booking engine's tagging. Its own kind means
 * a property without purchase events loses this one and keeps the rest, and the
 * error names the metric instead of the source.
 *
 * `totalRevenue` rather than `purchaseRevenue` because that is the column the
 * property was confirmed to report — GA4's Traffic acquisition report shows it
 * as "Total revenue", and asking for the other spelling is the failure this
 * separation exists to contain. */
/* `ecommercePurchases` is the count beside the value — how many reservations
   made up `totalRevenue`, so an average booking value can be read rather than
   inferred. GA4 renamed `transactions` to this; both spellings exist in the
   wild by property age, and the wrong one fails the report. It rides in this
   kind rather than a fourth one because the two are read together and a value
   with no count is half an answer — but that does mean a rename takes revenue
   with it, so the sync is checked for partial failures immediately after any
   change here. */
const REVENUE_METRICS = ['totalRevenue', 'ecommercePurchases'];

const METRICS_FOR = { channel_revenue_day: REVENUE_METRICS };

/* One report per kind. The dimensions are the whole difference between them —
   the same measurements, cut by nothing, by channel, or by source/medium.

   `sessionDefaultChannelGroup` is what answers "how much of this is paid
   search": Google classifies each session into Organic Search, Paid Search,
   Paid Social, Direct, Referral, Email and so on, using its own rules rather
   than ours. Deriving that from source/medium by hand is the classic way to
   quietly disagree with the numbers in the GA UI. */
const DIMENSIONS = {
  session_day: ['date'],
  channel_day: ['date', 'sessionDefaultChannelGroup'],
  /* Same cut as channel_day, different metrics — which is exactly why it is a
     separate kind rather than more columns on that one. */
  channel_revenue_day: ['date', 'sessionDefaultChannelGroup'],
  source_medium_day: ['date', 'sessionSource', 'sessionMedium'],
  /* Pages, and the pages people arrive on. Two kinds rather than one report
     with both dimensions: `pagePath` and `landingPage` are different questions
     — what got read against what got found — and crossing them multiplies the
     rows without answering either.
   *
   * Two kinds also means two failures. `landingPage` is a newer dimension than
   * the rest of this file asks for, and by the rule at the top an unknown name
   * fails the WHOLE report: separating them is what keeps a rename from taking
   * the page table down with the landing-page table.
   *
   * The metrics are the shared list, unchanged. Note that `sessions` cut by
   * `pagePath` counts sessions that *included* the page rather than sessions
   * *of* it — GA4's own semantics, and the reason the screen reads page views
   * as the page's own figure and sessions as context. */
  page_day: ['date', 'pagePath'],
  landing_page_day: ['date', 'landingPage'],
};

function propertyPath(credentials = {}) {
  const id = String(credentials.propertyId || '').trim().replace(/^properties\//, '');
  if (!id) throw new Error('Google Analytics needs a property id');
  if (/^G-/i.test(id)) {
    throw new Error(
      `"${id}" is a measurement id, not a property id. The Data API needs the numeric property `
      + 'id from Admin → Property Settings (e.g. 123456789).'
    );
  }
  if (!/^\d+$/.test(id)) throw new Error(`"${id}" is not a numeric Google Analytics property id`);
  return id;
}

/* Measurement id → property id, resolved rather than refused.
 *
 * `G-KVJESX8NT5` is what everybody has to hand: it is in the tag, in the code
 * snippet, in every setup guide. The numeric property id is three clicks deeper
 * and is the one the Data API takes. Telling somebody they typed the wrong one
 * is accurate and still leaves them to go and find the right one — and the
 * Admin API can answer it in two calls, with the credential already in hand.
 *
 * So a measurement id is now accepted: the account's properties are listed, and
 * each one's data streams are checked for that measurement id. What comes back
 * is cached, because it is a fact about the property that will not change and
 * the walk costs a request per property.
 *
 * If the lookup cannot run — the Admin API is a *separate* API and needs
 * enabling in the same project as the Data API — the error says which of the
 * two fixes to reach for rather than repeating that the id is wrong. */
const propertyCache = new Map();
const clearPropertyCache = () => propertyCache.clear();

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';

async function adminGet(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload.error && (payload.error.message || payload.error.status)) || `HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return payload;
}

async function resolveProperty(credentials, fetchImpl) {
  const raw = String(credentials.propertyId || '').trim().replace(/^properties\//, '');
  if (!/^G-/i.test(raw)) return propertyPath(credentials);
  if (propertyCache.has(raw)) return propertyCache.get(raw);

  const token = await accessTokenFor(credentials, fetchImpl, 'Google Analytics');
  const wanted = raw.toUpperCase();

  let summaries;
  try {
    summaries = await adminGet(`${ADMIN}/accountSummaries?pageSize=200`, token, fetchImpl);
  } catch (err) {
    /* "Insufficient authentication scopes" is a different problem from every
       other failure here, and the difference decides what somebody should go
       and do. It means the *token* was granted the wrong scopes — almost always
       because it is the Google Ads refresh token, which carries `adwords` — and
       pasting the numeric property id instead would hit the identical wall one
       call later. Offering that as a fix would send someone to do work that
       cannot possibly help, which is worse than saying nothing. */
    if (/scope/i.test(err.message)) {
      throw new Error(
        'The Google Analytics token was granted the wrong scopes: '
        + `${err.message} It needs https://www.googleapis.com/auth/analytics.readonly. `
        + 'A Google Ads refresh token carries the adwords scope and will always be refused here, '
        + 'however correct the property id is — mint a separate token with the analytics scope. '
        + 'Pasting the numeric property id will not help; the Data API refuses the same token.'
      );
    }
    throw new Error(
      `"${raw}" is a measurement id, and looking up the property it belongs to failed: ${err.message}. `
      + 'Either enable the Google Analytics Admin API in the same Cloud project as the Data API, '
      + 'or paste the numeric property id from Admin → Property Settings instead.'
    );
  }

  const properties = (summaries.accountSummaries || [])
    .flatMap((a) => a.propertySummaries || [])
    .map((p) => ({ id: String(p.property || '').replace(/^properties\//, ''), name: p.displayName }))
    .filter((p) => p.id);

  for (const property of properties) {
    let streams;
    try {
      streams = await adminGet(`${ADMIN}/properties/${property.id}/dataStreams?pageSize=200`, token, fetchImpl);
    } catch (err) {
      /* One property the credential cannot read must not stop the search — an
         account often holds properties this user was never granted. */
      continue;
    }
    for (const stream of streams.dataStreams || []) {
      const measurement = stream.webStreamData && stream.webStreamData.measurementId;
      if (measurement && String(measurement).toUpperCase() === wanted) {
        propertyCache.set(raw, property.id);
        return property.id;
      }
    }
  }

  throw new Error(
    `No property this account can read has the measurement id "${raw}". `
    + `Checked ${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}`
    + `${properties.length ? ` (${properties.map((p) => p.name).filter(Boolean).slice(0, 5).join(', ')})` : ''}. `
    + 'Check the Google account has access to the right property, or paste its numeric id directly.'
  );
}

/* Half-open [from, to) into the inclusive range GA4 takes. Same correction Meta
   and Google Ads need, for the same reason: getting it wrong double-counts a
   day on every pull for ever. */
function dateRange(window) {
  if (!window || !window.from || !window.to) return null;
  const until = new Date(Date.parse(window.to) - 86400000);
  if (Number.isNaN(until.getTime())) return null;
  return { startDate: String(window.from).slice(0, 10), endDate: until.toISOString().slice(0, 10) };
}

/* `20260814` → `2026-08-14`. Sorts correctly either way; parses only after. */
function isoDate(compact) {
  const s = String(compact || '');
  if (!/^\d{8}$/.test(s)) return s || null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function request({ kind, window, credentials, cursor = null, fetchImpl, pageSize = PAGE }) {
  const dimensions = DIMENSIONS[kind];
  if (!dimensions) throw new Error(`Google Analytics has no request shape for "${kind}"`);

  /* The Data API has no "all time" — a report without a date range is an error
     there — so one is always sent. Refusing instead was wrong for the one
     caller that legitimately has no window: the Connections screen's **Test**
     button, which asks for a single kind with `window: null` purely to prove a
     credential works. It failed every test with "needs a date range", which
     reads as a broken connector rather than a connectivity check that was never
     given a window.

     The fallback is short and recent on purpose. A test should be cheap, and a
     scheduled sync always supplies its own window, so this is never what a real
     pull uses. */
  const range = dateRange(window) || dateRange({
    from: new Date(Date.now() - TEST_DAYS * 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
  });

  const token = await accessTokenFor(credentials, fetchImpl, 'Google Analytics');
  const property = await resolveProperty(credentials, fetchImpl);

  return {
    url: `${HOST}/${VERSION}/properties/${property}:runReport`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [range],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: (METRICS_FOR[kind] || METRICS).map((name) => ({ name })),
      limit: pageSize || PAGE,
      offset: (cursor && cursor.offset) || 0,
      /* Without this a property with sampling or thresholding silently returns
         fewer rows than it has, and nothing in the response says so. */
      returnPropertyQuota: true,
    }),
  };
}

function checkForError(payload, response) {
  const status = response && response.status;
  const error = payload && payload.error;
  const message = error && (error.message || error.status);

  if (status === 401 || status === 403) {
    throw new Error(
      `Google Analytics refused the credential (HTTP ${status}${message ? `: ${message}` : ''}). `
      + 'The OAuth token needs the analytics.readonly scope — a Google Ads token has the adwords '
      + 'scope and will be refused here — and the account must have at least Viewer on the property.'
    );
  }
  if (status === 404) {
    throw new Error(`Google Analytics could not find that property (HTTP 404${message ? `: ${message}` : ''})`);
  }
  if (status && status >= 400) throw new Error(`Google Analytics refused the request (HTTP ${status}${message ? `: ${message}` : ''})`);
  if (error) throw new Error(`Google Analytics: ${message}`);
}

function extract(payload, { kind, cursor = null } = {}) {
  const rows = (payload && payload.rows) || [];
  const dimensionNames = ((payload && payload.dimensionHeaders) || []).map((h) => h.name);
  const metricNames = ((payload && payload.metricHeaders) || []).map((h) => h.name);

  const out = rows.map((row) => {
    const body = {};
    (row.dimensionValues || []).forEach((v, i) => {
      const name = dimensionNames[i];
      if (name) body[name] = name === 'date' ? isoDate(v.value) : v.value;
    });
    (row.metricValues || []).forEach((v, i) => {
      const name = metricNames[i];
      /* Every metric arrives as a string, including the integers. Left as
         numbers here so `sum()` does not concatenate a month of sessions into a
         250-digit figure — which is exactly what Meta's string counts did. */
      if (name) body[name] = v.value === '' || v.value === null ? null : Number(v.value);
    });

    /* The store's own date field. GA4 names it `date`; keeping that name means
       `transport.within` and `period.FIELD` need no special case. */
    body.date = body.date || null;
    body.property_id = null;
    return body;
  });

  /* Offset paging against the reported total. `rowCount` is the number of rows
     the query matches, not the number returned. */
  const seen = ((cursor && cursor.offset) || 0) + out.length;
  const total = payload && Number(payload.rowCount);
  const more = Number.isFinite(total) && seen < total && out.length > 0;

  return { rows: out, nextCursor: more ? { offset: seen } : null };
}

const pageSizeFor = () => PAGE;

module.exports = {
  id: 'google_analytics',
  /* `propertyId` plus the same OAuth triple Google Ads uses — a different
     consent, but the same exchange. */
  requires: ['propertyId', 'clientId', 'clientSecret', 'refreshToken'],
  request,
  extract,
  checkForError,
  pageSizeFor,
  propertyPath,
  resolveProperty,
  clearPropertyCache,
  dateRange,
  isoDate,
  DIMENSIONS,
  METRICS,
  PAGE,
  MIN_PAGE,
  TEST_DAYS,
  VERSION,
  HOST,
};
