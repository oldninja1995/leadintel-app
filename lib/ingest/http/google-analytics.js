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
  source_medium_day: ['date', 'sessionSource', 'sessionMedium'],
};

function propertyPath(credentials = {}) {
  const id = String(credentials.propertyId || '').trim().replace(/^properties\//, '');
  if (!id) throw new Error('Google Analytics needs a property id');
  /* The measurement id is the other thing called "the property", and sending it
     produces a 403 that reads as a permissions problem rather than a typo. */
  if (/^G-/i.test(id)) {
    throw new Error(
      `"${id}" is a measurement id, not a property id. The Data API needs the numeric property `
      + 'id from Admin → Property Settings (e.g. 123456789).'
    );
  }
  if (!/^\d+$/.test(id)) throw new Error(`"${id}" is not a numeric Google Analytics property id`);
  return id;
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

  const range = dateRange(window);
  if (!range) throw new Error('Google Analytics needs a date range — the Data API has no "all time"');

  const token = await accessTokenFor(credentials, fetchImpl);

  return {
    url: `${HOST}/${VERSION}/properties/${propertyPath(credentials)}:runReport`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [range],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: METRICS.map((name) => ({ name })),
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
  dateRange,
  isoDate,
  DIMENSIONS,
  METRICS,
  PAGE,
  MIN_PAGE,
  VERSION,
  HOST,
};
