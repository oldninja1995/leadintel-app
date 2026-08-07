/* Meta Ads — the request shape for a real pull.
 *
 * Confirmed against developers.facebook.com/docs/marketing-api/insights and the
 * ad-account insights reference, not written from memory: Graph API **v25.0**
 * (current since February 2026), token as a query parameter, cursor pagination
 * under `paging`.
 *
 *   insights   GET /v25.0/{accountId}/insights
 *              level = campaign | adset | ad, one row per day via
 *              `time_increment=1`
 *   creatives  GET /v25.0/{accountId}/adcreatives
 *
 * **Payloads are returned exactly as Meta sends them.** `connectors.js` says a
 * connector that tidied them on the way in would make replay a lie, and that
 * rule is the reason stage 2 exists. So `date_start` stays `date_start` and
 * leads stay inside `actions[]`; `canonical.js` knows both spellings. The only
 * thing unwrapped here is the `{ data: [...] }` envelope, which is Graph API
 * framing rather than payload.
 *
 * Two details that are easy to get wrong and expensive to notice later:
 *
 *   - **`until` is inclusive.** This codebase's windows are half-open — the
 *     fixture transport filters `t < window.to` — so passing `to` straight
 *     through would pull one extra day, every pull, for ever. It is stepped
 *     back a day here.
 *   - **Spend is a string in the account's major units** ("7000.50"), and the
 *     currency only appears if `account_currency` is asked for. It is asked for
 *     on every insights call, because money whose currency is assumed is money
 *     that is wrong the first time an account is not INR.
 */

const VERSION = 'v25.0';
const HOST = 'https://graph.facebook.com';

/* Meta caps a page at 500 rows for insights; asking for more is refused rather
   than truncated silently, so this asks for the cap. */
const PAGE = 500;

/* Which insights level each of this source's day-kinds is asking for, and the
   fields that kind needs. `account_currency` is on every one — see above. */
const LEVELS = {
  campaign_day: {
    level: 'campaign',
    fields: ['campaign_id', 'campaign_name', 'spend', 'impressions', 'clicks', 'actions', 'account_currency'],
  },
  adset_day: {
    level: 'adset',
    fields: ['adset_id', 'adset_name', 'campaign_id', 'spend', 'impressions', 'clicks', 'account_currency'],
  },
  ad_day: {
    level: 'ad',
    fields: ['ad_id', 'ad_name', 'adset_id', 'campaign_id', 'spend', 'impressions', 'clicks', 'account_currency'],
  },
};

/* An ad account id is `act_<digits>`. Accepting a bare number and prefixing it
   is a kindness worth doing here rather than making somebody discover the
   convention from a 400. */
function accountPath(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw new Error('Meta Ads needs an ad account id');
  return /^act_/.test(id) ? id : `act_${id.replace(/^act/, '')}`;
}

/* Half-open [from, to) into Meta's inclusive since/until. */
function timeRange(window) {
  if (!window || !window.from || !window.to) return null;
  const until = new Date(Date.parse(window.to) - 86400000);
  if (Number.isNaN(until.getTime())) return null;
  return {
    since: String(window.from).slice(0, 10),
    until: until.toISOString().slice(0, 10),
  };
}

function request({ kind, window, credentials, cursor = null }) {
  const account = accountPath(credentials.accountId);
  const token = String(credentials.accessToken || '').trim();
  if (!token) throw new Error('Meta Ads needs an access token');

  const params = new URLSearchParams();
  params.set('access_token', token);
  params.set('limit', String(PAGE));
  if (cursor) params.set('after', cursor);

  if (kind === 'creative') {
    params.set('fields', ['id', 'name', 'object_type', 'thumbnail_url', 'status'].join(','));
    return { url: `${HOST}/${VERSION}/${account}/adcreatives?${params}` };
  }

  const spec = LEVELS[kind];
  /* A kind this source declares but this connector cannot ask for would
     otherwise pull nothing and look like an empty account. */
  if (!spec) throw new Error(`Meta Ads: no request shape for "${kind}"`);

  params.set('level', spec.level);
  params.set('fields', spec.fields.join(','));
  params.set('time_increment', '1');

  const range = timeRange(window);
  if (range) {
    params.set('time_range', JSON.stringify(range));
  } else {
    /* No window means a connection test or a first run. A preset keeps that
       cheap rather than pulling an account's whole history to prove a token
       works. */
    params.set('date_preset', 'last_7d');
  }

  return { url: `${HOST}/${VERSION}/${account}/insights?${params}` };
}

/* Graph API reports failure in the body as often as in the status, so both are
   checked. The message is passed through rather than rewritten — Meta's own
   wording ("Error validating access token: Session has expired") is more useful
   than anything this layer could invent — with the parts that identify the
   failure kept alongside it. */
function checkForError(payload, response) {
  const error = payload && payload.error;
  if (!error && response && response.ok) return;

  if (error) {
    const parts = [error.message || 'Meta Ads refused the request'];
    if (error.code) parts.push(`code ${error.code}${error.error_subcode ? `/${error.error_subcode}` : ''}`);
    if (error.fbtrace_id) parts.push(`fbtrace ${error.fbtrace_id}`);
    /* Meta signals throttling as an ordinary error code. Saying so is the
       difference between "wait" and "your token is broken". */
    if ([4, 17, 32, 613].includes(error.code)) {
      parts.push('this is a rate limit, not a credential problem — the pull should be retried later');
    }
    throw new Error(`Meta Ads: ${parts.join(' — ')}`);
  }

  throw new Error(`Meta Ads: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
}

/* `paging.cursors.after` is present even on the last page; `paging.next` is
   not. Following the cursor alone would loop for ever on an account whose last
   page is full, so `next` is what decides whether there is another page. */
function extract(payload) {
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  const hasNext = Boolean(payload && payload.paging && payload.paging.next);
  const after = payload && payload.paging && payload.paging.cursors && payload.paging.cursors.after;
  return { rows, nextCursor: hasNext && after ? after : null };
}

module.exports = {
  id: 'meta_ads',
  requires: ['accountId', 'accessToken'],
  request,
  extract,
  checkForError,
  timeRange,
  accountPath,
  VERSION,
  LEVELS,
  PAGE,
};
