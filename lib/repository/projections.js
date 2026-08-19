/* Canonical entities -> screen payloads.
 *
 * Sub-phase 4.6. Every function here answers one question: what can the
 * ingested entities honestly say about this screen's rows?
 *
 * Three rules hold throughout, and they are the whole design.
 *
 * **Derive or decline — never borrow.** A field this file cannot compute from
 * the entities is rendered as `—`, not filled in from the authored module it is
 * replacing. A row that mixed six ingested figures with three authored ones,
 * indistinguishably, would be worse than either alone.
 *
 * **The schema still has to pass.** Every declared field of a row must be
 * present, which is why declining is explicit rather than an omission: the
 * shape is the design's and does not bend to what the fixtures happen to hold.
 *
 * **Thin is a true answer.** Five fixture campaign-days produce fewer rows than
 * the authored module's six campaigns, and that is the correct output, not a
 * bug to pad around.
 */

const { UP, DOWN, WARN, NA, MUTED, seg, spark } = require('../../data/_tokens');
const filters = require('../filters');
const fatigue = require('../creative-fatigue');
const verdicts = require('../creative-verdict');
const funnels = require('../creative-funnel');
const goals = require('../creative-goals');
const scoring = require('../creative-score');
const trends = require('../creative-trend');

/* What a source id is called on screen. */
const PLATFORM = { meta_ads: 'Meta', google_ads: 'Google' };

/* The one value that says "the entities cannot answer this". Kept as a constant
   because grepping for it is how you audit an ingested screen's real coverage. */
const NONE = '—';

/* Meta's own names for what a creative is. Module scope rather than local to
   the Creative Intelligence projection, because the campaign screen's Ads tab
   labels the same ads — and two screens keeping their own copy of this table is
   how one of them ends up calling a PHOTO something the other does not. */
/* **Only creatives something measured.**
 *
 * Meta's ads edge answers with every ad the account has ever created, while
 * insights cover the window that was pulled. On a real account that is 1,560
 * ads against about 50 with spend — so showing all of them fills the screen
 * with ads that ran years ago and correctly report `—` for every column. The
 * reader cannot tell those from a broken pipeline, and the ones that matter are
 * buried among them. On the Ads tab it also meant a 6 MB page.
 *
 * Unmeasured ads are not *wrong*, they are out of window, so this is a display
 * decision rather than a data one: they stay in the entities and out of the
 * cards. Widening the pull window is what brings more of them back, which is a
 * different lever and belongs to the connector.
 *
 * If nothing at all was measured the whole set is shown instead — an empty
 * screen would read as a broken connection rather than a quiet fortnight.
 *
 * Shared by Creative Intelligence and the campaign screen's Ads tab, which show
 * the same ads and must not disagree about which of them exist.
 */
function measuredCreatives(entities) {
  const all = entities.creatives || [];
  const measured = all.filter((c) => c.spend !== null && c.spend !== undefined);
  return measured.length ? measured : all;
}

const FORMAT = {
  VIDEO: { type: 'Video', icon: 'ph-fill ph-play-circle' },
  SHARE: { type: 'Image', icon: 'ph-fill ph-image-square' },
  PHOTO: { type: 'Image', icon: 'ph-fill ph-image-square' },
  STATUS: { type: 'Text', icon: 'ph-fill ph-text-aa' },
  LINK: { type: 'Link', icon: 'ph-fill ph-link-simple' },
  INVALID: { type: NONE, icon: 'ph-fill ph-image-square' },
};
const declined = (fields) => Object.fromEntries(fields.map((f) => [f, NONE]));

/* ── formatting ─────────────────────────────────────────────────────────── */

const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

/* Every money value on a canonical entity is in **paise**: normalise.js stores
   the minor unit so that a gateway working in paise and a PMS working in rupees
   land on the same scale (₹42,800 arrives here as 4280000). Formatting has to
   undo that, and the first version of this file did not — every figure on an
   ingested screen was a hundred times too large, which reads as plausible right
   up until someone checks it. Hence paise in the parameter name. */
function money(paise) {
  if (paise == null || Number.isNaN(paise)) return NONE;
  const n = paise / 100;
  /* Indian lakh notation above a lakh, plain rupees below — the convention the
     design's own hardcoded figures use (₹2.10L, ₹348). */
  return n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : rupees(n);
}

function count(n) {
  if (n == null || Number.isNaN(n)) return NONE;
  return n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n.toLocaleString('en-IN');
}

/* `spark` plots against a 0–100 y-axis, so a series of raw rupee figures would
   run far off the top of the viewbox. Scaled to the series' own maximum, which
   is what a sparkline means anyway: the shape, not the magnitude.

   A single day is a real case here — most fixture campaigns have one — and it
   would divide by zero on the way to a path, so it is drawn as the flat line it
   actually is rather than as NaN. */
function sparkline(values) {
  if (!values.length) return spark([0, 0]);
  const top = Math.max(...values);
  const scaled = values.map((v) => (top ? (v / top) * 100 : 0));
  return spark(scaled.length === 1 ? [scaled[0], scaled[0]] : scaled);
}

const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(2)}%` : NONE);
const ratio = (num, den) => (den ? `${(num / den).toFixed(1)}x` : NONE);
const sum = (rows, field) => rows.reduce((t, r) => t + (r[field] || 0), 0);

/* A merged field carries its value under `.value`; a plain one does not. */
const value = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/* A short, stable token for a string — used to version the thumbnail URL.
 *
 * **The proxy address is the same for an ad for ever**, and it is served with a
 * day of browser caching, so when the stored image changes underneath it every
 * reader keeps the old one until the cache expires. That is not hypothetical:
 * this account's stills went from Meta's 64-pixel preview to the full asset and
 * the screen went on showing the smudge, which reads exactly like the fix not
 * having worked.
 *
 * So the address carries a token derived from the image it stands for. Same
 * image, same URL, still cached; new image, new URL, fetched at once. FNV-1a
 * rather than a crypto hash because this is a cache key, not a secret, and it
 * has to be cheap enough to run per card per render. */
function token(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/* ── joins ──────────────────────────────────────────────────────────────── */

/* campaign -> bookings, via the leads the CRM attributed to it. The ad platform
   never sees a booking and the PMS never sees a campaign; the CRM's lead is the
   only thing that touches both, which is precisely the join the Analytics
   Engine page describes as closed-loop attribution. */
function bookingsByCampaign(entities) {
  const leadCampaign = new Map(entities.leads.map((l) => [l.id, l.campaign]));
  const byCampaign = {};
  for (const booking of entities.bookings) {
    const campaign = booking.leadId && leadCampaign.get(booking.leadId);
    if (!campaign) continue;
    (byCampaign[campaign] = byCampaign[campaign] || []).push(booking);
  }
  return byCampaign;
}

const revenueOf = (bookings) => bookings.reduce((t, b) => t + (value(b.revenue) || 0), 0);

/* The CRM's own reservations, grouped by what produced them.
 *
 * `bookingsByCampaign` above reads `entities.bookings` — the PMS folio. There
 * is no PMS, so it returns an empty map and every BOOKINGS, REVENUE and ROAS
 * cell on Meta Ads Analytics rendered a dash while the CRM held a reservation
 * value on every won lead the whole time. That is the same fault the three
 * headline tiles on the dashboard had, fixed there and never here: reading the
 * one system nobody has connected.
 *
 * The join is the lead's, because a deal has neither a campaign nor an ad of
 * its own — canonical copies both onto it at build time for exactly this. A
 * deal whose lead was untagged joins nothing and is counted under no campaign,
 * which is the same rule the leads follow and makes every figure here a FLOOR:
 * it counts what can be shown, not everything the advertising produced.
 *
 * Cancellations are excluded, so a reservation that fell through stops
 * inflating the campaign that won it. */
const isWonDeal = (d) => d.outcome === 'won' && !/cancel/i.test(String(d.bookingStatus || ''));

function dealsBy(entities, key) {
  const out = {};
  for (const deal of entities.deals || []) {
    if (!isWonDeal(deal)) continue;
    const k = deal[key];
    if (!k) continue;
    (out[k] = out[k] || []).push(deal);
  }
  return out;
}

/* An ad is joined through the lead's `ad_id`, which is the click identifier the
   lead form captured — the strongest rung on the identity ladder and the only
   one that ties a reservation to a single creative rather than to a campaign of
   four hundred.

   `via` optionally re-keys that join one hop further: an ad set has no id on a
   lead, but every ad belongs to one, so passing a map of adId -> adsetId lifts
   the same reservations up a level. Two hops is the limit worth taking — each
   one loses the rows whose previous key was missing, and a figure assembled
   from three joins cannot be explained to anybody who queries it. */
function dealsByAd(entities, via = null) {
  const adOfLead = new Map((entities.leads || []).map((l) => [l.id, l.adId]));
  const out = {};
  for (const deal of entities.deals || []) {
    if (!isWonDeal(deal)) continue;
    const adId = adOfLead.get(deal.leadId);
    if (!adId) continue;
    const key = via ? via.get(adId) : adId;
    if (!key) continue;
    (out[key] = out[key] || []).push(deal);
  }
  return out;
}

const dealRevenue = (deals) => deals.reduce((t, d) => t + (d.revenue || 0), 0);

/* ── campaigns ──────────────────────────────────────────────────────────── */

/* Not derivable from a campaign_day row: a campaign's status, objective, health
   score and pacing are properties of the campaign object itself, which the
   fixtures carry no kind for. */
const CAMPAIGN_DECLINED = ['status', 'objective', 'health', 'pace', 'paceLabel'];

/* ── what this screen cannot answer, and must therefore not show ────────────
 *
 * Campaign Analytics was authored from the design with a full set of plausible
 * figures — named guests with check-in dates, keyword bids, quality scores, an
 * AI narrative explaining a CPL fall that never happened. Under the ingested
 * driver only `campRows` was replaced, so the screen served five real campaigns
 * above four invented ad sets, five invented keywords and five invented
 * reservations, with nothing to mark where one ended and the other began.
 *
 * Every collection here needs a source nobody has connected: ad sets, ads and
 * keywords need adset/ad/keyword kinds no connector pulls yet, search terms
 * need the search-terms report, rooms, packages and reservations need the PMS,
 * and the insight cards are authored prose. So they are emptied rather than
 * filled — an empty table says "no data" and a populated one says "this is
 * your data", and only one of those is true.
 */
const CAMPAIGN_UNANSWERED = [
  'kwRows', 'searchTerms', 'resRows', 'dRooms', 'dPkgs', 'dFunnel', 'dAi',
];

/* KPI cards keep their row — the label and the metric it names are the design's
   structure, and a card that names a registry metric gets its real value from
   `lib/metrics/resolve.js` a moment after this returns. What goes is the
   authored figure, so a card the registry cannot back reads "—" instead of a
   number somebody made up. */
const CAMPAIGN_KPIS = ['dMkt', 'dBiz', 'dRevStats'];

function declineValues(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const out = { ...row, value: NONE };
    /* Only what the row already had. A delta added to a card that never
       displayed one would be a field the view does not read and a reader
       cannot see. */
    if ('delta' in row) out.delta = NONE;
    if ('deltaColor' in row) out.deltaColor = NA;
    return out;
  });
}

function unanswered(authored = {}) {
  const out = {};
  for (const key of CAMPAIGN_UNANSWERED) {
    /* Only collections the authored payload actually carries, so this does not
       invent keys on a screen that never had them. */
    if (Array.isArray(authored[key])) out[key] = [];
  }
  for (const key of CAMPAIGN_KPIS) {
    if (Array.isArray(authored[key])) out[key] = declineValues(authored[key]);
  }
  return out;
}

/* Meta only — Google has a screen of its own.
 *
 * campaignDays deliberately carries both platforms; it is the one entity they
 * share, and the marketing dashboard adds them together. This screen is not
 * that place. Its tables are campaign -> ad set -> ad, and a Google campaign
 * has no ad sets, so its rows arrived here to be rendered through a hierarchy
 * they do not have. */
function campaigns(entities, params = {}, authored = {}) {
  const byCampaign = {};
  for (const day of (entities.campaignDays || []).filter((d) => d.platform === 'meta_ads')) {
    (byCampaign[day.campaign] = byCampaign[day.campaign] || []).push(day);
  }

  const bookings = bookingsByCampaign(entities);
  /* The CRM's reservations, used only where the folio has none.
   *
   * The precedence table gives settled revenue to the PMS and that is not being
   * overturned here — a folio booking still wins wherever one exists. What is
   * fixed is the case that was actually live: there IS no PMS, so
   * `bookingsByCampaign` returned an empty map and every BOOKINGS, REVENUE and
   * ROAS cell on this screen dashed while the CRM held a reservation value on
   * every won lead the whole time. Reading the one system nobody has connected,
   * which is the same fault the dashboard's headline tiles had. */
  const reservations = dealsBy(entities, 'campaign');

  const campRows = Object.entries(byCampaign).map(([campaign, days]) => {
    const spend = sum(days, 'spend');
    const impressions = sum(days, 'impressions');
    const clicks = sum(days, 'clicks');
    /* The PLATFORM's reported leads, deliberately — Meta counts a lead when the
       form is submitted and the CRM counts the ones that arrived. Left alone so
       CPL keeps meaning what it has always meant on this screen. */
    const leads = sum(days, 'leads');
    const folio = bookings[campaign] || [];
    const won = folio.length ? folio : (reservations[campaign] || []);
    const revenue = folio.length ? revenueOf(folio) : dealRevenue(won);

    /* Ordered by the source's own date so the sparkline reads left to right in
       time rather than in whatever order the store replayed. */
    const series = [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    return {
      /* Which campaign, in the link. Every row pointed at the bare drill-down,
         so all of them opened the same page — and that page was still scoped to
         the authored demo campaign, which no longer exists in the store, so it
         opened on zeroes whichever row was clicked. */
      go: `/campaigns?v=campDetail&campaign=${encodeURIComponent(campaign)}`,
      name: days[0].label || campaign,
      platform: [...new Set(days.map((d) => PLATFORM[d.platform] || d.platform))].join(' + '),
      spend: money(spend),
      impr: count(impressions),
      ctr: pct(clicks, impressions),
      leads: count(leads),
      cpl: leads ? money(spend / leads) : NONE,
      bookings: won.length ? String(won.length) : NONE,
      rev: won.length ? money(revenue) : NONE,
      roas: won.length && spend ? ratio(revenue, spend) : NONE,
      roasColor: won.length && spend ? (revenue / spend >= 4 ? UP : WARN) : NA,
      healthColor: NA,
      paceColor: NA,
      spark: sparkline(series.map((d) => d.spend || 0)),
      ...declined(CAMPAIGN_DECLINED),
    };
  });

  return {
    campRows,
    adsetRows: adsets(entities),
    adRows: ads(entities),
    ...selected(byCampaign, params),
    ...unanswered(authored),
  };
}

/* The Ads tab — the same ads the Creative Intelligence screen measures, shown
 * in the campaign screen's own card.
 *
 * `creatives` is already a canonical collection joining the ads edge's identity
 * to ad-level insights, so this is a second reading of it rather than a second
 * fetch. The thumbnail arrives the way it does on Creative Intelligence: through
 * the `grad` field the design already binds, with the gradient left underneath
 * so an expired signature degrades to a coloured card and not to a broken
 * image.
 *
 * Ordered by spend, biggest first, and not truncated — the design draws three
 * cards and this account runs more than three. A silent top-N would read as
 * "these are the ads" when it meant "these are some of them".
 *
 * What declines, and why:
 *
 *   body, cta    the ad's copy lives in `object_story_spec`, which no request
 *                asks for. Inventing a line of ad copy is not a rounding error.
 *   freq         impressions over reach, and reach does not add across days.
 *                The daily figure is kept on the entity and read by the fatigue
 *                model, which compares a creative's days to its own earlier
 *                days — a valid use of it, and not the same as printing it as
 *                a period total.
 *   engagement   comments, shares, saves and negative feedback are action
 *                types nothing requests.
 *   outcomes     bookings, revenue and ROAS need the CRM and the PMS.
 */
function ads(entities) {
  /* The same set Creative Intelligence ranks. Showing every ad the account has
     ever created put 1,560 cards and 6 MB on this tab, nearly all of them
     reporting "—" for every figure because they ran outside the pulled window.
     See `measuredCreatives`. */
  const rows = [...measuredCreatives(entities)]
    .sort((a, b) => (b.spend || 0) - (a.spend || 0));

  /* Reservations joined to the ad that produced them, through the `ad_id` the
     lead form captured. This is the strongest rung on the identity ladder —
     one lead, one click, one creative — and it is the only reason an ad can
     carry a ROAS at all. An ad with no lead carrying its id declines rather
     than reporting zero: no reservations *found* is not no reservations. */
  const byAd = dealsByAd(entities);

  return rows.map((c) => {
    const won = byAd[c.adId] || [];
    const revenue = dealRevenue(won);
    const format = FORMAT[c.objectType] || { type: c.objectType || NONE, icon: 'ph-fill ph-image-square' };
    const fallback = c.backdrop || 'linear-gradient(135deg,#2b2741,#5d5294)';

    return {
      name: c.title || c.adId,
      adset: c.adsetName || NONE,
      type: format.type,
      thumbIcon: format.icon,
      platform: PLATFORM[`${c.platform}_ads`] || 'Meta',
      grad: c.thumbnailUrl
        ? `url('/creatives/${encodeURIComponent(c.adId)}/thumbnail?v=${token(c.thumbnailUrl)}') center/cover no-repeat, ${fallback}`
        : fallback,
      body: NONE,
      cta: NONE,
      spend: money(c.spend),
      ctr: pct(c.clicks, c.impressions),
      freq: NONE,
      bookings: won.length ? String(won.length) : NONE,
      rev: won.length ? money(revenue) : NONE,
      roas: won.length && c.spend ? ratio(revenue, c.spend) : NONE,
      roasColor: won.length && c.spend ? (revenue / c.spend >= 4 ? UP : WARN) : MUTED,
      saves: NONE,
      shares: NONE,
      comments: NONE,
      neg: NONE,
      negColor: MUTED,
      spark: sparkline((c.series || []).map((d) => d.spend || 0)),
    };
  });
}

/* The Ad sets tab.
 *
 * It rendered "No ad sets — needs an ads connector that pulls ad-set rows"
 * while Meta had been pulling `adset_day` on every sync for weeks. The rows
 * existed; nothing built a table out of them, and the empty state blamed a
 * connector rather than the missing projection.
 *
 * Four of the eleven columns are answered and the rest decline, which is the
 * honest split rather than a shortfall:
 *
 *   placement   Meta serves it under a breakdown, and no request asks for one.
 *   saturation  a judgement about how much of an audience has been reached,
 *               and reach is not fetched at this level.
 *   freq        impressions over reach, and reach does not add up across days
 *               — the same trap as the drill-down's Frequency card.
 *   bookings    needs the CRM and the PMS, neither of them connected.
 *   revenue
 *   net ROAS
 */
function adsets(entities) {
  const byAdset = {};
  for (const day of entities.adsetDays || []) {
    const key = day.adsetId || day.adset;
    if (!key) continue;
    (byAdset[key] = byAdset[key] || []).push(day);
  }

  /* Reservations lifted from the ad to the ad set it belongs to. The lead
     carries an ad id and never an ad set id, so the creative is the hop
     between them — see dealsByAd. Keyed the same way the rows above are, so an
     account reporting adsetId and one reporting only a name both join. */
  const adsetOfAd = new Map();
  for (const c of entities.creatives || []) {
    if (c.adId) adsetOfAd.set(c.adId, c.adsetId || c.adsetName);
  }
  const reservations = dealsByAd(entities, adsetOfAd);

  return Object.values(byAdset).map((days) => {
    const key = days[0].adsetId || days[0].adset;
    const won = reservations[key] || [];
    const revenue = dealRevenue(won);
    const spend = sum(days, 'spend');
    const clicks = sum(days, 'clicks');
    const impressions = sum(days, 'impressions');
    const leads = sum(days, 'leads');

    /* The audience is the ad set's own, not a guess from its name.
       Named by the LARGEST pool rather than the first or the hottest, for the
       reason lib/creative-funnel.js gives: an ad set stacking a 3,900-person
       30-day pool beside a 53,400-person 60-day one delivers almost entirely to
       the larger, older one, so the small hot pool describes the part that
       barely runs. Listing all eight joined by "+" was the first attempt and
       filled the column with a sentence nobody can read across a table row. */
    const pools = [...(days[0].audiences || [])]
      .sort((a, b) => (b.size || 0) - (a.size || 0));
    const first = pools[0] && (pools[0].name || `Audience ${pools[0].id}`);
    const audience = first
      ? (pools.length > 1 ? `${first} +${pools.length - 1} more` : first)
      /* Told there is no targeting, versus never having been told. */
      : (days[0].targeting ? 'Broad' : NONE);

    return {
      go: '/campaigns?v=campTabAdsets',
      name: days[0].adset || days[0].adsetId,
      opt: NONE,
      audience,
      placement: NONE,
      sat: '0%',
      satColor: MUTED,
      spend: money(spend),
      ctr: pct(clicks, impressions),
      freq: NONE,
      freqColor: MUTED,
      leads: leads ? count(leads) : NONE,
      bookings: won.length ? String(won.length) : NONE,
      rev: won.length ? money(revenue) : NONE,
      roas: won.length && spend ? ratio(revenue, spend) : NONE,
      roasColor: won.length && spend ? (revenue / spend >= 4 ? UP : WARN) : MUTED,
    };
  });
}

/* Which campaign the drill-down is about.
 *
 * `metricScope` decides the grain every KPI card on that page is evaluated at,
 * and it was a constant in the authored data — `munnar honeymoon jul`, a demo
 * campaign that stopped existing the day the fixture rows stopped replaying.
 * So the page read Spend ₹0 and Impressions 0 over a name from the fixtures,
 * beside CRM revenue that still matched it. Every row opening the same page
 * made it look like the drill-down was broken rather than pointed elsewhere.
 *
 * The name in the URL is the cleaned campaign key the rows are grouped by, so
 * it is the same string on both sides of the link and needs no second lookup.
 */
function selected(byCampaign, params) {
  const keys = Object.keys(byCampaign);
  const asked = typeof params.campaign === 'string' ? params.campaign : null;
  /* Out of range falls back to the first, as the creative overlay does — a
     stale bookmark should open a campaign, not an empty panel. */
  const key = (asked && keys.includes(asked)) ? asked : (keys[0] || null);

  if (!key) {
    /* No campaign to be about. Leaving the authored scope standing would point
       the cards at a demo campaign; removing the scope would print the whole
       workspace's spend on one campaign's page, which is the mistake
       lib/metrics/scope.js exists to prevent. Scoping to nothing is the honest
       third answer: every card declines. */
    return { dName: 'No campaign', metricScope: { dimension: 'campaign', value: '' } };
  }

  return {
    dName: byCampaign[key][0].label || key,
    metricScope: { dimension: 'campaign', value: key },
  };
}

/* ── leads ──────────────────────────────────────────────────────────────── */

/* Not derivable from a CRM lead row: the score and booking probability are
   model outputs (Phase 7), the follow-up and check-in dates are fields the
   fixtures do not carry, and the room is on the booking rather than the lead. */
const LEAD_DECLINED = ['score', 'room', 'prob', 'check', 'followup'];

const STAGE_COLOUR = {
  booked: UP, 'closed-won': UP,
  qualified: 'var(--color-accent-300)', quoted: 'var(--color-accent-300)', negotiation: 'var(--color-accent-300)',
  lost: DOWN, 'closed-lost': DOWN,
};

/* ── Lead Intelligence ────────────────────────────────────────────────────
 *
 * This rendered every lead the store holds — 5,222 rows in a month, 50,682 all
 * time — as one table. Thirteen megabytes of HTML, six and a half seconds
 * before the first byte, and a browser asked to lay out fifty thousand rows
 * nobody scrolls to the end of. It was the single most expensive page in the
 * app and the least usable.
 *
 * Capped, and the cap says what it cut. A list that silently shows the first
 * hundred is worse than one that shows a hundred and says so, because the
 * second can be trusted.
 *
 * Newest first, because "what came in" is the question this screen is opened
 * with. The stage and owner filters above it are the design's and are inert —
 * when they work, this is where the narrowing belongs.
 */
const LEAD_PAGE = 100;

function leads(entities) {
  const platformOf = new Map(entities.campaignDays.map((d) => [d.campaign, PLATFORM[d.platform] || d.platform]));

  /* A lead's `campaign` is the cleaned join key ("munnar honeymoon jul") — the
     right thing to join on and the wrong thing to show someone. The ad
     platform's own label is carried alongside it for exactly this. */
  const labelOf = new Map(entities.campaignDays.map((d) => [d.campaign, d.label]));

  /* A lead's value is its booking's revenue where one exists — a real figure
     from the PMS folio, not an estimate of what the lead might be worth. */
  const bookingByLead = new Map(entities.bookings.filter((b) => b.leadId).map((b) => [b.leadId, b]));

  /* The CRM's deal where the folio has none, which on a workspace with no PMS
     is every one of them. Same fault and same fix as the campaign screen: the
     folio wins where it exists, and discarding the only revenue anybody has for
     being second-best left a Value column of dashes. */
  const dealByLead = new Map();
  for (const deal of entities.deals || []) {
    if (!deal.leadId || !deal.revenue) continue;
    if (/cancel/i.test(String(deal.bookingStatus || ''))) continue;
    dealByLead.set(String(deal.leadId), deal);
  }

  const ordered = [...entities.leads].sort(
    (x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''))
  );

  const leadRows = ordered.slice(0, LEAD_PAGE).map((lead) => {
    const booking = bookingByLead.get(lead.id);
    const deal = dealByLead.get(String(lead.id));
    const stage = lead.stage || NONE;

    return {
      go: '/leads?v=leadProfile',
      name: lead.name || NONE,
      phone: lead.phone || NONE,
      property: lead.property || NONE,
      campaign: (lead.campaign && (labelOf.get(lead.campaign) || lead.campaign)) || NONE,
      platform: (lead.campaign && platformOf.get(lead.campaign)) || NONE,
      /* The address the CRM records where there is no name — see personName. */
      owner: lead.owner ? personName(lead.owner) : NONE,
      stage,
      stageColor: STAGE_COLOUR[String(stage).toLowerCase()] || NA,
      value: booking ? money(value(booking.revenue)) : (deal ? money(deal.revenue) : NONE),
      scoreColor: NA,
      checkColor: NA,
      fuColor: MUTED,
      ...declined(LEAD_DECLINED),
    };
  });

  return {
    leadRows,
    /* What the table is a page of. The heading said "1,847 leads · every lead
       carries full campaign attribution" on every workspace and every range,
       and both halves were untrue here: there are 5,222, and 3,700 of them
       carry no channel at all. */
    leadCount: count(entities.leads.length),
    leadNote: entities.leads.length > LEAD_PAGE
      ? `${count(entities.leads.length)} leads in range · newest ${LEAD_PAGE} shown`
      : `${count(entities.leads.length)} lead${entities.leads.length === 1 ? '' : 's'} in range`,
    /* Said plainly, because every attributed figure elsewhere in the app is a
       floor by exactly this much. */
    leadTagged: (() => {
      const tagged = entities.leads.filter((l) => l.channel === 'meta' || l.channel === 'google').length;
      if (!entities.leads.length) return '';
      return `${count(tagged)} carry a paid channel`;
    })(),
  };
}

/* ── coverage ───────────────────────────────────────────────────────────── */

/* What a screen actually got. Counting `—` rather than trusting the projection
   to describe itself: the report is derived from the rows that were really
   produced, so it cannot drift from them. */
function coverage(payload) {
  const report = [];
  for (const [name, rows] of Object.entries(payload)) {
    if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object') continue;
    const fields = Object.keys(rows[0]).filter((f) => f !== 'go');
    const blank = fields.filter((f) => rows.every((r) => r[f] === NONE));
    report.push({ collection: name, rows: rows.length, fields: fields.length, declined: blank });
  }
  return report;
}

/* creatives — the Creative Intelligence screen, from Meta's ads.
 *
 * The authored version of this screen shows nineteen fields per row. Meta's
 * ad-level insights support seven of them honestly, and the other twelve are
 * declined rather than filled — `derive or decline, never borrow`, as
 * everywhere else in this driver. Which twelve, and why, is worth writing down
 * so nobody re-derives the answer by guessing:
 *
 *   hookRate, dur       video metrics — `video_p25_watched_actions` and friends
 *                       are not requested, and are meaningless for image ads
 *   hook                a human description of the opening seconds; nothing
 *                       reports it
 *   type, icon, grad    the creative's format, which needs the creative object
 *                       fetched by id — the ads edge answers `creative` with an
 *                       id alone
 *   bookings, rev, roas revenue attributed to an ad, which needs identity
 *                       resolution down to ad level joined to PMS bookings.
 *                       The rung exists; the PMS is still on fixtures, so
 *                       joining real ads to fixture bookings would invent a
 *                       return that nobody earned
 *
 * `fatigue` and `winning` were on that list too, as "scores this product does
 * not compute". Both are computed now, from what Meta does report: fatigue from
 * a creative's own daily history (lib/creative-fatigue.js), and the bar that
 * said "winning score" from hold rate, which is a real measure rather than an
 * invented one. Neither is a vendor metric, and both say so on the screen — a
 * score whose definition is not on the page next to it is a number that gets
 * quoted in a meeting and then acted on.
 *
 * A creative that has never been measured reports `—` for spend and CTR rather
 * than ₹0 and 0%, because an ad with no insight rows has no measurement — it
 * did not spend nothing.
 */
/* What the screen can be ranked by, and how. The design drew a "Sort: Revenue"
   control with nothing behind it — no handler, no parameter — so it has never
   sorted anything. Revenue is not among these because revenue is not a column
   this screen can fill.

   Every comparator puts *unknown last*, whichever direction it sorts: a
   creative with no CPL is not the cheapest one. */
const STAGES = new Set(['TOFU', 'MOFU', 'BOFU', 'UNKNOWN']);

const SORTS = {
  /* The default, and the only ranking that answers "what should I do first".
   *
   * It compares *verdicts* rather than a column, so it takes the judged wrapper
   * instead of the entity — most urgent action first, then cheapest lead within
   * an action. Everything to stop, then everything to replace, then what is
   * worth more budget: the order you would work down on a Monday.
   *
   * A `comparator` rather than a `by`, because no single number on a creative
   * expresses it and inventing one — a 0–100 "winning score" — is exactly the
   * thing this screen was carrying before, with nothing behind it. */
  best: {
    label: 'Best Overall',
    /* **The weighted business score, highest first.**
     *
     * This ranked by the recommendation — everything to stop, then everything to
     * replace — which is a to-do list rather than a ranking, and a to-do list
     * cannot answer "which creative is worth the most". Worse, it put a
     * creative with a cheap lead and no bookings above one returning four times
     * the revenue, which is precisely the failure the score exists to fix.
     *
     * The recommendation is still on every card; it is a label, not an order.
     * Ties fall through to the ranking's own spend tiebreak below. */
    comparator: (a, b) => compare(a.assessed.score, b.assessed.score, -1),
  },
  /* One ranking per goal, so the measure the business buys against can be
     ranked directly and not only used to decide the verdict. A cost goal ranks
     cheapest first, a value goal ranks highest first — the goal says which. */
  goal: {
    label: 'Goal',
    comparator: (a, b) => compare(a.goalValue, b.goalValue, a.goalDirection === 'value' ? -1 : 1),
  },
  /* The two outcome rankings. Both read the judged wrapper rather than the
     entity, because both come from the CRM join rather than from anything
     Meta reports — see lib/creative-goals.js adOfLead.
   *
   * They are deliberately a pair. ROAS alone puts a creative returning 6x on
   * ₹400 above one returning 3x on ₹80,000, which is arithmetic rather than
   * advice; reservation value alone ranks the biggest budget first whatever
   * it earned. A reader who has both can see which creatives are in neither
   * list, and those are the ones worth an afternoon.
   *
   * A creative with no CRM match sorts last rather than first — `compare`
   * puts nulls at the end whichever direction is asked for, so an unmatched
   * creative never leads a ranking it could not be measured for. */
  roas: {
    label: 'ROAS',
    comparator: (a, b) => compare(a.assessed.metrics.roas, b.assessed.metrics.roas, -1),
  },
  revenue: {
    label: 'Reservation value',
    comparator: (a, b) => compare(a.assessed.metrics.revenue, b.assessed.metrics.revenue, -1),
  },
  spend: { label: 'Spend', by: (c) => c.spend, dir: -1 },
  /* Groups the screen by what each creative was bought to do, top of funnel
     first. Ranking by the stage *name* would sort Bottom before Top, which is
     the funnel upside down, so it ranks by position — see `rank` in
     lib/creative-funnel.js. Creatives sharing a stage fall back to spend,
     which is the tiebreak every ranking here uses. */
  funnel: { label: 'Funnel', by: (c) => funnels.rank(c.funnel), dir: 1 },
  cpl: { label: 'CPL', by: (c) => (c.leads > 0 && c.spend !== null ? c.spend / c.leads : null), dir: 1 },
  cpc: { label: 'CPC', by: (c) => (c.clicks > 0 && c.spend !== null ? c.spend / c.clicks : null), dir: 1 },
  ctr: { label: 'CTR', by: (c) => (c.impressions ? c.clicks / c.impressions : null), dir: -1 },
  cpm: { label: 'CPM', by: (c) => c.cpm, dir: 1 },
  frequency: { label: 'Frequency', by: (c) => c.frequency, dir: -1 },
  hold: { label: 'Hold rate', by: (c) => fatigue.holdRate(c), dir: -1 },
  fatigue: { label: 'Fatigue', by: (c) => { const w = fatigue.score(c.series); return w ? w.score : null; }, dir: -1 },
};

const SORT_ORDER = Object.keys(SORTS);

/* The three views the design draws in its segmented control.
 *
 * **They re-rank; they do not re-draw.** The design gives Leaderboard and
 * Timeline a label each and no markup — one card grid is all it defines — so
 * building them as a table and a Gantt would mean inventing two layouts and
 * writing them into `views/screens/`, which the converter owns. The same
 * reasoning already keeps presentation mode from stepping through five slides
 * that were never drawn (public/assets/app-ui.js).
 *
 * What a view *can* honestly change is the order the cards come in and what the
 * card says about itself, so that is what each one does:
 *
 *   Gallery      the sort control decides
 *   Leaderboard  the same ranking, with positions on the cards
 *   Timeline     newest first — a timeline is chronological by definition, so
 *                this is the one view the sort control does not drive — and
 *                each card says the window it ran over instead of its hook and
 *                hold rates
 *
 * **One ranking control, not two.** The leaderboard used to rank by its own
 * fixed rule, which meant choosing a ranking from the sort menu did nothing
 * visible in the view the screen opens on — a control that appears broken. The
 * "action first, then cheapest lead" ordering it used is now `sort=best`, the
 * default, available in every view. The leaderboard's own contribution is the
 * numbering.
 */
const VIEWS = {
  gallery: { label: 'Gallery', chronological: false },
  leaderboard: { label: 'Leaderboard', chronological: false },
  timeline: { label: 'Timeline', chronological: true },
};

const VIEW_ORDER = Object.keys(VIEWS);

/* Meta reports a date per insight row, so the run window is the series' own
   ends. `days` counts rows, which is not the same thing — an ad paused for a
   fortnight and restarted ran over 30 days on 16 of them, and the timeline is
   about the span. */
function window_(series = []) {
  const dates = (series || []).map((d) => d.date).filter(Boolean).sort();
  return dates.length ? { first: dates[0], last: dates[dates.length - 1], days: dates.length } : null;
}

/* An ISO date as a sortable number, so one comparator serves every ranking. */
const asNumber = (iso) => (iso ? Number(String(iso).replace(/-/g, '')) : null);

/* Unknown always sinks, whichever way the column sorts — a creative with no
   cost per lead is not the cheapest one on the screen. */
function compare(x, y, dir) {
  const xn = x === null || x === undefined || Number.isNaN(x);
  const yn = y === null || y === undefined || Number.isNaN(y);
  if (xn && yn) return 0;
  if (xn) return 1;
  if (yn) return -1;
  return (x - y) * dir;
}

/* "14 Jul" — the year is noise on a screen showing one quarter. */
const DAY = { day: 'numeric', month: 'short' };
const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { ...DAY, timeZone: 'UTC' });
};

function creatives(entities, params = {}) {
  const all = entities.creatives || [];
  const measured = measuredCreatives(entities);

  const key = SORTS[params.sort] ? params.sort : 'best';
  /* **Leaderboard opens the screen**, not Gallery. The question a reader brings
     to Creative Intelligence is which creative needs them today, and the
     leaderboard answers it in its first row — most urgent action first, then
     cheapest lead. Gallery ranks by whatever the sort control last said, which
     is a fine second view and a poor first one. */
  const view = VIEWS[params.view] ? params.view : 'leaderboard';
  const { by, dir, comparator } = SORTS[key];

  /* Every creative is judged before any one of them is shaped, because the
     benchmark a verdict weighs cost against is the *set's* own median. A
     per-card verdict computed in isolation would have nothing to compare
     against and would quietly collapse into a fatigue score wearing the word
     "stop" — see lib/creative-verdict.js. */
  /* The funnel stage is resolved once, here, and carried on a copy rather than
     written onto the entity — the entities are shared across requests through
     `require`, and a projection that mutated them would leak one screen's
     derived fields into every other. Resolving it before the sort is what lets
     the screen be *ranked* by it. */
  const audiences = entities.audiences || {};
  const goalKey = goals.resolve(params.goal);
  const goal = goals.GOALS[goalKey];
  const goalCtx = goals.context(entities);
  /* Worked out once for the screen: an objective every creative shares tells
     the funnel nothing, so it stops being a signal — see stageFor. */
  /* `measuredCreatives` already falls back to the whole set when nothing was
     measured, so the old `measured.length ? measured : all` here was the same
     decision made twice. */
  const varies = funnels.objectiveVaries(measured);
  const pool = measured
    .map((c) => ({ ...c, funnel: funnels.stageFor(c, audiences, { objectiveVaries: varies }) }));

  /* **Scored over the whole set at once**, because every component of Best
     Overall is a comparison against the other creatives on the screen — a cost
     per interested lead means nothing until there is something to compare it
     with. The result is keyed onto the goal context so the composite goal can
     read it back without scoring a second time. */
  const scored = scoring.score(pool, goalCtx);
  goalCtx.scored = new Map(scored.map((s) => [String(s.creative.adId), s]));

  /* **Which way each creative is going**, last seven days against the seven
     before. A lifetime average goes on looking fine for a fortnight after a
     creative starts collapsing, and by the time it moves the money is spent. */
  /* Both maps come from the one resolver, so this screen and the score behind
     it cannot disagree about which creative a lead belongs to — and so a lead
     the CRM identified only by ad name counts here too. See
     lib/creative-goals.js adOfLead. */
  const adOfLead = goals.adOfLead(entities);
  const leadsByAd = new Map();
  for (const lead of entities.leads || []) {
    const ad = adOfLead.get(String(lead.id));
    if (!ad) continue;
    if (!leadsByAd.has(ad)) leadsByAd.set(ad, []);
    leadsByAd.get(ad).push(lead);
  }
  const bookingsByAd = new Map();
  for (const booking of entities.bookings || []) {
    const ad = booking.leadId && adOfLead.get(String(booking.leadId));
    if (!ad) continue;
    if (!bookingsByAd.has(ad)) bookingsByAd.set(ad, []);
    bookingsByAd.get(ad).push(booking);
  }

  /* The CRM's reservations where the folio has none — the same fault, and the
   * same fix, as the campaign screen. This map drives creative *movement*
   * (`trend`) and every booking-shaped goal, so with no PMS every creative was
   * judged as though it had produced nothing, and a creative that sells is
   * indistinguishable from one that does not.
   *
   * A deal is aliased onto `checkIn` because that is the field the trend
   * windows on. It is not a stay date and does not pretend to be one: it is
   * when the deal last moved, which is the closest thing the CRM has to "this
   * reservation happened" and is exactly what `period.FIELD` already dates a
   * deal by. Naming it here rather than quietly reusing the key, because a
   * booking's checkIn and a deal's updatedAt answer different questions and
   * only one of them is available. */
  if (!bookingsByAd.size) {
    for (const deal of entities.deals || []) {
      if (deal.outcome !== 'won' || /cancel/i.test(String(deal.bookingStatus || ''))) continue;
      const ad = deal.leadId && adOfLead.get(String(deal.leadId));
      if (!ad) continue;
      if (!bookingsByAd.has(ad)) bookingsByAd.set(ad, []);
      bookingsByAd.get(ad).push({ ...deal, checkIn: deal.updatedAt });
    }
  }

  const movementOf = new Map(pool.map((c) => [String(c.adId), trends.trend(c, {
    leads: leadsByAd.get(String(c.adId)) || [],
    bookings: bookingsByAd.get(String(c.adId)) || [],
    isInterested: scoring.isInterested,
    money,
  })]));
  const judged = pool.map((c, i) => {
    const assessed = scored[i];
    const worn = assessed.metrics.worn;
    const spent = c.spend === null || c.spend === undefined ? null : c.spend;
    /* Whatever the business is buying against, alongside the count behind it —
       three bookings and three leads are both "enough to be a rate", and the
       goal says which it needs. */
    const measured = goal.of(c, goalCtx);
    return {
      c,
      worn,
      ran: window_(c.series),
      leads: c.leads || 0,
      cpl: (c.leads > 0 && spent !== null) ? spent / c.leads : null,
      goalValue: measured.value,
      goalDirection: goal.direction,
      events: measured.events,
      assessed,
    };
  });

  /* The recommendation reads the business score, not the goal in force: a
     reader switching the ranking to CTR has not changed what the creative is
     worth to the resort. */
  judged.forEach((j) => {
    j.movement = movementOf.get(String(j.c.adId));
    j.call = scoring.recommend(j.assessed, j.movement);
    j.stage = scoring.lifecycle(j.assessed, j.call, j.movement);
  });

  /* The chosen ranking, with spend breaking every tie. Without the tiebreak a
     ranking with few distinct values — funnel has three, `best` has five —
     leaves the rest of the screen in whatever order the entities happened to
     arrive in, which changes under the reader for no reason they can see. */
  const ranking = (a, b) => (
    (comparator ? comparator(a, b) : compare(by(a.c), by(b.c), dir))
    || compare(a.c.spend, b.c.spend, -1)
  );

  /* Newest first: the question a timeline answers is what changed lately, and
     no ranking the sort control offers answers it. */
  const chronological = (a, b) => (
    compare(asNumber(a.ran && a.ran.first), asNumber(b.ran && b.ran.first), -1)
    || compare(asNumber(a.ran && a.ran.last), asNumber(b.ran && b.ran.last), -1)
  );

  /* Narrowed to one funnel stage when the Best-TOFU/MOFU/BOFU tiles ask for it.
   *
   * Applied **after** scoring, not before, and that ordering matters: a
   * creative is scored against the cohort at its own stage, so the figure a
   * card shows is identical whether or not the grid is narrowed. Filtering
   * first would have rebuilt the cohort from the filtered set — the same
   * numbers by luck for a single stage, and quietly different the moment the
   * filter meant anything else.
   *
   * UNKNOWN is reachable by name rather than swept in with the rest: a creative
   * whose stage could not be read is not TOFU, and hiding it entirely would
   * lose spend from a screen whose whole job is to account for it. */
  const stageAsked = typeof params.stage === 'string' ? params.stage.toUpperCase() : null;
  const inStage = STAGES.has(stageAsked)
    ? judged.filter((j) => j.assessed.stage === stageAsked)
    : judged;

  /* And by recommendation, from the census line above the grid. Same reasoning
     as the stage filter: the verdict is already computed per creative, so
     narrowing to one action changes which cards are shown and none of their
     figures. The two compose — Best TOFU and then PAUSE RECOMMENDED is a
     reasonable thing to ask, and neither filter knows about the other. */
  const actionAsked = typeof params.action === 'string' ? params.action.toLowerCase() : null;
  const inAction = actionAsked && scoring.ACTIONS[actionAsked]
    ? inStage.filter((j) => j.call.action === actionAsked)
    : inStage;

  const ranked = inAction.sort(VIEWS[view].chronological ? chronological : ranking);
  const rows = ranked.map((j) => j.c);

  /* Keyed by the collection name the data module uses, because the driver
     spreads this over the screen's payload — returning a bare array would
     scatter it across the payload as numbered keys and leave the screen
     rendering its authored rows, silently. */
  /* The control cycles rather than opening a menu: the design draws no menu,
     and inventing one would mean writing markup into a generated view. */
  const nextSort = SORT_ORDER[(SORT_ORDER.indexOf(key) + 1) % SORT_ORDER.length];

  return {
    sortLabel: key === 'goal' ? goal.label : SORTS[key].label,
    /* Kept, and now the fallback rather than the whole control: without
       JavaScript the caret still cycles to the next ranking, which is worse
       than a menu and much better than a dead control. */
    sortNext: `/creatives?view=${view}&sort=${nextSort}`,
    /* Every ranking at once, for the menu the control opens. The design draws a
       caret and no menu, so the markup for one cannot come from the converter —
       it is built at runtime from this, the same way the filter chips build
       theirs. See enhanceSort() in public/assets/app-ui.js. */
    sortOptions: SORT_ORDER.map((name) => ({
      key: name,
      label: SORTS[name].label,
      go: `/creatives?view=${view}&sort=${name}&goal=${goalKey}`,
      active: name === key,
    })),
    /* **What "best" means, per business.** A resort selling rooms is not judged
       the way a lead-gen account is, and this account buys against *qualified*
       lead CPL rather than the platform-reported kind. The goal decides both
       the ranking and what the verdict weighs — see lib/creative-goals.js. */
    goalLabel: goal.label,
    /* The no-JavaScript fallback, and — because the enhancer finds its controls
       among the elements carrying one — the thing that makes the control
       reachable at all. Without it the caret opened nothing. */
    goalNext: `/creatives?view=${view}&sort=${key}&goal=${goals.ORDER[(goals.ORDER.indexOf(goalKey) + 1) % goals.ORDER.length]}`,
    goalOptions: goals.ORDER.map((name) => ({
      key: name,
      label: goals.GOALS[name].label,
      go: `/creatives?view=${view}&sort=${key}&goal=${name}`,
      active: name === goalKey,
    })),
    /* Named rather than dashed. A goal whose sources nobody has connected shows
       an empty column under a control that appears to work, and a reader cannot
       tell that from an account that earned nothing — which is the failure this
       screen has had to undo more than once. */
    goalNote: goals.unavailable(goal, goalCtx) || '',
    /* The segmented control the design draws as three inert spans. Each tab
       holds the current ranking, so switching view does not silently reset it. */
    viewTabs: VIEW_ORDER.map((name) => ({
      label: VIEWS[name].label,
      go: `/creatives?view=${name}&sort=${key}`,
      ...seg(name === view),
      title: VIEWS[name].chronological
        ? 'Most recently started first'
        : `Ranked by ${SORTS[key].label.toLowerCase()}${name === 'leaderboard' ? ', numbered' : ''}`,
    })),
    /* The line under the heading said "24 active creatives · sorted by revenue"
       on every screen, whatever was on it and however it was ranked. */
    creativeSummary: `${rows.length} creative${rows.length === 1 ? '' : 's'} · ${VIEWS[view].label}, ${
      VIEWS[view].chronological
        ? 'most recently started first'
        : `ranked by ${SORTS[key].label.toLowerCase()}${key === 'best' ? ' — what to act on first' : ''}`
    }`,
    /* The scores on the cards, defined where they are read rather than in a
       document nobody opens. */
    fatigueLegend: fatigue.summary(),
    /* Best overall, and the best at each stage — a media buyer plans a week
       around the second question as much as the first. */
    /* **The executive summary**, entirely counted from the rows on screen. Every
       figure here is a tally of real recommendations — there is no separate
       analysis that could disagree with the cards below it. */
    creativeCensus: (() => {
      const tally = {};
      for (const j of judged) tally[j.call.action] = (tally[j.call.action] || 0) + 1;
      const order = ['scale', 'continue', 'watch', 'reduce', 'retest', 'pause', 'insufficient'];
      return order
        .filter((a) => tally[a])
        .map((a) => ({
          action: a,
          marker: scoring.ACTIONS[a].marker,
          label: scoring.ACTIONS[a].label,
          count: String(tally[a]),
          /* Clickable, so the census reads as a control rather than a caption.
           *
           * There were two `go` keys here and the second won — a template that
           * had lost its expressions, so every chip linked to
           * `/creatives?view=&sort=&goal=&action=` and the filter it was
           * pointing at never ran. Clicking SCALE showed all 212 creatives,
           * which is exactly what a caption does.
           *
           * Carries the view, the sort, the goal and the stage through, so
           * clicking a count narrows the board without resetting everything
           * else the reader had chosen. */
          go: `/creatives?view=${view}&sort=${key}&goal=${goalKey}`
            + (actionAsked === a ? '' : `&action=${a}`)
            + (STAGES.has(stageAsked) ? `&stage=${stageAsked}` : ''),
          /* Clicking the one already in force clears it, which is the only
             affordance a filter made of chips can offer without a second
             control saying "all". */
          active: actionAsked === a,
          title: actionAsked === a
            ? `Showing only the ${tally[a]} creative${tally[a] === 1 ? '' : 's'} recommended for ${scoring.ACTIONS[a].label.toLowerCase()} — click again to show every creative`
            : `Show only the ${tally[a]} creative${tally[a] === 1 ? '' : 's'} recommended for ${scoring.ACTIONS[a].label.toLowerCase()}`,
          /* The chip in force has to look different from the six beside it, or
             a reader who has narrowed the board cannot tell that they have.
             Computed here rather than as a ternary in the template: the view
             is generated, and an expression in it has to survive a re-run. */
          bg: actionAsked === a ? 'var(--color-neutral-900)' : 'transparent',
          border: actionAsked === a ? scoring.ACTIONS[a].color : 'transparent',
          color: scoring.ACTIONS[a].color,
        }));
    })(),
    /* The three sentences a reader wants before they read anything else. Each
       is derived or omitted — a summary that pads itself out with a generic
       observation is a summary nobody trusts twice. */
    creativeNotes: (() => {
      const notes = [];
      const scoredRows = judged.filter((j) => j.assessed.score !== null);
      if (!scoredRows.length) return notes;

      const fatiguing = judged.filter((j) => j.movement.key === 'fatiguing' || j.movement.key === 'declining');
      const spendAtRisk = judged
        .filter((j) => j.call.action === 'pause' || j.call.action === 'reduce')
        .reduce((t, j) => t + (j.c.spend || 0), 0);

      const byStage = {};
      for (const j of scoredRows) {
        const st = j.assessed.stage;
        (byStage[st] = byStage[st] || []).push(j.assessed.score);
      }
      const averages = Object.entries(byStage)
        .filter(([, v]) => v.length >= 2)
        .map(([st, v]) => ({ stage: st, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
        .sort((a, b) => b.avg - a.avg);

      if (averages.length >= 2) {
        const top = averages[0];
        const bottom = averages[averages.length - 1];
        notes.push({
          heading: 'Biggest opportunity',
          text: `${top.stage} creatives average ${Math.round(top.avg)}/100 across ${top.n} of them — the strongest stage on the account.`,
        });
        notes.push({
          heading: 'Biggest problem',
          text: `${bottom.stage} creatives average ${Math.round(bottom.avg)}/100 across ${bottom.n} — the weakest stage, and where a new creative would earn the most.`,
        });
      }

      if (spendAtRisk > 0) {
        notes.push({
          heading: 'Spend under review',
          text: `${money(spendAtRisk)} sits behind creatives recommended for reduction or pausing. Recommendations only — nothing is changed in Meta by this screen.`,
        });
      }

      if (fatiguing.length) {
        notes.push({
          heading: 'Trend alert',
          text: `${fatiguing.length} creative${fatiguing.length === 1 ? ' is' : 's are'} declining or fatiguing week on week.`,
        });
      }

      return notes;
    })(),
    /* The best creative at each stage. A media buyer plans a week around
       "which is my best BOFU creative" as much as around the overall winner,
       so both are asked.

       The hover says how the stage was decided — it is read from the ad set,
       not declared — because a tile that names a winner per stage is only as
       good as the classification underneath it. */
    bestByStage: scoring.bestByStage(scored).map(({ stage, row }) => ({
      stage,
      marker: { TOFU: '🔵', MOFU: '🟣', BOFU: '🟠', UNKNOWN: '⚪' }[stage],
      label: stage === 'UNKNOWN' ? 'Unclassified' : stage,
      title: row.creative.title || row.creative.adId,
      score: String(row.score),
      why: `${funnels.meaning(row.creative.funnel)} Best of the ${scored.filter((r) => r.stage === stage && r.score !== null).length} creative(s) scored at this stage.`,
      go: `/creatives?view=${view}&sort=${key}&goal=${goalKey}&stage=${stage}`,
    })),
    verdictLegend: `Action — what to do about the creative, from its fatigue and its cost per lead against the account median (${verdicts.MIN_LEADS}+ leads to be judged on cost).`,
    creatives: ranked.map(({ c, worn, ran, call, assessed, movement, stage: life }, index) => {
    const m = assessed.metrics;
    /* A rate is a fraction here and a percentage only on the way to the screen. */
    const asPct = (v, dp = 1) => (v === null || v === undefined ? NONE : `${(v * 100).toFixed(dp)}%`);
    const asRatio = (v) => (v === null || v === undefined ? NONE : `${v.toFixed(1)}x`);
    const format = FORMAT[c.objectType] || { type: c.objectType || NONE, icon: 'ph-fill ph-image-square' };

    /* The card's image is delivered through the `grad` field the design already
       binds — `background:<%= cr.grad %>` — so the creative shows without
       touching views/screens/, which the converter owns and a re-run would
       overwrite. The gradient stays underneath as the fallback: if the proxy
       404s on an expired signature, the card degrades to how it looked before
       rather than to a broken-image icon. */
    /* `backdrop` on the entity is the authored driver's way of keeping the
       design's six distinct gradients — a real Meta ad has a thumbnail and does
       not need one. */
    const fallback = c.backdrop || 'linear-gradient(135deg,#2b2741,#5d5294)';
    const backdrop = c.thumbnailUrl
      ? `url('/creatives/${encodeURIComponent(c.adId)}/thumbnail?v=${token(c.thumbnailUrl)}') center/cover no-repeat, ${fallback}`
      : fallback;

    return {
    /* Each card names *itself*. This was hardcoded to cr=1, so every creative
       on the screen opened the first one's panel — the card you clicked and the
       detail you got were unrelated. The index is 1-based to match the design's
       own `?cr=` convention. */
    /* The selection carries the sort *and the view*, or clicking a card under
       one ranking would open whatever sat at that position under another. */
    go: `/creatives?view=${view}&sort=${key}&cr=${index + 1}`,
    /* Not rendered — the drawer matches on it. Matching on the title broke the
       moment the leaderboard started prefixing a rank to it. */
    adId: c.adId,
    /* Empty when there is no video behind the still — an image ad is not a
       video that failed to load, and the view renders nothing rather than a
       player with no source. */
    video: c.videoId ? `/creatives/${encodeURIComponent(c.adId)}/video` : '',
    /* The ad as a guest saw it. Unlike the video route this works on a token
       scoped to `ads_read`, so it is what the drawer actually shows. */
    preview: `/creatives/${encodeURIComponent(c.adId)}/preview`,
    poster: c.thumbnailUrl ? `/creatives/${encodeURIComponent(c.adId)}/thumbnail?v=${token(c.thumbnailUrl)}` : '',
    title: c.title || c.adId,
    /* Leaderboard numbers its rows; the other two views leave this empty and
       the badge does not render.

       Its own field rather than a prefix on the title, which is what this was
       first: a title carrying "3. " is a title that has to be stripped again
       by every reader of it — the drawer had to, and every test that asserted
       on a name had to as well. Position is presentation, and it lives in a
       presentation field. */
    rank: view === 'leaderboard' ? String(index + 1) : '',
    type: format.type,
    icon: format.icon,
    grad: backdrop,
    /* The badge under the format carried a video duration, which is not among
       the fields fetched. It now says which part of the funnel the creative is
       working in — read from the campaign's objective, so it is what was
       bought rather than what was inferred. */
    /* TOFU / MOFU / BOFU — what a media buyer calls the stage, and what the
       scoring model is selected by. */
    dur: assessed.stage === 'UNKNOWN' ? NONE : assessed.stage,
    /* Why that matters, on hover: a Top-of-funnel creative that books nothing
       is not underperforming, it is doing what was bought. */
    durWhy: `${funnels.meaning(c.funnel)} Scored on the ${assessed.stage} model: ${Object.entries(assessed.weights).map(([k, w]) => `${k} ${Math.round(w * 100)}%`).join(', ')}.${assessed.cohortWide ? ' Compared against the whole account — no other creative sits at this stage.' : ` Compared against the ${assessed.cohortSize} creatives at this stage.`}`,
    platform: PLATFORM[c.platform] || 'Meta',
    /* The design's `hook` is a line of prose under the title. It carries the
       two video rates, because the card has no cell left for them and this is
       where a reader looks for how the creative opens and whether it holds.
       An image ad says so rather than showing 0% twice — it did not fail to
       hold attention, it has no video to hold it with.
       On the timeline the same line carries the run window instead, which is
       the only thing that view is read for. */
    hook: (() => {
      if (view === 'timeline') {
        return ran
          ? `Ran ${shortDate(ran.first)} – ${shortDate(ran.last)} · ${ran.days} day${ran.days === 1 ? '' : 's'} measured`
          : 'No measured days';
      }
      const h = fatigue.hookRate(c);
      const hold = fatigue.holdRate(c);
      if (h === null && hold === null) return NONE;
      const parts = [];
      if (h !== null) parts.push(`${(h * 100).toFixed(1)}% hook`);
      if (hold !== null) parts.push(`${(hold * 100).toFixed(1)}% hold`);
      return parts.join(' · ');
    })(),
    hookRate: fatigue.hookRate(c) === null ? NONE : `${(fatigue.hookRate(c) * 100).toFixed(1)}%`,
    /* Cost per lead, from Meta's own ad-level lead actions.
       Three outcomes, kept apart: no lead count reported at all is unknown;
       spend with zero leads is not a cost per lead but a cost per nothing, and
       dividing would give Infinity dressed as a number; otherwise the real
       figure. */
    cpl: m.cpl === null ? NONE : money(m.cpl),
    ctr: m.ctr === null ? NONE : asPct(m.ctr, 2),
    /* The cell the design labelled SPEND now carries the measure the whole
       score turns on. Spend has not gone anywhere — it rides on the score row
       below, where it belongs beside the money-at-stake tiebreak. */
    spend: m.cpil === null ? NONE : money(m.cpil),
    spendTotal: c.spend === null ? NONE : money(c.spend),
    /* Three cells that could never be filled from Meta — bookings, revenue and
       net ROAS all need PMS and CRM data that is still fixtures — now carry
       three that can. Their labels are re-bound to match; a cell showing CPM
       under a heading that says BOOKINGS would be worse than the dash it
       replaced. */
    /* Sorting by a number the card does not show is half a control. */
    resValue: m.revenue === null || m.revenue === undefined ? NONE : money(m.revenue),
    /* Counts, because that is what somebody asks a creative for: how many
       people it made interested and how many rooms it filled. The rates the
       score is actually computed from ride on the hover of each — a rate is
       the fair comparison between two creatives of different sizes, and a
       count is the thing that happened. Both, in the space of one cell. */
    intLeads: m.interested === null || m.interested === undefined ? NONE : String(m.interested),
    intLeadsWhy: m.interested === null || m.interested === undefined
      ? 'No CRM data behind this creative, so how many of its leads were interested is unknown.'
      : `${m.interested} of ${m.leads} lead${m.leads === 1 ? '' : 's'} reached an interested stage${m.interestedRate === null ? '' : ` — ${asPct(m.interestedRate)} interested rate`}. The rate is what the score compares; the count is what happened.`,
    reservations: m.bookings === null || m.bookings === undefined ? NONE : String(m.bookings),
    reservationsWhy: m.bookings === null || m.bookings === undefined
      ? 'Reservations come from CRM deals won against this creative’s leads. None recorded in this range.'
      : `${m.bookings} reservation${m.bookings === 1 ? '' : 's'} from ${m.leads} lead${m.leads === 1 ? '' : 's'}${m.bookingRate === null ? '' : ` — ${asPct(m.bookingRate)} of them booked`}${m.costPerBooking === null ? '' : `, at ${money(m.costPerBooking)} each`}. A resort books slowly: a reservation can close weeks after the click that produced it, so a recent creative reads low here before it reads true.`,
    /* Kept as the rates behind the two counts above, and as what the score is
       computed from. */
    bookings: asPct(m.interestedRate),
    rev: asPct(m.bookingRate),
    roas: asRatio(m.roas),
    roasColor: m.roas === null ? 'var(--color-neutral-300)' : (m.roas >= 3 ? UP : (m.roas >= 1 ? WARN : DOWN)),
    /* The remaining platform metrics keep a home in the tooltip rather than
       being dropped: they are still how a media buyer reads delivery. */
    deliveryWhy: [
      c.cpm === null || c.cpm === undefined ? null : `CPM ${rupees(c.cpm)}`,
      c.frequency === null || c.frequency === undefined ? null : `frequency ${c.frequency.toFixed(1)}×`,
      (c.spend === null || !c.clicks) ? null : `CPC ${rupees(c.spend / 100 / c.clicks)}`,
      c.leads ? `${c.leads} lead${c.leads === 1 ? '' : 's'}` : null,
      m.interested === null ? null : `${m.interested} interested`,
      m.bookings === null ? null : `${m.bookings} booking${m.bookings === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ') || 'Nothing measured yet',
    /* Unknown is never healthy: too little history renders "—" in a neutral
       colour rather than a reassuring green zero. */
    fatigue: worn ? String(worn.score) : NONE,
    /* The number alone was the complaint: 42 out of what, meaning what. The
       band's name travels with it on the badge, and the full definition — what
       the score reads, over what window, against what — is the tooltip. */
    fatigueBand: worn ? worn.label : 'No reading',
    fatigueWhy: fatigue.explain(worn),
    /* Opaque even when unknown: the dash sits on the creative too, and a
       transparent badge over a photo is not a badge. */
    fatigueBg: worn ? worn.bg : 'rgba(20,22,31,.86)',
    fatigueColor: worn ? worn.color : 'var(--signal-none)',
    /* The bar was a "winning score" nothing computes. It now shows hold rate —
       the share of plays watched to the end — which is a real measure of
       whether a creative earns attention. A width needs a percentage, so an
       image ad renders 0 width with the label declining beside it. */
    /* The bar is the Best Overall score. It was hold rate, and before that a
       "winning score" nothing computed — this is the first thing it has shown
       that answers the question the screen is opened to ask. */
    winning: assessed.score === null ? '0%' : `${assessed.score}%`,
    bestScore: assessed.score === null ? NONE : String(assessed.score),
    confidence: assessed.confidence.label,
    confidenceKey: assessed.confidence.key,
    /* "Strong BOFU performer — 5.2x ROAS + 7.4% booking rate", from the two
       components that actually carried this creative's score. */
    headline: scoring.headline(assessed, money),
    cpb: m.costPerBooking === null ? NONE : money(m.costPerBooking),
    hookPct: m.hookRate === null ? NONE : asPct(m.hookRate),
    holdPct: m.holdRate === null ? NONE : asPct(m.holdRate),
    confidenceColor: assessed.confidence.key === 'high' ? UP
      : assessed.confidence.key === 'moderate' ? 'var(--color-accent-300)'
      : assessed.confidence.key === 'low' ? WARN : 'var(--color-neutral-500)',
    /* Why the score is what it is, component by component, with the weight each
       one carried — a composite nobody can take apart is a composite nobody
       should trust. */
    bestWhy: (() => {
      const parts = Object.values(assessed.parts)
        .map((x) => `${x.label} ${x.points}/100 (${Math.round(x.weight * 100)}%)`)
        .join(' · ');
      const thin = assessed.covered < 1
        ? ` Scored on ${Math.round(assessed.covered * 100)}% of the intended weight — the rest needs the CRM and PMS connected.`
        : '';
      const shrunk = assessed.rawScore !== null && assessed.rawScore !== assessed.score
        ? ` Raw ${assessed.rawScore}, pulled to ${assessed.score} by sample size (${assessed.confidence.leads} leads).`
        : '';
      return `Best Overall ${assessed.score === null ? '—' : assessed.score}/100. ${parts}.${thin}${shrunk}`;
    })(),
    /* The instruction. A fatigue score tells a reader something is wrong and
       leaves them to decide what to do about it, which is the half of the job
       that was missing — see lib/creative-verdict.js. */
    /* Advice, not an action. Nothing here calls Meta or Google to change an ad
       — the card says PAUSE RECOMMENDED and the marketer decides. */
    verdict: `${call.marker} ${call.label}`,
    verdictAction: call.action,
    /* Where the creative is in its life, which is a different question from
       what to do about it. */
    lifecycle: `${life.marker} ${life.label}`,
    trend: `${movement.marker} ${movement.label}`,
    trendKey: movement.key,
    trendColor: movement.color,
    trendWhy: movement.said || 'Not enough history for a week-on-week comparison',
    verdictInstruction: call.instruction,
    verdictWhy: verdicts.sentence(call),
    verdictBecause: call.because.join(' · ') || call.instruction,
    verdictColor: call.color,
    verdictBg: call.bg,
    };
  }) };
}

/* The creative detail overlay — the panel that opens when a card is clicked.
 *
 * It is a *selection*, so it reads `?cr=` from the request and shows that
 * creative. It deliberately re-uses the card projection rather than deriving
 * the same figures a second way: the panel disagreeing with the card it opened
 * from would be worse than either being wrong on its own.
 *
 * Its own fields — thumbStop, watch, quality — are declined. Those are Meta
 * video statistics beyond the two rates fetched, and a "quality grade" that
 * nothing computes.
 */
function overlayCreativeDetail(entities, params = {}) {
  /* Ranked the same way the screen behind it was, so position N is the card
     that was actually clicked. */
  const rows = creatives(entities, params).creatives;
  if (!rows.length) return {};

  /* 1-based, matching the design's convention and what the cards now emit. Out
     of range falls back to the first rather than rendering an empty panel. */
  const index = Math.max(1, Number(params.cr) || 1) - 1;
  const card = rows[index] || rows[0];
  const source = (entities.creatives || []).find((c) => c.adId === card.adId);

  return {
    selCr: {
      title: card.title,
      type: card.type,
      dur: card.dur,
      platform: card.platform,
      campaign: (source && source.campaignId) ? `Campaign ${source.campaignId}` : NONE,
      grad: card.grad,
      video: card.video,
      preview: card.preview,
      poster: card.poster,
      spend: card.spend,
      leads: source && source.leads !== null && source.leads !== undefined ? count(source.leads) : NONE,
      bookings: NONE,
      roas: NONE,
      roasColor: MUTED,
      hook: card.hook,
      /* Meta reports neither a scroll-stop rate nor an average watch time among
         the fields fetched, and "quality" is a grade nothing here computes. */
      thumbStop: NONE,
      watch: NONE,
      hold: (() => {
        const h = fatigue.holdRate(source || {});
        return h === null ? NONE : `${(h * 100).toFixed(1)}%`;
      })(),
      /* The bar the design labels "winning score", carrying what the card's
         does — the panel and the card share one number or they share none. */
      winning: card.winning,
      quality: NONE,
      fatigue: card.fatigue,
      fatigueColor: card.fatigueColor,
      /* The panel is where a reader goes when the card's badge raised a
         question, so it carries the answer rather than the same bare number. */
      fatigueBand: card.fatigueBand,
      fatigueWhy: card.fatigueWhy,
      funnel: card.dur,
      funnelWhy: card.durWhy,
      verdict: card.verdict,
      verdictWhy: card.verdictWhy,
      verdictBecause: card.verdictBecause,
      verdictColor: card.verdictColor,
      verdictBg: card.verdictBg,
      ctr: card.ctr,
      cpl: card.cpl,
    },
  };
}

/* The Marketing Dashboard's funnel.
 *
 * The only part of that screen answered from data so far. It read 48.2L
 * impressions and 2,554 leads under a KPI row saying 23,24,542 impressions —
 * the same page contradicting itself — and it said the same thing with the
 * range set to "today", when the real figure for today is zero.
 *
 * The two ad-side stages are the platforms' own, so they agree with the tiles
 * above. `Leads` is the platform-reported count, kept distinct from the CRM's
 * for the reason `ads.reported_leads` is: the platforms claim more than the CRM
 * records, and the gap is the thing identity resolution exists to measure.
 *
 * `Qualified` declines because nothing defines it — a lead stage is a CRM
 * concept and no registry metric filters by one. `Bookings` declines until a
 * PMS is connected. Neither reads zero: an unconnected source has not reported
 * none, it has reported nothing.
 *
 * The bar widths are the design's own taper and not the literal ratios —
 * clicks over impressions is 1.5%, which as a bar is invisible. Width is
 * presentation here and the figure beside it is the fact.
 */
/* Which CRM status words mean interested. Imported rather than restated: the
   marketing funnel and the dashboard's interested-rate tile disagreeing about
   what "qualified" means, on two screens a click apart, is exactly the drift
   the metric registry exists to prevent. */
const { INTERESTED } = require('../metrics/registry');

const CHANNEL_OF = { meta_ads: 'meta', google_ads: 'google' };

/* One row per ad platform, from the rows themselves.
 *
 * This table was authored — ₹6.42L against ₹19.8L, with a written-out AI
 * recommendation ("Scale — CPL falling with volume holding") beside figures
 * nobody measured. It sat under a heading that said "CRM-attributed · last 30
 * days" and was the most confident-looking thing on the screen.
 *
 * Every column here is derived or declined. The two that *cannot* be derived
 * are gone rather than filled: there is no MER, because total marketing cost is
 * not a thing any connected system reports, and no recommendation, because
 * nothing here is a model and a sentence in that column would be a guess
 * wearing a verdict's clothes.
 */
function platformRows(entities) {
  const byChannel = new Map();
  for (const day of entities.campaignDays || []) {
    const channel = CHANNEL_OF[day.platform] || day.platform;
    if (!channel) continue;
    const row = byChannel.get(channel) || { spend: 0, impressions: 0, clicks: 0, days: [] };
    row.spend += day.spend || 0;
    row.impressions += day.impressions || 0;
    row.clicks += day.clicks || 0;
    row.days.push(day);
    byChannel.set(channel, row);
  }

  /* Leads and reservations come from the CRM, keyed by the channel the lead
     was tagged with — not from the platforms' own reported conversions, which
     count differently and would put a Meta-shaped number beside CRM revenue. */
  const leadsBy = new Map();
  for (const lead of entities.leads || []) {
    if (!lead.channel) continue;
    leadsBy.set(lead.channel, (leadsBy.get(lead.channel) || 0) + 1);
  }

  const wonBy = new Map();
  const revenueBy = new Map();
  for (const deal of entities.deals || []) {
    if (!deal.channel || deal.outcome !== 'won') continue;
    if (/cancel/i.test(String(deal.bookingStatus || ''))) continue;
    wonBy.set(deal.channel, (wonBy.get(deal.channel) || 0) + 1);
    revenueBy.set(deal.channel, (revenueBy.get(deal.channel) || 0) + (deal.revenue || 0));
  }

  /* Google's online half.
   *
   * The CRM only knows a booking somebody worked as a lead. A guest who
   * clicked a search ad and booked on the website never becomes a TeleCRM
   * deal, so Google's row carried its full spend against only the part of its
   * return that happened to arrive by phone — the row read 1.3x while the
   * booking engine had taken more than the CRM recorded.
   *
   * GA4's Paid Search channel group is the only measure of that half: Google
   * Ads counts the conversion and never prices it, the booking engine prices
   * it and does not know which ad it came from.
   *
   * **Added to `google` only, and only because Meta has no equivalent.** GA4's
   * Paid Search is search advertising, and folding it into a blended figure or
   * crediting any of it to Meta would be borrowing. Paid Social revenue is the
   * mirror of this for Meta and is deliberately not read here — it would need
   * the same argument made separately, and nobody has asked the question it
   * answers. */
  const paidSearchRows = (entities.webChannelRevenueDays || [])
    .filter((r) => /^paid\s*search$/i.test(String(r.channelGroup || '')));
  const webRevenue = new Map();
  if (paidSearchRows.length) {
    webRevenue.set('google', paidSearchRows.reduce((t, r) => t + (r.revenue || 0), 0));
  }

  /* The same map the Channel chip labels its options with, imported rather than
     repeated: a table headed "Google Ads" beside a filter offering something
     else spelled differently is the quiet disagreement worth one require. */
  const NAMES = filters.LABELS.channel;
  const ICONS = { meta: 'ph ph-meta-logo', google: 'ph ph-google-logo' };

  /* The comparison every row is judged against — the other platforms' figures,
     not a target nobody set. */
  const cplOf = (channel, row) => {
    const n = leadsBy.get(channel) || 0;
    return n ? row.spend / n : null;
  };
  const allCpl = [...byChannel.entries()].map(([c, r]) => cplOf(c, r)).filter((v) => v !== null);
  const medianCpl = allCpl.length
    ? [...allCpl].sort((a, b) => a - b)[Math.floor(allCpl.length / 2)]
    : null;

  return [...byChannel.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .map(([channel, row]) => {
      const leadCount = leadsBy.get(channel) || 0;
      const won = wonBy.get(channel) || 0;
      /* CRM-recorded value plus, for Google, what the booking engine took from
         paid-search sessions. The two are separate books and a booking in both
         is counted twice — flagged on the row rather than silently netted,
         because nothing can reconcile them until a PMS gives both one folio. */
      const crmRevenue = revenueBy.get(channel) || 0;
      const online = webRevenue.get(channel) || 0;
      const revenue = crmRevenue + online;

      /* A sparkline of this platform's own daily spend, in date order — the
         authored one was a shape, not a series. */
      const series = [...row.days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const peak = Math.max(...series.map((d) => d.spend || 0), 1);

      return {
        name: NAMES[channel] || channel,
        /* The raw token beside the display name, because the topbar chips are
           built by walking the payload for a field called `platform` or
           `channel` (lib/filters.js DIMENSIONS) — and this table called it
           `name`, which matches neither. The result was not "Google is missing
           from the channel chip" but every chip on the screen offering nothing
           at all, while looking exactly like a working control.

           The token rather than the label, since it is what `scope.js` narrows
           on: `meta` and `google`, not "Meta Ads". */
        channel,
        icon: ICONS[channel] || 'ph ph-chart-bar',
        /* Declined explicitly, because the driver merges this over the authored
           module: a field left undefined here does not render blank, it renders
           the invented figure underneath. That is how a table ends up half
           measured and half fiction with nothing marking the seam.

           MER is revenue over *total marketing cost*, which no connected system
           reports — the same reason the dashboard's MER tile has no registry
           entry. Net ROAS needs settled folio revenue, which needs a PMS. */
        mer: NONE,
        netRoas: NONE,
        netColor: 'var(--color-neutral-500)',
        spend: money(row.spend),
        /* CRM reservation value, plus GA4's paid-search revenue on Google's
           row. Zero revenue on real spend is a real answer — it means nothing
           this channel produced has been tagged and won — so it prints as a
           figure rather than a dash.
         *
           NOTE the BOOKINGS column beside it stays the CRM's count alone:
           GA4 reports what the booking engine took, not how many reservations
           made it up, so adding revenue without its bookings is the honest
           half. It does mean this row's revenue ÷ bookings is not an average
           stay value, which is why no such column is offered. */
        rev: money(revenue),
        /* What the online half contributed, so a reader can see the two books
           apart rather than having to trust one merged figure. */
        revOnline: online ? money(online) : null,
        /* `ratio` divides for you — handing it the quotient made every row
           dash, because the denominator it was checking was undefined. */
        roas: ratio(revenue, row.spend),
        leads: leadCount ? count(leadCount) : NONE,
        cpl: leadCount ? money(row.spend / leadCount) : NONE,
        bookings: won ? count(won) : NONE,
        cpa: won ? money(row.spend / won) : NONE,
        spark: series.map((d, i) => `${(i / Math.max(series.length - 1, 1)) * 120},${26 - ((d.spend || 0) / peak) * 24}`).join(' '),
        ...verdict({ spend: row.spend, leads: leadCount, won, revenue, cpl: cplOf(channel, row), medianCpl }),
      };
    });
}

/* The recommendation column, derived.
 *
 * It was an authored sentence — "Scale — CPL falling with volume holding" —
 * printed beside figures nobody measured. What replaces it is a rule, not a
 * model, and it says so: this codebase already refuses to put a language model
 * behind a number it cannot reconcile with the registry (see lib/ai/reasoner.js
 * for the same decision made once already).
 *
 * The order matters. Each branch is a question that must be answered before the
 * next one is worth asking, so a platform with no attribution is never told to
 * scale on a ROAS that was computed from nothing.
 */
function verdict({ spend, leads, won, revenue, cpl, medianCpl }) {
  const say = (text, tone) => ({
    rec: text,
    recColor: tone === 'up' ? 'var(--color-accent-300)' : tone === 'warn' ? 'var(--signal-warn)' : 'var(--color-neutral-400)',
    recBorder: tone === 'up' ? 'var(--color-accent-800)' : 'var(--color-neutral-800)',
  });

  /* Spending with nothing coming back is the only finding here that does not
     depend on attribution being wired, so it is asked first and stated plainly.
     It is also the one a reader most needs to see. */
  if (spend > 0 && leads === 0) {
    return say('No CRM leads tagged to this platform — check lead-form field mapping before reading any figure in this row', 'warn');
  }
  if (spend === 0) return say('No spend in this period', null);

  /* Everything past here is a comparison against the other platform, which is
     the only benchmark that exists: there is no category figure for a resort
     group in Kerala, and inventing a target to score against would be the
     authored sentence again in a different font. */
  const cheaper = medianCpl && cpl && cpl < medianCpl * 0.8;
  const dearer = medianCpl && cpl && cpl > medianCpl * 1.25;

  if (won === 0) {
    return say(
      cheaper
        ? 'Cheapest leads, none won yet — a volume channel that has not converted in this window'
        : 'Leads arriving, none won in this window — judge on CPL until a reservation lands',
      null
    );
  }

  const roas = spend ? revenue / spend : 0;
  if (roas >= 4 && cheaper) return say('Strongest on both cost and return — the clearest case for more budget', 'up');
  if (roas >= 4) return say('Returning above target on CRM-recorded value', 'up');
  if (roas < 1) return say('Reservation value below spend in this window — cost per reservation is the number to fix', 'warn');
  if (dearer) return say('Leads cost more than the other platform for a similar return', 'warn');
  return say('Holding — neither the cheapest leads nor the best return', null);
}

/* The one-line note under a hero KPI, derived.
 *
 * These read "Meta ₹6.4L · Google ₹4.5L" and "2,554 leads" — fixed strings
 * sitting under figures that had since become real and did not agree with
 * them. A sub-line is small enough to go unchecked and specific enough to be
 * believed, which is the worst pair of properties a number on a screen can
 * have. Each one is now computed from the same rows as the figure above it, or
 * left blank. */
/* The lines under the hero figures, narrowed by whatever the topbar narrowed.
 *
 * These counted every lead in the workspace while the figures above them were
 * scoped by the channel chip, so choosing Google gave a ROAS built from Google's
 * spend and a caption reading "1,355 of 5,059 leads tagged" — the whole CRM,
 * under a card about one platform. The chip is in `params` because readParams
 * spreads the query, and it is read through filters.selected for the reason
 * every other reader does: the chips are named f_channel, not channel. */
function heroSubs(entities, base = {}, params = {}) {
  const rows = base.mktHero;
  if (!Array.isArray(rows)) return null;

  const chosen = String((filters.selected(params) || {}).channel || '').toLowerCase();
  const inScope = (lead) => !chosen || String(lead.channel || '').toLowerCase() === chosen;

  const spendBy = new Map();
  for (const day of entities.campaignDays || []) {
    const channel = CHANNEL_OF[day.platform] || day.platform;
    if (!channel) continue;
    spendBy.set(channel, (spendBy.get(channel) || 0) + (day.spend || 0));
  }
  const split = [...spendBy.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([channel, spend]) => `${channel === 'meta' ? 'Meta' : channel === 'google' ? 'Google' : channel} ${money(spend)}`)
    .join(' · ');

  const scoped = (entities.leads || []).filter(inScope);
  const leadCount = scoped.length;
  const tagged = scoped.filter((l) => l.channel === 'meta' || l.channel === 'google').length;

  const SUB = {
    'ads.spend': split,
    'cost.per_lead': leadCount ? `${count(leadCount)} leads` : '',
    /* Says what it leaves out, because the figure is a floor and the gap here
       is most of it. */
    /* Says what it leaves out AND what it adds, because the figure is a floor
       on one side and a sum of two books on the other. */
    'revenue.attributed_total': tagged
      ? `${count(tagged)} of ${count(leadCount)} leads tagged · plus GA4 paid search`
      : (chosen
        ? `no ${chosen} leads tagged in range · GA4 paid search only`
        : 'no leads tagged to a channel · GA4 paid search only'),
  };

  return rows.map((card) => (card.metric && SUB[card.metric] !== undefined
    ? { ...card, sub: SUB[card.metric] }
    : card));
}

/* ── Spend against revenue, over the window ───────────────────────────────
 *
 * The design drew this: eight stacked bars at fixed heights, a revenue line
 * that rose because it had been drawn rising, and axis labels reading W1 Jun
 * to W4 Jul whichever range was selected. It was the largest thing on the
 * screen and the only one that never moved.
 *
 * Built from the same figures as the cards above it, deliberately — the bars
 * are the spend behind the Ad spend tile and the line is the numerator of the
 * ROAS tile, so a reader comparing them cannot find two different answers.
 *
 * **Two scales on one canvas**, as the design intends: spend and revenue are
 * different units and forcing them onto one axis would either flatten the bars
 * or send the line off the top. The view says so under the legend rather than
 * leaving somebody to infer that a line above a bar means revenue exceeded
 * spend at that point.
 */
const PAID_TAGGED = new Set(['meta', 'google']);

function spendVsRevenue(entities) {
  const days = entities.campaignDays || [];
  const dates = [...new Set(days.map((d) => d.date).filter(Boolean))].sort();
  if (!dates.length) {
    return { empty: true, reason: 'No ad spend in this range — there is nothing to plot against revenue.' };
  }

  /* Up to eight buckets covering the window end to end, so the axis is the
     range the reader chose rather than a fixed eight weeks. A short window gets
     one bucket per day; a quarter gets eleven-day blocks. */
  const first = Date.parse(dates[0]);
  const last = Date.parse(dates[dates.length - 1]);
  const span = Math.max(1, Math.round((last - first) / MS_PER_DAY) + 1);
  const buckets = Math.min(8, Math.max(1, Math.min(span, dates.length)));
  const width = Math.ceil(span / buckets);
  const indexOf = (date) => {
    const offset = Math.floor((Date.parse(date) - first) / MS_PER_DAY / width);
    return Math.min(Math.max(offset, 0), buckets - 1);
  };

  const empty = () => ({ meta: 0, google: 0, other: 0, revenue: 0 });
  const rows = Array.from({ length: buckets }, empty);

  for (const day of days) {
    if (!day.date) continue;
    const row = rows[indexOf(day.date)];
    const channel = CHANNEL_OF[day.platform];
    if (channel === 'meta') row.meta += day.spend || 0;
    else if (channel === 'google') row.google += day.spend || 0;
    else row.other += day.spend || 0;
  }

  /* The revenue line is `revenue.attributed_total` cut by bucket — CRM deals
     tagged to a paid channel, plus what the booking engine took from
     paid-search sessions. The same definition the ROAS tile divides by. */
  for (const deal of entities.deals || []) {
    if (!PAID_TAGGED.has(deal.channel) || deal.outcome !== 'won') continue;
    if (/cancel/i.test(String(deal.bookingStatus || ''))) continue;
    if (!deal.updatedAt) continue;
    rows[indexOf(deal.updatedAt)].revenue += deal.revenue || 0;
  }
  for (const row of entities.webChannelRevenueDays || []) {
    if (!row.date || !/^paid\s*search$/i.test(String(row.channelGroup || ''))) continue;
    rows[indexOf(row.date)].revenue += row.revenue || 0;
  }

  /* Geometry. The viewBox is the design's — 640 × 200 — because the gridlines
     and the panel around it are still its markup. */
  const BASE = 180;
  const TALL = 156;
  const slot = 640 / buckets;
  const barWidth = Math.max(8, Math.min(26, slot * 0.42));

  const spendTop = Math.max(...rows.map((r) => r.meta + r.google + r.other), 0);
  const revenueTop = Math.max(...rows.map((r) => r.revenue), 0);
  const label = (i) => {
    const at = new Date(first + i * width * MS_PER_DAY);
    return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const bars = rows.map((row, i) => {
    const x = slot * i + (slot - barWidth) / 2;
    const height = (value) => (spendTop ? (value / spendTop) * TALL : 0);
    /* Stacked from the baseline up, largest platform first, so a bar reads as
       one column of spend rather than three that happen to touch. */
    const meta = height(row.meta);
    const google = height(row.google);
    const other = height(row.other);
    return {
      x, width: barWidth, label: label(i),
      meta: { y: BASE - meta, h: meta },
      google: { y: BASE - meta - google, h: google },
      other: { y: BASE - meta - google - other, h: other },
      spendText: money(row.meta + row.google + row.other),
      revenueText: money(row.revenue),
      cx: x + barWidth / 2,
      cy: revenueTop ? BASE - (row.revenue / revenueTop) * TALL : BASE,
      hasRevenue: row.revenue > 0,
    };
  });

  return {
    empty: false,
    bars,
    /* Only where something was measured — joining across a bucket with no
       revenue would draw a line down to the axis and back, which reads as a
       week that earned nothing rather than one nothing has been recorded for
       yet. */
    line: revenueTop
      ? bars.filter((b) => b.hasRevenue).map((b, i) => `${i ? 'L' : 'M'}${b.cx.toFixed(1)},${b.cy.toFixed(1)}`).join(' ')
      : null,
    last: revenueTop ? [...bars].reverse().find((b) => b.hasRevenue) || null : null,
    spendTopText: money(spendTop),
    revenueTopText: revenueTop ? money(revenueTop) : null,
    /* Said on the chart, because two scales on one canvas is the assumption a
       reader will otherwise make wrongly. */
    note: revenueTop
      ? `bars to ${money(spendTop)} · line to ${money(revenueTop)} — separate scales`
      : 'no attributed revenue in this range, so no line is drawn',
  };
}

function marketing(entities, params = {}, base = {}) {
  const days = entities.campaignDays || [];
  const impressions = sum(days, 'impressions');
  const clicks = sum(days, 'clicks');
  const bookings = (entities.bookings || []).length;

  /* The CRM's own lead count, not the platforms' reported conversions.
   *
   * This summed `leads` off campaignDays and printed **2,466.83** — a
   * fractional lead, because Google reports `conversions` as a double and it
   * was being added to Meta's integers. A lead count with decimals is a visible
   * symptom of a deeper wrong: those are two platforms' *own* conversion
   * counts, on their own attribution windows, and the funnel below them is
   * CRM-shaped. Counting the CRM's leads makes the stage mean the same thing as
   * every other lead figure in the product. */
  /* **One population, all the way down.**
   *
   * The stages were two funnels stacked on top of each other. Impressions and
   * clicks are Meta and Google; leads, qualified and bookings were the WHOLE
   * CRM — every enquiry the property took, including the phone calls,
   * walk-ins, OTA bookings and organic traffic that no advertising was paid
   * for. On this account that is 5,070 leads sitting under 40,344 ad clicks,
   * so the click-to-lead rate read 12.57% when only 1,356 of those leads were
   * ever tagged to a paid channel. The advertising was being credited with the
   * business's entire demand.
   *
   * It is the same error `roas.attributed` exists to avoid, in a different
   * shape: a numerator from everywhere over a denominator only the ads
   * contributed to.
   *
   * So every stage below the clicks is now paid-tagged. It is a floor —
   * an untagged lead that an ad genuinely produced is missing from it — and
   * that is the direction to err in, the same one the ROAS cards take. The
   * whole-CRM counts have not gone anywhere: they are the CRM Dashboard and
   * the Sales screens, which is where a question about all demand belongs. */
  const paidLeads = (entities.leads || []).filter((l) => PAID_TAGGED.has(l.channel));
  const leads = paidLeads.length;
  const qualified = paidLeads.filter((l) => INTERESTED.test(String(l.stage || ''))).length;
  const won = (entities.deals || []).filter((d) => PAID_TAGGED.has(d.channel)
    && d.outcome === 'won'
    && !/cancel/i.test(String(d.bookingStatus || ''))).length;

  /* The bar is as long as the number beside it.
   *
   * The widths were the design's — 100%, 62%, 38%, 24%, 12% — a tidy taper
   * drawn once and left alone while the counts above them became real. On
   * this account clicks are 1.86% of impressions and were rendering as a bar
   * nearly two-thirds the width of the one above: the figures said one thing
   * and the picture said another, in the same row.
   *
   * Measured against the top of the funnel rather than against the previous
   * stage, because a step-by-step scale would draw every bar nearly full and
   * hide exactly what a funnel is for. The step rate is already the figure
   * printed beside each stage, so the two are not redundant.
   *
   * **Log scale, and the caption says so.** A marketing funnel spans four
   * orders of magnitude — two million impressions to four hundred bookings —
   * and drawn linearly every stage below the first is a sliver one and a half
   * pixels wide. Four indistinguishable slivers are their own untruth: leads
   * and bookings differ by a factor of ten and would look identical.
   *
   * A log scale is a real transform rather than an invented taper, it is
   * monotonic so a bigger stage is always a longer bar, and the exact count and
   * step rate are printed beside every stage — nobody has to read a magnitude
   * off the bar alone. What is not acceptable is an unlabelled one, so the
   * panel header states it. */
  const top = impressions || clicks || leads || 0;
  const bar = (value) => {
    if (!value || !top || top <= 1) return '0%';
    const share = Math.log(Math.max(value, 1)) / Math.log(top);
    return `${Math.max(2, Math.min(100, share * 100)).toFixed(1)}%`;
  };

  const stage = (label, value, of) => ({
    label,
    n: value ? count(value) : NONE,
    pct: value && of ? pct(value, of) : NONE,
    w: bar(value),
  });

  return {
    mktFunnel: [
      { label: 'Impressions', n: impressions ? count(impressions) : NONE, pct: impressions ? '100%' : NONE, w: impressions ? '100%' : '0%' },
      stage('Clicks', clicks, impressions),
      stage('Leads', leads, clicks),
      /* Was always dashed — nothing knew what qualified meant. It is the same
         rule the interested-rate tile uses, imported so the two cannot drift. */
      stage('Qualified', qualified, leads),
      /* Was the PMS's bookings, which is 0 with no PMS. The CRM's won
         reservations are what the rest of this screen counts. */
      /* The PMS fallback is gone with it: `bookings` is every confirmed booking
         the property has, which is the same whole-business figure this funnel
         just stopped mixing in. Paid-tagged won deals or nothing. */
      stage('Bookings', won, qualified || leads),
    ],
    platforms: platformRows(entities),
    mktChart: spendVsRevenue(entities),
    /* Any KPI on this screen with no registry entry behind it is declined.
     *
     * Five of the six resolve to metrics and are replaced with real figures.
     * The sixth was **Frequency: 2.4**, which nothing computes — an authored
     * number sitting in a row of measured ones, in the same typeface, with a
     * "+0.3" beside it. There is no way for a reader to tell.
     *
     * That card now names a metric — `ads.frequency_meta`, Meta's own per-ad
     * frequency weighted by impressions. The reasoning that used to sit here
     * still holds and is why the card was RE-LABELLED rather than simply
     * filled: account frequency is impressions over deduplicated reach, reach
     * cannot be summed across ads because the same person is reached by
     * several, and calling the per-ad figure "Frequency" would have been the
     * plausible wrong number this rule exists to catch.
     *
     * Written as a rule over "has no metric" rather than as a check for this
     * one card, so the next authored figure somebody adds is caught by it. */
    mktKpis: (base.mktKpis || []).map((card) => (card.metric ? card : {
      ...card,
      value: NONE,
      delta: '·',
      deltaColor: NA,
      tip: `${card.label} has no definition behind it in this build — it is not measured, and the figure that used to sit here was authored.`,
    })),
    /* Spread only when there is something to replace — returning `mktHero:
       undefined` would blank the hero row rather than leave it alone, because
       the driver spreads this over the authored payload. */
    ...(heroSubs(entities, base, params) ? { mktHero: heroSubs(entities, base, params) } : {}),
  };
}

const { dashboard } = require('./dashboard-projection');

/* ── Website Analytics ────────────────────────────────────────────────────
 *
 * Every figure on this screen was authored: 1.84L sessions, six invented page
 * paths, a six-step booking funnel. Google Analytics has been connected and
 * syncing hourly the whole time, which makes this the worst kind of screen —
 * plausible, specific, and about a property that does not exist.
 *
 * What GA4's Data API can answer, it now answers. What it cannot, this
 * declines, and the difference is worth stating per card because it is not
 * arbitrary:
 *
 *   sessions, users, bounce, session length   session_day — measured
 *   traffic sources                           channel_day + channel_revenue_day
 *   top pages, landing pages                  page_day, landing_page_day
 *   booking-engine starts, the funnel         events this property does not send
 *   exit rate, scroll depth, form steps       not GA4 metrics at all
 *
 * The funnel is the honest casualty. A booking funnel is a sequence of custom
 * events — availability checked, guest details entered, payment page — and a
 * property that fires none of them has not measured a funnel with every step
 * at zero; it has measured nothing. Six labelled rows reading "—" say that,
 * where six invented ones said the opposite.
 *
 * **No deltas.** The card's "+14.2%" needs the window before this one, and a
 * projection is handed the rows already narrowed to the window it is drawing.
 * Comparing would mean re-reading the store from here, which is the repository's
 * job and not this file's — so the arrows go rather than being guessed.
 */

/* Session-weighted, never averaged flat.
 *
 * `bounceRate` and `averageSessionDuration` are rates already. A day with four
 * sessions and a day with four thousand are not two equal opinions about the
 * property's bounce rate, and averaging them as though they were is how a quiet
 * Tuesday ends up counting as much as a bank holiday. */
function weighted(rows, field) {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const v = r[field];
    const w = r.sessions || 0;
    if (v === null || v === undefined || !w) continue;
    num += v * w;
    den += w;
  }
  return den ? num / den : null;
}

/* `161` -> `2m 41s`, the design's own spelling. */
function duration(seconds) {
  if (seconds === null || seconds === undefined) return NONE;
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const rest = whole % 60;
  return m ? `${m}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

const percent = (rate) => (rate === null || rate === undefined ? NONE : `${(rate * 100).toFixed(1)}%`);

/* Rows sharing one dimension value, summed — the same rollup three tables need
   and the reason none of them does it itself. */
function byDimension(rows, key) {
  const by = new Map();
  for (const r of rows) {
    const name = r[key];
    if (!name) continue;
    const acc = by.get(name) || { name, rows: [], sessions: 0, users: 0, pageViews: 0 };
    acc.rows.push(r);
    acc.sessions += r.sessions || 0;
    acc.users += r.users || 0;
    acc.pageViews += r.pageViews || 0;
    by.set(name, acc);
  }
  return [...by.values()];
}

function website(entities, params = {}, authored = {}) {
  const sessionDays = entities.sessionDays || [];
  const channelDays = entities.webChannelDays || [];
  const revenueDays = entities.webChannelRevenueDays || [];
  const pageDays = entities.webPageDays || [];
  const landingDays = entities.webLandingDays || [];

  const sessions = sum(sessionDays, 'sessions');
  const users = sum(sessionDays, 'users');
  const measured = sessionDays.length > 0;

  /* Revenue per channel group, keyed on Google's own label — the same join
     `platformRows` makes, and for the same reason: re-deriving the channel from
     source/medium is how a screen stops agreeing with the GA interface. */
  const revenueBy = new Map();
  const reservationsBy = new Map();
  for (const r of revenueDays) {
    const g = r.channelGroup;
    if (!g) continue;
    revenueBy.set(g, (revenueBy.get(g) || 0) + (r.revenue || 0));
    reservationsBy.set(g, (reservationsBy.get(g) || 0) + (r.reservations || 0));
  }

  const direct = [...revenueBy.entries()].find(([g]) => /^direct$/i.test(g));

  const kpi = (label, value) => ({ label, value, delta: NONE, deltaColor: NA });

  const webKpis = [
    kpi('Sessions', measured ? count(sessions) : NONE),
    kpi('Users', measured ? count(users) : NONE),
    kpi('Bounce rate', percent(weighted(sessionDays, 'bounceRate'))),
    kpi('Avg session', duration(weighted(sessionDays, 'avgSessionSeconds'))),
    /* Not a GA4 metric — it is whatever event the booking engine fires when
       somebody opens it, and this property fires none. Named rather than
       dropped, because the card is a question worth keeping in view. */
    kpi('Booking engine starts', NONE),
    /* GA4's Direct channel group, which is what "direct revenue" means on a
       screen about the website: money the booking engine took from sessions
       with no referrer. Not the CRM's direct bookings, which are a different
       book and are counted on the dashboard. */
    kpi('Direct revenue', direct ? money(direct[1]) : NONE),
  ];

  const sourceRows = byDimension(channelDays, 'channelGroup')
    .sort((a, b) => b.sessions - a.sessions);
  const topSessions = Math.max(...sourceRows.map((r) => r.sessions), 0);

  const webSources = sourceRows.map((r) => ({
    src: r.name,
    sessions: count(r.sessions),
    /* Blank rather than ₹0 where the channel produced no measured revenue: a
       channel group with no purchase event is unmeasured, not unprofitable. */
    rev: revenueBy.has(r.name) ? money(revenueBy.get(r.name)) : NONE,
    w: topSessions ? `${Math.round((r.sessions / topSessions) * 100)}%` : '0%',
  }));

  /* Top pages by what a page actually reports — views. Sessions cut by
     `pagePath` count sessions that *included* the page, which is a different
     and easily misread figure, so it is not what these are ranked on. */
  const topPages = byDimension(pageDays, 'page')
    .sort((a, b) => b.pageViews - a.pageViews)
    .slice(0, 12)
    .map((r) => ({
      page: r.name,
      views: count(r.pageViews),
      /* Session duration on a page cut, which is the length of the sessions
         that included this page — not time on this page. GA4 has no
         time-on-page metric; the column keeps the design's heading and the
         difference is stated here rather than implied there. */
      avg: duration(weighted(r.rows, 'avgSessionSeconds')),
      /* Exit rate died with Universal Analytics and has no GA4 equivalent, and
         booking clicks are an event this property does not send. */
      exit: NONE,
      clicks: NONE,
    }));

  const lpRows = byDimension(landingDays, 'landingPage')
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 12)
    .map((r) => ({
      lp: r.name,
      sessions: count(r.sessions),
      bounce: percent(weighted(r.rows, 'bounceRate')),
      /* No threshold, so no colour. A bounce rate is good or bad against the
         property's own history and this workspace has set no target — painting
         one green would be inventing the benchmark rather than the number. */
      bounceColor: NA,
      /* Scroll depth, form starts and form completions are custom events. A
         landing page that fires none has not scored zero on them. */
      scroll: NONE,
      formStart: NONE,
      formDone: NONE,
      conv: NONE,
      clicks: NONE,
      /* Revenue per landing page needs the purchase joined to the page the
         session started on, which is a GA4 report this does not pull —
         `channel_revenue_day` cuts by channel, not by landing page. */
      rev: NONE,
      audit: NONE,
      auditColor: NA,
      auditBorder: 'var(--color-neutral-800)',
    }));

  /* The funnel: two ends measured, four middles declined.
   *
   * Every step was dashed, which was right when nothing could answer any of
   * them and wrong once GA4 was reporting both ends. A visit is a session, and
   * a confirmed booking is a booking-engine purchase — GA4 counts both, and the
   * rate between them is the number this panel exists for.
   *
   * The four stages between are custom events — availability checked, guest
   * details entered, payment page reached — and this property fires none of
   * them. They keep their labels and their dashes: the gap is the point, and it
   * is a tagging job rather than a missing screen.
   *
   * Widths run against the top of the funnel and are floored so a real stage
   * stays visible, the same rule the marketing funnel states. */
  const purchases = revenueDays.reduce((t, r) => t + (r.reservations || 0), 0);
  const funnelTop = sessions || 0;
  const share = (value) => (funnelTop && value ? `${Math.max(1.5, (value / funnelTop) * 100).toFixed(1)}%` : '0%');

  const webFunnel = (authored.webFunnel || []).map((step, i) => {
    const last = i === (authored.webFunnel || []).length - 1;
    if (i === 0) {
      return {
        ...step,
        n: measured ? count(funnelTop) : NONE,
        pct: measured ? '100%' : NONE,
        w: measured ? '100%' : '0%',
        drop: NONE,
      };
    }
    if (last && purchases) {
      return {
        ...step,
        n: count(purchases),
        pct: funnelTop ? pct(purchases, funnelTop) : NONE,
        w: share(purchases),
        /* Against the stage above it, which is the first one — every stage
           between is unmeasured, so a step-on-step drop would be a drop from
           nothing. Stated as the whole-funnel fall instead. */
        drop: funnelTop ? `−${(100 - (purchases / funnelTop) * 100).toFixed(1)}%` : NONE,
      };
    }
    return { ...step, n: NONE, pct: NONE, w: '0%', drop: NONE };
  });

  return { webKpis, webSources, topPages, lpRows, webFunnel };
}

/* ── Attribution ──────────────────────────────────────────────────────────
 *
 * The screen was entirely authored: ₹18.9L to Meta, 218 assisted conversions,
 * 6.2 days to book, and a "real journey" belonging to Lead #4812, who does not
 * exist. Two systems can actually answer some of it, and this is the line
 * between them.
 *
 * **What credits revenue here is Google Analytics.** GA4 is the only connected
 * system that watches a visit, classifies where it came from and prices what it
 * bought. Its `sessionDefaultChannelGroup` split IS an attribution model —
 * last non-direct click, Google's own — applied to the property's real traffic.
 * Taking it verbatim is deliberate; re-deriving a channel from source/medium is
 * how a screen stops agreeing with the GA interface somebody checks it against.
 *
 * **The CRM credits the half GA4 cannot see.** A guest who rang reservations
 * and was closed on the phone never becomes a session. Those bookings are
 * TeleCRM deals, tagged with the channel their lead arrived on, and they get
 * their own rows — named as CRM rows, never merged into GA4's, because a
 * booking made online and then entered into the CRM is in both books and no
 * PMS exists yet to reconcile them.
 *
 * **What neither can answer, this declines.** Touchpoints per booking, assisted
 * conversions and the spread between first and last click all need a touchpoint
 * chain — every ad, search and email a booking passed through, in order. The
 * store holds a handful of lead events in total. Without chains the seven
 * models cannot disagree: one touch is credited whole by all of them, which is
 * why the selector previews the same figures whichever is chosen, and why
 * saying so is better than printing seven different invented splits.
 *
 * Time to book IS computable and is the one journey figure that survives: the
 * CRM records when a lead arrived and when its deal was won.
 */

/* Renamed from DAY — the creative screen already owns that name for a date
   format option, and two constants a thousand lines apart sharing one name is
   how a file stops loading at all. */
const MS_PER_DAY = 86400000;

/* Ribbon colours, cycled. Six is more than the property has channel groups with
   revenue, and running out is handled by wrapping rather than by going blank. */
const FLOW_FILLS = [
  'var(--color-accent-700)',
  'var(--color-accent-2-600)',
  'var(--color-accent-600)',
  'var(--color-neutral-700)',
  'var(--color-neutral-600)',
  'var(--color-accent-800)',
];

/* The Sankey, drawn from the numbers rather than typed into the markup.
 *
 * The design's five ribbons were fixed paths with the revenue written beside
 * them as text — so re-crediting the table below changed the figures and left
 * the diagram's shape saying whatever it had always said. A diagram that
 * contradicts the table under it is worse than no diagram, so the bands are
 * computed: a channel's thickness on both sides is its share of credited
 * revenue, and a channel with no revenue has no ribbon.
 *
 * The right-hand block is "last touch" only in the sense that everything
 * arrives there — with no chains there is no intermediate step to draw, and
 * pretending otherwise would be the same invention in a different shape.
 */
function sankey(rows) {
  const total = rows.reduce((t, r) => t + r.amount, 0);
  if (!total) return [];

  const TOP = 30;
  const SPAN = 175;
  const GAP = 5;
  const RIGHT_TOP = 48;
  const RIGHT_SPAN = 120;
  const MIN = 6;

  const usable = Math.max(SPAN - GAP * Math.max(rows.length - 1, 0), MIN * rows.length);

  let y = TOP;
  let ry = RIGHT_TOP;
  return rows.map((r, i) => {
    const share = r.amount / total;
    const h = Math.max(MIN, share * usable);
    const rh = Math.max(3, share * RIGHT_SPAN);
    const band = {
      label: r.label,
      rev: r.rev,
      y, h,
      /* Where the label sits inside its own box, so a thin band's text does not
         drift outside it. */
      labelY: y + Math.min(h / 2 + 3, h - 2),
      showRev: h >= 26,
      revY: y + h / 2 + 13,
      fill: FLOW_FILLS[i % FLOW_FILLS.length],
      path: `M90,${y} C250,${y} 270,${ry} 430,${ry} L430,${ry + rh} C270,${ry + rh} 250,${y + h} 90,${y + h} Z`,
    };
    y += h + GAP;
    ry += rh;
    return band;
  });
}

/* `4.7` -> `4.7 days`; whole numbers lose the point. */
function days(value) {
  if (value === null || value === undefined) return NONE;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} day${rounded === 1 ? '' : 's'}`;
}

function attribution(entities, params = {}, authored = {}) {
  const revenueDays = entities.webChannelRevenueDays || [];
  const channelDays = entities.webChannelDays || [];
  const deals = entities.deals || [];
  const leads = entities.leads || [];
  const leadEvents = entities.leadEvents || [];

  /* ── GA4's credit ─────────────────────────────────────────────────────── */

  const webRevenue = new Map();
  const webBookings = new Map();
  for (const r of revenueDays) {
    if (!r.channelGroup || !r.revenue) continue;
    webRevenue.set(r.channelGroup, (webRevenue.get(r.channelGroup) || 0) + r.revenue);
    webBookings.set(r.channelGroup, (webBookings.get(r.channelGroup) || 0) + (r.reservations || 0));
  }
  const webSessions = new Map();
  for (const r of channelDays) {
    if (!r.channelGroup) continue;
    webSessions.set(r.channelGroup, (webSessions.get(r.channelGroup) || 0) + (r.sessions || 0));
  }

  /* ── The CRM's credit ─────────────────────────────────────────────────── */

  const won = deals.filter((d) => d.outcome === 'won' && !/cancel/i.test(String(d.bookingStatus || '')));
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const crm = new Map();
  for (const d of won) {
    const key = d.channel || 'untagged';
    const acc = crm.get(key) || { amount: 0, bookings: 0, lags: [] };
    acc.amount += d.revenue || 0;
    acc.bookings += 1;
    const lead = leadById.get(d.leadId);
    if (lead && lead.createdAt && d.updatedAt) {
      const lag = (Date.parse(d.updatedAt) - Date.parse(lead.createdAt)) / MS_PER_DAY;
      if (Number.isFinite(lag) && lag >= 0) acc.lags.push(lag);
    }
    crm.set(key, acc);
  }

  const crmLeads = new Map();
  for (const l of leads) {
    const key = l.channel || 'untagged';
    crmLeads.set(key, (crmLeads.get(key) || 0) + 1);
  }

  const LABELS = filters.LABELS.channel || {};
  /* Most of this workspace's won deals carry no channel at all, and that row
     is the largest on the table — so it has to say what it is rather than
     read as a missing label. Revenue the CRM recorded against an enquiry
     nobody tagged is real revenue that cannot be attributed, which is a
     finding about how leads are being logged, not a gap in this screen. */
  const nameOf = (channel) => (channel === 'untagged' ? 'Untagged enquiries' : LABELS[channel] || channel);
  const mean = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);

  /* ── One table, two books, each row saying which ──────────────────────── */

  const webRows = [...webRevenue.entries()]
    .map(([group, amount]) => ({ group, amount }))
    .sort((a, b) => b.amount - a.amount);

  const crmRows = [...crm.entries()]
    .filter(([, v]) => v.amount > 0)
    .map(([channel, v]) => ({ channel, ...v }))
    .sort((a, b) => b.amount - a.amount);

  const total = webRows.reduce((t, r) => t + r.amount, 0) + crmRows.reduce((t, r) => t + r.amount, 0);
  const share = (amount) => (total ? `${((amount / total) * 100).toFixed(1)}%` : '0%');

  const attrChannels = [
    ...webRows.map((r) => {
      const bookings = webBookings.get(r.group) || 0;
      const sessions = webSessions.get(r.group) || 0;
      return {
        channel: `${r.group} · GA4`,
        /* A touchpoint count needs the chain, and GA4's channel report is one
           row per session per day with no journey attached to it. */
        tp: NONE,
        rev: money(r.amount),
        share: share(r.amount),
        bookings: bookings ? count(bookings) : NONE,
        /* Purchases over sessions on the same channel group — the booking
           engine's own conversion rate, not the ad platform's. */
        conv: sessions && bookings ? pct(bookings, sessions) : NONE,
        time: NONE,
      };
    }),
    ...crmRows.map((r) => ({
      channel: `${nameOf(r.channel)} · CRM`,
      tp: NONE,
      rev: money(r.amount),
      share: share(r.amount),
      bookings: count(r.bookings),
      /* Won deals over leads the CRM tagged to this channel — a sales
         conversion rate, which is a different thing from GA4's above and is
         labelled by the row it sits on. */
      conv: crmLeads.get(r.channel) ? pct(r.bookings, crmLeads.get(r.channel)) : NONE,
      /* The one journey figure that survives: lead created to deal won. */
      time: days(mean(r.lags)),
    })),
  ];

  /* ── The flow diagram, from the same rows ─────────────────────────────── */

  const flowRows = [
    ...webRows.map((r) => ({ label: r.group, amount: r.amount, rev: money(r.amount) })),
    ...crmRows.map((r) => ({
      label: `${nameOf(r.channel)} (CRM)`, amount: r.amount, rev: money(r.amount),
    })),
  ];
  const attrFlow = sankey(flowRows);

  /* ── The journey card, from a booking that happened ───────────────────── */

  const ICON = {
    meta: 'ph ph-meta-logo',
    google: 'ph ph-google-logo',
    email: 'ph ph-envelope-simple',
    whatsapp: 'ph ph-whatsapp-logo',
  };

  /* The most recent won deal whose lead is also in this window — the journey is
     the gap between the two, and a deal whose lead fell outside the range has
     no measurable gap to show. */
  const traceable = won
    .filter((d) => leadById.has(d.leadId) && d.updatedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;

  let journey = [];
  let attrJourneyCaption = 'No booking in this range has both its lead and its close recorded — a journey needs the two ends of it.';

  if (traceable) {
    const lead = leadById.get(traceable.leadId);
    const start = Date.parse(lead.createdAt);
    const dayOf = (at) => {
      const n = Math.round((Date.parse(at) - start) / MS_PER_DAY);
      return Number.isFinite(n) ? `Day ${Math.max(n, 0)}` : NONE;
    };

    journey = [
      {
        icon: ICON[lead.channel] || 'ph ph-user-circle',
        label: lead.channel
          ? `Enquiry arrived — ${LABELS[lead.channel] || lead.channel}${lead.campaign ? ` · ${lead.campaign}` : ''}`
          : 'Enquiry arrived — channel not tagged',
        when: dayOf(lead.createdAt),
      },
      ...leadEvents
        .filter((e) => e.leadId === lead.id && e.at)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((e) => ({
          icon: 'ph ph-chat-circle-dots',
          label: String(e.type || 'activity').replace(/_/g, ' '),
          when: dayOf(e.at),
        })),
      {
        icon: 'ph ph-calendar-check',
        label: `Booking confirmed — ${money(traceable.revenue)}`,
        when: dayOf(traceable.updatedAt),
      },
    ];

    attrJourneyCaption = `Lead #${String(lead.id).slice(0, 8)} · ${nameOf(lead.channel || 'untagged')}`
      + `${lead.property ? ` · ${lead.property}` : ''} · ${money(traceable.revenue)}`;
  }

  /* ── The two tiles ────────────────────────────────────────────────────── */

  const lags = crmRows.flatMap((r) => r.lags);
  const traced = won.filter((d) => leadById.has(d.leadId)).length;

  return {
    attrChannels,
    attrFlow,
    journey,
    attrJourneyCaption,

    /* Meta's node label and the booking total, which the design typed into its
       SVG as literal text. Meta's paid revenue is GA4's Paid Social plus what
       the CRM closed from Meta-tagged leads — the same two books as everywhere
       else on this screen. */
    attrSankeyMeta: money((webRevenue.get('Paid Social') || 0) + ((crm.get('meta') || {}).amount || 0)),
    attrSankeyTotal: money(total),

    /* Assisted conversions need to know a booking had more than one touch, and
       nothing here records a second touch to count. Declined with the reason
       rather than estimated. */
    attrAssisted: NONE,
    attrAssistedSub: leadEvents.length
      ? `${count(leadEvents.length)} lead events recorded — too few for a chain`
      : 'no touchpoint chain is recorded',

    attrTimeToBook: days(mean(lags)),
    attrTimeSub: traced
      ? `${count(traced)} bookings traced to their enquiry · touchpoints not measured`
      : 'no booking in range traces back to its enquiry',

    /* What the table is, said above the table. The model selector stays — it is
       a real, persisted workspace setting — but with one touch per booking
       every model credits it whole, so it cannot move these figures and the
       screen should not imply it can. */
    attrCreditBasis: total
      ? 'GA4 channel groups and CRM-tagged deals · two books, added, not reconciled'
      : 'nothing measured in this range',
    attrFlowNote: total
      ? 'width = credited revenue · GA4 last non-direct click, plus CRM-tagged phone bookings'
      : 'no credited revenue in this range',
  };
}

/* ── Audience Analytics ───────────────────────────────────────────────────
 *
 * Authored end to end: revenue by age and gender, a device split, six cities,
 * and four audience segments with saturation, spend, leads, bookings, revenue
 * and net ROAS. None of it was measured, and the segments table is the one that
 * matters — it is the screen's argument.
 *
 * **A segment here is a Meta ad set**, which is what an audience actually is on
 * the platform: targeting is configured on the ad set, spend is reported
 * against it, and the custom audiences it draws from are named on it. So the
 * table is real without a single new source — ad-set days for the money, and
 * the CRM for what came back, joined on the ad set id the lead carries.
 *
 * **Age and gender, and device, are declined in the view rather than here.**
 * Both are Meta *breakdowns* — a different request per breakdown, doubling the
 * insights pull — and GA4's demographics need Google Signals and are
 * thresholded away on a property this size. Neither is a field anything
 * currently fetches, so neither is a number this file could produce.
 *
 * **Saturation is declined too**, and that one is worth stating: it is
 * frequency against audience size, ad-set frequency is not among the fields the
 * insights pull asks for, and audience size is only known for the custom
 * audiences an ad set happens to name. A percentage assembled from two thirds
 * of that would be a bar somebody plans a budget around.
 */
function audiencesScreen(entities, params = {}, base = {}) {
  const days = entities.adsetDays || [];

  /* Ad sets, rolled up from their days — the same shape and the same reason as
     every other rollup on this screen's neighbours. */
  const bySet = new Map();
  for (const day of days) {
    const id = day.adsetId && String(day.adsetId);
    if (!id) continue;
    const acc = bySet.get(id) || {
      id, name: day.adset || id, spend: 0, impressions: 0, clicks: 0, metaLeads: 0,
      audiences: day.audiences || [],
    };
    acc.spend += day.spend || 0;
    acc.impressions += day.impressions || 0;
    acc.clicks += day.clicks || 0;
    if (day.leads !== null && day.leads !== undefined) acc.metaLeads += day.leads;
    if (!acc.audiences.length && (day.audiences || []).length) acc.audiences = day.audiences;
    if (!acc.name && day.adset) acc.name = day.adset;
    bySet.set(id, acc);
  }

  /* What came back, from the CRM rather than from Meta's own conversion count.
     A lead carries the ad set it arrived from; a deal inherits its lead. */
  const crmLeads = new Map();
  const leadSet = new Map();
  for (const lead of entities.leads || []) {
    const id = lead.adsetId && String(lead.adsetId);
    if (!id) continue;
    leadSet.set(String(lead.id), id);
    crmLeads.set(id, (crmLeads.get(id) || 0) + 1);
  }

  const wonBy = new Map();
  const revenueBy = new Map();
  for (const deal of entities.deals || []) {
    if (deal.outcome !== 'won' || /cancel/i.test(String(deal.bookingStatus || ''))) continue;
    const id = leadSet.get(String(deal.leadId));
    if (!id) continue;
    wonBy.set(id, (wonBy.get(id) || 0) + 1);
    revenueBy.set(id, (revenueBy.get(id) || 0) + (deal.revenue || 0));
  }

  /* Meta's own word for what the audience is, where the ad set names one. An
     ad set targeting by interest or geography names no custom audience at all,
     and "no custom audience" is not a type — it is the absence of one. */
  const typeOf = (set) => {
    const kinds = [...new Set((set.audiences || []).map((a) => a && a.subtype).filter(Boolean))];
    if (!kinds.length) return NONE;
    return kinds.map((k) => String(k).toLowerCase().replace(/_/g, ' ')).join(' · ');
  };

  /* **One bucket per segment**, for the revenue roll-up below.
   *
   * The column above lists every subtype an ad set draws from — "custom ·
   * lookalike" is honest on a row. It is useless as a grouping key: an ad set
   * naming three audiences would land in its own bucket of one, and attributing
   * it to all three would count its revenue three times. So a segment gets a
   * single primary type, chosen in the order a media buyer would name it.
   *
   * Broad and interest targeting share a bucket because the insights pull
   * cannot tell them apart — an ad set that names no custom audience might be
   * either, and inventing the distinction would be worse than the honest
   * coarser one. */
  const primaryTypeOf = (set) => {
    const kinds = (set.audiences || []).map((a) => String((a && a.subtype) || '').toUpperCase());
    if (kinds.some((k) => k.includes('LOOKALIKE'))) return 'Lookalike';
    if (kinds.some((k) => k.includes('WEBSITE') || k.includes('ENGAGEMENT'))) return 'Retargeting';
    if (kinds.length) return 'Custom list';
    return 'Broad / interest';
  };

  /* ── Google's half ───────────────────────────────────────────────────────
   *
   * Google has no ad set. Its grouping level is the ad group, and for a Search
   * campaign the targeting *is* the keyword list — which has a screen of its
   * own and does not belong on this one. What Google calls an audience lives at
   * campaign level: Demand Gen and Performance Max are bought against audience
   * signals configured there, and a Search campaign's campaign row is still the
   * unit a budget moves between.
   *
   * So a Google segment is a campaign, and it says so on the row rather than
   * pretending to be the same object as a Meta ad set. Two platforms with two
   * different targeting models in one table is honest; flattening them into one
   * invented "segment" entity would not be.
   *
   * **The CRM join is by campaign name**, which works because both sides pass
   * through the same normaliser — `n.campaignName` strips the platform prefix
   * and the separators from a Google campaign name and from the lead's
   * utm_campaign alike, so "Google | Brand Search" and "brand search" meet in
   * the middle. It is a weaker rung than the ad set id Meta's rows use, and the
   * row's tooltip says which one it stood on. */
  const byCampaign = new Map();
  for (const day of (entities.campaignDays || []).filter((d) => d.platform === 'google_ads')) {
    const key = day.campaign;
    if (!key) continue;
    const acc = byCampaign.get(key) || {
      key, name: day.label || key, spend: 0, impressions: 0, clicks: 0, type: null,
    };
    acc.spend += day.spend || 0;
    acc.impressions += day.impressions || 0;
    acc.clicks += day.clicks || 0;
    if (!acc.type && day.channelType) acc.type = day.channelType;
    byCampaign.set(key, acc);
  }

  /* Leads and won deals keyed the same way, so a campaign row can carry what
     came back from it rather than only what it cost. */
  const leadsByCampaign = new Map();
  const campaignOfLead = new Map();
  for (const lead of entities.leads || []) {
    if (!lead.campaign) continue;
    campaignOfLead.set(String(lead.id), lead.campaign);
    leadsByCampaign.set(lead.campaign, (leadsByCampaign.get(lead.campaign) || 0) + 1);
  }
  const wonByCampaign = new Map();
  const revByCampaign = new Map();
  for (const deal of entities.deals || []) {
    if (deal.outcome !== 'won' || /cancel/i.test(String(deal.bookingStatus || ''))) continue;
    const key = deal.campaign || campaignOfLead.get(String(deal.leadId));
    if (!key) continue;
    wonByCampaign.set(key, (wonByCampaign.get(key) || 0) + 1);
    revByCampaign.set(key, (revByCampaign.get(key) || 0) + (deal.revenue || 0));
  }

  const googleRows = [...byCampaign.values()].map((c) => {
    const leads = leadsByCampaign.get(c.key) || 0;
    const won = wonByCampaign.get(c.key) || 0;
    const revenue = revByCampaign.get(c.key) || 0;
    return {
      platform: 'google',
      /* Google's targeting is the campaign type: a Search campaign is bought
         on keywords, Demand Gen and Performance Max on audience signals. */
      bucket: c.type ? String(c.type).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : 'Unclassified',
      leadCount: leads,
      bookingCount: won,
      revenueValue: revenue,
      name: c.name,
      type: c.type ? String(c.type).toLowerCase().replace(/_/g, ' ') : NONE,
      sat: NONE,
      satColor: NA,
      spend: money(c.spend),
      spendValue: c.spend,
      leads: leads ? count(leads) : NONE,
      bookings: won ? count(won) : NONE,
      abv: won ? money(revenue / won) : NONE,
      rev: won ? money(revenue) : NONE,
      /* Zero only where something was measured and returned nothing. A row no
         CRM lead ever matched has not earned 0.0x — nothing about it was
         measured, and a measured zero and an unmeasured one must not print
         alike on a table somebody moves budget from. */
      roas: leads ? ratio(revenue, c.spend) : NONE,
      roasColor: c.spend > 0 && revenue / c.spend >= 3 ? UP : (revenue > 0 ? WARN : NA),
      tip: 'Google Ads campaign. Reservations are joined by campaign name — the lead\'s utm_campaign against the campaign\'s own, both through the same normaliser — which is a weaker join than the ad set id Meta\'s rows use.',
    };
  });

  const rows = [...bySet.values()].sort((a, b) => b.spend - a.spend);
  const metaSegs = rows.map((set) => {
    const leads = crmLeads.get(set.id) || 0;
    const won = wonBy.get(set.id) || 0;
    const revenue = revenueBy.get(set.id) || 0;
    const named = (set.audiences || []).map((a) => (a && a.name) || null).filter(Boolean);

    return {
      platform: 'meta',
      /* The bucket the revenue roll-up groups on, kept beside the display
         type rather than re-derived from it — a label is not a key. */
      bucket: primaryTypeOf(set),
      leadCount: leads,
      bookingCount: won,
      revenueValue: revenue,
      name: set.name,
      type: typeOf(set),
      /* Frequency against audience size, and neither is fetched. */
      sat: NONE,
      satColor: NA,
      spend: money(set.spend),
      spendValue: set.spend,
      /* The CRM's count, not Meta's reported conversions — the same decision the
         marketing funnel makes, and for the same reason: they count differently
         and only one of them can be followed through to a booking. */
      leads: leads ? count(leads) : NONE,
      bookings: won ? count(won) : NONE,
      /* Average booking value, which the design abbreviates. Only where there
         are bookings to divide by. */
      abv: won ? money(revenue / won) : NONE,
      rev: won ? money(revenue) : NONE,
      /* Zero only where something was measured and returned nothing. A row no
         CRM lead ever matched has not earned 0.0x — nothing about it was
         measured, and a measured zero and an unmeasured one must not print
         alike on a table somebody moves budget from. */
      roas: leads ? ratio(revenue, set.spend) : NONE,
      roasColor: set.spend > 0 && revenue / set.spend >= 3 ? UP : (revenue > 0 ? WARN : NA),
      tip: named.length
        ? `Custom audiences: ${named.join(', ')}`
        : 'No custom audience named on this ad set — interest or geography targeting, which the insights pull cannot see.',
    };
  });

  /* One table, both platforms, ranked by spend.
   *
   * A Meta ad set and a Google campaign are not the same object and the rows
   * say so — the type column carries the audience subtypes on one and the
   * channel type on the other, and each row's tooltip names the join it stood
   * on. Ranking them together is the point: a budget moves between them, and
   * two tables side by side is the arrangement that stops anybody comparing.
   *
   * `spendValue` is the raw figure the sort needs — `spend` is formatted, and
   * sorting on "₹99,085" against "₹1.15L" is a string comparison that puts a
   * lakh below a thousand. */
  const audSegs = [...metaSegs, ...googleRows]
    .sort((x, y) => (y.spendValue || 0) - (x.spendValue || 0));

  /* ── Revenue by audience type, from the CRM ─────────────────────────────
   *
   * The segments table answers "which audience", and a table of a dozen rows
   * does not answer "which KIND of audience is worth buying" — which is the
   * question a media buyer brings to this screen before they know the names.
   *
   * Revenue is the CRM's: won, uncancelled deals reaching the segment through
   * the lead, by ad set id on Meta and by campaign name on Google. Not Meta's
   * reported conversions, which count differently and carry no value, and not
   * GA4's, which knows nothing about an audience.
   *
   * A type with spend and no revenue keeps its row. That is the finding — an
   * audience kind absorbing budget and returning nothing measured is exactly
   * what this panel exists to surface, and dropping it would leave a list of
   * winners with no denominator. */
  const byType = new Map();
  for (const row of [...metaSegs, ...googleRows]) {
    const key = row.bucket || 'Unclassified';
    const acc = byType.get(key) || { type: key, spend: 0, leads: 0, bookings: 0, revenue: 0, segments: 0 };
    acc.spend += row.spendValue || 0;
    acc.leads += row.leadCount || 0;
    acc.bookings += row.bookingCount || 0;
    acc.revenue += row.revenueValue || 0;
    acc.segments += 1;
    byType.set(key, acc);
  }

  const typeRows = [...byType.values()].sort((x, y) => (y.revenue - x.revenue) || (y.spend - x.spend));
  const revenueTop = Math.max(...typeRows.map((t) => t.revenue), 0);
  const revenueAll = typeRows.reduce((t, r) => t + r.revenue, 0);

  const audRevenue = typeRows.map((t) => ({
    type: t.type,
    /* How many segments are behind the figure, so a type carried by one ad set
       does not read like a category. */
    meta: `${count(t.segments)} segment${t.segments === 1 ? '' : 's'} · ${money(t.spend)} spent`,
    rev: t.revenue ? money(t.revenue) : NONE,
    bookings: t.bookings ? count(t.bookings) : NONE,
    roas: t.leads ? ratio(t.revenue, t.spend) : NONE,
    share: revenueAll ? `${((t.revenue / revenueAll) * 100).toFixed(0)}%` : NONE,
    w: revenueTop ? `${Math.max(2, (t.revenue / revenueTop) * 100).toFixed(0)}%` : '0%',
  }));

  /* Where the visitors were, from Google Analytics.
   *
   * The design ranks cities by revenue and GA4 can answer that where ecommerce
   * is tagged, so the column keeps its meaning. Sessions carry the bar, because
   * a city with traffic and no measured purchase is still somewhere the
   * property is being looked at — ranking on revenue alone would drop it off a
   * list titled "Top locations". */
  const citySessions = new Map();
  for (const row of entities.webCityDays || []) {
    if (!row.city) continue;
    citySessions.set(row.city, (citySessions.get(row.city) || 0) + (row.sessions || 0));
  }
  const cityRevenue = new Map();
  for (const row of entities.webCityRevenueDays || []) {
    if (!row.city) continue;
    cityRevenue.set(row.city, (cityRevenue.get(row.city) || 0) + (row.revenue || 0));
  }

  const cities = [...citySessions.entries()]
    .map(([name, sessions]) => ({ name, sessions, revenue: cityRevenue.get(name) || 0 }))
    .sort((a, b) => (b.revenue - a.revenue) || (b.sessions - a.sessions))
    .slice(0, 8);
  const topSessions = Math.max(...cities.map((c) => c.sessions), 0);

  const audGeo = cities.map((c) => ({
    name: c.name,
    rev: c.revenue ? money(c.revenue) : `${count(c.sessions)} sessions`,
    w: topSessions ? `${Math.round((c.sessions / topSessions) * 100)}%` : '0%',
  }));

  /* ── Age and gender, from Meta's own breakdown ───────────────────────────
   *
   * The design titles this "Revenue by age & gender" and no system in this
   * stack can produce it: Meta reports spend, delivery and its own action
   * counts by demographic and never revenue, and what a booking was worth lives
   * in the CRM, which holds no age. So the chart counts LEADS and is labelled
   * leads. Retitling a chart is a smaller lie than filling it.
   *
   * Buckets come from Meta rather than from the design's five, because an
   * account with no 65+ delivery should have no 65+ column — and the design's
   * axis stops at "55+" while Meta reports 55-64 and 65+ separately. */
  /* **Reservations by age and gender cannot be measured, and this is where
   * that gets decided.**
   *
   * Meta splits delivery by demographic and never revenue. A reservation is
   * priced in the CRM, and the CRM records no age — so there is no join, at
   * any level, that puts a booking in an age band. Distributing bookings
   * across bands in proportion to something else would be a model wearing the
   * clothes of a measurement, on the one chart where a reader is most likely
   * to conclude something about people.
   *
   * What Meta does report per band, in the order this prefers it:
   *
   *   leads   the outcome, where the account's lead action is broken down —
   *           on this account it is not, and every band reports zero
   *   clicks  intent, always reported
   *   spend   where the money went, always reported
   *
   * So the chart falls through to the strongest measure with something in it
   * and names the one it drew. A panel showing spend under a title saying
   * leads would be worse than the fixed bars it replaced. */
  const MEASURES = [
    { key: 'leads', label: 'Leads', of: (row) => row.leads || 0, format: (v) => count(v), unit: 'leads' },
    { key: 'clicks', label: 'Clicks', of: (row) => row.clicks || 0, format: (v) => count(v), unit: 'clicks' },
    { key: 'spend', label: 'Spend', of: (row) => row.spend || 0, format: (v) => money(v), unit: 'of spend' },
  ];

  const demoRows = entities.metaDemographicDays || [];
  const measure = MEASURES.find((m) => demoRows.some((row) => row.age && m.of(row) > 0)) || MEASURES[0];

  const demo = new Map();
  for (const row of demoRows) {
    if (!row.age) continue;
    const bucket = demo.get(row.age) || { age: row.age, female: 0, male: 0, other: 0 };
    const gender = String(row.gender || '').toLowerCase();
    const key = gender === 'female' ? 'female' : (gender === 'male' ? 'male' : 'other');
    bucket[key] += measure.of(row);
    demo.set(row.age, bucket);
  }

  /* Meta's bands sort lexically except that "65+" must come last — "18-24"
     through "55-64" order correctly as strings and "65+" does not. */
  const ages = [...demo.values()].sort((x, y) => String(x.age).localeCompare(String(y.age)));
  const peak = Math.max(...ages.map((a) => Math.max(a.female, a.male)), 0);

  /* The design's viewBox, so the bars land inside the axis it already draws. */
  const FLOOR = 120;
  const TALL = 94;
  const slot = ages.length ? 340 / ages.length : 340;
  const barWidth = Math.min(18, Math.max(6, slot / 4));

  const audAge = ages.map((a, i) => {
    const at = (value) => {
      const h = peak ? (value / peak) * TALL : 0;
      return { y: FLOOR - h, h };
    };
    const left = slot * i + (slot - barWidth * 2 - 4) / 2;
    return {
      label: String(a.age),
      x: left,
      maleX: left + barWidth + 4,
      width: barWidth,
      female: at(a.female),
      male: at(a.male),
      femaleLeads: measure.format(a.female),
      maleLeads: measure.format(a.male),
    };
  });

  const total = ages.reduce((t, a) => t + a.female + a.male + a.other, 0);
  const top = [...ages].sort((x, y) => Math.max(y.female, y.male) - Math.max(x.female, x.male))[0];
  const audAgeNote = (() => {
    if (!ages.length) {
      return 'Meta reports no age or gender split in this range — the demographic breakdown may not have synced yet.';
    }
    if (!top || !total) return 'Meta reported the split but nothing measured against it in this range.';
    const best = top.female >= top.male ? 'female' : 'male';
    const value = Math.max(top.female, top.male);
    const share = `${((value / total) * 100).toFixed(0)}%`;
    const why = measure.key === 'leads'
      ? 'Leads, not reservations: Meta reports no revenue by demographic and the CRM records no age, so no booking can be placed in an age band.'
      : `Meta reports no lead action by demographic on this account, so these bars are ${measure.label.toLowerCase()} — the strongest measure it does split. Reservations cannot be split at all: the CRM records no age.`;
    return `${top.age} ${best} took ${measure.format(value)} of ${measure.format(total)} ${measure.unit} (${share}) — the largest single group. ${why}`;
  })();

  return {
    audSegs,
    audGeo,
    audAge,
    audAgeNote,
    audRevenue,
    /* Which measure the bars are, so the panel's title says it rather than
       claiming one thing and drawing another. */
    audAgeMeasure: measure.label,
  };
}

/* ── AI Command Center ────────────────────────────────────────────────────
 *
 * The most dangerous screen in the app, and the last one still entirely
 * authored. It opened with a paragraph in an analyst's voice — "Net revenue
 * closed at ₹52.3L, up 12.4% … Munnar Honeymoon carried it, with CPL down 22%
 * after UGC video 03 took 60% of ad set budget. Confidence 94%" — about a
 * property that does not exist, beside six KPI tiles and eleven bullet points
 * of risks, opportunities and actions, none of them measured. A wrong number is
 * bad; a wrong number with a *reason* attached is worse, because the reason is
 * what a reader acts on.
 *
 * So it is derived, and the rule it is derived under is the one lib/ai/
 * reasoner.js already states for explanations: **no unsourced assertion**.
 * Every sentence below names the figure it is made of and the rows that figure
 * came from. Nothing here infers causality — "CPL fell *after* the budget
 * moved" is a claim about the world that no join in this codebase can support,
 * and it is exactly the sort of sentence the authored version was full of.
 *
 * **No language model is involved, and that is deliberate rather than a gap.**
 * lib/ai/reasoner.js keeps a model-backed reasoner as a stub with its reasons
 * written down: no API key, no reviewed prompt, no evaluation against the
 * six-step contract. This screen is the registry reasoner's output in the
 * design's own layout — more fluent would be nice, less accountable would not.
 *
 * What stays declined: the four health scores, the forecast, the anomaly chain
 * and the simulator. A 0–100 composite is a weighting somebody has to choose
 * and defend, and inventing one here would put a number on the screen with the
 * same confident face as the ones beside it that are real.
 */
function aiScreen(entities, params = {}, base = {}) {
  /* The range this paragraph is about, taken from the resolved window rather
     than from a chip label the projection is not handed. `to` is exclusive —
     the half-open rule lib/metrics/period.js states — so the day before it is
     the last day the figures cover. */
  const over = params.over || null;
  const lastDay = over && over.to
    ? new Date(Date.parse(over.to) - 86400000).toISOString().slice(0, 10)
    : null;
  /* Sliced to a day: the window's edges are full timestamps, and shortDate
     parses a date. Unsliced it printed the ISO string into the headline. */
  const range = over && over.from && lastDay
    ? `${shortDate(String(over.from).slice(0, 10))} – ${shortDate(lastDay)}`
    : null;

  const days = entities.campaignDays || [];
  const spend = sum(days, 'spend');

  const leads = entities.leads || [];
  const tagged = leads.filter((l) => l.channel === 'meta' || l.channel === 'google');

  const won = (entities.deals || []).filter((d) => d.outcome === 'won'
    && !/cancel/i.test(String(d.bookingStatus || '')));
  const cancelled = (entities.deals || []).filter((d) => d.outcome === 'won'
    && /cancel/i.test(String(d.bookingStatus || '')));
  const wonPaid = won.filter((d) => PAID_TAGGED.has(d.channel));
  const crmRevenue = wonPaid.reduce((t, d) => t + (d.revenue || 0), 0);

  const paidSearchRows = (entities.webChannelRevenueDays || [])
    .filter((r) => /^paid\s*search$/i.test(String(r.channelGroup || '')));
  const webRevenue = paidSearchRows.reduce((t, r) => t + (r.revenue || 0), 0);
  const webBookings = paidSearchRows.reduce((t, r) => t + (r.reservations || 0), 0);

  const revenue = crmRevenue + webRevenue;
  const bookings = wonPaid.length + webBookings;
  const roas = spend > 0 ? revenue / spend : null;

  /* Per channel, from the rows both figures already come from — so a sentence
     naming a channel names one the tables elsewhere would also name. */
  const byChannel = new Map();
  for (const day of days) {
    const channel = CHANNEL_OF[day.platform];
    if (!channel) continue;
    const acc = byChannel.get(channel) || { channel, spend: 0, revenue: 0, bookings: 0 };
    acc.spend += day.spend || 0;
    byChannel.set(channel, acc);
  }
  for (const deal of wonPaid) {
    const acc = byChannel.get(deal.channel);
    if (!acc) continue;
    acc.revenue += deal.revenue || 0;
    acc.bookings += 1;
  }
  const google = byChannel.get('google');
  if (google) { google.revenue += webRevenue; google.bookings += webBookings; }
  const channels = [...byChannel.values()].filter((c) => c.spend > 0);

  const kpi = (label, value, note) => ({ label, value, delta: note || '·', deltaColor: NA });

  /* ── the paragraph ─────────────────────────────────────────────────────
     One sentence per measured thing, and a sentence for each thing that is
     measured badly. Assembled rather than written, so it cannot drift from the
     tiles underneath it. */
  const say = [];
  if (!days.length && !leads.length) {
    say.push('Nothing was measured in this range — no ad spend, no leads, and nothing for the rest of this screen to be about.');
  } else {
    say.push(
      `Over ${range || 'the selected range'}, ${money(spend)} of ad spend is matched by ${money(revenue)} of attributed reservation value — ${roas === null ? 'no return on spend can be computed' : `${roas.toFixed(1)}x`}, across ${count(bookings)} reservations.`
    );
    if (webRevenue && crmRevenue) {
      say.push(
        `That total is two books added and not reconciled: ${money(crmRevenue)} the CRM recorded against paid-tagged leads, and ${money(webRevenue)} the booking engine took from sessions Google Analytics classified as paid search. A guest who did both is counted twice, and nothing can separate them until a property management system gives both one folio.`
      );
    }
    if (leads.length) {
      say.push(
        `It is a floor. ${count(tagged.length)} of ${count(leads.length)} leads carry a channel, so revenue from the other ${count(leads.length - tagged.length)} sits outside the numerator while the spend that may have produced it stays in the denominator.`
      );
    }
    const dead = channels.filter((c) => c.spend > 0 && !c.revenue);
    if (dead.length) {
      say.push(
        `${dead.map((c) => `${PLATFORM[`${c.channel}_ads`] || c.channel} spent ${money(c.spend)} with no attributed reservation against it`).join('; ')} — which is a measurement gap as often as it is a performance one.`
      );
    }
    if (cancelled.length && won.length) {
      say.push(`${count(cancelled.length)} won deal${cancelled.length === 1 ? '' : 's'} in range carr${cancelled.length === 1 ? 'ies' : 'y'} a cancelled booking status and ${cancelled.length === 1 ? 'is' : 'are'} excluded from every figure above.`);
    }
    say.push('Every figure here is counted from the same rows the screens behind it show. Nothing on this page infers a cause.');
  }

  const risks = [];
  const opportunities = [];

  const untagged = leads.length - tagged.length;
  if (untagged > 0) {
    risks.push({
      dot: untagged / leads.length > 0.5 ? DOWN : WARN,
      text: `${count(untagged)} of ${count(leads.length)} leads carry no channel`,
      meta: 'Every attributed figure on every screen is a floor by this much · fix is in the CRM lead form, not here',
    });
  }
  for (const c of channels.filter((x) => !x.revenue).sort((a, b) => b.spend - a.spend)) {
    risks.push({
      dot: DOWN,
      text: `${PLATFORM[`${c.channel}_ads`] || c.channel} has no attributed reservation in range`,
      meta: `${money(c.spend)} spent · either nothing closed or nothing was tagged`,
    });
  }
  if (cancelled.length) {
    risks.push({
      dot: WARN,
      text: `${count(cancelled.length)} won deal${cancelled.length === 1 ? '' : 's'} cancelled`,
      meta: `${money(cancelled.reduce((t, d) => t + (d.revenue || 0), 0))} of reservation value removed from every figure`,
    });
  }

  /* Ranked on return, and only where the spend behind it is small enough for
     "spend more" to be the obvious next move. */
  const earning = channels
    .filter((c) => c.revenue > 0 && c.spend > 0)
    .map((c) => ({ ...c, roas: c.revenue / c.spend }))
    .sort((a, b) => b.roas - a.roas);
  const best = earning[0];
  const worst = earning[earning.length - 1];
  if (best) {
    opportunities.push({
      text: `${PLATFORM[`${best.channel}_ads`] || best.channel} returns ${best.roas.toFixed(1)}x on ${money(best.spend)}`,
      meta: `${count(best.bookings)} reservations · the strongest measured return in the account`,
    });
  }
  if (worst && best && worst.channel !== best.channel && worst.roas < best.roas) {
    opportunities.push({
      text: `${PLATFORM[`${worst.channel}_ads`] || worst.channel} returns ${worst.roas.toFixed(1)}x on ${money(worst.spend)}`,
      meta: `${(best.roas / (worst.roas || 1)).toFixed(1)}× the return sits on the other channel at this measurement coverage`,
    });
  }

  /* Actions are the risks and opportunities above, said as the next move, and
     nothing else. No estimate of what a move would earn — that is a forecast,
     and a forecast this codebase has no model for. */
  const actions = [];
  if (best && worst && worst.channel !== best.channel && worst.roas < best.roas) {
    actions.push({
      text: `Compare ${PLATFORM[`${worst.channel}_ads`] || worst.channel} against ${PLATFORM[`${best.channel}_ads`] || best.channel} before the next budget change`,
      meta: `${worst.roas.toFixed(1)}x against ${best.roas.toFixed(1)}x on measured reservations`,
      btn: 'Open',
    });
  }
  if (untagged > 0) {
    actions.push({
      text: 'Capture the channel on every CRM lead form',
      meta: `${count(untagged)} leads in range cannot be attributed to anything`,
      btn: 'Connections',
    });
  }
  if (!paidSearchRows.length) {
    actions.push({
      text: 'No paid-search revenue reported by Google Analytics in range',
      meta: 'The booking engine may not be sending purchase events',
      btn: 'Connections',
    });
  }

  const declined = (rows, why) => (rows || []).map((row) => ({
    ...row, score: NONE, w: '0%', color: NA, chips: [why],
  }));

  return {
    sumTitle: `${range || 'This range'} in one paragraph`,
    sumNarrative: say.join(' '),
    sumKpis: [
      kpi('AD SPEND', spend ? money(spend) : NONE),
      kpi('ATTRIBUTED REVENUE', revenue ? money(revenue) : NONE, 'CRM + GA4'),
      kpi('ROAS', roas === null ? NONE : `${roas.toFixed(1)}x`, 'on measured revenue'),
      kpi('RESERVATIONS', bookings ? count(bookings) : NONE, 'CRM + GA4'),
      kpi('LEADS', leads.length ? count(leads.length) : NONE, 'CRM'),
      /* Replaces "CONFIDENCE 94% composite", which was a number with no
         definition. Attribution coverage is the honest version of the same
         idea: how much of what you are reading can be traced at all. */
      kpi('ATTRIBUTABLE', leads.length ? `${((tagged.length / leads.length) * 100).toFixed(0)}%` : NONE, 'of leads carry a channel'),
    ],
    aiRisks: risks,
    aiOpps: opportunities,
    aiActions: actions,
    /* A 0–100 composite is a weighting somebody has to choose and defend, and
       an invented one would sit on this screen with the same confident face as
       the figures beside it that are real. */
    healthMinis: declined(base.healthMinis, 'no scoring model is defined for this'),
  };
}

/* ── CRM Dashboard ────────────────────────────────────────────────────────
 *
 * The KPI cards were already real — they name registry metrics and the resolver
 * fills them. Three collections underneath were not: the pipeline by stage, the
 * sales leaderboard and the follow-up list, all authored, all sitting under
 * figures that had become measured. That mixture is the worst state a screen
 * can be in: nothing marks where one ends and the other begins.
 *
 * The stages and the leaderboard are answerable from what TeleCRM already
 * sends. The follow-up list is not, and says so.
 */
/* A person's name for a leaderboard, out of whatever the CRM recorded.
 *
 * TeleCRM assigns a lead by identity, and on this workspace that identity is
 * an email address — so the Executive column read "Dhanyasalespnr@gmail.com".
 * The domain carries nothing a reader needs and costs half the column, so it
 * comes off and the full address rides on the row's title attribute, where
 * somebody checking who this is can still find it.
 *
 * **The local part is not parsed further.** "firstnamesales" contains a name
 * and some noise, and no rule separates them that would not also mangle a
 * real one — a column people are ranked in is the last place to put a guess.
 * The connector now asks TeleCRM for a name field first (see leadBody), so a
 * workspace that records one gets it without anything here changing. */
function personName(owner) {
  const raw = String(owner || '').trim();
  if (!raw) return NONE;
  /* An address is shown whole, and lowercased.
   *
   * The domain came off first, which turned firstnamesales@example.com into
   * "Firstnamesales" — a string that reads like a badly transcribed name rather
   * than like the identifier it is. An email announces itself as an account;
   * half of one announces nothing and invites the reader to treat it as a
   * person's name that somebody typed wrong.
   *
   * Lowercased because `n.text` title-cases on the way in and an address is not
   * a name; conventionally they are written lower, and the case carries no
   * meaning a mail server would honour. */
  if (raw.includes('@')) return raw.toLowerCase();
  return raw;
}

/* Initials from the display name, not the address — an email beginning with a
   digit or a dot would otherwise produce an avatar reading ".". */
function personInitials(display) {
  /* The domain first: "firstnamesales@example.com" split on non-letters gives
     firstnamesales / example / com, and the avatar read "DG" — the D of a person
     and the G of their mail provider. */
  const who = String(display || '').split('@')[0];
  const parts = who.split(/[^A-Za-z]+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}
function crmScreen(entities, params = {}, base = {}) {
  const leads = entities.leads || [];
  const deals = entities.deals || [];

  const won = deals.filter((d) => d.outcome === 'won' && !/cancel/i.test(String(d.bookingStatus || '')));
  const dealOfLead = new Map();
  for (const deal of deals) if (deal.leadId) dealOfLead.set(String(deal.leadId), deal);

  /* ── Pipeline by stage ───────────────────────────────────────────────────
   *
   * The design names six stages and the CRM names whatever the workspace typed
   * into it. Rather than force one onto the other, the stages ARE the CRM's,
   * ordered by how far down the funnel they sit where the name is recognised
   * and appended in count order where it is not — a workspace that invents
   * "Awaiting advance" should see it rather than have it disappear into an
   * "other" bucket nobody can act on.
   *
   * Value is the deal attached to the lead, which most open leads do not have:
   * TeleCRM creates the deal at conversion. So an early stage shows a count and
   * no value, which is the truth — there is no quoted figure to sum yet, and
   * the design's "₹12.8L of New" was a number invented for a stage that has
   * none. */
  const ORDER = ['new', 'fresh', 'contacted', 'interested', 'qualified', 'quoted', 'negotiation', 'booked', 'won', 'lost'];
  const byStage = new Map();
  for (const lead of leads) {
    const name = String(lead.stage || '').trim();
    if (!name) continue;
    const acc = byStage.get(name) || { name, count: 0, value: 0 };
    acc.count += 1;
    const deal = dealOfLead.get(String(lead.id));
    if (deal && deal.revenue) acc.value += deal.revenue;
    byStage.set(name, acc);
  }

  const rank = (name) => {
    const at = ORDER.indexOf(String(name).toLowerCase());
    return at === -1 ? ORDER.length : at;
  };
  const stages = [...byStage.values()].sort((x, y) => (rank(x.name) - rank(y.name)) || (y.count - x.count));
  const widest = Math.max(...stages.map((st) => st.count), 0);

  const crmStages = stages.map((st) => ({
    label: st.name,
    n: count(st.count),
    /* Blank rather than ₹0 where no deal is attached yet — an enquiry with no
       quote has no value, it does not have a value of nothing. */
    rev: st.value ? money(st.value) : NONE,
    w: widest ? `${Math.max(2, (st.count / widest) * 100).toFixed(0)}%` : '0%',
  }));

  /* ── Sales performance ───────────────────────────────────────────────────
   *
   * By the owner the CRM records on the lead, which is the only name in this
   * data. Bookings and reservation value are the won deals reaching that owner
   * through their leads.
   *
   * **Response time is not here**, and the design put it on every row: it needs
   * a first-response event per lead, TeleCRM has no account-wide endpoint for
   * actions, and this workspace has never minted the webhook token that would
   * carry them. A leaderboard ranking people on a number nobody measured is the
   * one thing on this screen it would be worst to invent. */
  const byOwner = new Map();
  for (const lead of leads) {
    const owner = String(lead.owner || '').trim();
    if (!owner) continue;
    const acc = byOwner.get(owner) || { owner, leads: 0, bookings: 0, revenue: 0 };
    acc.leads += 1;
    byOwner.set(owner, acc);
  }
  const ownerOfLead = new Map(leads.filter((l) => l.owner).map((l) => [String(l.id), String(l.owner).trim()]));
  for (const deal of won) {
    const owner = ownerOfLead.get(String(deal.leadId));
    if (!owner || !byOwner.has(owner)) continue;
    const acc = byOwner.get(owner);
    acc.bookings += 1;
    acc.revenue += deal.revenue || 0;
  }

  const reps = [...byOwner.values()]
    .sort((x, y) => (y.revenue - x.revenue) || (y.bookings - x.bookings))
    .slice(0, 8)
    .map((r) => ({
      init: personInitials(personName(r.owner)),
      name: personName(r.owner),
      meta: `${count(r.bookings)} booking${r.bookings === 1 ? '' : 's'} · ${count(r.leads)} lead${r.leads === 1 ? '' : 's'}`,
      rev: r.revenue ? money(r.revenue) : NONE,
    }));

  /* ── Follow-ups due ──────────────────────────────────────────────────────
   *
   * Declined, and it is the clearest decline on the screen. A follow-up is due
   * when somebody said they would call back and has not — a promise, recorded
   * as a lead event with a time on it. None of those events are ingested, so
   * every named guest and every "due in 20 min" on this list was invented.
   *
   * The rows keep their shape and lose their content, so the panel reads as a
   * feature waiting on a connection rather than as an empty box. */
  const followups = (base.followups || []).slice(0, 1).map((row) => ({
    ...row,
    name: 'Not measured',
    what: 'A follow-up is a promise recorded against a lead. TeleCRM sends those by webhook and the token has never been minted, so none are in the store.',
    when: NONE,
    meta: NONE,
    dot: NA,
  }));

  /* ── Cards with nothing behind them ─────────────────────────────────────
   *
   * Three of the ten KPIs on this screen name no registry metric, so nothing
   * ever replaced their authored figures and they sat in a row of measured
   * ones, in the same typeface, with no way for a reader to tell:
   *
   *   Pipeline value ₹38.4L, "probability weighted ₹14.2L"
   *   Follow-ups due 46
   *   Stage velocity 3.8 days
   *
   * **Pipeline value is the one worth explaining, because it looks like it
   * should be easy.** It is the value of what is open, and TeleCRM does not
   * price a deal until it converts — every stage below Won/Converted carries
   * a lead count and no money, which is exactly what the stage table above
   * shows. There is no quoted figure to sum, so a pipeline value would have
   * to be invented from an average booking and a per-stage probability
   * nobody has defined. "Probability weighted" names the second of those
   * inventions out loud.
   *
   * Stage velocity needs stage-change events and follow-ups need the promise
   * recorded against a lead; both arrive by the webhook this workspace has
   * never minted, which is the same reason the list beneath them declines.
   *
   * Written as a rule over "has no metric" rather than as three checks, so
   * the next authored card somebody adds is caught by it — the same rule the
   * marketing dashboard applies to its own row. */
  /* **Pipeline value, computed rather than assumed absent.**
   *
   * The card was declined on the reasoning that TeleCRM prices a deal only at
   * conversion — which is true of most of this workspace's deals and is not a
   * reason to stop looking. A deal that exists and has neither been won nor
   * lost IS open pipeline, whatever stage its lead sits in, and its value is
   * recorded. So it is summed, and the card declines only when that sum is
   * genuinely empty.
   *
   * Cancelled is excluded for the same reason it is everywhere else: a booking
   * that was called off is not money in the pipeline.
   *
   * "Probability weighted" stays gone. That needs a per-stage probability
   * nobody has defined, and it was the second invention on a card that had
   * two. */
  const openDeals = deals.filter((d) => {
    const outcome = String(d.outcome || '').toLowerCase();
    if (outcome === 'won' || outcome === 'lost') return false;
    return !/cancel/i.test(String(d.bookingStatus || ''));
  });
  const openValue = openDeals.reduce((t, d) => t + (d.revenue || 0), 0);

  /* ── When the CRM records no open value, estimate it — and say so ────────
   *
   * Across the whole store, value exists on exactly two stages: Won/Converted
   * (₹452.76L) and a handful of Lost. Fresh, Interested, Just an enquiry,
   * Ringing no answer and Travel Agency carry none between them, because
   * TeleCRM writes a deal's value at conversion and not before. So there is no
   * open pipeline to sum, and a dash was the honest answer.
   *
   * It was also a useless one, asked for three times. The figure people want is
   * the expected value of what is open, and this workspace's own history
   * supplies both terms: how often a lead converts, and what one is worth when
   * it does. Multiplying those by the leads still in play is a forecast, not a
   * measurement — so it is labelled an estimate, the arithmetic is printed
   * under it, and the tip names both inputs.
   *
   * **This is the one modelled number in the app.** It is here because the
   * alternative was a permanent dash on the card a sales manager opens the
   * screen for. The design's "probability weighted ₹14.2L" was the same idea
   * with the probability invented; this one uses the rate the CRM actually
   * shows. If TeleCRM ever prices a quote, the measured sum above wins and this
   * disappears — which is the right precedence and the reason it is written
   * second. */
  const CLOSED_STAGE = /(won|converted|lost|not interested|closed)/i;
  const openLeads = leads.filter((l) => l.stage && !CLOSED_STAGE.test(String(l.stage)));
  const wonValue = won.reduce((t, d) => t + (d.revenue || 0), 0);
  const closeRate = leads.length ? won.length / leads.length : null;
  const averageWon = won.length ? wonValue / won.length : null;
  const estimate = (openLeads.length && closeRate && averageWon)
    ? openLeads.length * closeRate * averageWon
    : null;

  const WHY = {
    'Pipeline value': 'TeleCRM prices a deal when it converts, not when it is quoted, so open leads carry no value to sum. A figure here would be an average booking multiplied by a per-stage probability nobody has defined.',
    'Follow-ups due': 'A follow-up is a promise recorded against a lead. Those arrive by webhook and this workspace has never minted the token, so none are in the store.',
    'Stage velocity': 'Time between stages needs a stage-change event per lead. TeleCRM sends those by webhook and the token has never been minted.',
  };

  /* Filled where it can be, declined where it cannot — and the sub-line says
     which, because "—" and "₹4.2L across 30 open deals" send a reader to very
     different places. */
  const answered = {
    /* Recorded first, estimated second, dash last. */
    'Pipeline value': openValue ? {
      value: money(openValue),
      sub: `${count(openDeals.length)} open deal${openDeals.length === 1 ? '' : 's'} · value the CRM has recorded`,
      tip: 'Deals the CRM has neither won nor lost, at the value entered against them. Cancelled bookings excluded. It is a floor: TeleCRM prices most deals only at conversion, so an enquiry with no quote against it contributes nothing here.',
    } : (estimate ? {
      value: money(estimate),
      /* The arithmetic, on the card. An estimate whose method is a tooltip away
         is an estimate people quote as a measurement. */
      sub: `estimated · ${count(openLeads.length)} open × ${(closeRate * 100).toFixed(1)}% close × ${money(averageWon)}`,
      tip: `An ESTIMATE, not a recorded figure. TeleCRM writes a deal's value when it converts, so nothing open carries one and there is no sum to take. This is the leads still in play, at this workspace's own observed close rate (${(closeRate * 100).toFixed(1)}% across ${count(leads.length)} leads) and its own average won reservation (${money(averageWon)} across ${count(won.length)}). It moves when either does, and it is replaced by a real sum the day the CRM prices a quote.`,
    } : null),
  };

  const decline = (rows) => (rows || []).map((card) => {
    if (card.metric) return card;
    const filled = answered[card.label];
    if (filled) {
      return {
        ...card,
        value: filled.value,
        delta: '·',
        deltaColor: NA,
        ...(('sub' in card) ? { sub: filled.sub } : {}),
        tip: filled.tip,
      };
    }
    return {
      ...card,
      value: NONE,
      delta: '·',
      deltaColor: NA,
      ...(('sub' in card) ? { sub: '' } : {}),
      tip: WHY[card.label] || `${card.label} has no definition behind it in this build — it is not measured, and the figure that used to sit here was authored.`,
    };
  });

  return {
    crmStages,
    reps,
    followups,
    crmHero: decline(base.crmHero),
    crmKpis: decline(base.crmKpis),
  };
}

/* ── Sales Pipeline ───────────────────────────────────────────────────────
 *
 * Authored down to the guests: Rahul Menon at ₹31,000 on a 2BR houseboat,
 * untouched three hours. Six columns with counts, conversion rates, average
 * days in stage and a drop percentage, none of it measured.
 *
 * The columns and the cards in them are answerable — the CRM holds the stage,
 * the name, the owner and the property. What is not answerable is every figure
 * describing MOVEMENT between stages: a conversion rate, a time in stage and a
 * drop rate all need to know when a lead entered and left one, and that is a
 * stage-change event. TeleCRM has no account-wide endpoint for actions, so
 * those arrive by webhook and this workspace has never minted the token.
 *
 * So the board is real and the three figures above each column decline. That is
 * the honest shape of a pipeline built on a CRM whose history is not being
 * ingested — and it is worth being blunt about, because a conversion rate per
 * stage is exactly the number somebody would restructure a sales team around.
 */
function pipelineScreen(entities, params = {}, base = {}) {
  const leads = entities.leads || [];
  const deals = entities.deals || [];

  const dealOfLead = new Map();
  for (const deal of deals) if (deal.leadId) dealOfLead.set(String(deal.leadId), deal);

  /* Same ordering rule as the CRM dashboard's stage table: down the funnel
     where the name is recognised, by size where the workspace invented it. */
  const ORDER = ['new', 'fresh', 'contacted', 'interested', 'hot', 'qualified', 'quoted', 'negotiation', 'booked', 'won', 'won/converted', 'lost'];
  const rank = (name) => {
    const at = ORDER.indexOf(String(name).toLowerCase());
    return at === -1 ? ORDER.length : at;
  };

  const byStage = new Map();
  for (const lead of leads) {
    const name = String(lead.stage || '').trim();
    if (!name) continue;
    const acc = byStage.get(name) || { name, leads: [], value: 0 };
    acc.leads.push(lead);
    const deal = dealOfLead.get(String(lead.id));
    if (deal && deal.revenue) acc.value += deal.revenue;
    byStage.set(name, acc);
  }

  const CHANNEL_ICON = { meta: 'ph ph-meta-logo', google: 'ph ph-google-logo' };

  const pipeStages = [...byStage.values()]
    .sort((x, y) => (rank(x.name) - rank(y.name)) || (y.leads.length - x.leads.length))
    .map((stage) => {
      /* Newest first, and only a handful: a column is a sample of what is in
         the stage, not the stage itself — the count above it is the stage. */
      const cards = [...stage.leads]
        .sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')))
        .slice(0, 6)
        .map((lead) => {
          const deal = dealOfLead.get(String(lead.id));
          const days = lead.createdAt
            ? Math.floor((Date.now() - Date.parse(lead.createdAt)) / MS_PER_DAY)
            : null;
          return {
            name: lead.name || 'Unnamed enquiry',
            /* Only where a deal exists. TeleCRM prices a deal at conversion, so
               an open lead genuinely has no value — inventing one is how the
               "₹18.6L open pipeline" in the heading came to exist. */
            val: deal && deal.revenue ? money(deal.revenue) : '',
            /* Empty rather than a dash: the card omits the line when there is
               nothing to put on it, and three stacked dashes was most of what a
               card said. */
            what: lead.property || (lead.campaign ? String(lead.campaign) : ''),
            own: personInitials(personName(lead.owner)),
            /* Age since the enquiry arrived — the one time on this card that is
               measured. "Untouched 3h" was a different claim: it says nobody
               replied, which needs the response event nothing is sending. */
            age: days === null ? NONE : (days === 0 ? 'today' : `${days}d old`),
            ageColor: days === null ? MUTED : (days > 14 ? DOWN : (days > 3 ? WARN : MUTED)),
            chan: CHANNEL_ICON[lead.channel] || 'ph ph-user-circle',
          };
        });

      return {
        name: stage.name,
        n: count(stage.leads.length),
        /* Empty rather than a dash — the header shows it only when there is one,
           and a dash beside every stage name was noise on twelve columns. */
        rev: stage.value ? money(stage.value) : '',
        /* All three need a stage-change event per lead, and none is ingested.
           The view drops the whole row rather than printing "conv — avg — drop —"
           on every column, which was three dead labels per stage. */
        conv: NONE,
        time: NONE,
        drop: NONE,
        dropColor: NA,
        measured: false,
        cards,
        /* How many are behind the six shown, so a column says what it is a
           sample of rather than implying it holds six leads. */
        more: Math.max(0, stage.leads.length - cards.length),
      };
    });

  /* **A board is a board up to about eight columns.**
   *
   * The design drew six stages. This CRM has twelve — Fresh, Interested, Just
   * an enquiry, Ringing no answer, Travel Agency, Not interested, Not
   * available, Busy, Switched off, Hot, Won/Converted, Lost — because a
   * workspace names its own, and every one of them is real. Rendered flat that
   * is a horizontal scroll nobody reaches the end of, where the two hundred
   * leads that matter sit beside twenty-six that are switched off.
   *
   * So the board shows the largest eight and the rest collapse into one
   * summary column that names them with their counts. Nothing is hidden and
   * nothing is invented: the tail is still on screen, just not given a column
   * each. The List view is unchanged and still carries every stage in full. */
  const BOARD = 8;
  const shown = pipeStages.slice(0, BOARD);
  const tail = pipeStages.slice(BOARD);

  return {
    pipeStages: shown,
    /* The List view answers "all of it", so it gets the whole set. */
    pipeAllStages: pipeStages,
    pipeTail: tail.length ? {
      count: count(tail.length),
      leads: count(tail.reduce((t, st) => t + Number(String(st.n).replace(/\D/g, '')) || 0, 0)),
      names: tail.map((st) => `${st.name} ${st.n}`),
    } : null,
  };
}

/* ── Sales Analytics ──────────────────────────────────────────────────────
 *
 * A leaderboard of five named people with calls made, WhatsApp sent, response
 * times, a close rate, a coaching note and a five-star rating — and the CRM
 * holds none of it except who owns which lead.
 *
 * What is real: how many leads a person owns, how many became bookings, what
 * those were worth, and the rate between them. That is a leaderboard, and it is
 * the part somebody can act on.
 *
 * What is not: calls, WhatsApp messages and response times are activity, which
 * is the lead-event stream nothing is ingesting. The rating and the coaching
 * note are a judgement no model here makes. Compliance is a score nobody has
 * defined. Each declines in place rather than being dropped, because a column
 * that vanishes is a column nobody asks about again.
 */
function salesScreen(entities, params = {}, base = {}) {
  const leads = entities.leads || [];
  const won = (entities.deals || []).filter((d) => d.outcome === 'won'
    && !/cancel/i.test(String(d.bookingStatus || '')));

  const ownerOfLead = new Map();
  const byOwner = new Map();
  for (const lead of leads) {
    const owner = String(lead.owner || '').trim();
    if (!owner) continue;
    ownerOfLead.set(String(lead.id), owner);
    const acc = byOwner.get(owner) || { owner, leads: 0, bookings: 0, revenue: 0 };
    acc.leads += 1;
    byOwner.set(owner, acc);
  }
  for (const deal of won) {
    const owner = ownerOfLead.get(String(deal.leadId));
    if (!owner || !byOwner.has(owner)) continue;
    const acc = byOwner.get(owner);
    acc.bookings += 1;
    acc.revenue += deal.revenue || 0;
  }

  const rows = [...byOwner.values()].sort((x, y) => (y.revenue - x.revenue) || (y.bookings - x.bookings));
  /* The median close rate, so a row is coloured against the team rather than
     against a target nobody set. */
  const rates = rows.filter((r) => r.leads).map((r) => r.bookings / r.leads).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : null;

  const salesRows = rows.map((r) => {
    const rate = r.leads ? r.bookings / r.leads : null;
    return {
      init: personInitials(personName(r.owner)),
      name: personName(r.owner),
      /* The address the CRM actually recorded, for the row's title — the
         column shows who, and this says exactly which account that is. */
      who: r.owner,
      bookings: count(r.bookings),
      rev: r.revenue ? money(r.revenue) : NONE,
      abv: r.bookings ? money(r.revenue / r.bookings) : NONE,
      close: rate === null ? NONE : `${(rate * 100).toFixed(1)}%`,
      closeColor: rate === null || median === null ? NA : (rate >= median ? UP : DOWN),
      /* Activity, which is the lead-event stream nothing ingests. */
      calls: NONE,
      wa: NONE,
      resp: NONE,
      respColor: NA,
      /* A judgement and a score, neither of which anything here defines. */
      comp: NONE,
      compColor: NA,
      coach: 'Not measured — activity, coaching notes and ratings need the CRM event stream, which is not being ingested.',
      rating: NONE,
    };
  });

  /* The team, summed from the rows above rather than from a second read — a
   * footer and its column disagreeing is the classic way a table loses trust.
   *
   * **The rates are recomputed, never averaged.** A close rate is bookings over
   * leads, and the mean of five people's close rates is not the team's: it
   * weights somebody with nine leads the same as somebody with nine hundred.
   * Same for average booking value, which is total revenue over total bookings.
   *
   * The declined columns stay declined. A total of six dashes is not zero. */
  const totals = rows.reduce((t, r) => ({
    leads: t.leads + r.leads,
    bookings: t.bookings + r.bookings,
    revenue: t.revenue + r.revenue,
  }), { leads: 0, bookings: 0, revenue: 0 });

  const salesTotal = rows.length ? {
    init: '',
    name: `All ${count(rows.length)} executive${rows.length === 1 ? '' : 's'}`,
    who: `${count(totals.leads)} leads owned`,
    bookings: count(totals.bookings),
    rev: totals.revenue ? money(totals.revenue) : NONE,
    abv: totals.bookings ? money(totals.revenue / totals.bookings) : NONE,
    close: totals.leads ? `${((totals.bookings / totals.leads) * 100).toFixed(1)}%` : NONE,
    closeColor: NA,
    calls: NONE, wa: NONE, resp: NONE, respColor: NA,
    comp: NONE, compColor: NA, coach: '', rating: NONE,
  } : null;

  /* Every call KPI is an activity figure. Same stream, same absence. */
  const callKpis = (base.callKpis || []).map((card) => ({
    ...card, value: NONE, delta: '·', deltaColor: NA,
  }));

  return { salesRows, salesTotal, callKpis };
}

const PROJECTIONS = {
  dashboard,
  campaigns,
  marketing,
  leads,
  creatives,
  'overlay-creative-detail': overlayCreativeDetail,
  website,
  attribution,
  audiences: audiencesScreen,
  ai: aiScreen,
  crm: crmScreen,
  pipeline: pipelineScreen,
  sales: salesScreen,
};

module.exports = { PROJECTIONS, coverage, money, count, pct, ratio, NONE, PLATFORM, bookingsByCampaign };
