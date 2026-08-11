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
  /* The ads edge with the creative object expanded is heavier per row than any
     insights call — it fetches an object per ad rather than a row of numbers —
     so it starts well below the insights levels rather than discovering that
     through a refusal on every sync. */
  creative: 25,
  /* One row per ad set and per audience, not per day — an account has tens of
     these, not thousands, so they page comfortably. */
  adset: 200,
  audience: 200,
};

const PAGE = 500;

/* Below this there is no point shrinking further — a request this small that
   still refuses is refusing for a reason other than size, and saying so beats
   grinding down to one row per call. */
const MIN_PAGE = 10;

/* The size the creative still is requested at. See the creative branch of
   `request` for why the default is unusable. */
const THUMBNAIL_PX = 640;

/* Which insights level each of this source's day-kinds is asking for, and the
   fields that kind needs. `account_currency` is on every one — see above. */
const LEVELS = {
  campaign_day: {
    level: 'campaign',
    /* `objective` is what the campaign was bought for, and it is the only
       honest way to say where a creative sits in the funnel — inferring a stage
       from frequency or audience size would be a guess wearing a label. */
    fields: ['campaign_id', 'campaign_name', 'objective', 'spend', 'impressions', 'clicks', 'actions', 'account_currency'],
  },
  adset_day: {
    level: 'adset',
    /* `actions` here for the same reason it is at ad level: the Ad sets table
       reports leads and a cost per lead, and a lead count averaged down from
       the campaign cannot say which ad set earned it. */
    fields: [
      'adset_id', 'adset_name', 'campaign_id',
      'spend', 'impressions', 'clicks', 'actions', 'account_currency',
    ],
  },
  /* `actions` at ad level too: cost per lead is what the Creative Intelligence
     screen is read for, and a lead count averaged up to the campaign cannot say
     which ad earned it. */
  ad_day: {
    level: 'ad',
    fields: [
      'ad_id', 'ad_name', 'adset_id', 'campaign_id',
      'spend', 'impressions', 'clicks', 'actions', 'account_currency',
      /* Fatigue needs all three: frequency is how often the same person has
         seen it, CPM is what the auction now charges for that, and CTR is
         derived from clicks and impressions above. */
      'frequency', 'cpm',
      /* Hook and hold. `video_play_actions` is the three-second view — hook
         rate is that over impressions — and `video_p100_watched_actions` is the
         completion, which over plays is hold rate. Absent for image ads, which
         is why both decline rather than read zero there. */
      'video_play_actions', 'video_p100_watched_actions',
    ],
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
  /* Ad sets, from the **adsets** edge rather than from insights.
   *
   * `targeting` is a configuration field: it describes how the ad set was
   * built, and the insights endpoint — which reports what the ad set *did* —
   * does not carry it. It has to be its own request.
   *
   * This is what makes the funnel badge mean anything on a lead-gen account.
   * Reading the campaign objective files every creative in an `OUTCOME_LEADS`
   * account under "Bottom of funnel", including the broad prospecting ad set
   * that has never heard of the brand. See lib/creative-funnel.js. */
  if (kind === 'adset') {
    params.set('fields', [
      'id', 'name', 'campaign_id', 'effective_status',
      /* Only the parts of the spec that decide a stage. `targeting` in full is
         a large object — placements, devices, behaviours, exclusions — and
         pulling all of it per ad set on every sync is cost for fields nothing
         reads. */
      'targeting{custom_audiences,excluded_custom_audiences,geo_locations,age_min,age_max,flexible_spec}',
    ].join(','));
    return { url: `${HOST}/${VERSION}/${account}/adsets?${params}` };
  }

  /* The account's custom audiences, for their retention windows.
   *
   * An ad set's targeting names its audiences by id alone — Meta does not
   * expand them inline — and the id says nothing about how recent the audience
   * is. `retention_days` is the whole point: it is the difference between a
   * 7-day site visitor (hot) and a 365-day engager (barely warm), which is the
   * line the funnel is drawn on. */
  if (kind === 'audience') {
    params.set('fields', ['id', 'name', 'subtype', 'retention_days', 'approximate_count_lower_bound'].join(','));
    return { url: `${HOST}/${VERSION}/${account}/customaudiences?${params}` };
  }

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
      /* `image_url` as well as `thumbnail_url`: the thumbnail is a 64×64
         preview, which is unreadable stretched across a card. The full asset is
         preferred for display and the thumbnail kept as the fallback, since not
         every creative has both. */
      /* **Where a full-size still actually lives.**
       *
       * `thumbnail_url` is a 64x64 preview and the `thumbnail_width`/
       * `thumbnail_height` parameters below do not reach it through a nested
       * field expansion — confirmed against this account, which re-synced with
       * them set and returned the same 1.7 KB images.
       *
       * `image_url` is the full asset and is the right answer for an image ad.
       * A **video** ad frequently has none, and nearly every ad here is video —
       * for those the still sits inside the story spec, or inside the asset
       * feed for an Advantage+ creative. All three are requested and
       * canonical.js prefers them in that order, falling back to the postage
       * stamp only when nothing better exists. */
      /* `video_id` as well: a still is what a creative looks like paused, and
         a video ad is not a still. The id is the handle the video route
         resolves to a playable source — see /creatives/:adId/video. */
      'creative{id,name,object_type,thumbnail_url,image_url,video_id'
        + ',object_story_spec{video_data{video_id,image_url},link_data{picture}}'
        + ',asset_feed_spec{images{url},videos{video_id,thumbnail_url}}}',
    ].join(','));

    /* **Ask for a thumbnail big enough to look at.**
     *
     * `thumbnail_url` defaults to a 64x64 preview — about 1.7 KB — and a
     * 64-pixel image stretched across a card is a smudge, which reads as "I
     * cannot see the creative" rather than as an image that loaded. Meta sizes
     * that field from these two parameters, and they are the whole fix.
     *
     * It matters most for video, which is nearly everything on this account:
     * a video creative frequently reports no `image_url` at all, so the
     * thumbnail is not the fallback for it, it is the only still there is.
     *
     * 640 rather than larger because the card renders at roughly 300 CSS
     * pixels; this covers a 2x display and no more. */
    params.set('thumbnail_width', String(THUMBNAIL_PX));
    params.set('thumbnail_height', String(THUMBNAIL_PX));

    /* Only ads that still exist as far as the account is concerned.
     *
     * The edge otherwise answers with every ad ever created — 1,175 on a real
     * account, the overwhelming majority archived years ago — and expanding a
     * creative for each of them is what makes Meta refuse the request outright.
     * The screen shows only creatives something measured in the pulled window,
     * so archived and deleted ads were being fetched at full cost to be
     * discarded. Paused ads are kept: an ad paused yesterday still spent
     * yesterday, and dropping it would put a hole in the window. */
    params.set('filtering', JSON.stringify([{
      field: 'ad.effective_status',
      operator: 'IN',
      value: ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'],
    }]));

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
    /* No window means a connection test or a scheduled pull.
     *
     * Thirty days rather than seven, because fatigue is a *comparison*: a
     * creative's last week is only meaningful against its own recent baseline,
     * and with a seven-day pull every creative looks like it has no history and
     * every score reads as unknown. Seven days was enough while the screen only
     * showed spend and CTR; it is not enough to say whether either is falling.
     *
     * It is still a preset rather than an account's whole history — the cost of
     * this window is real, which is what the per-level page sizes and the
     * shrink-on-refusal loop above exist to manage. */
    params.set('date_preset', 'last_30d');
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
    const err = new Error(`Meta Ads: ${parts.join(' — ')}`);
    /* Kept structured as well as in the message. The size-refusal check used to
       read the wording alone, and Meta does not always supply the wording — the
       ads edge answers an over-heavy request with "An unknown error occurred"
       and code 1/99, which matched nothing and so was never retried smaller. */
    err.code = error.code;
    err.subcode = error.error_subcode;
    throw err;
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
/* **Meta says "too much" in two different ways.**
 *
 * The polite one is the wording — "Please reduce the amount of data you're
 * asking for" — which the insights edges use. The ads edge does not: an
 * over-heavy request there comes back as the generic *"An unknown error
 * occurred"* under **code 1, subcode 99**, and reading only the wording left it
 * unrecognised, unretried, and permanently failing.
 *
 * That is not a hypothetical. Asking the ads edge for a hundred ads at a time
 * with the creative object expanded is heavier per row than any insights call,
 * and it is the request that fetches the creative image. The account synced
 * every day of spend and no creatives at all, which read on screen as an empty
 * Creative Intelligence rather than as one refused call. */
function isTooMuchData(error) {
  if (!error) return false;
  if (error.code === 1 && Number(error.subcode) === 99) return true;
  const text = String(error.message || error);
  return /reduce the amount of data/i.test(text) || /code 1\/99\b/.test(text);
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
  THUMBNAIL_PX,
};
