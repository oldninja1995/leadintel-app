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
    label: 'Best',
    /* Action first; within an action, the *money at stake*.
     *
     * This ranked cheapest-lead-first within a group, which is right for Scale
     * and backwards for Stop: it put the creative wasting the least above the
     * one wasting the most. A ₹374 stop outranked a ₹68,682 stop.
     *
     * Spend is the one tiebreak that reads correctly in every group, because it
     * is not a judgement about the creative at all — it is how much money is
     * riding on the decision. It falls through to the ranking's own spend
     * tiebreak below, so this comparator only has to order the actions. */
    comparator: (a, b) => (
      verdicts.ACTION_ORDER.indexOf(a.call.action) - verdicts.ACTION_ORDER.indexOf(b.call.action)
    ),
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
  const pool = (measured.length ? measured : all)
    .map((c) => ({ ...c, funnel: funnels.stageFor(c, audiences) }));
  const judged = pool.map((c) => {
    const worn = fatigue.score(c.series);
    const spent = c.spend === null || c.spend === undefined ? null : c.spend;
    return {
      c,
      worn,
      ran: window_(c.series),
      leads: c.leads || 0,
      cpl: (c.leads > 0 && spent !== null) ? spent / c.leads : null,
    };
  });
  verdicts.decide(judged).forEach((call, i) => { judged[i].call = call; });

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

  const ranked = judged.sort(VIEWS[view].chronological ? chronological : ranking);
  const rows = ranked.map((j) => j.c);

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

  /* The control cycles rather than opening a menu: the design draws no menu,
     and inventing one would mean writing markup into a generated view. */
  const nextSort = SORT_ORDER[(SORT_ORDER.indexOf(key) + 1) % SORT_ORDER.length];

  return {
    sortLabel: SORTS[key].label,
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
      go: `/creatives?view=${view}&sort=${name}`,
      active: name === key,
    })),
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
    verdictLegend: `Action — what to do about the creative, from its fatigue and its cost per lead against the account median (${verdicts.MIN_LEADS}+ leads to be judged on cost).`,
    creatives: ranked.map(({ c, worn, ran, call }, index) => {
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
      ? `url('/creatives/${encodeURIComponent(c.adId)}/thumbnail') center/cover no-repeat, ${fallback}`
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
    dur: funnels.label(c.funnel) || NONE,
    /* Why that matters, on hover: a Top-of-funnel creative that books nothing
       is not underperforming, it is doing what was bought. */
    durWhy: funnels.meaning(c.funnel),
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
    cpl: (c.leads === null || c.leads === undefined || c.spend === null)
      ? NONE
      : (c.leads > 0 ? money(c.spend / c.leads) : NONE),
    ctr: c.impressions ? pct(c.clicks, c.impressions) : NONE,
    spend: c.spend === null ? NONE : money(c.spend),
    /* Three cells that could never be filled from Meta — bookings, revenue and
       net ROAS all need PMS and CRM data that is still fixtures — now carry
       three that can. Their labels are re-bound to match; a cell showing CPM
       under a heading that says BOOKINGS would be worse than the dash it
       replaced. */
    bookings: c.cpm === null || c.cpm === undefined ? NONE : rupees(c.cpm),
    rev: c.frequency === null || c.frequency === undefined ? NONE : `${c.frequency.toFixed(1)}×`,
    roas: (c.spend === null || !c.clicks) ? NONE : rupees(c.spend / 100 / c.clicks),
    roasColor: 'var(--color-neutral-300)',
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
    winning: (() => {
      const hold = fatigue.holdRate(c);
      return hold === null ? '0%' : `${Math.min(100, hold * 100).toFixed(1)}%`;
    })(),
    /* The instruction. A fatigue score tells a reader something is wrong and
       leaves them to decide what to do about it, which is the half of the job
       that was missing — see lib/creative-verdict.js. */
    verdict: call.label,
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

const PROJECTIONS = {
  campaigns,
  leads,
  creatives,
  'overlay-creative-detail': overlayCreativeDetail,
};

module.exports = { PROJECTIONS, coverage, money, count, pct, ratio, NONE, PLATFORM, bookingsByCampaign };
