/* Creative fatigue.
 *
 * **These thresholds are not Meta's.** Meta publishes no fatigue metric — its
 * nearest equivalent is the Ad Relevance Diagnostics ranking, which is a
 * comparison against competing ads rather than against a creative's own
 * history. Everything below is the consensus of ad-operations practitioners,
 * gathered from published guidance in August 2026, and it is recorded here as
 * such so nobody later mistakes it for a vendor specification:
 *
 *   frequency   2.0–3.0 prepare · 3.0–4.0 act soon · 4.0+ replace now
 *               (cold audiences fatigue near 2.5; retargeting tolerates ~4.0)
 *   CTR         a 15% fall week-over-week is a warning; 20% over two weeks is
 *               treated as confirmed. It is the earliest signal, typically
 *               visible three to five days before frequency crosses its line
 *   CPM         an 18% rise over two weeks, because Meta prices a
 *               low-engagement ad higher — a tired creative costs more *and*
 *               converts less
 *
 * Sources: adsights.ai, goodmorningco.com, segwise.ai, adamigo.ai,
 * makometrics.com, marpipe.com — all consulted 2026-08-07.
 *
 * **The comparison is a creative against itself**, never against an account
 * average. A campaign whose creatives all run at frequency 3 is not evidence
 * that any one of them is tiring, and a high-frequency retargeting ad is not
 * fatigued for being retargeting.
 *
 * **Unknown is never healthy.** A creative with too little history returns null
 * rather than a reassuring score, for the reason this codebase repeats
 * everywhere: carrying a zero, or a green band, turns "cannot say" into "it is
 * fine" — and the whole point of the column is to catch the ones that are not.
 */

/* The recent window, and the minimum history worth comparing it against. Seven
   days because that is the cadence the guidance is written in; a shorter recent
   window swings on one bad day. */
const RECENT_DAYS = 7;
const MIN_BASELINE_DAYS = 7;

/* Below this, a day's numbers are noise rather than signal — a creative that
   got forty impressions did not have its click-through rate collapse. */
const MIN_IMPRESSIONS = 500;

const THRESHOLDS = {
  frequency: { prepare: 2.0, act: 3.0, replace: 4.0 },
  ctrDrop: { warn: 0.15, confirmed: 0.20 },
  cpmRise: { warn: 0.18 },
};

/* The badge sits on top of the creative now, not on the flat gradient the
   design drew — so a translucent tint over an arbitrary photo can land on
   anything and become unreadable. Backgrounds are near-opaque dark, which the
   coloured text reads against whatever the image happens to be. */
const BANDS = [
  { at: 70, band: 'replace', label: 'Replace', color: '#ff9a9a', bg: 'rgba(20,22,31,.86)' },
  { at: 40, band: 'act', label: 'Act soon', color: '#ffcf85', bg: 'rgba(20,22,31,.86)' },
  { at: 20, band: 'watch', label: 'Watch', color: '#ffe0a3', bg: 'rgba(20,22,31,.86)' },
  { at: 0, band: 'healthy', label: 'Healthy', color: '#9ce0b4', bg: 'rgba(20,22,31,.86)' },
];

/* What the number on the badge means, in one place.
 *
 * A score nobody can define is a score nobody can argue with, which is worse
 * than no score: it gets quoted in a meeting and then acted on. So the screen
 * carries this text rather than leaving the reader to infer a scale from the
 * colours, and both halves — the legend under the heading and the tooltip on
 * each badge — read it from here so they cannot drift apart.
 *
 * Written as prose rather than assembled from the constants below, because the
 * sentence that explains a weighting is not the weighting. If the thresholds
 * move, this moves with them by hand and deliberately. */
const DEFINITION = {
  short: 'How worn out a creative is against its own earlier run — 0 fresh, 100 spent.',
  how: `Three signals, each capped so no single reading carries the score: how many times the average person has now seen it (frequency ${THRESHOLDS.frequency.prepare}+), how far its click-through has fallen over the last ${RECENT_DAYS} days against everything before them (${Math.round(THRESHOLDS.ctrDrop.warn * 100)}%+), and how far its CPM has risen over the same comparison (${Math.round(THRESHOLDS.cpmRise.warn * 100)}%+).`,
  scale: '0–19 healthy · 20–39 watch · 40–69 act soon · 70+ replace.',
  caveat: `Compared against itself, never against other ads. Under ${RECENT_DAYS + MIN_BASELINE_DAYS} days of usable history it scores nothing at all rather than a reassuring zero.`,
};

/* The one-line version, for a legend that has to fit on a line. */
const summary = () => `Fatigue — ${DEFINITION.short} ${DEFINITION.scale}`;

/* The badge's tooltip: the definition, then this creative's own reading. */
function explain(worn) {
  if (!worn) return `${DEFINITION.short} ${DEFINITION.caveat}`;
  const band = BANDS.find((b) => b.band === worn.band);
  const reading = worn.reasons.length ? ` Reading: ${worn.reasons.join(', ')}.` : ' No signal has crossed its threshold.';
  return `${worn.score}/100 — ${band.label}. ${DEFINITION.how}${reading} Last ${worn.recentDays} days against the ${worn.baselineDays} before them.`;
}

const bandLabel = (band) => (BANDS.find((b) => b.band === band) || {}).label || null;

const sum = (rows, field) => rows.reduce((t, r) => t + (Number(r[field]) || 0), 0);

/* Both halves must be real numbers. `null / 10000` is 0 in JavaScript, which
   would report an image ad as having a 0% hook rate — a confident, wrong
   answer, where the truth is that it has no video to measure. */
const rate = (numerator, denominator) => (
  Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : null
);

/* Mean of the days that reported one. Meta's `frequency` is already a ratio per
   day, so it is averaged rather than added — summing daily frequencies would
   produce a number that grows with the length of the window and means nothing. */
function meanFrequency(rows) {
  const values = rows.map((r) => r.frequency).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function meanCpm(rows) {
  const values = rows.map((r) => r.cpm).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/* A proportional change, guarding the case that makes every naive version of
   this wrong: a baseline of zero. Going from no clicks to some clicks is not an
   infinite improvement, it is a creative that had nothing to compare. */
const change = (recent, baseline) => (
  typeof recent === 'number' && typeof baseline === 'number' && baseline > 0
    ? (recent - baseline) / baseline
    : null
);

/*
 * Returns null when there is not enough history to say anything — which the
 * caller must render as "unknown", never as healthy.
 */
function score(series = []) {
  const usable = (series || []).filter((d) => (Number(d.impressions) || 0) >= MIN_IMPRESSIONS);
  if (usable.length < RECENT_DAYS + MIN_BASELINE_DAYS) return null;

  const ordered = usable.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recent = ordered.slice(-RECENT_DAYS);
  const baseline = ordered.slice(0, -RECENT_DAYS);

  const recentCtr = rate(sum(recent, 'clicks'), sum(recent, 'impressions'));
  const baselineCtr = rate(sum(baseline, 'clicks'), sum(baseline, 'impressions'));
  const ctrChange = change(recentCtr, baselineCtr);

  const recentCpm = meanCpm(recent);
  const baselineCpm = meanCpm(baseline);
  const cpmChange = change(recentCpm, baselineCpm);

  const frequency = meanFrequency(recent);

  /* Each signal contributes independently, and each is capped, so one extreme
     reading cannot carry the score on its own — a creative is called fatigued
     because several things agree, which is what the guidance actually says. */
  let points = 0;
  const reasons = [];

  if (typeof frequency === 'number') {
    if (frequency >= THRESHOLDS.frequency.replace) { points += 40; reasons.push(`seen ${frequency.toFixed(1)}× per person`); }
    else if (frequency >= THRESHOLDS.frequency.act) { points += 28; reasons.push(`frequency ${frequency.toFixed(1)}`); }
    else if (frequency >= THRESHOLDS.frequency.prepare) { points += 14; reasons.push(`frequency ${frequency.toFixed(1)}`); }
  }

  if (typeof ctrChange === 'number' && ctrChange < 0) {
    const drop = -ctrChange;
    if (drop >= THRESHOLDS.ctrDrop.confirmed) { points += 40; reasons.push(`click-through down ${Math.round(drop * 100)}%`); }
    else if (drop >= THRESHOLDS.ctrDrop.warn) { points += 22; reasons.push(`click-through down ${Math.round(drop * 100)}%`); }
  }

  if (typeof cpmChange === 'number' && cpmChange >= THRESHOLDS.cpmRise.warn) {
    points += 20;
    reasons.push(`CPM up ${Math.round(cpmChange * 100)}%`);
  }

  const value = Math.max(0, Math.min(100, points));
  const { band, label, color, bg } = BANDS.find((b) => value >= b.at);

  return {
    score: value,
    band,
    /* The band's name in words. The number alone is the thing readers said they
       could not interpret; "51" and "Act soon" together need no legend. */
    label,
    color,
    bg,
    /* Why, in the reader's terms. A score with no reason is a number to
       distrust, and the column exists to prompt an action. */
    reasons,
    frequency,
    ctrChange,
    cpmChange,
    recentDays: recent.length,
    baselineDays: baseline.length,
  };
}

/* Which part of the funnel a creative is working in.
 *
 * Taken from the campaign's **objective**, which is what the advertiser
 * actually bought, rather than inferred from frequency or audience size — an
 * inference would be a guess wearing a confident label. Meta's objective
 * taxonomy spans two generations: the ODAX names (`OUTCOME_*`, current) and the
 * legacy ones, and both still appear on live accounts.
 *
 * An objective not in this table returns null rather than defaulting to a
 * stage, because a creative filed under the wrong part of the funnel is worse
 * than one filed under none.
 */
const FUNNEL = {
  /* Top — being seen. */
  OUTCOME_AWARENESS: 'Top', BRAND_AWARENESS: 'Top', REACH: 'Top',
  VIDEO_VIEWS: 'Top', POST_ENGAGEMENT: 'Top',
  /* Middle — being considered. */
  OUTCOME_TRAFFIC: 'Middle', LINK_CLICKS: 'Middle', TRAFFIC: 'Middle',
  OUTCOME_ENGAGEMENT: 'Middle', OUTCOME_APP_PROMOTION: 'Middle',
  APP_INSTALLS: 'Middle', MESSAGES: 'Middle',
  /* Bottom — being acted on. */
  OUTCOME_LEADS: 'Bottom', LEAD_GENERATION: 'Bottom',
  OUTCOME_SALES: 'Bottom', CONVERSIONS: 'Bottom',
  PRODUCT_CATALOG_SALES: 'Bottom', STORE_VISITS: 'Bottom',
};

const funnelStage = (objective) => (objective ? (FUNNEL[String(objective).toUpperCase()] || null) : null);

/* The badge text. "Top" alone reads as a ranking — first place — which is the
   opposite of what it says about a creative that is only there to be seen. */
const funnelLabel = (objective) => {
  const stage = funnelStage(objective);
  return stage ? `${stage} of funnel` : null;
};

/* What each stage is buying, for the tooltip. A creative filed under Top is not
   underperforming because it books nothing; that is what was bought. */
const FUNNEL_MEANS = {
  Top: 'bought for reach — judge it on being seen and on hook rate, not on leads',
  Middle: 'bought for clicks and engagement — judge it on cost per click and hold rate',
  Bottom: 'bought for leads and sales — judge it on cost per lead',
};

/* Top, then Middle, then Bottom — the order the funnel is drawn in and the
   order a reader walks it. Ranking alphabetically would put Bottom first and
   Top last, which is the funnel upside down. */
const FUNNEL_ORDER = { Top: 1, Middle: 2, Bottom: 3 };

/* Null, not a high number, for an objective that maps to no stage: the
   comparators sink unknowns on their own, and a creative with no funnel stage
   is not at the bottom of the funnel. */
const funnelRank = (objective) => {
  const stage = funnelStage(objective);
  return stage ? FUNNEL_ORDER[stage] : null;
};

const funnelMeaning = (objective) => {
  const stage = funnelStage(objective);
  return stage ? `${stage} of funnel: ${FUNNEL_MEANS[stage]}. Read from the campaign objective, so it is what was bought rather than what was inferred.` : null;
};

/* Hook and hold, which are only meaningful for video. Both return null for an
   image ad rather than zero — it did not fail to hold anyone's attention, it
   has no video to hold it with. */
const hookRate = (c) => rate(c.videoPlays, c.impressions);
const holdRate = (c) => rate(c.videoCompletions, c.videoPlays);

module.exports = {
  score, hookRate, holdRate, funnelStage, funnelLabel, funnelMeaning, funnelRank,
  explain, summary, bandLabel,
  DEFINITION, THRESHOLDS, BANDS, FUNNEL, FUNNEL_ORDER, RECENT_DAYS, MIN_BASELINE_DAYS, MIN_IMPRESSIONS,
};
