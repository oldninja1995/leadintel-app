/* Best Overall — what a creative is worth to the business.
 *
 * A resort does not buy leads, it books rooms. Cost per lead is the measure the
 * ad platform can produce on its own, which is why it was the default, and it
 * is the wrong thing to optimise: the cheapest creative on platform-reported
 * CPL is routinely the one filling the pipeline with people who were never
 * going to stay. The measure that matters is what an interested lead costs, and
 * after that what the leads actually did.
 *
 * The worked example this was built against, and the case it must never get
 * wrong:
 *
 *              CPL     Interested   Booking   ROAS
 *   Creative A  ₹120        8%          1%    1.5x
 *   Creative B  ₹180       25%          5%    4.5x
 *
 * B ranks above A. It costs half again as much per lead and returns three times
 * the revenue, and any ranking that puts A first is measuring the wrong thing.
 *
 * ── how the score is built ─────────────────────────────────────────────────
 *
 * Six components, each normalised to 0–100 against the creatives on the screen,
 * then weighted. The weights are one object at the top of this file so they can
 * be changed without touching anything else:
 *
 *   35%  cost per interested lead   the point of the whole exercise
 *   25%  lead -> booking rate        did the leads actually book
 *   20%  ROAS                        what came back for what went out
 *   10%  interested lead rate        quality of what the creative attracts
 *    5%  CTR                         does it earn the click at all
 *    5%  fatigue                     is it still working, or on the way down
 *
 * **Raw values are never added together.** ₹340 a lead, 25%, 4.5x and a fatigue
 * of 51 are four different kinds of number, and summing them produces something
 * with no meaning that still sorts. Each is turned into a 0–100 score against
 * the set first, and the direction is per component: for a cost, lower is
 * better; for a rate or a ratio, higher is.
 *
 * **Normalised against the set, robustly.** A single creative at ten times the
 * account's cost per lead would, under plain min-max scaling, compress every
 * other creative into the top few points and flatten the ranking. Values are
 * therefore winsorised at the 10th and 90th percentiles before scaling, so one
 * outlier moves the ends of the range and not the order of everything inside
 * it.
 *
 * **Fatigue is a modifier, not a verdict.** It carries 5%, and its worst case
 * costs a creative five points out of a hundred. A creative booking at four
 * times the account's rate does not stop being the best thing on the account
 * because it has been seen three times, and a ranking that let fatigue override
 * business performance would be a ranking that recommends replacing winners.
 */

const fatigueScore = require('./creative-fatigue');

/* ── weights ────────────────────────────────────────────────────────────────
 *
 * Must sum to 1. Asserted rather than assumed: a set of weights that sums to
 * 0.95 produces scores that are quietly 5% low and nothing anywhere would say
 * so. */
/* **A creative is scored against the job it was bought to do.**
 *
 * One weighting for every creative asks a top-of-funnel prospecting video why
 * it did not book anybody, which it was never there to do. A reach buy against
 * a cold audience and a retargeting ad against 30-day video watchers have
 * different purposes, different natural conversion rates, and deserve different
 * questions — so there is a weight set per stage, and the stage decides which
 * one applies.
 *
 * Hook and hold are two measurements of one thing — whether the creative earns
 * attention — so the brief's single "Hook / Hold Quality" weight is split
 * evenly between them here. Splitting rather than blending keeps each
 * measurable on its own and keeps the total honest.
 *
 * Every number in this block is a constant. Changing what the business values
 * is an edit here and nowhere else. */
const WEIGHTS_BY_STAGE = {
  /* Attract new audiences. Judged on earning attention and the click, and only
     lightly on what happened downstream — a cold audience converts at a
     fraction of a warm one and punishing it for that would recommend switching
     off the top of the funnel. */
  TOFU: {
    hookRate: 0.15,
    holdRate: 0.15,
    ctr: 0.20,
    cpl: 0.20,
    interestedRate: 0.10,
    cpil: 0.10,
    fatigue: 0.10,
  },

  /* Turn warm audiences into qualified leads. The middle is where lead quality
     is actually decided, so cost per interested lead leads and booking rate
     starts to matter. */
  MOFU: {
    cpil: 0.30,
    interestedRate: 0.20,
    bookingRate: 0.20,
    roas: 0.15,
    ctr: 0.10,
    fatigue: 0.05,
  },

  /* Convert high intent into bookings. These audiences already know the resort,
     so there is no excuse for them not to convert, and the weighting says so. */
  BOFU: {
    bookingRate: 0.30,
    roas: 0.25,
    cpil: 0.20,
    costPerBooking: 0.15,
    bookingVolume: 0.05,
    fatigue: 0.05,
  },

  /* No stage could be read — the ad set has no targeting, no telling name and
     no objective that maps. Weighted as the middle, which is the least wrong
     assumption for a lead-gen account, and the card says the stage is unknown
     rather than implying it was assessed as MOFU. */
  UNKNOWN: {
    cpil: 0.30,
    interestedRate: 0.20,
    bookingRate: 0.20,
    roas: 0.15,
    ctr: 0.10,
    fatigue: 0.05,
  },
};

for (const [stage, set] of Object.entries(WEIGHTS_BY_STAGE)) {
  const total = Object.values(set).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`creative-score: ${stage} weights sum to ${total}, not 1`);
  }
}

/* What the funnel classifier calls a stage, and what a media buyer calls it. */
const STAGE_OF = { Top: 'TOFU', Middle: 'MOFU', Bottom: 'BOFU' };

const stageOf = (creative) => (
  (creative.funnel && STAGE_OF[creative.funnel.stage]) || 'UNKNOWN'
);

/* Kept for callers that want the shape of the default model without a stage. */
const WEIGHTS = WEIGHTS_BY_STAGE.UNKNOWN;

/* ── what counts as interested ──────────────────────────────────────────────
 *
 * The CRM's own stages. "Interested" is the first point at which a human has
 * looked at the enquiry and decided it is real — everything before it is a form
 * submission, which is exactly the thing Meta already counts and the thing this
 * score exists to stop rewarding.
 *
 * A booked lead is interested; so is a lost one that reached negotiation. The
 * set is deliberately generous at the far end, because a lead that got as far
 * as a quote was interested whatever happened afterwards. */
const INTERESTED_STAGES = new Set([
  'interested', 'qualified', 'quoted', 'negotiation', 'proposal',
  'booked', 'closed-won', 'won', 'converted',
]);

const isInterested = (lead) => INTERESTED_STAGES.has(String(lead.stage || '').toLowerCase().trim());

/* ── confidence ─────────────────────────────────────────────────────────────
 *
 * The tiers asked for, by the creative's own lead count. */
const TIERS = [
  { at: 30, key: 'high', label: 'High confidence' },
  { at: 10, key: 'moderate', label: 'Moderate confidence' },
  { at: 3, key: 'low', label: 'Low confidence' },
  { at: 0, key: 'insufficient', label: 'Insufficient data' },
];

const tierFor = (leads) => TIERS.find((t) => (leads || 0) >= t.at);

/* How hard a thin sample is pulled back toward the middle.
 *
 * **Shrinkage, not a penalty multiplier.** A flat multiplier — 0.5 for a thin
 * creative, say — punishes a bad new creative and a good new creative by the
 * same proportion, which buries the good one and leaves the bad one looking
 * merely mediocre. Pulling the score toward the set's own average instead says
 * the honest thing: with four leads we do not yet know that this is
 * exceptional, so it is treated as ordinary until it proves otherwise.
 *
 * The weight a creative's own score carries is `leads / (leads + K)`. At K = 10
 * that is 23% of its own score at 3 leads, 50% at 10, 75% at 30 — which lands
 * on the tier boundaries the brief asks for without them having to be special
 * cases. A new creative with genuinely excellent numbers still climbs; it just
 * cannot take first place on four leads. */
const SHRINK_K = 10;

/* ── normalisation ──────────────────────────────────────────────────────────
 *
 * Percentile-clipped min-max. `direction` is 'cost' (lower is better) or
 * 'value' (higher is better).
 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* Returns a function mapping one raw value to 0–100, or null when the set
   cannot support a comparison at all. */
function scaler(values, direction) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length < 2) return null;

  const lo = percentile(clean, 0.10);
  const hi = percentile(clean, 0.90);

  /* Every creative identical on this component. Scoring them 0 would punish
     them all for agreeing; 50 says "no distinction here", which is true. */
  if (!(hi > lo)) return () => 50;

  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const clipped = Math.min(hi, Math.max(lo, value));
    const position = (clipped - lo) / (hi - lo);
    return Math.round((direction === 'cost' ? 1 - position : position) * 100);
  };
}

/* ── the raw metrics ────────────────────────────────────────────────────────
 *
 * `ctx` comes from lib/creative-goals.js — the CRM and PMS walk, keyed by ad.
 * Every one of these returns null rather than zero when its inputs are missing,
 * because a creative with no CRM behind it has not achieved a booking rate of
 * nought, it has no booking rate at all.
 */
const per = (a, b) => (
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && b > 0
    ? a / b
    : null
);

/* Spend is paise on a canonical entity; rates are fractions here and become
   percentages only at the point of display. */
function metricsFor(creative, row) {
  const spend = creative.spend === null || creative.spend === undefined ? null : creative.spend;
  const leads = creative.leads || 0;
  const interested = row ? row.interested : null;
  const bookings = row ? row.bookings : null;
  const revenue = row ? row.revenue : null;

  return {
    spend,
    leads,
    interested,
    bookings,
    cpl: per(spend, leads),
    /* The one that matters most. Null, not Infinity, when a creative produced
       leads but none of them were interested — that is a real and damning
       answer, and it is handled by the score as a floor rather than by
       dividing by zero. */
    cpil: interested === null ? null : per(spend, interested),
    interestedRate: interested === null ? null : per(interested, leads),
    bookingRate: bookings === null ? null : per(bookings, leads),
    costPerBooking: bookings === null ? null : per(spend, bookings),
    /* The money itself, beside the ratio built from it. ROAS answers "was
       this efficient" and revenue answers "did it matter", and a creative
       returning 6x on ₹400 of spend is not the one to scale. Both are needed
       to rank sensibly, so both are carried. */
    revenue,
    roas: revenue === null ? null : per(revenue, spend),
    ctr: per(creative.clicks, creative.impressions),
    hookRate: fatigueScore.hookRate(creative),
    holdRate: fatigueScore.holdRate(creative),
    cpm: creative.cpm === undefined ? null : creative.cpm,
    /* Volume, not a rate: how much the creative actually delivered, which is
       what a bottom-of-funnel buy is partly judged on. */
    bookingVolume: bookings === null ? null : bookings,
    worn: fatigueScore.score(creative.series),
  };
}

/* A creative that got leads and interested none of them has the worst possible
   cost per interested lead, not an unknown one. Scored at the floor rather than
   left out, or the creative most deserving of replacement would be excused for
   having failed completely. */
const HAS_LEADS_NONE_INTERESTED = 0;

const COMPONENTS = [
  { key: 'cpil', direction: 'cost', label: 'Cost per interested lead' },
  { key: 'bookingRate', direction: 'value', label: 'Lead to booking rate' },
  { key: 'roas', direction: 'value', label: 'ROAS' },
  { key: 'interestedRate', direction: 'value', label: 'Interested lead rate' },
  { key: 'ctr', direction: 'value', label: 'CTR' },
  { key: 'cpl', direction: 'cost', label: 'Lead efficiency' },
  { key: 'costPerBooking', direction: 'cost', label: 'Cost per booking' },
  { key: 'bookingVolume', direction: 'value', label: 'Booking volume' },
  { key: 'hookRate', direction: 'value', label: 'Hook rate' },
  { key: 'holdRate', direction: 'value', label: 'Hold rate' },
];

/* Fatigue is already 0–100 and already the right way round for wear: 0 fresh,
   100 spent. Its component score is the inverse, so fresh scores well. A
   creative with no reading scores 50 — neither rewarded nor punished for a
   history nobody has. */
const fatigueComponent = (worn) => (worn ? 100 - worn.score : 50);

/* ── the score ──────────────────────────────────────────────────────────────
 *
 * Scored over the whole set at once, because every component is a comparison
 * against the other creatives on the screen.
 */
function score(creatives, ctx = { byAd: new Map() }, options = {}) {
  const weights = { ...WEIGHTS, ...(options.weights || {}) };

  const rows = creatives.map((c) => {
    const walked = ctx.byAd ? ctx.byAd.get(String(c.adId)) : null;
    return { creative: c, metrics: metricsFor(c, walked), stage: stageOf(c) };
  });

  /* **Scaled within the funnel stage, not across the whole screen.**
   *
   * A bottom-of-funnel retargeting ad books at several times the rate of a cold
   * prospecting video, and comparing them on one scale would rank every BOFU
   * creative above every TOFU creative on arithmetic alone — which answers
   * "which creative converts best" when the question is "how well is this
   * creative doing the job it was bought for".
   *
   * A stage with fewer than two creatives cannot be a cohort — there is nothing
   * to compare against — so it falls back to the whole set and the card says the
   * comparison was account-wide. Better a stated wider comparison than a
   * cohort of one scoring itself 50 for ever. */
  const cohorts = new Map();
  for (const r of rows) {
    if (!cohorts.has(r.stage)) cohorts.set(r.stage, []);
    cohorts.get(r.stage).push(r);
  }

  const globalScalers = {};
  for (const component of COMPONENTS) {
    globalScalers[component.key] = scaler(rows.map((r) => r.metrics[component.key]), component.direction);
  }

  const scalersByStage = new Map();
  for (const [stage, members] of cohorts) {
    const built = {};
    for (const component of COMPONENTS) {
      built[component.key] = members.length >= 2
        ? scaler(members.map((r) => r.metrics[component.key]), component.direction)
        : globalScalers[component.key];
    }
    scalersByStage.set(stage, built);
    for (const r of members) r.cohortSize = members.length;
  }

  const scalersFor = (r) => scalersByStage.get(r.stage) || globalScalers;

  /* The set's average score, for shrinkage to pull toward. Computed from the
     unshrunk scores of creatives that have enough leads to be worth averaging —
     shrinking toward a mean that thin creatives themselves dominate would drag
     the whole board down together. */
  const unshrunk = rows.map((r) => raw(r, scalersFor(r), WEIGHTS_BY_STAGE[r.stage], options.weights));
  const anchorFor = (stage) => {
    const solid = rows
      .map((r, i) => ({ stage: r.stage, leads: r.metrics.leads, value: unshrunk[i].value }))
      .filter((x) => x.stage === stage && x.leads >= 10 && x.value !== null)
      .map((x) => x.value);
    return solid.length ? solid.reduce((a, b) => a + b, 0) / solid.length : 50;
  };
  const anchors = new Map([...cohorts.keys()].map((stage) => [stage, anchorFor(stage)]));

  return rows.map((r, i) => {
    const { value, parts, covered } = unshrunk[i];
    const leads = r.metrics.leads;
    const tier = tierFor(leads);

    /* Confidence pulls the score toward the anchor rather than scaling it
       down — see SHRINK_K. */
    const own = leads / (leads + SHRINK_K);
    const anchor = anchors.get(r.stage);
    const adjusted = value === null ? null : Math.round(value * own + anchor * (1 - own));

    return {
      creative: r.creative,
      metrics: r.metrics,
      /* TOFU / MOFU / BOFU, and whether the comparison was against its own
         stage or against the whole account. */
      stage: r.stage,
      cohortSize: r.cohortSize || 1,
      cohortWide: (r.cohortSize || 1) < 2,
      weights: WEIGHTS_BY_STAGE[r.stage],
      /* Both are reported: the score as ranked, and what it was before the
         sample size was taken into account. A reader who wants to know why a
         promising new creative sits fourth can see the difference. */
      score: adjusted,
      rawScore: value,
      parts,
      /* Which components actually contributed. A creative with no CRM behind it
         is scored on CTR and fatigue alone, and that has to be visible rather
         than dressed up as a full assessment. */
      covered,
      confidence: { ...tier, leads, weight: Number(own.toFixed(2)) },
    };
  });
}

/* One creative's weighted score, before confidence.
 *
 * **Missing components are dropped and the weights renormalised over what is
 * left**, rather than scored as zero. A creative with no CRM connected has no
 * booking rate; scoring that 0 would mean 45% of its score is a punishment for
 * a source nobody has connected, and every creative on the account would be
 * punished identically — which is noise dressed as a ranking. `covered` records
 * how much of the intended weight was answerable, so the screen can say the
 * score is thinner than it looks. */
function raw(row, scalers, stageWeights, override) {
  const weights = { ...stageWeights, ...(override || {}) };
  const parts = {};
  let total = 0;
  let weighted = 0;

  for (const component of COMPONENTS) {
    /* A component the stage's model does not weigh is not part of its score.
       That is the whole point of a per-stage model: a TOFU creative is not
       asked about cost per booking. */
    if (!weights[component.key]) continue;
    const scale = scalers[component.key];
    const value = row.metrics[component.key];

    /* Leads but none interested is the worst outcome, not a missing one. */
    const floored = component.key === 'cpil'
      && value === null
      && row.metrics.leads > 0
      && row.metrics.interested === 0;

    let points = null;
    if (floored) points = HAS_LEADS_NONE_INTERESTED;
    else if (scale && value !== null) points = scale(value);

    if (points === null) continue;

    parts[component.key] = { points, weight: weights[component.key], label: component.label };
    total += weights[component.key];
    weighted += points * weights[component.key];
  }

  /* Fatigue always contributes — it needs no CRM and has a defined answer for a
     creative with no reading. */
  const fatiguePoints = fatigueComponent(row.metrics.worn);
  parts.fatigue = { points: fatiguePoints, weight: weights.fatigue, label: 'Fatigue' };
  total += weights.fatigue;
  weighted += fatiguePoints * weights.fatigue;

  return {
    value: total > 0 ? Math.round(weighted / total) : null,
    parts,
    covered: Number(total.toFixed(2)),
  };
}

/* ── the recommendation ─────────────────────────────────────────────────────
 *
 * Three, driven by the business score rather than by cost per lead. Fatigue can
 * push a creative down but never alone decide it: a creative booking at four
 * times the account rate is not replaced for being seen three times.
 */
/* **Recommendations, never actions.** Every label here is advice to a marketer
 * who then decides. Nothing in this codebase calls Meta or Google to pause,
 * activate, edit or budget an ad, and the wording is deliberate: the card says
 * PAUSE RECOMMENDED, not PAUSED. */
const ACTIONS = {
  scale: {
    action: 'scale', label: 'SCALE', marker: '🟢',
    instruction: 'Consider raising its budget',
    color: 'var(--signal-good)', bg: 'var(--signal-good-bg)',
  },
  continue: {
    action: 'continue', label: 'CONTINUE', marker: '🟢',
    instruction: 'Leave it running as it is',
    color: 'var(--signal-good-soft)', bg: 'var(--signal-good-soft-bg)',
  },
  watch: {
    action: 'watch', label: 'WATCH', marker: '🟡',
    instruction: 'Keep an eye on it before deciding',
    color: 'var(--signal-warn)', bg: 'var(--signal-warn-bg)',
  },
  reduce: {
    action: 'reduce', label: 'REDUCE', marker: '🟠',
    instruction: 'Consider taking budget off it',
    color: 'var(--signal-caution)', bg: 'var(--signal-caution-bg)',
  },
  retest: {
    action: 'retest', label: 'RETEST', marker: '🔵',
    instruction: 'The concept still works — try a fresh execution',
    color: 'var(--signal-info)', bg: 'var(--signal-info-bg)',
  },
  pause: {
    action: 'pause', label: 'PAUSE RECOMMENDED', marker: '🔴',
    instruction: 'Consider turning it off — your call',
    color: 'var(--signal-bad)', bg: 'var(--signal-bad-bg)',
  },
  insufficient: {
    action: 'insufficient', label: 'INSUFFICIENT DATA', marker: '⚪',
    instruction: 'Keep testing — there is not enough here to judge',
    color: 'var(--signal-none)', bg: 'var(--signal-none-bg)',
  },
};

/* Most urgent first. */
const ACTION_ORDER = ['pause', 'reduce', 'retest', 'watch', 'continue', 'scale', 'insufficient'];

/* Where a score stops being promising and starts being a problem. Expressed
   against the score rather than against any one metric, so a creative can be
   dear per lead and still scale if it books. */
const STRONG = 65;
const WEAK = 40;

/* Enough of the intended weight answered for the score to be an assessment
   rather than a guess: cost per interested lead alone is 35%, and without it
   nothing here is really measuring the business. */
const COVERED_ENOUGH = 0.5;

/* The decision, from the business score, the sample behind it, the way the
 * creative is moving and how worn it is — in that order of authority.
 *
 * **Never from cost per lead alone**, and never PAUSE on a thin sample: a
 * creative with too little data gets "keep testing", because the only honest
 * reading of four leads is that nobody knows yet.
 *
 * The rules are ordered and the first match decides. Order is the design:
 *
 *   1  nothing to judge on            -> INSUFFICIENT DATA
 *   2  proven bad, and worn out       -> PAUSE RECOMMENDED
 *   3  proven bad                     -> PAUSE RECOMMENDED
 *   4  was strong, now exhausted      -> RETEST — the concept still works
 *   5  deteriorating from a real base -> REDUCE
 *   6  strong, proven, stable, fresh  -> SCALE
 *   7  strong but thin or wobbling    -> WATCH
 *   8  healthy, no case to scale      -> CONTINUE
 *   9  anything else                  -> WATCH
 */
function recommend(scored, movement = null) {
  const { score: value, confidence, covered, metrics } = scored;
  const worn = metrics.worn;
  const stage = scored.stage === 'UNKNOWN' ? 'unclassified' : scored.stage;
  const because = [];

  const proven = confidence.key === 'high' || confidence.key === 'moderate';
  const measured = covered >= COVERED_ENOUGH;
  const trend = movement || {};
  const declining = trend.key === 'declining' || trend.key === 'fatiguing';
  const exhausted = worn && worn.band === 'replace';

  if (value === null || confidence.key === 'insufficient') {
    return {
      ...ACTIONS.insufficient,
      because: [`${confidence.leads} lead${confidence.leads === 1 ? '' : 's'} so far — too little to judge`],
      score: value,
    };
  }

  /* The reasons, assembled once and shared by every branch below: a
     recommendation that cannot show its working is a recommendation that gets
     argued with and cannot answer. */
  because.push(`${value}/100 against other ${stage} creatives`);
  if (metrics.cpil === null) because.push('scored on reach and fatigue only — no CRM data');
  else if (!measured) because.push(`only ${Math.round(covered * 100)}% of the ${stage} model could be answered`);
  if (confidence.key === 'low') because.push(`low confidence — ${confidence.leads} leads`);
  if (trend.said && trend.key !== 'unknown' && trend.key !== 'stable') because.push(trend.said);
  if (worn && worn.reasons.length) because.push(...worn.reasons);

  const call = (() => {
    if (value < WEAK && proven && exhausted) return ACTIONS.pause;
    if (value < WEAK && proven) return ACTIONS.pause;

    /* Worn out but the business numbers are still good: the *execution* is
       spent, not the idea. Replacing the creative with a fresh cut of the same
       concept is a different instruction from switching it off. */
    if (exhausted && value >= STRONG) return ACTIONS.retest;
    if (exhausted && proven) return ACTIONS.reduce;

    if (declining && proven && value >= WEAK) return ACTIONS.reduce;

    if (value >= STRONG && proven && measured && !declining && !exhausted) return ACTIONS.scale;
    if (value >= STRONG) return ACTIONS.watch;

    if (value >= WEAK && proven && !declining) return ACTIONS.continue;
    return ACTIONS.watch;
  })();

  return { ...call, because, score: value, trend: trend.key || 'unknown' };
}

/* The lifecycle label, which answers a different question from the
 * recommendation: not "what should I do" but "where is this creative in its
 * life". Derived from the same inputs rather than stored, so it cannot drift
 * from the numbers it describes. */
const LIFECYCLE = {
  testing: { key: 'testing', label: 'TESTING', marker: '🧪' },
  learning: { key: 'learning', label: 'LEARNING', marker: '🧠' },
  winner: { key: 'winner', label: 'WINNER', marker: '🏆' },
  scaling: { key: 'scaling', label: 'SCALE', marker: '📈' },
  fatiguing: { key: 'fatiguing', label: 'FATIGUING', marker: '⚠️' },
  declining: { key: 'declining', label: 'DECLINING', marker: '📉' },
  pause: { key: 'pause', label: 'PAUSE RECOMMENDED', marker: '🔴' },
  retest: { key: 'retest', label: 'RETEST', marker: '🔄' },
};

function lifecycle(scored, call, movement = null) {
  const { confidence, score: value } = scored;
  const worn = scored.metrics.worn;
  const trend = movement || {};

  if (call.action === 'pause') return LIFECYCLE.pause;
  if (call.action === 'retest') return LIFECYCLE.retest;
  if (confidence.key === 'insufficient') return LIFECYCLE.testing;
  if (confidence.key === 'low') return LIFECYCLE.learning;
  if (trend.key === 'fatiguing' || (worn && worn.band === 'replace')) return LIFECYCLE.fatiguing;
  if (trend.key === 'declining') return LIFECYCLE.declining;
  if (call.action === 'scale') return LIFECYCLE.scaling;
  if (value !== null && value >= STRONG) return LIFECYCLE.winner;
  return LIFECYCLE.learning;
}

/* ── the one-line read ──────────────────────────────────────────────────────
 *
 * "Strong BOFU performer — 5.2x ROAS + 7.4% booking rate".
 *
 * Built from the two components that contributed most to *this* creative's
 * score, phrased in the raw figures rather than in the normalised points —
 * nobody argues with "ROAS 88/100", and the point of the line is to be
 * arguable. The adjective follows the score, so a weak performer is not
 * described as strong for having a best component.
 */
const BAND = [
  { at: 65, word: 'Strong' },
  { at: 45, word: 'Steady' },
  { at: 0, word: 'Weak' },
];

const SHOW = {
  cpil: (m, money) => `${money(m.cpil)} cost per interested lead`,
  cpl: (m, money) => `${money(m.cpl)} cost per lead`,
  costPerBooking: (m, money) => `${money(m.costPerBooking)} cost per booking`,
  roas: (m) => `${m.roas.toFixed(1)}x ROAS`,
  bookingRate: (m) => `${(m.bookingRate * 100).toFixed(1)}% booking rate`,
  interestedRate: (m) => `${(m.interestedRate * 100).toFixed(0)}% interested lead rate`,
  ctr: (m) => `${(m.ctr * 100).toFixed(2)}% CTR`,
  hookRate: (m) => `${(m.hookRate * 100).toFixed(0)}% hook rate`,
  holdRate: (m) => `${(m.holdRate * 100).toFixed(0)}% hold rate`,
  bookingVolume: (m) => `${m.bookingVolume} booking${m.bookingVolume === 1 ? '' : 's'}`,
  fatigue: (m) => (m.worn ? `fatigue ${m.worn.score}` : 'no fatigue reading'),
};

function headline(scored, money = (v) => String(Math.round(v / 100))) {
  if (scored.score === null) return 'Nothing measurable yet';

  const word = BAND.find((b) => scored.score >= b.at).word;
  const stage = scored.stage === 'UNKNOWN' ? 'unclassified' : scored.stage;

  /* Ranked by what each part actually contributed — its points times its
     weight — so the line names the reasons the score is what it is, not merely
     the metrics that happen to look good. */
  const top = Object.entries(scored.parts)
    .filter(([key]) => SHOW[key] && key !== 'fatigue')
    .filter(([key]) => {
      const raw = scored.metrics[key];
      return typeof raw === 'number' && Number.isFinite(raw);
    })
    .sort((a, b) => (b[1].points * b[1].weight) - (a[1].points * a[1].weight))
    .slice(0, 2)
    .map(([key]) => SHOW[key](scored.metrics, money));

  if (!top.length) return `${word} ${stage} performer`;
  return `${word} ${stage} performer — ${top.join(' + ')}`;
}

/* The best creative at each stage, which is a different question from the best
   creative overall and the one a media buyer plans a week around. */
function bestByStage(scoredRows) {
  const best = new Map();
  for (const row of scoredRows) {
    if (row.score === null) continue;
    const held = best.get(row.stage);
    if (!held || row.score > held.score) best.set(row.stage, row);
  }
  return ['TOFU', 'MOFU', 'BOFU', 'UNKNOWN']
    .filter((stage) => best.has(stage))
    .map((stage) => ({ stage, row: best.get(stage) }));
}

module.exports = {
  headline, bestByStage, stageOf, lifecycle, LIFECYCLE, WEIGHTS_BY_STAGE, STAGE_OF,
  score, recommend, metricsFor, scaler, percentile, tierFor, isInterested, fatigueComponent,
  WEIGHTS, COMPONENTS, TIERS, SHRINK_K, INTERESTED_STAGES, ACTIONS, ACTION_ORDER,
  STRONG, WEAK, COVERED_ENOUGH,
};
