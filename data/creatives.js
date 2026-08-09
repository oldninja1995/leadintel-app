/* Creative Intelligence. AUTHORED — see PHASES.md, Phase 1.
 *
 * **This module used to hold finished cells; it now holds inputs.**
 *
 * The first version of this file wrote out what each card should say — the
 * strings `fatigue: '42'` and `winning: '78%'`, six times. That is why the
 * screen shipped with a bar labelled HOLD RATE showing a number that was never
 * a hold rate: the label had been re-bound to what the ingested driver computes
 * and the authored driver went on serving the old "winning score" underneath
 * it. Two drivers, two answers, one label.
 *
 * So this module now supplies **creative entities in the same shape
 * lib/ingest/canonical.js produces** — a daily series, an objective, video
 * milestones — and `select()` hands them to the same projection the ingested
 * driver uses. One code path computes fatigue, funnel stage and the verdict for
 * both drivers, which means the authored screen cannot drift from the real one
 * again, and the sort control and the view tabs work here too.
 *
 * What is authored is now honest about being authored: these are inputs a
 * plausible Meta account would report, and every figure the screen shows is
 * *derived* from them by the same code that would derive it from Meta. Nothing
 * on the card is typed in.
 *
 * UGC video 03 is the creative the Analytics Engine page cites as taking 60% of
 * the Munnar Honeymoon ad set budget, so it leads here.
 */

const { PROJECTIONS } = require('../lib/repository/projections');

const GRAD = {
  hill: 'linear-gradient(135deg,#2b2741,#5d5294)',
  lake: 'linear-gradient(135deg,#26305e,#4c5397)',
  spice: 'linear-gradient(135deg,#3f3a2a,#7a6a45)',
  rain: 'linear-gradient(135deg,#23313a,#446070)',
  suite: 'linear-gradient(135deg,#3a2a35,#7a4f68)',
  boat: 'linear-gradient(135deg,#233a33,#3f7a63)',
};

/* The last day these fixtures describe. Fixed rather than `today`, because a
   fixture that moves with the clock makes a test that passes on Tuesday and
   fails on Wednesday — and because the raw store's other fixtures are pinned to
   the same fortnight. */
const LAST_DAY = '2026-08-06';

const isoDay = (offsetFromLast) => {
  const d = new Date(`${LAST_DAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offsetFromLast);
  return d.toISOString().slice(0, 10);
};

/* The window fatigue compares against. Kept as a literal 7 rather than imported
   so this file reads as a description of an account rather than as a fixture
   tuned to the scorer — the shift below is a thing the ads did, not a number
   chosen to trip a threshold. */
const RECENT = 7;

/* A creative's daily insight rows.
 *
 * Steady for most of the run, then `shift` applies over the closing week — which
 * is what a tiring creative looks like in Meta's own numbers: the audience has
 * been exhausted, so frequency climbs, click-through falls and CPM rises
 * together. A creative with no shift simply keeps running as it was.
 */
function run({ days, impressions, ctr, cpm, frequency, leadsPerDay = 0, hook = null, hold = null, shift = {} }) {
  const rows = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const late = i < RECENT;
    const ctrDay = ctr * (1 + (late ? (shift.ctr || 0) : 0));
    const cpmDay = cpm * (1 + (late ? (shift.cpm || 0) : 0));
    const freqDay = late && shift.frequency ? shift.frequency : frequency;
    const clicks = Math.round(impressions * ctrDay);

    /* Leads are whole people, and a resort creative does not return three of
       them every single day. The daily figure is the difference between two
       running totals, so a rate of 0.8 lands as 0,1,1,1,0,1… and thirty days
       add up to exactly twenty-four rather than to thirty rounded-up ones. */
    const elapsed = days - i;
    const leads = Math.floor(elapsed * leadsPerDay) - Math.floor((elapsed - 1) * leadsPerDay);

    rows.push({
      date: isoDay(i),
      impressions,
      clicks,
      /* Paise, as every money value on a canonical entity is. CPM is per
         thousand impressions and in rupees, so ×100 to get there. */
      spend: Math.round((impressions / 1000) * cpmDay * 100),
      leads,
      frequency: Number(freqDay.toFixed(2)),
      cpm: Number(cpmDay.toFixed(2)),
      videoPlays: hook === null ? null : Math.round(impressions * hook),
      videoCompletions: hook === null || hold === null ? null : Math.round(impressions * hook * hold),
    });
  }
  return rows;
}

const total = (rows, field) => {
  const values = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

const mean = (rows, field) => {
  const values = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};

/* Totals folded from the series exactly the way canonical.js folds them, so an
   authored creative and an ingested one are the same kind of object. A total
   typed in by hand could disagree with the days beneath it, which is the class
   of bug this whole rewrite is closing. */
function creative({ adId, title, objectType, objective, platform = 'meta', backdrop, campaignId, series }) {
  return {
    entity: 'creative',
    id: adId,
    adId,
    title,
    status: 'ACTIVE',
    creativeId: `CR-${adId}`,
    campaignId,
    /* Authored creatives have no Meta thumbnail to proxy; the gradient the
       design drew stands in for the still. */
    thumbnailUrl: null,
    backdrop,
    objectType,
    objective,
    platform,
    spend: total(series, 'spend'),
    impressions: total(series, 'impressions'),
    clicks: total(series, 'clicks'),
    leads: total(series, 'leads'),
    videoPlays: total(series, 'videoPlays'),
    videoCompletions: total(series, 'videoCompletions'),
    frequency: mean(series, 'frequency'),
    cpm: mean(series, 'cpm'),
    series,
    days: series.length,
    sources: [{ source: 'authored', externalId: adId }],
  };
}

/* Six creatives from one resort account, chosen so the screen shows every
   verdict the product can reach. A demo where everything says "keep running"
   demonstrates nothing, and one where everything says "stop" is not an account
   anybody recognises.
 *
 *   honeymoon   cheap leads, no fatigue signal          -> scale
 *   houseboat   frequency 3.2 and click-through falling -> refresh
 *   ayurveda    ordinary on every measure               -> keep running
 *   monsoon     three times the median cost, worn out   -> stop
 *   lake villa  nine days old, an awareness buy, no leads -> not enough data
 *   anniversary early fatigue, cost in line             -> keep running
 */
const CREATIVES = [
  creative({
    adId: '90001',
    title: 'UGC video 03 — honeymoon walkthrough',
    objectType: 'VIDEO',
    objective: 'OUTCOME_LEADS',
    campaignId: '7710',
    backdrop: GRAD.hill,
    series: run({
      days: 30, impressions: 14200, ctr: 0.0341, cpm: 296, frequency: 1.9,
      leadsPerDay: 2.93, hook: 0.382, hold: 0.41,
      shift: { cpm: 0.03 },
    }),
  }),
  creative({
    adId: '90002',
    title: 'Houseboat sunset — reel cut',
    objectType: 'VIDEO',
    objective: 'OUTCOME_TRAFFIC',
    campaignId: '7712',
    backdrop: GRAD.boat,
    series: run({
      days: 26, impressions: 11800, ctr: 0.0302, cpm: 264, frequency: 2.4,
      leadsPerDay: 1.3, hook: 0.347, hold: 0.33,
      shift: { ctr: -0.18, cpm: 0.10, frequency: 3.2 },
    }),
  }),
  creative({
    adId: '90003',
    title: 'Ayurveda retreat — carousel',
    objectType: 'SHARE',
    objective: 'OUTCOME_ENGAGEMENT',
    campaignId: '7715',
    backdrop: GRAD.spice,
    series: run({
      days: 22, impressions: 9600, ctr: 0.0264, cpm: 240, frequency: 1.5,
      leadsPerDay: 0.833,
      shift: { ctr: -0.05, cpm: 0.05 },
    }),
  }),
  creative({
    adId: '90004',
    title: 'Monsoon package — static',
    objectType: 'PHOTO',
    objective: 'OUTCOME_LEADS',
    campaignId: '7710',
    backdrop: GRAD.rain,
    series: run({
      days: 30, impressions: 8800, ctr: 0.0188, cpm: 268, frequency: 3.4,
      leadsPerDay: 0.3,
      shift: { ctr: -0.26, cpm: 0.22, frequency: 4.3 },
    }),
  }),
  creative({
    adId: '90005',
    title: 'Lake villa suite tour',
    objectType: 'VIDEO',
    objective: 'OUTCOME_AWARENESS',
    campaignId: '7719',
    backdrop: GRAD.lake,
    /* Nine days: below the fourteen fatigue needs, which is the case the badge
       must render as "no reading" rather than as a healthy zero. */
    series: run({
      days: 9, impressions: 10400, ctr: 0.0271, cpm: 252, frequency: 1.4,
      leadsPerDay: 0, hook: 0.294, hold: 0.28,
    }),
  }),
  creative({
    adId: '90006',
    title: 'Anniversary suite — testimonial',
    objectType: 'VIDEO',
    objective: 'OUTCOME_SALES',
    campaignId: '7721',
    backdrop: GRAD.suite,
    series: run({
      days: 18, impressions: 7400, ctr: 0.0294, cpm: 258, frequency: 2.6,
      leadsPerDay: 0.733, hook: 0.318, hold: 0.37,
      shift: { ctr: -0.16, cpm: 0.08 },
    }),
  }),
];

/* `select` is the static driver's seam for content that varies with the request
   (lib/repository/static.js). The sort control and the view tabs are exactly
   that: the screen is the same six creatives ranked differently, and which
   ranking is a property of the URL rather than of the data. */
module.exports = {
  /* Present so the schema check sees the key even before `select` runs. */
  creatives: [],
  select: (params = {}) => PROJECTIONS.creatives({ creatives: CREATIVES }, params),
};

/* The entities themselves, for the tests and for the detail overlay — which
   must read the same six creatives or the panel would disagree with the card
   that opened it. Hung off the function rather than exported as a key: the
   static driver spreads everything else on this module straight onto the view
   payload, and a list of raw entities has no business being there. */
module.exports.select.entities = CREATIVES;
