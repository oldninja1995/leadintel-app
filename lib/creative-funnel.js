/* Which part of the funnel a creative is working in.
 *
 * **Read from targeting, not from the objective.** The first version of this
 * read the campaign objective, on the reasoning that an objective is what the
 * advertiser *bought* and anything else would be a guess. That reasoning was
 * sound and the choice was still wrong: an account can run its entire funnel —
 * cold prospecting, warm engagers, hot video-watchers — under a single
 * `OUTCOME_LEADS` objective, and most lead-gen accounts do. Every creative then
 * reads "Bottom of funnel" and the badge says nothing at all.
 *
 * Targeting is not a looser signal than the objective. It is a *fact about how
 * the ad set was built*, sitting in the spec Meta already holds — unlike
 * frequency or audience size, which are performance readings and would be an
 * inference wearing a confident label. That distinction is the one this file
 * keeps; it has simply moved to a better fact.
 *
 * **The rule is audience recency.**
 *
 *   Top      no custom audience at all — broad, or narrowed only by geography
 *            or interest. Nobody in it has met the brand
 *   Middle   a custom audience with a retention window over 30 days. Warm:
 *            they engaged, but weeks ago
 *   Bottom   a custom audience with a retention window of 30 days or less.
 *            Hot: recent engagement, recent intent
 *
 * An ad set targeting several audiences takes the *shortest* retention among
 * them: the hottest audience in the mix is the one that decides how the ad set
 * behaves, and averaging two windows would produce a number that describes
 * neither.
 *
 * **Three signals, in order, and the screen says which one answered.** A
 * funnel stage that cannot be traced back to a reason is a label, and a label
 * on a card gets believed:
 *
 *   1. targeting   the ad set's own custom audiences and their retention
 *   2. name        the ad set's name, when targeting is missing. Names like
 *                  "Broad | Kerala", "All 60 Days KL" and "30 Days 75%
 *                  Watchers" carry the stage explicitly, and an account that
 *                  names its ad sets that way is telling you the answer
 *   3. objective   the campaign objective, as it always was — last, because it
 *                  is the signal that fails on a single-objective account
 *
 * Nothing resolved is null, not a default. A creative filed under the wrong
 * part of the funnel is worse than one filed under none.
 */

/* Where warm becomes hot. Thirty days because that is the window Meta's own
   engagement audiences default to and the one media buyers build around — a
   "30 day video viewer" audience is the standard hot retargeting pool, and a
   60-day one is the standard warm pool. It is a convention, not a law, which is
   why it is a named constant rather than a literal in a comparison. */
const HOT_WITHIN_DAYS = 30;

const STAGES = ['Top', 'Middle', 'Bottom'];

/* ── 1. targeting ───────────────────────────────────────────────────────── */

/* `audiences` maps custom-audience id -> { retentionDays, name, subtype }, from
   the account's own audience list. The ids on an ad set's targeting spec are
   ids alone — Meta does not expand them inline — so the retention that decides
   the stage has to be joined in from there.
 *
 * An ad set whose audiences are all unknown to that map is *not* treated as
 * broad: it has a custom audience, so it is certainly not Top, and guessing
 * between Middle and Bottom without the retention would be the coin toss this
 * file exists to avoid. It returns null and lets the name have a go. */
function fromTargeting(targeting, audiences = {}) {
  if (!targeting) return null;

  const ids = (targeting.customAudienceIds || []).map(String);
  if (!ids.length) {
    /* Broad, or narrowed by geography and interest only. Both are cold: a
       Bangalore holidaymaker who has never heard of the resort is at the top of
       the funnel whether or not the city was named. */
    return { stage: 'Top', signal: 'targeting', because: 'no custom audience — cold traffic' };
  }

  const windows = ids
    .map((id) => audiences[id] && audiences[id].retentionDays)
    .filter((d) => typeof d === 'number' && Number.isFinite(d) && d > 0);

  if (!windows.length) return null;

  /* The hottest audience in the mix decides it. */
  const shortest = Math.min(...windows);
  return shortest <= HOT_WITHIN_DAYS
    ? { stage: 'Bottom', signal: 'targeting', because: `retargeting a ${shortest}-day audience — recent intent` }
    : { stage: 'Middle', signal: 'targeting', because: `retargeting a ${shortest}-day audience — warm, but not recent` };
}

/* ── 2. the ad set's name ───────────────────────────────────────────────── */

/* Names are read only when targeting could not answer, and the card says so —
 * a name is a claim by whoever typed it, and an ad set renamed but not rebuilt
 * would file its creatives under a stage it no longer occupies.
 *
 * The patterns are the ones this account actually uses, which is the only
 * honest basis for them. A name matching nothing returns null rather than a
 * default.
 */
const BROAD = /\b(broad|prospect(ing)?|cold|open|acquisition)\b/i;

/* "All 60 Days KL", "30 Days 75% Watchers", "retargeting 7d" — a day count in
   an ad set name is nearly always the audience's retention window. */
const DAYS = /\b(\d{1,3})\s*(?:-|\s)?\s*day/i;

const WARM_WORDS = /\b(lookalike|lal|lla|similar|engag\w*|viewer|watch\w*|visit\w*|retarget\w*|remarket\w*|warm|hot|custom aud\w*|ca)\b/i;

function fromName(name) {
  if (!name) return null;
  const text = String(name);

  const days = text.match(DAYS);
  if (days) {
    const window = Number(days[1]);
    if (window > 0) {
      return window <= HOT_WITHIN_DAYS
        ? { stage: 'Bottom', signal: 'name', because: `named for a ${window}-day audience — recent intent` }
        : { stage: 'Middle', signal: 'name', because: `named for a ${window}-day audience — warm, but not recent` };
    }
  }

  /* Broad is checked after the day count, so "Broad | 30 Days" reads as the
     retargeting pool its name says it is rather than as cold traffic. */
  if (BROAD.test(text)) {
    return { stage: 'Top', signal: 'name', because: 'named as broad or prospecting — cold traffic' };
  }

  if (WARM_WORDS.test(text)) {
    /* Warm rather than hot: the name says there is an audience but not how
       recent it is, and calling it hot would claim the thing that was not
       said. */
    return { stage: 'Middle', signal: 'name', because: 'named for a retargeting or lookalike audience, with no window given' };
  }

  return null;
}

/* ── 3. the campaign objective ──────────────────────────────────────────── */

/* Meta's objective taxonomy spans two generations — the ODAX names
   (`OUTCOME_*`, current) and the legacy ones — and both still appear on live
   accounts. Kept as the last resort rather than deleted: an account that runs
   real awareness and traffic campaigns *is* telling you something with its
   objectives, and an ad set with neither targeting nor a meaningful name still
   has one. */
const FUNNEL = {
  OUTCOME_AWARENESS: 'Top', BRAND_AWARENESS: 'Top', REACH: 'Top',
  VIDEO_VIEWS: 'Top', POST_ENGAGEMENT: 'Top',

  OUTCOME_TRAFFIC: 'Middle', LINK_CLICKS: 'Middle', TRAFFIC: 'Middle',
  OUTCOME_ENGAGEMENT: 'Middle', OUTCOME_APP_PROMOTION: 'Middle',
  APP_INSTALLS: 'Middle', MESSAGES: 'Middle',

  OUTCOME_LEADS: 'Bottom', LEAD_GENERATION: 'Bottom',
  OUTCOME_SALES: 'Bottom', CONVERSIONS: 'Bottom',
  PRODUCT_CATALOG_SALES: 'Bottom', STORE_VISITS: 'Bottom',
};

function fromObjective(objective) {
  const stage = objective ? FUNNEL[String(objective).toUpperCase()] : null;
  return stage
    ? { stage, signal: 'objective', because: 'from the campaign objective — no targeting or ad set name to read' }
    : null;
}

/* ── the answer ─────────────────────────────────────────────────────────── */

/* `creative` carries what canonical resolved for it: the ad set's targeting,
   the ad set's name, and the campaign's objective. */
function stageFor(creative = {}, audiences = {}) {
  return fromTargeting(creative.targeting, audiences)
    || fromName(creative.adsetName)
    || fromObjective(creative.objective)
    || null;
}

const label = (resolved) => (resolved ? `${resolved.stage} of funnel` : null);

const rank = (resolved) => (resolved ? STAGES.indexOf(resolved.stage) + 1 : null);

/* What each stage is buying, for the tooltip — a creative filed under Top is
   not underperforming because it books nothing, that is what it is for. */
const MEANS = {
  Top: 'cold traffic — judge it on reach and hook rate, not on cost per lead',
  Middle: 'warm audiences — judge it on cost per click and hold rate; frequency runs higher here and that is normal',
  Bottom: 'hot, recent audiences — judge it on cost per lead. Frequency runs highest here by design',
};

/* The tooltip names the signal that answered, because "Middle of funnel" read
   from a name and "Middle of funnel" read from a retention window are not
   claims of equal strength, and the reader is entitled to know which they have. */
const SOURCE_OF = {
  targeting: "the ad set's targeting",
  name: "the ad set's name",
  objective: 'the campaign objective',
};

function meaning(resolved) {
  if (!resolved) {
    return 'No funnel stage: the ad set has no targeting this can read, its name says nothing about an audience, and the campaign objective maps to no stage. Declined rather than guessed.';
  }
  return `${resolved.stage} of funnel — ${MEANS[resolved.stage]}. Read from ${SOURCE_OF[resolved.signal]}: ${resolved.because}.`;
}

module.exports = {
  stageFor, label, rank, meaning,
  fromTargeting, fromName, fromObjective,
  HOT_WITHIN_DAYS, STAGES, FUNNEL, MEANS,
};
