/* Creative detail drawer. AUTHORED — see PHASES.md, Phase 1.
 *
 * The drawer used to describe UGC video 03 in typed-in strings, whichever card
 * had been clicked, and it disagreed with the card as soon as the card started
 * computing its own figures: "Fatigue is still healthy at 42" sat under a badge
 * reading 50. A panel that contradicts the card it opened from is worse than
 * either being wrong alone, so everything the screen can derive is now derived
 * — from the same six creatives in data/creatives.js, through the same
 * projection — and only what nothing computes is still authored.
 *
 * Still authored, and marked as such on sight:
 *
 *   funnelV      the video-completion ladder. Meta reports p25/p50/p75/p100 and
 *                the connector requests only p100, so four of the five rungs
 *                have no source
 *   best*        the winning audience, placement, package and property. Those
 *                need a breakdown request per ad that nothing issues
 *   versions     the creative's edit history, which lives in whatever tool cut
 *                it, not in Meta
 */

const { PROJECTIONS } = require('../lib/repository/projections');
const creatives = require('./creatives');
const fatigue = require('../lib/creative-fatigue');

/* Content that has no source, kept apart from the derived fields so the
   difference is legible rather than a matter of reading the merge order. */
const AUTHORED = {
  funnelV: [
    { label: '3-second view', pct: '38.2%', w: '100%' },
    { label: '25% watched', pct: '31.4%', w: '82%' },
    { label: '50% watched', pct: '24.1%', w: '63%' },
    { label: '75% watched', pct: '19.8%', w: '52%' },
    { label: 'Completed', pct: '11.6%', w: '30%' },
  ],

  bestAud: 'Lookalike 1% — past bookers',
  bestPlace: 'Instagram Reels',
  bestPkg: 'Honeymoon 3N/4D',
  bestResort: 'Munnar Hillside',

  versions: [
    { tag: 'v3', when: 'Jul 18', note: 'Recut opening to lead with the pool reveal — current' },
    { tag: 'v2', when: 'Jul 09', note: 'Added price overlay at 0:12' },
    { tag: 'v1', when: 'Jun 28', note: 'Original guest-supplied cut' },
  ],
};

/* The note the panel leads with. Assembled from the creative's own verdict and
   fatigue reading rather than written out, because a sentence typed in beside a
   computed badge is a sentence that will eventually disagree with it. */
const note = (cr) => [
  `${cr.title}: ${cr.verdict.toLowerCase()} — ${cr.verdictBecause}.`,
  `Fatigue ${cr.fatigue}${cr.fatigue === '—' ? '' : '/100'} (${cr.fatigueBand}). ${fatigue.DEFINITION.short}`,
  `${cr.funnel === '—' ? 'Funnel stage unknown — the campaign objective does not map to one.' : `${cr.funnel}, from the campaign objective.`}`,
].join(' ');

module.exports = {
  selCr: {},
  select: (params = {}) => {
    const projected = PROJECTIONS['overlay-creative-detail'](
      { creatives: creatives.select.entities },
      params,
    ).selCr;

    if (!projected) return { selCr: { ...AUTHORED } };
    return { selCr: { ...AUTHORED, ...projected, aiNote: note(projected) } };
  },
};
