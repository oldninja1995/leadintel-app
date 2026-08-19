/* Raw payloads in, canonical entities out.
 *
 * Two steps, kept apart because they fail differently. `normaliseRecord` turns
 * one payload into typed fields — a per-source concern, and the only place in
 * the codebase that knows Google reports micros and the PMS stamps IST.
 * `build` groups normalised records into the four things the product actually
 * talks about and resolves any disagreement between them.
 *
 *   campaignDay   one campaign, one day, from either ad platform
 *   lead          one enquiry, from the CRM
 *   booking       one reservation — PMS, CRM and gateway all have a view
 *   payment       one settlement, from the gateway
 *
 * Only `booking` is contested, so it is the only entity that goes through the
 * precedence rules. The others have exactly one authoritative source and
 * pretending otherwise would be ceremony.
 */

const n = require('./normalise');
const sources = require('./sources');
const { merge } = require('./precedence');

/* ── Per-source, per-kind normalisation ─────────────────────────────────── */

/* Instants go through `timestamp`, which assumes IST when a source stamps
   local time without an offset. Whole-day facts go through `date` and keep
   their calendar date untouched — see the note in normalise.js for why the
   two must not be confused. */

/* Reads the first spelling of a field that is actually present, flat or
   nested. The vendors disagree and the raw store keeps whichever arrived. */
function g(body, ...paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), body);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const googleDay = (b) => g(b, 'date', 'segments.date');
const googleCost = (b) => g(b, 'cost_micros', 'metrics.costMicros');
const googleCurrency = (b) => g(b, 'currency', 'customer.currencyCode');

/* Both platforms return counts as strings — Google under `metrics`, Meta as
   flat fields — so both go through here. `null` rather than 0 when absent, for
   the reason stated on metaLeads: a row that did not report a figure is not a
   row reporting none. */
function metric(b, name) {
  /* Google's REST response nests metrics in **lowerCamelCase** while GAQL asks
     for them in snake_case, so `metrics.conversions_value` is never what comes
     back — it arrives as `metrics.conversionsValue`. Reading only the snake
     spelling returned null for every multi-word metric while the single-word
     ones worked, which is the most confusing possible half-failure: the row is
     present, the numbers are there, and one column is silently empty. */
  const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const raw = g(b, name, `metrics.${name}`, `metrics.${camel}`);
  if (raw === undefined) return { value: null, raw: null };
  const value = Number(raw);
  return { value: Number.isFinite(value) ? value : null, raw };
}

const metaDay = (b) => b.date ?? b.date_start;
const metaCurrency = (b) => b.currency ?? b.account_currency;

/* Meta reports conversions as a list of typed actions rather than a column, so
   a lead count has to be picked out of it. `lead` is the on-platform lead form;
   the offsite pixel variants are counted too, because an account using one and
   an account using the other are both generating leads and a metric that saw
   only the first would read zero for half of them.
   `null` rather than 0 when the field is absent entirely: a row that was never
   asked for its actions did not report no leads, it reported nothing — and
   carrying a zero would turn "don't know" into "it's nothing". */
const LEAD_ACTIONS = new Set([
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);

/* Meta returns several of its metrics as `[{action_type, value}]` rather than
   as a column. Absent entirely is unknown, not zero — an image ad reports no
   video plays because it is not a video. */
function actionTotal(actions) {
  if (!Array.isArray(actions)) return { value: null, raw: actions ?? null };
  const total = actions.reduce((sum, a) => sum + (Number(a && a.value) || 0), 0);
  return { value: total, raw: actions };
}

function metaLeads(b) {
  /* Coerced for the same reason impressions is: a count that arrives as a
     string sums by concatenation and nothing downstream notices. */
  if (b.leads !== undefined && b.leads !== null) return metric(b, 'leads');
  if (!Array.isArray(b.actions)) return { value: null, raw: b.actions ?? null };

  const matched = b.actions.filter((a) => a && LEAD_ACTIONS.has(a.action_type));
  if (!matched.length) return { value: 0, raw: b.actions };

  /* Meta returns action values as strings. */
  const total = matched.reduce((sum, a) => sum + (Number(a.value) || 0), 0);
  return { value: total, raw: b.actions };
}

const MAPPERS = {
  /* Meta's live payloads and the fixtures spell three things differently, and
     both spellings reach here because stage 1 stores what the source sent:

       day       `date_start` live, `date` in fixtures
       currency  `account_currency` live, `currency` in fixtures
       leads     inside `actions[]` live, a plain `leads` count in fixtures

     Read here rather than reconciled in the connector, which is where this
     codebase has always put interpretation.

     A fourth difference, and the costly one: the fixtures write impressions and
     clicks as JSON numbers and live Meta writes them as **strings**. These two
     were passed through as they arrived, which every test agreed with, because
     the tests read the fixtures. On the real account `sum()` starts at 0 and
     concatenates — a month of impressions came out as a 250-digit number, and
     CTR and CPM, which divide by it, both read zero. Coerced through `metric`
     like every other count. */
  meta_ads: {
    campaign_day: (b) => ({
      campaign: n.campaignName(b.campaign_name),
      date: n.date(metaDay(b)),
      spend: n.money(b.spend, metaCurrency(b)),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metaLeads(b),
    }),
    /* Measurement, per ad set per day. It carried only a name, a date and a
       spend, because the only thing reading it was the creative screen's
       fallback for an ad set's name — so the Ad sets table had nothing to build
       a row from and rendered its empty state, under a message blaming a
       connector that was in fact pulling these rows all along. */
    /* Meta splits the rows to carry a breakdown, so `age` and `gender` arrive
       as ordinary fields on an otherwise ordinary insights row. Passed through
       raw: they are Meta's own bucket labels ("25-34", "female") and are
       compared and grouped, never displayed as prose. */
    demographic_day: (b) => ({
      date: n.date(metaDay(b)),
      age: { value: b.age ?? null, raw: b.age ?? null },
      gender: { value: b.gender ?? null, raw: b.gender ?? null },
      spend: n.money(b.spend, metaCurrency(b)),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metaLeads(b),
    }),
    adset_day: (b) => ({
      adsetId: { value: b.adset_id ?? null, raw: b.adset_id ?? null },
      adset: n.text(b.adset_name),
      campaignId: { value: b.campaign_id ?? null, raw: b.campaign_id ?? null },
      date: n.date(metaDay(b)),
      spend: n.money(b.spend, metaCurrency(b)),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metaLeads(b),
    }),
    /* Impressions and clicks are carried at ad level too, because that is the
       grain the Creative Intelligence screen measures a creative at — a
       click-through rate averaged up to the campaign says nothing about which
       ad earned it. */
    ad_day: (b) => ({
      ad: n.text(b.ad_name),
      date: n.date(metaDay(b)),
      spend: n.money(b.spend, metaCurrency(b)),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metaLeads(b),
      frequency: { value: b.frequency === undefined ? null : Number(b.frequency), raw: b.frequency ?? null },
      cpm: { value: b.cpm === undefined ? null : Number(b.cpm), raw: b.cpm ?? null },
      /* Meta reports video milestones as action arrays rather than columns, the
         same shape as `actions`. Absent on an image ad — which is not zero
         plays, it is not a video, and the two must not read alike. */
      videoPlays: actionTotal(b.video_play_actions),
      videoCompletions: actionTotal(b.video_p100_watched_actions),
    }),
    /* From the ads edge: the ad's identity plus the id of the creative it runs.
       `updated_at` is not among the fields requested, so it comes back as a
       stated problem rather than a fabricated timestamp. */
    /* An ad set's configuration, from the adsets edge — how it was built,
       not what it did. `targeting.custom_audiences` arrives as objects carrying
       an id and sometimes a name; only the ids are kept, because the retention
       window that decides the funnel stage lives on the audience itself and is
       joined in from the `audience` kind. */
    adset: (b) => ({
      adsetId: { value: b.id ?? null, raw: b.id ?? null },
      adsetName: n.text(b.name),
      campaignId: { value: b.campaign_id ?? null, raw: b.campaign_id ?? null },
      customAudienceIds: {
        value: ((b.targeting && b.targeting.custom_audiences) || [])
          .map((a) => String((a && (a.id ?? a)) ?? ''))
          .filter(Boolean),
        raw: (b.targeting && b.targeting.custom_audiences) || null,
      },
      /* Kept so a later reader can tell "targeted nowhere in particular" from
         "we never fetched the targeting" — an empty audience list means cold
         traffic, and a missing spec means nothing at all. */
      hasTargeting: { value: b.targeting !== undefined && b.targeting !== null, raw: b.targeting ?? null },
    }),

    /* A custom audience and, the only reason it is fetched, how far back it
       reaches. Seven days of site visitors and 365 days of engagers are not the
       same audience and must not read alike. */
    audience: (b) => ({
      audienceId: { value: b.id ?? null, raw: b.id ?? null },
      audienceName: n.text(b.name),
      subtype: b.subtype === undefined ? { value: null, raw: null } : n.text(b.subtype),
      retentionDays: {
        value: b.retention_days === undefined || b.retention_days === null ? null : Number(b.retention_days),
        raw: b.retention_days ?? null,
      },
      /* How many people are in it. An ad set stacking a 4,000-person 30-day
         pool with a 53,000-person 60-day one delivers almost entirely to the
         larger, older audience — so size is what decides which one describes
         the ad set. Meta reports it as a lower bound, which is the right
         conservative reading. */
      size: {
        value: b.approximate_count_lower_bound === undefined || b.approximate_count_lower_bound === null
          ? null
          : Number(b.approximate_count_lower_bound),
        raw: b.approximate_count_lower_bound ?? null,
      },
    }),

    creative: (b) => ({
      title: n.text(b.title ?? b.name),
      /* Absent is not malformed. A field the request did not ask for must not
         raise a normalisation problem — that channel is for values that arrived
         and could not be read, and filling it with "you didn't fetch this"
         would drown the ones that matter. */
      status: b.status === undefined ? { value: null, raw: null } : n.text(b.status),
      creativeId: { value: (b.creative && b.creative.id) || b.creative_id || null, raw: b.creative ?? null },
      campaignId: { value: b.campaign_id ?? null, raw: b.campaign_id ?? null },
      /* The ad set the ad runs in. Requested from the ads edge alongside the
         campaign id, and the join that lets a creative be told which part of
         the funnel it is working in — the targeting is a property of the ad
         set, not of the ad. */
      adsetId: { value: b.adset_id ?? null, raw: b.adset_id ?? null },
      /* Kept raw. A thumbnail URL is a signed, expiring address rather than a
         value to normalise, and rewriting it in any way would break it. */
      /* Full asset first, 64×64 preview second. A thumbnail blown up to card
         width is worse than no image. */
      thumbnailUrl: (() => {
        /* Best available still, in descending order of size. The postage-stamp
           thumbnail is last: at 64 pixels it is a smudge on a card, which reads
           as an image that failed rather than one that loaded. */
        const cr = b.creative || {};
        const story = cr.object_story_spec || {};
        const feed = cr.asset_feed_spec || {};
        const first = (list, key) => (Array.isArray(list) && list.length ? list[0][key] : null);

        const value = cr.image_url
          || (story.video_data && story.video_data.image_url)
          || (story.link_data && story.link_data.picture)
          || first(feed.images, 'url')
          || first(feed.videos, 'thumbnail_url')
          || cr.thumbnail_url
          || b.image_url || b.thumbnail_url || null;

        return { value, raw: value };
      })(),
      /* The video behind the still, where there is one. Three places again,
         because Meta puts it wherever the creative was built. */
      videoId: (() => {
        const cr = b.creative || {};
        const story = cr.object_story_spec || {};
        const feed = cr.asset_feed_spec || {};
        const value = cr.video_id
          || (story.video_data && story.video_data.video_id)
          || (Array.isArray(feed.videos) && feed.videos.length ? feed.videos[0].video_id : null)
          || null;
        return { value: value ? String(value) : null, raw: value ?? null };
      })(),
      objectType: {
        value: (b.creative && b.creative.object_type) || b.object_type || b.type || null,
        raw: (b.creative && b.creative.object_type) || null,
      },
      updatedAt: n.timestamp(b.updated_at),
    }),
  },

  /* Google's REST reporting nests its fields and renames them to
     lowerCamelCase — `metrics.costMicros`, `segments.date`,
     `customer.currencyCode` — while the fixtures are flat snake_case. Both
     arrive, for the same reason Meta's two spellings do, and both are read
     here rather than flattened in the connector. */
  google_ads: {
    /* Google reports cost in micros of the account currency — the one unit
       difference between the two ad platforms, and the reason `money` takes a
       unit rather than assuming rupees. */
    campaign_day: (b) => ({
      campaign: n.campaignName(g(b, 'campaign_name', 'campaign.name')),
      /* `campaign.id` is fetched by the query and was dropped here, so the one
         collection that knows a campaign's *name* was the only Google grain
         without its *id* — and every other grain is keyed by the id. Keyword
         Analytics groups keywords by campaign, which is that join. */
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: g(b, 'campaign.id') ?? null },
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metric(b, 'conversions'),
      /* Google-only, and not derivable from anything else on the page. */
      channelType: { value: g(b, 'channel_type', 'campaign.advertisingChannelType', 'campaign.advertising_channel_type') ?? null, raw: null },
      impressionShare: metric(b, 'search_impression_share'),
      lostToBudget: metric(b, 'search_budget_lost_impression_share'),
      lostToRank: metric(b, 'search_rank_lost_impression_share'),
    }),
    adgroup_day: (b) => ({
      adgroup: n.text(g(b, 'adgroup_name', 'ad_group.name', 'adGroup.name')),
      adgroupId: { value: g(b, 'adgroup_id', 'ad_group.id', 'adGroup.id') ?? null, raw: g(b, 'ad_group.id') ?? null },
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: g(b, 'campaign.id') ?? null },
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metric(b, 'conversions'),
    }),
    keyword_day: (b) => ({
      /* Raw, not n.text — that title-cases, and a keyword is the literal string
         that was bid on. "resort with activities munnar" is not the same bid as
         "Resort With Activities Munnar", and a screen you search against must
         show what Google holds. Same rule that broke first_response. */
      keyword: { value: g(b, 'keyword', 'ad_group_criterion.keyword.text', 'adGroupCriterion.keyword.text') ?? null, raw: null },
      /* Machine enums must not go through n.text — it title-cases, which turned
         `first_response` into `First_response` and made a metric read zero.
         EXACT / PHRASE / BROAD is a token, not a label. */
      matchType: { value: g(b, 'match_type', 'ad_group_criterion.keyword.match_type', 'adGroupCriterion.keyword.matchType') ?? null, raw: null },
      /* Not a metric — it lives on the criterion, not under metrics. */
      qualityScore: { value: g(b, 'quality_score', 'ad_group_criterion.quality_info.quality_score', 'adGroupCriterion.qualityInfo.qualityScore') ?? null, raw: null },
      adgroupId: { value: g(b, 'adgroup_id', 'ad_group.id', 'adGroup.id') ?? null, raw: null },
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: null },
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metric(b, 'conversions'),
    }),

    /* Google's ad level. Meta's equivalent is `creative`; these stay separate
       entities because an ad group is not an ad set and an expanded text ad is
       not a creative asset. */
    ad_day: (b) => ({
      ad: n.text(g(b, 'ad_name', 'ad_group_ad.ad.name', 'adGroupAd.ad.name')),
      adId: { value: g(b, 'ad_id', 'ad_group_ad.ad.id', 'adGroupAd.ad.id') ?? null, raw: null },
      adType: { value: g(b, 'ad_type', 'ad_group_ad.ad.type', 'adGroupAd.ad.type') ?? null, raw: null },
      status: { value: g(b, 'status', 'ad_group_ad.status', 'adGroupAd.status') ?? null, raw: null },
      adgroupId: { value: g(b, 'adgroup_id', 'ad_group.id', 'adGroup.id') ?? null, raw: null },
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: null },
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metric(b, 'conversions'),
    }),

    /* What was actually typed. The term itself is the identity — Google issues
       no id for one — so it is carried as text and never title-cased. */
    search_term_day: (b) => ({
      term: { value: g(b, 'search_term', 'search_term_view.search_term', 'searchTermView.searchTerm') ?? null, raw: null },
      termStatus: { value: g(b, 'status', 'search_term_view.status', 'searchTermView.status') ?? null, raw: null },
      adgroupId: { value: g(b, 'adgroup_id', 'ad_group.id', 'adGroup.id') ?? null, raw: null },
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: null },
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metric(b, 'conversions'),
    }),

    /* Conversions with the action that produced them attached. The undivided
       figure is a fractional double summed across every action an account
       defines, which is how reported leads came to read 18,395.989782. */
    /* The criterion list — what the account is bidding on now, with no window.
     *
     * Raw for the keyword text, for the same reason `keyword_day` is: `n.text`
     * title-cases, and a keyword is the literal string that was bid on.
     * Enums — match type, status — must not go through it either. */
    keyword: (b) => ({
      keywordId: { value: g(b, 'keyword_id', 'ad_group_criterion.criterion_id', 'adGroupCriterion.criterionId') ?? null, raw: null },
      keyword: { value: g(b, 'keyword', 'ad_group_criterion.keyword.text', 'adGroupCriterion.keyword.text') ?? null, raw: null },
      matchType: { value: g(b, 'match_type', 'ad_group_criterion.keyword.match_type', 'adGroupCriterion.keyword.matchType') ?? null, raw: null },
      /* ENABLED or PAUSED. A paused keyword is still in the account and is a
         decision somebody made, which is exactly what the table is read for. */
      status: { value: g(b, 'status', 'ad_group_criterion.status', 'adGroupCriterion.status') ?? null, raw: null },
      adgroupId: { value: g(b, 'adgroup_id', 'ad_group.id', 'adGroup.id') ?? null, raw: null },
      adgroup: n.text(g(b, 'adgroup_name', 'ad_group.name', 'adGroup.name')),
      adgroupStatus: { value: g(b, 'adgroup_status', 'ad_group.status', 'adGroup.status') ?? null, raw: null },
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: null },
      /* The campaign's own name, so the dropdown can list a campaign that has
         keywords and no spend in the selected range — which is most of them
         when the range is a single day. */
      campaign: n.campaignName(g(b, 'campaign_name', 'campaign.name')),
      campaignStatus: { value: g(b, 'campaign_status', 'campaign.status') ?? null, raw: null },
      channelType: { value: g(b, 'channel_type', 'campaign.advertising_channel_type', 'campaign.advertisingChannelType') ?? null, raw: null },
    }),
    conversion_day: (b) => ({
      action: { value: g(b, 'conversion_action', 'segments.conversion_action_name', 'segments.conversionActionName') ?? null, raw: null },
      category: { value: g(b, 'conversion_action_category', 'segments.conversion_action_category', 'segments.conversionActionCategory') ?? null, raw: null },
      campaignId: { value: g(b, 'campaign_id', 'campaign.id') ?? null, raw: null },
      date: n.date(googleDay(b)),
      conversions: metric(b, 'conversions'),
      conversionValue: metric(b, 'conversions_value'),
      /* Everything the action recorded, primary or not.
       *
       * `all_conversions` was already being fetched and was dropped here, so
       * five of six conversion actions rendered 0 — `conversions` counts
       * primary actions only, and secondary ones report zero in it by
       * definition. Keeping both is the honest shape: one is what Google bids
       * on, the other is what happened, and collapsing them would either hide
       * four actions or overstate the figure the account optimises against. */
      allConversions: metric(b, 'all_conversions'),
      allConversionValue: metric(b, 'all_conversions_value'),
    }),
  },

  /* Google Analytics.
   *
   * The metrics arrive as strings from the API and as numbers from the
   * fixtures, so every one goes through `metric()` — the same coercion Meta's
   * string counts needed after a month of impressions concatenated into a
   * 250-digit figure.
   *
   * `bounceRate` is a **rate already**, 0–1, not a percentage and not a count.
   * It must never be summed across days: a week of 0.4 bounce rates is not
   * 2.8. Nothing here sums it — the metric layer averages weighted by sessions
   * — and this note is why. */
  google_analytics: {
    session_day: (b) => ({
      date: n.date(g(b, 'date')),
      sessions: metric(b, 'sessions'),
      users: metric(b, 'totalUsers'),
      newUsers: metric(b, 'newUsers'),
      bounceRate: metric(b, 'bounceRate'),
      avgSessionSeconds: metric(b, 'averageSessionDuration'),
      pageViews: metric(b, 'screenPageViews'),
    }),
    channel_day: (b) => ({
      date: n.date(g(b, 'date')),
      /* Google's own classification, kept verbatim. Re-deriving "is this paid
         search" from source/medium is how a screen quietly stops agreeing with
         the GA interface people check it against. */
      channelGroup: { value: g(b, 'sessionDefaultChannelGroup') ?? null, raw: g(b, 'sessionDefaultChannelGroup') ?? null },
      sessions: metric(b, 'sessions'),
      users: metric(b, 'totalUsers'),
      newUsers: metric(b, 'newUsers'),
      bounceRate: metric(b, 'bounceRate'),
      avgSessionSeconds: metric(b, 'averageSessionDuration'),
      pageViews: metric(b, 'screenPageViews'),
    }),
    /* Revenue per channel per day. The channel group is spelled exactly as
       channel_day spells it, because the two are joined on it — "Paid Search"
       is Google's own label and normalising it to a token here would stop it
       matching the sessions beside it.

       Currency is assumed INR rather than read: GA4 reports in the property's
       currency and does not return it on a report row, and every other figure
       in this workspace is rupees. A currency guessed differently per row would
       be worse than one assumed consistently — the same reasoning the TeleCRM
       connector states for deal value. */
    channel_revenue_day: (b) => ({
      date: n.date(g(b, 'date')),
      channelGroup: { value: g(b, 'sessionDefaultChannelGroup') ?? null, raw: g(b, 'sessionDefaultChannelGroup') ?? null },
      revenue: n.money(g(b, 'totalRevenue'), 'INR'),
      reservations: metric(b, 'ecommercePurchases'),
    }),
    /* The page cut. `pagePath` is the path without host or query — which is
       what makes it groupable at all; the same page with three campaign
       parameters is one row here and three in any URL-keyed report. */
    city_day: (b) => ({
      date: n.date(g(b, 'date')),
      city: { value: g(b, 'city') ?? null, raw: g(b, 'city') ?? null },
      sessions: metric(b, 'sessions'),
      users: metric(b, 'totalUsers'),
      newUsers: metric(b, 'newUsers'),
      bounceRate: metric(b, 'bounceRate'),
      avgSessionSeconds: metric(b, 'averageSessionDuration'),
      pageViews: metric(b, 'screenPageViews'),
    }),
    /* Spelled exactly as city_day spells it, because the two are joined on
       it — the same rule channel_revenue_day follows against channel_day. */
    city_revenue_day: (b) => ({
      date: n.date(g(b, 'date')),
      city: { value: g(b, 'city') ?? null, raw: g(b, 'city') ?? null },
      revenue: n.money(g(b, 'totalRevenue'), 'INR'),
      reservations: metric(b, 'ecommercePurchases'),
    }),
    page_day: (b) => ({
      date: n.date(g(b, 'date')),
      page: { value: g(b, 'pagePath') ?? null, raw: g(b, 'pagePath') ?? null },
      sessions: metric(b, 'sessions'),
      users: metric(b, 'totalUsers'),
      newUsers: metric(b, 'newUsers'),
      bounceRate: metric(b, 'bounceRate'),
      avgSessionSeconds: metric(b, 'averageSessionDuration'),
      pageViews: metric(b, 'screenPageViews'),
    }),
    /* Where a session started, which is the page a campaign actually bought.
       Kept apart from `page_day` for the reason the request shapes state: a
       page read halfway through a visit and a page somebody landed on are two
       different facts, and only the second is a landing page. */
    landing_page_day: (b) => ({
      date: n.date(g(b, 'date')),
      landingPage: { value: g(b, 'landingPage') ?? null, raw: g(b, 'landingPage') ?? null },
      sessions: metric(b, 'sessions'),
      users: metric(b, 'totalUsers'),
      newUsers: metric(b, 'newUsers'),
      bounceRate: metric(b, 'bounceRate'),
      avgSessionSeconds: metric(b, 'averageSessionDuration'),
      pageViews: metric(b, 'screenPageViews'),
    }),
    source_medium_day: (b) => ({
      date: n.date(g(b, 'date')),
      source: { value: g(b, 'sessionSource') ?? null, raw: g(b, 'sessionSource') ?? null },
      medium: { value: g(b, 'sessionMedium') ?? null, raw: g(b, 'sessionMedium') ?? null },
      sessions: metric(b, 'sessions'),
      users: metric(b, 'totalUsers'),
      newUsers: metric(b, 'newUsers'),
      bounceRate: metric(b, 'bounceRate'),
      avgSessionSeconds: metric(b, 'averageSessionDuration'),
      pageViews: metric(b, 'screenPageViews'),
    }),
  },

  telecrm: {
    lead: (b) => ({
      name: n.text(b.name),
      phone: n.phone(b.phone),
      email: n.text(b.email),
      createdAt: n.timestamp(b.created_at),
      stage: n.text(b.stage),
      owner: n.text(b.owner),
      campaign: n.campaignName(b.utm_campaign),
      adId: { value: b.ad_id ?? null, raw: b.ad_id },
      /* The ad's NAME, and the ad set it belonged to.
       *
       * This account's TeleCRM sends `facebook_ad` ("Guest Review 11") and
       * `facebook_ad_set_id`, and no ad id at all — the connector says so
       * where it declines to fill `ad_id` with an ad set's. Carried because
       * without them nothing ties a reservation to a creative, and Creative
       * Intelligence had five CRM columns reading "—" on every card.
       *
       * Kept beside `adId` rather than folded into it: an id is a claim the
       * platform made and a name is a string somebody typed twice. Which rung
       * answered has to stay visible, or the identity ladder starts reporting
       * name matches as id matches. */
      adName: { value: b.ad_name ?? null, raw: b.ad_name ?? null },
      adsetId: { value: b.adset_id ?? null, raw: b.adset_id ?? null },
      property: n.text(b.property),
      /* Which channel produced this lead, so a cost per lead can be divided by
         the leads that channel paid for. Raw passthrough like the ids — these
         are the tokens `scope.js` narrows on (`meta`, `google`), not prose, and
         title-casing them would break the comparison silently. Null where the
         CRM does not say, which is not the same as organic. */
      channel: { value: b.channel ?? null, raw: b.channel ?? null },
      source: { value: b.source ?? null, raw: b.source ?? null },
    }),
    lead_event: (b) => ({
      leadId: { value: b.lead_id, raw: b.lead_id },
      /* An event type is a machine token, not prose. `n.text` title-cases —
         correct for a guest's name, wrong here, because it turns
         `first_response` into `First_response` and every downstream comparison
         then has to know the normaliser mangled it. Raw passthrough, the same
         as the ids beside it. */
      type: { value: b.type, raw: b.type },
      at: n.timestamp(b.at),
    }),
    deal: (b) => ({
      leadId: { value: b.lead_id, raw: b.lead_id },
      bookingRef: { value: b.booking_ref ?? null, raw: b.booking_ref },
      revenue: n.money(b.value, b.currency),
      stage: n.text(b.stage),
      updatedAt: n.timestamp(b.updated_at),
      /* Whether the reservation behind the deal still stands. A won lead whose
         booking was later cancelled keeps its reservation value in the CRM, so
         without this the money follows the cancellation into the revenue
         figure. Raw passthrough — it is compared, not displayed. */
      bookingStatus: { value: b.booking_status ?? null, raw: b.booking_status ?? null },
      /* won / lost, as the connector classified it against the workspace's own
         lead-stage pipeline. Raw passthrough — it is a token, and title-casing
         it would break every comparison downstream. */
      outcome: { value: b.outcome ?? null, raw: b.outcome ?? null },
    }),
  },

  pms: {
    booking: (b) => ({
      guest: n.text(b.guest_name),
      phone: n.phone(b.guest_phone),
      property: n.text(b.property),
      roomType: n.text(b.room_type),
      checkIn: n.date(b.check_in),
      checkOut: n.date(b.check_out),
      bookingStatus: n.text(b.status),
      nights: { value: b.nights ?? null, raw: b.nights },
      updatedAt: n.timestamp(b.updated_at),
    }),
    folio: (b) => ({
      bookingId: { value: b.booking_id, raw: b.booking_id },
      revenue: n.money(b.total, b.currency),
      roomRevenue: n.money(b.room_revenue, b.currency),
      commission: n.money(b.commission, b.currency),
      closedAt: n.timestamp(b.closed_at),
    }),
    inventory_day: (b) => ({
      date: n.date(b.date),
      available: { value: b.rooms_available ?? null, raw: b.rooms_available },
      sold: { value: b.rooms_sold ?? null, raw: b.rooms_sold },
    }),
  },

  razorpay: {
    /* The gateway already reports paise, which is the unit everything else is
       converted into — so this is the one money field that needs no scaling. */
    payment: (b) => ({
      bookingRef: { value: b.booking_ref ?? null, raw: b.booking_ref },
      payment: n.money(b.amount, b.currency, { unit: 'minor' }),
      status: n.text(b.status),
      method: n.text(b.method),
      phone: n.phone(b.contact),
      createdAt: n.timestamp(b.created_at),
    }),
    refund: (b) => ({
      paymentId: { value: b.payment_id, raw: b.payment_id },
      bookingRef: { value: b.booking_ref ?? null, raw: b.booking_ref },
      payment: n.money(-b.amount, b.currency, { unit: 'minor' }),
      status: n.text(b.status),
      reason: n.text(b.reason),
      createdAt: n.timestamp(b.created_at),
    }),
  },
};

/* ── The OTAs ───────────────────────────────────────────────────────────────
 *
 * One mapper, six channels. What a channel reports about a reservation is the
 * same set of facts wherever it comes from — who is staying, on which nights,
 * what the guest paid and what the channel kept — so the difference between
 * Booking.com and Agoda is a commission rate and a field name, not a shape.
 *
 * The field names read several spellings, for the reason the ad platforms do:
 * payloads reach here exactly as the source sent them. But note what that means
 * today — **no OTA has a request shape written** (lib/ingest/http has none), so
 * every payload these read is a fixture, and the alternate spellings are the
 * plausible ones from each vendor's public documentation rather than spellings
 * anything here has seen arrive. They are a head start for whoever writes the
 * first real connector, not a claim that the mapping is proven.
 *
 * Money: `gross` is what the guest paid, `commission` is what the channel
 * billed, `net` is what the property banks. A channel that states its own net
 * is believed; one that does not has it derived in `build`, never here, because
 * a derived figure and a reported one must be distinguishable and a mapper's
 * job is to read what arrived.
 */
const OTA_STATUSES = new Set([
  'confirmed', 'modified', 'new', 'ok', 'checked_in', 'checked_out', 'stayed',
  'cancelled', 'canceled', 'no_show', 'noshow', 'rejected', 'pending',
]);

/* A status is a machine token, not prose, so it does not go through `n.text` —
   that title-cases, which is how `first_response` once became `First_response`
   and a metric silently read zero. Lowered rather than passed through raw
   because the channels disagree on case ("CANCELLED", "Cancelled"), and a
   status compared three ways is a status compared no ways. An unrecognised
   value is kept and flagged rather than dropped: a channel inventing a sixth
   state is news, and guessing which side of confirmed it falls on would put
   revenue in or out of a total on the strength of a guess. */
function otaStatus(input) {
  const raw = input;
  if (input === null || input === undefined || input === '') return { value: null, raw, problem: 'empty' };
  const value = String(input).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!OTA_STATUSES.has(value)) return { value, raw, problem: `unrecognised reservation status "${input}"` };
  return { value, raw };
}

function otaReservation(b) {
  const currency = g(b, 'currency', 'currency_code') || 'INR';
  const money = (...paths) => {
    const found = g(b, ...paths);
    /* Absent is unknown, not zero. A channel that did not state its commission
       has not told us it charged none — and `n.money` would flag the empty as a
       problem, which would fill the problems channel with fields nobody sent. */
    if (found === undefined) return { value: null, raw: null };
    return n.money(found, currency);
  };

  return {
    guest: n.text(g(b, 'guest_name', 'guest.name', 'customer_name')),
    property: n.text(g(b, 'property', 'hotel_name', 'listing_name')),
    propertyId: { value: g(b, 'property_id', 'hotel_id', 'listing_id') ?? null, raw: g(b, 'property_id', 'hotel_id', 'listing_id') ?? null },
    roomType: n.text(g(b, 'room_type', 'room_name', 'unit_type')),
    checkIn: n.date(g(b, 'check_in', 'checkin', 'arrival_date')),
    checkOut: n.date(g(b, 'check_out', 'checkout', 'departure_date')),
    nights: (() => {
      const found = g(b, 'nights', 'los', 'length_of_stay');
      return { value: found === undefined ? null : Number(found), raw: found ?? null };
    })(),
    guests: (() => {
      const found = g(b, 'guests', 'occupancy', 'adults');
      return { value: found === undefined ? null : Number(found), raw: found ?? null };
    })(),
    status: otaStatus(g(b, 'status', 'reservation_status', 'state')),
    gross: money('gross_amount', 'total_price', 'total_amount', 'gross'),
    commission: money('commission_amount', 'commission'),
    net: money('net_amount', 'payout_amount', 'net'),
    bookedAt: n.timestamp(g(b, 'booked_at', 'created_at', 'reservation_date')),
    updatedAt: n.timestamp(g(b, 'updated_at', 'modified_at', 'last_change')),
  };
}

for (const channel of sources.OTA_CHANNELS) {
  MAPPERS[channel.id] = { reservation: otaReservation };
}

function normaliseRecord(record) {
  const mapper = MAPPERS[record.source] && MAPPERS[record.source][record.kind];
  if (!mapper) return null;
  const source = sources.get(record.source);
  return {
    source: record.source,
    system: source.system,
    kind: record.kind,
    externalId: record.externalId,
    fields: mapper(record.body),
    raw: record.body,
  };
}

/* Any field a normaliser could not read. Collected rather than thrown so one
   bad row does not stop a sync, and counted so a source degrading is visible
   rather than merely survivable. */
/* What could not be READ — which is not the same as what was not there.
 *
 * `text`, `campaignName`, `money` and the rest return `problem: 'empty'` for a
 * null input, and that is useful to the caller: it distinguishes "this field
 * was absent" from "this field held something I could not parse". Counting the
 * two together was the mistake.
 *
 * A TeleCRM lead carries no campaign when nobody tagged it, no property when
 * the enquiry named none, and no email when the guest gave a phone number.
 * Across ~5,000 leads and seven optional fields that produced **129,631
 * "problems"** — which fired a notification reading "129,214 values from
 * telecrm could not be read", and cost every CRM metric 20 points of
 * confidence, dropping `revenue.reservations` to 55% and suppressing its
 * recommendations under the 60% floor.
 *
 * None of it was a data-quality failure. Worse, the real parse failures — a
 * malformed date, an unrecognised money format — were buried in six figures of
 * noise, which is the opposite of what this exists for.
 *
 * Absence is therefore not a problem here. A field that is genuinely required
 * is enforced where it matters: `connectors.js` throws when a record has no
 * external id, and the entity builders decline a row rather than invent one. */
const ABSENT = 'empty';

function problems(normalised) {
  const found = [];
  for (const record of normalised) {
    for (const [name, field] of Object.entries(record.fields)) {
      if (field && field.problem && field.problem !== ABSENT) {
        found.push({ source: record.source, kind: record.kind, externalId: record.externalId, field: name, problem: field.problem, raw: field.raw });
      }
    }
  }
  return found;
}

/* ── Entities ───────────────────────────────────────────────────────────── */

const val = (field) => (field ? field.value : null);

/* ── who a lead belongs to ────────────────────────────────────────────────
 *
 * A lead is an enquiry. A customer is the person who made it, and the same
 * person enquires more than once — from two ads, in two seasons, or five times
 * in a week from a number nobody ever answers. Counting enquiries where the
 * question is about people is how one unreachable number becomes five
 * unreachable customers, and the NC figures are exactly that question.
 *
 * So every lead is stamped with a `customer` key here, over the WHOLE store,
 * rather than deduplicated inside a metric. A metric only ever sees entities
 * already narrowed to the selected window (lib/metrics/index.js), so it cannot
 * tell a first enquiry from a fourth one — the earlier three are outside the
 * window it was handed. This is the only layer that can see all of them.
 *
 * The key is the phone number, because that is what the CRM dials and what
 * TeleCRM itself falls back to as a unique field. Email is the fallback and a
 * lead with neither is its own customer, never merged with another under a
 * synthetic key — two anonymous enquiries are not evidence of one person.
 *
 * `REPEAT_LOOKBACK_DAYS` is what makes "the same person" a bounded claim. Two
 * enquiries from one number 400 days apart are not one continuing conversation;
 * treating them as one customer would quietly deflate every count that follows.
 * Past the horizon the same number opens a NEW customer, which is why the key
 * carries an epoch rather than being the phone number alone.
 *
 * The horizon is only as true as the history behind it: with 90 days in the
 * store, a lookback of a year can only find repeats inside those 90. It
 * understates repeats and therefore OVERSTATES customer counts, which is the
 * safe direction — it never invents a repeat that is not there.
 */
const REPEAT_LOOKBACK_DAYS = 365;
const REPEAT_LOOKBACK_MS = REPEAT_LOOKBACK_DAYS * 86400000;

/* The last ten digits, so +91 98xxx, 0098xxx and 98xxx are one person. Indian
   mobile numbers are ten digits and the CRM stores them every one of those
   ways. Ten rather than the whole string because a country code is present on
   some rows and absent on others for the same guest; ten rather than fewer
   because shorter would start joining strangers together. */
function personOf(lead) {
  const digits = String(lead.phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return `phone:${digits.slice(-10)}`;
  if (digits.length) return `phone:${digits}`;
  const email = String(lead.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  return null;
}

/* Stamps `customer`, `repeat` and `firstEnquiryAt` onto every lead. Mutates,
   because these are fields of the lead entity being built and threading a
   second collection through `build` would buy nothing. */
function withCustomers(leads) {
  const byPerson = new Map();
  for (const lead of leads) {
    const person = personOf(lead);
    /* No phone and no email: its own customer, and it cannot be a repeat of
       anything. Stamped here so no lead is ever left without a key — a metric
       counting distinct customers would otherwise collapse all of them into
       one `undefined`. */
    if (!person) {
      lead.customer = `lead:${lead.id}`;
      lead.repeat = false;
      lead.firstEnquiryAt = lead.createdAt || null;
      continue;
    }
    if (!byPerson.has(person)) byPerson.set(person, []);
    byPerson.get(person).push(lead);
  }

  for (const [person, group] of byPerson) {
    /* Oldest first, so each lead is judged against what came before it and not
       against the order the API happened to return (TeleCRM pages newest
       first). A lead with no createdAt sorts to the front and starts the run;
       it cannot be a repeat of something it has no position against. */
    group.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    let epoch = 0;
    let previous = null;
    let firstOfEpoch = null;
    for (const lead of group) {
      const at = Date.parse(lead.createdAt);
      const gap = previous !== null && Number.isFinite(at) ? at - previous : null;
      /* Past the horizon this is a new customer, not a returning one. */
      if (gap !== null && gap > REPEAT_LOOKBACK_MS) {
        epoch += 1;
        firstOfEpoch = null;
      }
      lead.customer = `${person}#${epoch}`;
      lead.repeat = firstOfEpoch !== null;
      if (firstOfEpoch === null) firstOfEpoch = lead.createdAt || null;
      lead.firstEnquiryAt = firstOfEpoch;
      if (Number.isFinite(at)) previous = at;
    }
  }

  return leads;
}

function build(rawRecords) {
  const normalised = rawRecords.map(normaliseRecord).filter(Boolean);
  const of = (source, kind) => normalised.filter((r) => r.source === source && r.kind === kind);

  /* campaignDay — one authoritative source per row, but two possible ones, so
     the key is the cleaned campaign name rather than either platform's id.
     That is the join Phase 5 will need and the reason cleanup happens now. */
  const campaignDays = [];
  for (const source of ['meta_ads', 'google_ads']) {
    for (const r of of(source, 'campaign_day')) {
      const f = r.fields;
      campaignDays.push({
        entity: 'campaignDay',
        id: `${val(f.campaign)}:${val(f.date)}`,
        campaign: val(f.campaign),
        /* The platform's own id for the campaign, beside the name.
         *
         * Every other Google grain — ad group, ad, keyword, search term,
         * conversion — carries `campaignId` and nothing carried the name, so
         * "which campaign is this keyword in" could be asked and not answered.
         * The name is what a reader recognises and the id is what the rows
         * agree on; both are needed to join them. */
        campaignId: f.campaignId ? val(f.campaignId) : null,
        label: f.campaign.label,
        date: val(f.date),
        platform: source,
        spend: val(f.spend),
        impressions: val(f.impressions),
        clicks: val(f.clicks),
        leads: val(f.leads),
        /* Google-only; absent on every Meta row, which is correct rather than
           missing — Meta has no equivalent of impression share. */
        channelType: f.channelType ? val(f.channelType) : null,
        impressionShare: f.impressionShare ? val(f.impressionShare) : null,
        lostToBudget: f.lostToBudget ? val(f.lostToBudget) : null,
        lostToRank: f.lostToRank ? val(f.lostToRank) : null,
        sources: [{ source, externalId: r.externalId }],
      });
    }
  }

  const leads = of('telecrm', 'lead').map((r) => {
    const f = r.fields;
    return {
      entity: 'lead',
      id: r.externalId,
      name: val(f.name),
      phone: val(f.phone),
      email: val(f.email),
      createdAt: val(f.createdAt),
      stage: val(f.stage),
      owner: val(f.owner),
      campaign: val(f.campaign),
      adId: val(f.adId),
      adName: val(f.adName),
      adsetId: val(f.adsetId),
      property: val(f.property),
      /* Which channel produced the lead, so paid cost can be divided by the
         leads that channel paid for rather than by every lead in the CRM.
         Adding it to the field map above is not enough — this list is explicit,
         and a field missing from it is silently undefined rather than an
         error, which is exactly how the per-channel lead count read 0 while the
         data was sitting in the store. */
      channel: val(f.channel),
      source: val(f.source),
      sources: [{ source: 'telecrm', externalId: r.externalId }],
    };
  });

  /* `customer`, `repeat` and `firstEnquiryAt`, stamped over every lead in the
     store — see withCustomers. It runs here, on the full set, because it is the
     last point at which the full set exists. */
  withCustomers(leads);

  const payments = [...of('razorpay', 'payment'), ...of('razorpay', 'refund')].map((r) => {
    const f = r.fields;
    return {
      entity: 'payment',
      id: r.externalId,
      bookingRef: val(f.bookingRef),
      amount: val(f.payment),
      status: val(f.status),
      method: val(f.method) || null,
      createdAt: val(f.createdAt),
      sources: [{ source: 'razorpay', externalId: r.externalId }],
    };
  });

  /* booking — the only contested entity. Three systems have a view of it and
     the precedence rules decide each field separately, so a booking can take
     its status from the PMS and its campaign from the CRM in the same breath. */
  const folios = of('pms', 'folio');
  const deals = of('telecrm', 'deal');

  const bookings = of('pms', 'booking').map((r) => {
    const f = r.fields;
    const id = r.externalId;
    const folio = folios.find((x) => val(x.fields.bookingId) === id);
    const deal = deals.find((x) => val(x.fields.bookingRef) === id);
    const paid = payments.filter((p) => p.bookingRef === id);

    const revenue = merge('revenue', [
      folio && { system: 'pms', source: 'pms', value: val(folio.fields.revenue), raw: folio.fields.revenue.raw },
      deal && { system: 'crm', source: 'telecrm', value: val(deal.fields.revenue), raw: deal.fields.revenue.raw },
    ].filter(Boolean));

    const status = merge('bookingStatus', [
      { system: 'pms', source: 'pms', value: val(f.bookingStatus), raw: f.bookingStatus.raw },
      deal && { system: 'crm', source: 'telecrm', value: val(deal.fields.stage), raw: deal.fields.stage.raw },
    ].filter(Boolean));

    const settled = merge('payment', paid.length
      ? [{ system: 'gateway', source: 'razorpay', value: paid.reduce((t, p) => t + (p.amount || 0), 0), raw: paid.map((p) => p.id) }]
      : []);

    return {
      entity: 'booking',
      id,
      guest: val(f.guest),
      phone: val(f.phone),
      property: val(f.property),
      roomType: val(f.roomType),
      checkIn: val(f.checkIn),
      checkOut: val(f.checkOut),
      nights: val(f.nights),
      revenue,
      bookingStatus: status,
      settled,
      leadId: deal ? val(deal.fields.leadId) : null,
      sources: [
        { source: 'pms', externalId: id },
        ...(folio ? [{ source: 'pms', externalId: folio.externalId }] : []),
        ...(deal ? [{ source: 'telecrm', externalId: deal.externalId }] : []),
        ...paid.map((p) => ({ source: 'razorpay', externalId: p.id })),
      ],
    };
  });

  /* otaReservation — one reservation as a channel reports it.
   *
   * **Kept apart from `booking` on purpose.** A channel's reservation and the
   * PMS's booking are the same stay seen twice, and folding them together is
   * the obvious move and the wrong one: the precedence table gives `revenue`
   * and `bookingStatus` to the PMS, so an OTA row would either lose (and
   * vanish, taking the commission with it) or be given an authority the table
   * never granted it. Neither is worth doing while the PMS is unconnected and
   * there is nothing to reconcile against.
   *
   * So this is the channel's own account of the stay, labelled as such, and the
   * screen says which. When the PMS is connected, the join is by confirmation
   * number and belongs here — it is not written yet, and pretending otherwise
   * by summing the two would double-count every reservation that arrived twice.
   *
   * `net` is what the property banks. A channel that states it is believed; one
   * that does not has it derived, and `netDerived` records which happened —
   * a derived net assumes commission is the only deduction, which is true of
   * these six and not of every channel.
   */
  const otaReservations = [];
  for (const channel of sources.OTA_CHANNELS) {
    for (const r of of(channel.id, 'reservation')) {
      const f = r.fields;
      const gross = val(f.gross);
      const commission = val(f.commission);
      const stated = val(f.net);
      const derivable = gross !== null && commission !== null;

      /* Nights as the channel stated them, or counted off the dates. A stay
         with neither is null, never 0 — an unknown length of stay divided into
         revenue would produce an ADR out of nothing. */
      const checkIn = val(f.checkIn);
      const checkOut = val(f.checkOut);
      const spanned = checkIn && checkOut
        ? Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000)
        : null;
      const nights = Number.isFinite(val(f.nights)) ? val(f.nights) : (Number.isFinite(spanned) && spanned > 0 ? spanned : null);

      otaReservations.push({
        entity: 'otaReservation',
        /* Prefixed by the channel: two OTAs may both number a reservation
           `1001`, and the raw store keeps them apart by path while a flat list
           of entities would not. */
        id: `${channel.id}:${r.externalId}`,
        reference: String(r.externalId),
        channel: channel.id,
        channelName: channel.name,
        guest: val(f.guest),
        property: val(f.property),
        propertyId: val(f.propertyId),
        roomType: val(f.roomType),
        checkIn,
        checkOut,
        nights,
        guests: val(f.guests),
        status: val(f.status),
        gross,
        commission,
        net: stated !== null ? stated : (derivable ? gross - commission : null),
        netDerived: stated === null && derivable,
        bookedAt: val(f.bookedAt),
        updatedAt: val(f.updatedAt),
        sources: [{ source: channel.id, externalId: r.externalId }],
      });
    }
  }

  /* inventoryDay — rooms available and sold, per property per night. Not
     contested: only the PMS knows its own inventory. Added in Phase 6 because
     occupancy and RevPAR are defined over available room nights and there was
     nothing to define them against; the payloads were already being normalised
     and simply never became an entity.

     The property id lives in the record's own key (`P-MUN:2026-07-14`) rather
     than in the mapped fields, because the mapper keeps names and measures, not
     ids — so it is read back off the key here. */
  /* A booking carries both the property's id and its name; an inventory row
     carries only the id. Without this map the two entities key on different
     things — inventory on `P-MUN`, bookings on `Munnar Hillside` — and
     occupancy for a property silently reads zero available rooms, because the
     filter matches neither. The id is kept alongside the name so the join can
     still be traced. */
  const propertyNames = new Map();
  for (const r of of('pms', 'booking')) {
    if (r.raw && r.raw.property_id && r.raw.property) propertyNames.set(r.raw.property_id, r.raw.property);
  }

  const inventoryDays = of('pms', 'inventory_day').map((r) => {
    const f = r.fields;
    const [propertyId] = String(r.externalId).split(':');
    return {
      entity: 'inventoryDay',
      id: r.externalId,
      propertyId,
      property: propertyNames.get(propertyId) || null,
      date: val(f.date),
      available: val(f.available),
      sold: val(f.sold),
      sources: [{ source: 'pms', externalId: r.externalId }],
    };
  });

  /* leadEvent — what happened to a lead and when. The first-response event is
     what makes the 44-minute median on the dashboard measurable at all, which
     is the reason TeleCRM streams rather than polls. */
  const leadEvents = of('telecrm', 'lead_event').map((r) => {
    const f = r.fields;
    return {
      entity: 'leadEvent',
      id: r.externalId,
      leadId: val(f.leadId),
      type: val(f.type),
      at: val(f.at),
      sources: [{ source: 'telecrm', externalId: r.externalId }],
    };
  });

  /* creative — an ad and what it achieved.
   *
   * The identity comes from the ads edge and the measurement from ad-level
   * insights, joined on the ad id. They arrive as two kinds because they are
   * two requests, but they describe one thing: the creative as it actually ran.
   *
   * A creative with no insight rows keeps its identity and reports null spend
   * rather than zero — an ad that has never been measured has not spent
   * nothing, it has no measurement, and the two must not read alike. */
  const adDayById = new Map();
  for (const r of of('meta_ads', 'ad_day')) {
    const [adId] = String(r.externalId).split(':');
    if (!adDayById.has(adId)) adDayById.set(adId, []);
    adDayById.get(adId).push(r);
  }

  const meanOf = (rows, field) => {
    const values = rows.map((r) => val(r.fields[field])).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };

  const totalOf = (rows, field) => {
    const values = rows.map((r) => val(r.fields[field])).filter((v) => v !== null && v !== undefined);
    return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
  };

  /* What each campaign was bought for, by id. Meta reports the objective on
     every insights row, so the last one seen wins — a campaign does not change
     objective mid-flight, and if it did the current answer is the right one. */
  const objectiveByCampaign = new Map();
  for (const r of of('meta_ads', 'campaign_day')) {
    const id = r.raw && r.raw.campaign_id;
    const objective = r.raw && r.raw.objective;
    if (id && objective) objectiveByCampaign.set(String(id), objective);
  }

  /* How each ad set was built, by id — the targeting the funnel is read from.
     `adset_day` carries an ad set's *measurements*; this is its configuration,
     and they arrive as two different kinds because Meta serves them from two
     different edges. */
  const adsetById = new Map();
  for (const r of of('meta_ads', 'adset')) {
    const id = val(r.fields.adsetId) || String(r.externalId);
    if (id) {
      adsetById.set(String(id), {
        name: val(r.fields.adsetName),
        customAudienceIds: val(r.fields.customAudienceIds) || [],
        hasTargeting: val(r.fields.hasTargeting) === true,
      });
    }
  }

  /* Ad set names also come off the ad-level insight rows, which every account
     has whether or not the adsets edge was fetched. Kept as a second source for
     the name alone: the funnel's name fallback can then still answer on an
     account whose targeting was never pulled. */
  const adsetNameById = new Map();
  for (const r of of('meta_ads', 'adset_day')) {
    const id = r.raw && r.raw.adset_id;
    const name = val(r.fields.adset);
    if (id && name) adsetNameById.set(String(id), name);
  }

  /* Custom audiences by id, for their retention windows. */
  const audiences = {};
  for (const r of of('meta_ads', 'audience')) {
    const id = val(r.fields.audienceId) || String(r.externalId);
    if (id) {
      audiences[String(id)] = {
        name: val(r.fields.audienceName),
        subtype: val(r.fields.subtype),
        retentionDays: val(r.fields.retentionDays),
        size: val(r.fields.size),
      };
    }
  }

  /* adsetDay — one ad set on one day, the same grain and shape as campaignDay.
   *
   * Daily rather than aggregated on purpose: `lib/metrics/period.js` narrows by
   * a row's own date, so a table built from these answers the date-range chips
   * for free. An ad set totalled here would have no date to narrow by and would
   * quietly ignore the range above it.
   *
   * The ad set's *configuration* — which audiences it targets — is joined on
   * rather than left for the screen to look up, because the join needs the
   * `adset` and `audience` kinds and the projection only ever sees entities.
   * Null where the adsets edge was never fetched, which is not the same as an
   * ad set targeting nobody in particular. */
  const adsetDays = of('meta_ads', 'adset_day').map((r) => {
    const f = r.fields;
    const adsetId = val(f.adsetId) || String(r.externalId).split(':')[0];
    const config = adsetId ? adsetById.get(String(adsetId)) : null;
    const audienceIds = (config && config.customAudienceIds) || [];

    return {
      entity: 'adsetDay',
      id: r.externalId,
      adsetId: adsetId ? String(adsetId) : null,
      adset: val(f.adset) || (config && config.name) || null,
      campaignId: val(f.campaignId) ? String(val(f.campaignId)) : null,
      date: val(f.date),
      platform: 'meta',
      spend: val(f.spend),
      impressions: val(f.impressions),
      clicks: val(f.clicks),
      leads: val(f.leads),
      /* Named where the audience kind was fetched, ids where it was not — a
         reader can act on "50% Watchers 60 days" and cannot act on an id, but
         an id is still better than claiming there was no targeting. */
      audiences: audienceIds.map((id) => {
        const a = audiences[String(id)];
        return {
          id: String(id),
          name: (a && a.name) || null,
          retentionDays: (a && a.retentionDays) ?? null,
          /* Size decides which pool describes the ad set — see the funnel rule
             in lib/creative-funnel.js. An ad set stacking a 3,900-person
             30-day pool beside a 53,400-person 60-day one delivers almost
             entirely to the larger, older one. */
          size: (a && a.size) ?? null,
        };
      }),
      targeting: config && config.hasTargeting ? true : null,
      sources: [{ source: 'meta_ads', externalId: r.externalId }],
    };
  });

  const creatives = of('meta_ads', 'creative').map((r) => {
    const f = r.fields;
    const adId = String(r.externalId);
    const days = adDayById.get(adId) || [];
    const adsetId = val(f.adsetId) || (days[0] && val(days[0].fields.adsetId)) || null;
    const adset = adsetId ? adsetById.get(String(adsetId)) : null;

    return {
      entity: 'creative',
      id: adId,
      adId,
      /* The ad's name. Meta's creative object carries its own name, but it is
         not requested here — the ads edge answers an object field with its id
         alone, and inventing a second request to fetch names would be a lot of
         round trips for a label the ad already has. */
      title: val(f.title),
      status: val(f.status),
      creativeId: val(f.creativeId),
      campaignId: val(f.campaignId),
      thumbnailUrl: val(f.thumbnailUrl),
      videoId: val(f.videoId),
      objectType: val(f.objectType),
      objective: objectiveByCampaign.get(String(val(f.campaignId))) || null,
      /* The three signals the funnel stage is read from, in the order
         lib/creative-funnel.js tries them: the ad set's targeting, the ad set's
         name, then the objective above. Resolved here because the join to the
         ad set happens here; classified there, because which stage a 30-day
         audience implies is a judgement and not a join. */
      adsetId: adsetId ? String(adsetId) : null,
      adsetName: (adset && adset.name) || (adsetId ? adsetNameById.get(String(adsetId)) : null) || null,
      /* Null rather than an empty spec when the adsets edge was never fetched:
         an ad set targeting nobody in particular is cold traffic, and one whose
         targeting nobody asked for is unknown. The two must not read alike. */
      targeting: adset && adset.hasTargeting
        ? { customAudienceIds: adset.customAudienceIds }
        : null,
      platform: 'meta',
      /* Measured, or null where nothing measured it. */
      spend: totalOf(days, 'spend'),
      impressions: totalOf(days, 'impressions'),
      clicks: totalOf(days, 'clicks'),
      leads: totalOf(days, 'leads'),
      videoPlays: totalOf(days, 'videoPlays'),
      videoCompletions: totalOf(days, 'videoCompletions'),
      /* Frequency and CPM are ratios per day, so they are averaged over the
         days that reported one — adding them would produce a figure that grows
         with the window and means nothing. */
      frequency: meanOf(days, 'frequency'),
      cpm: meanOf(days, 'cpm'),

      /* The daily series, in date order. Fatigue is a comparison of a
         creative's recent days against its own earlier ones, so a total cannot
         answer it — only the shape over time can. Kept on the entity rather
         than recomputed per screen, because the join to ad_day happens here. */
      /* Every measured field, not only the ones fatigue reads. The date-range
         chips narrow a creative by re-totalling this series (lib/metrics/period.js),
         and a series missing leads or video plays would leave those two figures
         standing at their all-time values beside a narrowed spend — which is
         worse than not narrowing at all. */
      series: days
        .map((d) => ({
          date: val(d.fields.date),
          spend: val(d.fields.spend),
          impressions: val(d.fields.impressions),
          clicks: val(d.fields.clicks),
          leads: val(d.fields.leads),
          videoPlays: val(d.fields.videoPlays),
          videoCompletions: val(d.fields.videoCompletions),
          frequency: val(d.fields.frequency),
          cpm: val(d.fields.cpm),
        }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
      days: days.length,
      sources: [{ source: 'meta_ads', externalId: r.externalId }],
    };
  });

  /* Google's own hierarchy, kept as its own entities.
   *
   * Deliberately NOT folded into `adsetDays` or `creatives`. An ad group is not
   * an ad set and a text ad is not a creative asset: they carry different
   * fields, they are measured differently, and the screen that showed Google
   * rows under Meta's ad-set shape is the bug this separation removes.
   * Renaming that column would have kept the wrong projection behind it. */
  const googleRows = (kind, extra) => of('google_ads', kind).map((r) => {
    const f = r.fields;
    return {
      id: r.externalId,
      date: val(f.date),
      campaignId: val(f.campaignId),
      spend: val(f.spend),
      impressions: val(f.impressions),
      clicks: val(f.clicks),
      leads: val(f.leads),
      sources: [{ source: 'google_ads', externalId: r.externalId }],
      ...extra(f),
    };
  });

  const googleAdGroups = googleRows('adgroup_day', (f) => ({
    entity: 'googleAdGroup', adgroup: val(f.adgroup), adgroupId: val(f.adgroupId),
  }));

  const googleAds = googleRows('ad_day', (f) => ({
    entity: 'googleAd',
    ad: val(f.ad), adId: val(f.adId), adType: val(f.adType),
    status: val(f.status), adgroupId: val(f.adgroupId),
  }));

  const googleKeywords = googleRows('keyword_day', (f) => ({
    entity: 'googleKeyword',
    keyword: val(f.keyword), matchType: val(f.matchType),
    qualityScore: val(f.qualityScore), adgroupId: val(f.adgroupId),
  }));

  const googleSearchTerms = googleRows('search_term_day', (f) => ({
    entity: 'googleSearchTerm',
    term: val(f.term), termStatus: val(f.termStatus), adgroupId: val(f.adgroupId),
  }));

  /* The account's current keyword list.
   *
   * **Not dated, and deliberately absent from period.js.** Every other Google
   * collection is a measurement over a window; this is a statement about the
   * present — what the account is bidding on — and narrowing it by a range
   * would answer "which keywords existed in July", which Google does not
   * report and this does not know. The screen says so where it is read.
   *
   * Kept apart from `googleKeywords` rather than merged into it: one is what
   * exists and the other is what it did, they have different cardinality (four
   * measured against however many are enabled), and joining them here would
   * hide which of the two a given row came from. The join happens on the
   * screen, where the absence is displayed rather than resolved. */
  const googleKeywordList = of('google_ads', 'keyword').map((r) => {
    const f = r.fields;
    return {
      entity: 'googleKeywordListing',
      id: r.externalId,
      keywordId: val(f.keywordId),
      keyword: val(f.keyword),
      matchType: val(f.matchType),
      status: val(f.status),
      adgroupId: val(f.adgroupId),
      adgroup: val(f.adgroup),
      adgroupStatus: val(f.adgroupStatus),
      campaignId: val(f.campaignId),
      campaign: val(f.campaign),
      campaignStatus: val(f.campaignStatus),
      channelType: val(f.channelType),
      sources: [{ source: 'google_ads', externalId: r.externalId }],
    };
  });

  /* Conversions carry no spend of their own — they are a breakdown of the
     campaign's, so summing them beside it would double-count. */
  const googleConversions = of('google_ads', 'conversion_day').map((r) => {
    const f = r.fields;
    return {
      entity: 'googleConversion',
      id: r.externalId,
      date: val(f.date),
      campaignId: val(f.campaignId),
      action: val(f.action),
      category: val(f.category),
      conversions: val(f.conversions),
      conversionValue: val(f.conversionValue),
      /* `null` rather than 0 when the field is absent — a row ingested before
         these were fetched has no answer, which is not the same as an action
         that recorded nothing. */
      allConversions: f.allConversions ? val(f.allConversions) : null,
      allConversionValue: f.allConversionValue ? val(f.allConversionValue) : null,
      sources: [{ source: 'google_ads', externalId: r.externalId }],
    };
  });

  /* Deals as a collection of their own, not only as an enrichment of a PMS
   * booking.
   *
   * `deals` was read once, to merge its revenue into a matching booking — so
   * with no PMS connected, the reservation value the CRM records on every won
   * lead reached nothing at all. That is the right precedence (the folio wins
   * when it exists) and the wrong outcome when there is no folio: the only
   * revenue anybody has was being discarded for being second-best.
   *
   * The channel comes from the lead that became the deal, because a deal has no
   * channel of its own — which is also the only way "revenue from Meta" can
   * mean anything. A deal whose lead is untagged gets null and is counted under
   * no channel, the same rule the leads follow. */
  const leadChannel = new Map(leads.map((l) => [l.id, l.channel]));
  const leadCampaign = new Map(leads.map((l) => [l.id, l.campaign]));
  /* Whether the person behind the deal was enquiring for the first time, taken
     from the lead for the same reason the channel is: a deal has no history of
     its own. `null` where the lead is unknown — NOT false, which would mean
     "known to be a returning customer" and would quietly move revenue out of
     the NC figures rather than leaving it unclassified. */
  const leadCustomer = new Map(leads.map((l) => [l.id, l.customer]));
  const leadRepeat = new Map(leads.map((l) => [l.id, l.repeat]));
  const dealRows = deals.map((r) => {
    const f = r.fields;
    const leadId = val(f.leadId);
    return {
      entity: 'deal',
      id: r.externalId,
      leadId,
      bookingRef: val(f.bookingRef),
      revenue: val(f.revenue),
      stage: val(f.stage),
      updatedAt: val(f.updatedAt),
      bookingStatus: val(f.bookingStatus),
      outcome: val(f.outcome),
      channel: leadChannel.has(leadId) ? leadChannel.get(leadId) : null,
      campaign: leadCampaign.has(leadId) ? leadCampaign.get(leadId) : null,
      customer: leadCustomer.has(leadId) ? leadCustomer.get(leadId) : null,
      repeat: leadRepeat.has(leadId) ? leadRepeat.get(leadId) : null,
      sources: [{ source: 'telecrm', externalId: r.externalId }],
    };
  });

  /* Website behaviour, three cuts of the same days. Kept as separate
     collections rather than one with a nullable dimension, because summing them
     together would count every session three times — once undimensioned, once
     per channel, once per source/medium. */
  const webDay = (kind, extra) => of('google_analytics', kind).map((r) => {
    const f = r.fields;
    return {
      entity: kind,
      id: r.externalId,
      date: val(f.date),
      sessions: val(f.sessions),
      users: val(f.users),
      newUsers: val(f.newUsers),
      bounceRate: val(f.bounceRate),
      avgSessionSeconds: val(f.avgSessionSeconds),
      pageViews: val(f.pageViews),
      ...extra(f),
      sources: [{ source: 'google_analytics', externalId: r.externalId }],
    };
  });

  const sessionDays = webDay('session_day', () => ({}));
  const webChannelDays = webDay('channel_day', (f) => ({ channelGroup: val(f.channelGroup) }));
  const webSourceDays = webDay('source_medium_day', (f) => ({ source: val(f.source), medium: val(f.medium) }));
  const webPageDays = webDay('page_day', (f) => ({ page: val(f.page) }));
  const webCityDays = webDay('city_day', (f) => ({ city: val(f.city) }));

  /* Meta's account-level age × gender split. */
  const metaDemographicDays = of('meta_ads', 'demographic_day').map((r) => {
    const f = r.fields;
    return {
      entity: 'demographicDay',
      id: r.externalId,
      date: val(f.date),
      age: val(f.age),
      gender: val(f.gender),
      spend: val(f.spend),
      impressions: val(f.impressions),
      clicks: val(f.clicks),
      leads: val(f.leads),
      sources: [{ source: 'meta_ads', externalId: r.externalId }],
    };
  });
  const webCityRevenueDays = of('google_analytics', 'city_revenue_day').map((r) => {
    const f = r.fields;
    return {
      entity: 'city_revenue_day',
      id: r.externalId,
      date: val(f.date),
      city: val(f.city),
      revenue: val(f.revenue),
      reservations: val(f.reservations),
      sources: [{ source: 'google_analytics', externalId: r.externalId }],
    };
  });
  const webLandingDays = webDay('landing_page_day', (f) => ({ landingPage: val(f.landingPage) }));

  /* Revenue per channel per day.
   *
   * Deliberately NOT built through `webDay`: that helper fills in sessions,
   * users, bounce rate and page views, and this kind reports none of them. Six
   * nulls on every row would read as a pull that half-failed rather than as a
   * different question asked of the same dimension. */
  const webChannelRevenueDays = of('google_analytics', 'channel_revenue_day').map((r) => {
    const f = r.fields;
    return {
      entity: 'channel_revenue_day',
      id: r.externalId,
      date: val(f.date),
      channelGroup: val(f.channelGroup),
      revenue: val(f.revenue),
      reservations: val(f.reservations),
      sources: [{ source: 'google_analytics', externalId: r.externalId }],
    };
  });

  return {
    campaignDays, adsetDays, leads, bookings, payments, inventoryDays, leadEvents, creatives,
    otaReservations, deals: dealRows,
    sessionDays, webChannelDays, webChannelRevenueDays, webSourceDays, webPageDays, webLandingDays,
    webCityDays, webCityRevenueDays, metaDemographicDays,
    googleAdGroups, googleAds, googleKeywords, googleSearchTerms, googleConversions,
    googleKeywordList,
    /* Keyed by id rather than listed: every consumer of this looks an audience
       up by the id an ad set named, and none of them iterates it. */
    audiences,
    problems: problems(normalised),
  };
}

/* The shape this module produces, as a version.
 *
 * The materialised snapshot is keyed on the rows that went into it —
 * `count:max(seq):connected` — which is everything about the INPUT and
 * nothing about the code that transformed it. So a change here produced no
 * change in the marker, the cached snapshot stayed valid, and a deploy that
 * added a field to a lead went on serving leads without it until the next
 * sync happened to write an envelope. That is a silent no-op deploy, and it
 * is worse than a broken one: everything looks fine and nothing changed.
 *
 * **Bump this whenever the shape of what `build` returns changes** — a new
 * field, a renamed one, a different join. Not for a comment or a refactor
 * that produces identical output; the cost of a bump is one rebuild per
 * workspace, which is exactly what a shape change needs. */
const SHAPE = '2026-08-19.keyword-list';

module.exports = { build, normaliseRecord, problems, MAPPERS, SHAPE };
