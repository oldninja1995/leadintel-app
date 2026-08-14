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

  const campRows = Object.entries(byCampaign).map(([campaign, days]) => {
    const spend = sum(days, 'spend');
    const impressions = sum(days, 'impressions');
    const clicks = sum(days, 'clicks');
    const leads = sum(days, 'leads');
    const won = bookings[campaign] || [];
    const revenue = revenueOf(won);

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

  return rows.map((c) => {
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
      bookings: NONE,
      rev: NONE,
      roas: NONE,
      roasColor: MUTED,
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

  return Object.values(byAdset).map((days) => {
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
      bookings: NONE,
      rev: NONE,
      roas: NONE,
      roasColor: MUTED,
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

function leads(entities) {
  const platformOf = new Map(entities.campaignDays.map((d) => [d.campaign, PLATFORM[d.platform] || d.platform]));

  /* A lead's `campaign` is the cleaned join key ("munnar honeymoon jul") — the
     right thing to join on and the wrong thing to show someone. The ad
     platform's own label is carried alongside it for exactly this. */
  const labelOf = new Map(entities.campaignDays.map((d) => [d.campaign, d.label]));

  /* A lead's value is its booking's revenue where one exists — a real figure
     from the PMS folio, not an estimate of what the lead might be worth. */
  const bookingByLead = new Map(entities.bookings.filter((b) => b.leadId).map((b) => [b.leadId, b]));

  const leadRows = entities.leads.map((lead) => {
    const booking = bookingByLead.get(lead.id);
    const stage = lead.stage || NONE;

    return {
      go: '/leads?v=leadProfile',
      name: lead.name || NONE,
      phone: lead.phone || NONE,
      property: lead.property || NONE,
      campaign: (lead.campaign && (labelOf.get(lead.campaign) || lead.campaign)) || NONE,
      platform: (lead.campaign && platformOf.get(lead.campaign)) || NONE,
      owner: lead.owner || NONE,
      stage,
      stageColor: STAGE_COLOUR[String(stage).toLowerCase()] || NA,
      value: booking ? money(value(booking.revenue)) : NONE,
      scoreColor: NA,
      checkColor: NA,
      fuColor: MUTED,
      ...declined(LEAD_DECLINED),
    };
  });

  return { leadRows };
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
  const leadsByAd = new Map();
  for (const lead of entities.leads || []) {
    const ad = lead.adId && String(lead.adId);
    if (!ad) continue;
    if (!leadsByAd.has(ad)) leadsByAd.set(ad, []);
    leadsByAd.get(ad).push(lead);
  }
  const adOfLead = new Map((entities.leads || []).filter((l) => l.adId).map((l) => [String(l.id), String(l.adId)]));
  const bookingsByAd = new Map();
  for (const booking of entities.bookings || []) {
    const ad = booking.leadId && adOfLead.get(String(booking.leadId));
    if (!ad) continue;
    if (!bookingsByAd.has(ad)) bookingsByAd.set(ad, []);
    bookingsByAd.get(ad).push(booking);
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
             Carries the stage through, so the two filters compose. */
          go: `/creatives?view=${view}&sort=${key}&goal=${goalKey}&action=${a}`
            + (STAGES.has(stageAsked) ? `&stage=${stageAsked}` : ''),
          /* Clickable, so the census reads as a control rather than a caption.
             Carries the current stage so the two filters compose. */
          go: `/creatives?view=\&sort=\&goal=\&action=${stageAsked && STAGES.has(stageAsked) ? `&stage=` : ''}`,
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
    bestByStage: scoring.bestByStage(scored).map(({ stage, row }) => ({
      stage,
      marker: { TOFU: '🔵', MOFU: '🟣', BOFU: '🟠', UNKNOWN: '⚪' }[stage],
      label: stage === 'UNKNOWN' ? 'Unclassified' : stage,
      title: row.creative.title || row.creative.adId,
      score: String(row.score),
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
    fatigueColor: worn ? worn.color : '#c9ccd6',
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

  const NAMES = { meta: 'Meta Ads', google: 'Google Ads' };
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
      const revenue = revenueBy.get(channel) || 0;

      /* A sparkline of this platform's own daily spend, in date order — the
         authored one was a shape, not a series. */
      const series = [...row.days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const peak = Math.max(...series.map((d) => d.spend || 0), 1);

      return {
        name: NAMES[channel] || channel,
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
        /* CRM reservation value, which is what the CRM columns beside it are
           counted from. Zero revenue on real spend is a real answer — it means
           nothing this channel produced has been tagged and won — so it prints
           as a figure rather than a dash. */
        rev: money(revenue),
        roas: row.spend ? ratio(revenue / row.spend) : NONE,
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
    recColor: tone === 'up' ? 'var(--color-accent-300)' : tone === 'warn' ? '#ffcf85' : 'var(--color-neutral-400)',
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

function marketing(entities) {
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
  const leads = (entities.leads || []).length;
  const qualified = (entities.leads || []).filter((l) => INTERESTED.test(String(l.stage || ''))).length;
  const won = (entities.deals || []).filter((d) => d.outcome === 'won'
    && !/cancel/i.test(String(d.bookingStatus || ''))).length;

  const stage = (label, value, of, width) => ({
    label,
    n: value ? count(value) : NONE,
    pct: value && of ? pct(value, of) : NONE,
    w: value ? width : '0%',
  });

  return {
    mktFunnel: [
      { label: 'Impressions', n: impressions ? count(impressions) : NONE, pct: impressions ? '100%' : NONE, w: impressions ? '100%' : '0%' },
      stage('Clicks', clicks, impressions, '62%'),
      stage('Leads', leads, clicks, '38%'),
      /* Was always dashed — nothing knew what qualified meant. It is the same
         rule the interested-rate tile uses, imported so the two cannot drift. */
      stage('Qualified', qualified, leads, '24%'),
      /* Was the PMS's bookings, which is 0 with no PMS. The CRM's won
         reservations are what the rest of this screen counts. */
      stage('Bookings', won || bookings, qualified || leads, '12%'),
    ],
    platforms: platformRows(entities),
  };
}

const PROJECTIONS = {
  campaigns,
  marketing,
  leads,
  creatives,
  'overlay-creative-detail': overlayCreativeDetail,
};

module.exports = { PROJECTIONS, coverage, money, count, pct, ratio, NONE, PLATFORM, bookingsByCampaign };
