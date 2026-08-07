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

const { UP, DOWN, WARN, NA, MUTED, spark } = require('../../data/_tokens');
const fatigue = require('../creative-fatigue');

/* What a source id is called on screen. */
const PLATFORM = { meta_ads: 'Meta', google_ads: 'Google' };

/* The one value that says "the entities cannot answer this". Kept as a constant
   because grepping for it is how you audit an ingested screen's real coverage. */
const NONE = '—';
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

function campaigns(entities) {
  const byCampaign = {};
  for (const day of entities.campaignDays) {
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
      go: '/campaigns?v=campDetail',
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

  return { campRows };
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
 *   fatigue, winning    scores this product does not compute. Phase 8 already
 *                       records the fatigue rule as unevaluable for the same
 *                       reason
 *
 * A creative that has never been measured reports `—` for spend and CTR rather
 * than ₹0 and 0%, because an ad with no insight rows has no measurement — it
 * did not spend nothing.
 */
function creatives(entities) {
  const all = entities.creatives || [];

  /* **Only creatives something measured.**
   *
   * Meta's ads edge answers with every ad the account has ever created, while
   * insights cover the window that was pulled. On a real account that is 1,175
   * ads against 47 with spend — so showing all of them fills the screen with
   * ads that ran years ago and correctly report `—` for every column. The
   * reader cannot tell those from a broken pipeline, and the 47 that matter are
   * buried among them.
   *
   * Unmeasured ads are not *wrong*, they are out of window, so this is a
   * display decision rather than a data one: they stay in the entities and out
   * of the ranking. Widening the pull window is what brings more of them back,
   * which is a different lever and belongs to the connector.
   *
   * If nothing at all was measured the whole set is shown instead — an empty
   * screen would read as a broken connection rather than a quiet fortnight. */
  const measured = all.filter((c) => c.spend !== null && c.spend !== undefined);
  const rows = (measured.length ? measured : all)
    .slice()
    /* Biggest spend first: the screen is a ranking, and an unordered one makes
       the reader do the sorting. */
    .sort((a, b) => (b.spend || 0) - (a.spend || 0));

  /* Keyed by the collection name the data module uses, because the driver
     spreads this over the screen's payload — returning a bare array would
     scatter it across the payload as numbered keys and leave the screen
     rendering its authored rows, silently. */
  /* Meta's own names for what a creative is. */
  const FORMAT = {
    VIDEO: { type: 'Video', icon: 'ph-fill ph-play-circle' },
    SHARE: { type: 'Image', icon: 'ph-fill ph-image-square' },
    PHOTO: { type: 'Image', icon: 'ph-fill ph-image-square' },
    STATUS: { type: 'Text', icon: 'ph-fill ph-text-aa' },
    LINK: { type: 'Link', icon: 'ph-fill ph-link-simple' },
    INVALID: { type: NONE, icon: 'ph-fill ph-image-square' },
  };

  return { creatives: rows.map((c) => {
    const format = FORMAT[c.objectType] || { type: c.objectType || NONE, icon: 'ph-fill ph-image-square' };
    const worn = fatigue.score(c.series);

    /* The card's image is delivered through the `grad` field the design already
       binds — `background:<%= cr.grad %>` — so the creative shows without
       touching views/screens/, which the converter owns and a re-run would
       overwrite. The gradient stays underneath as the fallback: if the proxy
       404s on an expired signature, the card degrades to how it looked before
       rather than to a broken-image icon. */
    const backdrop = c.thumbnailUrl
      ? `url('/creatives/${encodeURIComponent(c.adId)}/thumbnail') center/cover no-repeat, linear-gradient(135deg,#2b2741,#5d5294)`
      : 'linear-gradient(135deg,#2b2741,#5d5294)';

    return {
    go: '/creatives?cr=1',
    title: c.title || c.adId,
    type: format.type,
    icon: format.icon,
    grad: backdrop,
    dur: NONE,
    platform: PLATFORM[c.platform] || 'Meta',
    /* The design's `hook` is a line of prose under the title. It carries the
       two video rates, because the card has no cell left for them and this is
       where a reader looks for how the creative opens and whether it holds.
       An image ad says so rather than showing 0% twice — it did not fail to
       hold attention, it has no video to hold it with. */
    hook: (() => {
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
    cpl: (c.leads === null || c.leads === undefined || c.spend === null)
      ? NONE
      : (c.leads > 0 ? money(c.spend / c.leads) : NONE),
    ctr: c.impressions ? pct(c.clicks, c.impressions) : NONE,
    spend: c.spend === null ? NONE : money(c.spend),
    bookings: NONE,
    rev: NONE,
    roas: NONE,
    roasColor: 'var(--color-neutral-400)',
    /* Unknown is never healthy: too little history renders "—" in a neutral
       colour rather than a reassuring green zero. */
    fatigue: worn ? String(worn.score) : NONE,
    fatigueBg: worn ? worn.bg : 'transparent',
    fatigueColor: worn ? worn.color : 'var(--color-neutral-400)',
    winning: NONE,
    };
  }) };
}

const PROJECTIONS = { campaigns, leads, creatives };

module.exports = { PROJECTIONS, coverage, money, count, pct, ratio, NONE, PLATFORM, bookingsByCampaign };
