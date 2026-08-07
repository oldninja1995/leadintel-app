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

/* Meta caps a page at 500 rows for insights, but the cap is not the same thing
 * as a size it will actually serve. Asking for 500 rows of *ad-level* data with
 * `time_increment=1` makes Meta assemble a row per ad per day, and on a real
 * account it answers "Please reduce the amount of data you're asking for" —
 * which is a refusal, not a throttle, and retrying it unchanged never works.
 *
 * So the page is sized by how much each level actually costs. Campaign-level is
 * one row per campaign per day and comfortably takes the cap; ad-level is one
 * row per ad per day, which is the same account multiplied by every ad in it.
 */
const PAGE_FOR = {
  campaign_day: 500,
  adset_day: 250,
  ad_day: 100,
  creative: 100,
};

const PAGE = 500;

/* Below this there is no point shrinking further — a request this small that
   still refuses is refusing for a reason other than size, and saying so beats
   grinding down to one row per call. */
const MIN_PAGE = 10;

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

function request({ kind, window, credentials, cursor = null, pageSize = null }) {
  const account = accountPath(credentials.accountId);
  const token = String(credentials.accessToken || '').trim();
  if (!token) throw new Error('Meta Ads needs an access token');

  const params = new URLSearchParams();
  params.set('access_token', token);
  params.set('limit', String(pageSize || PAGE_FOR[kind] || PAGE));
  if (cursor) params.set('after', cursor);

  /* Creatives come from the **ads** edge, not `/adcreatives`.
   *
   * `/adcreatives` lists an account's creatives with no reference to the ads
   * running them, and a creative with no ad has no spend, no impressions and no
   * clicks — nothing the Creative Intelligence screen exists to show. The ads
   * edge carries the link, so a creative can be joined to the ad-level insights
   * that measure it.
   *
   * `creative` is requested as a plain field, which Graph API answers with the
   * object's id. That id is the join; the name shown is the ad's, which is what
   * an ad account is actually organised by. */
  if (kind === 'creative') {
    /* The creative is expanded rather than left as an id. Graph API field
       expansion — `creative{...}` — fetches the nested object in the same
       request; asking for `creative` alone answers with its id and would need a
       second call per ad to learn what the ad actually looks like.
       `thumbnail_url` is what makes the screen show the creative rather than a
       coloured rectangle, and `object_type` is what makes the format column
       real instead of declined. */
    params.set('fields', [
      'id', 'name', 'status', 'adset_id', 'campaign_id',
      'creative{id,name,object_type,thumbnail_url}',
    ].join(','));
    return { url: `${HOST}/${VERSION}/${account}/ads?${params}` };
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

/* "Please reduce the amount of data you're asking for" is Meta declining to
 * assemble a result this large. It is not a rate limit — waiting does not help
 * and retrying the identical request never succeeds — and it is not a
 * credential problem either, so it must not be reported as one. The only thing
 * that resolves it is asking for less.
 *
 * Recognised by message rather than code: Meta returns it as code 1 with
 * subcode 99, which is its generic "unknown error" pair and is used for
 * unrelated failures too. The wording is the specific part.
 */
function isTooMuchData(error) {
  return /reduce the amount of data/i.test(String((error && error.message) || error));
}

const pageSizeFor = (kind) => PAGE_FOR[kind] || PAGE;

module.exports = {
  id: 'meta_ads',
  requires: ['accountId', 'accessToken'],
  request,
  extract,
  checkForError,
  isTooMuchData,
  pageSizeFor,
  timeRange,
  accountPath,
  VERSION,
  LEVELS,
  PAGE,
  PAGE_FOR,
  MIN_PAGE,
};
