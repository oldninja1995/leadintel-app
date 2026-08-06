/* Creative detail drawer. AUTHORED — see PHASES.md, Phase 1.
 * Shows UGC video 03, matching its row on the Creative Intelligence screen. */

const { UP } = require('./_tokens');

module.exports = {
  selCr: {
    title: 'UGC video 03 — honeymoon walkthrough',
    type: 'Video', dur: '0:34', platform: 'Meta',
    campaign: 'Munnar Honeymoon',
    grad: 'linear-gradient(135deg,#2b2741,#5d5294)',

    spend: '₹1.26L', leads: '312', bookings: '58',
    roas: '4.8x', roasColor: UP,

    hook: '0:03 infinity pool reveal',
    thumbStop: '38.2%', watch: '19.4s', hold: '57.1%',
    quality: 'A+', fatigue: '42', fatigueColor: UP, winning: '78%',

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

    aiNote:
      'This creative is carrying the campaign: it took 60% of ad set budget on Jul 18 and CPL fell from ₹446 to ₹348 while lead volume rose 18%. Fatigue is still healthy at 42, but hold rate has slipped 4 points in ten days — the usual first signal. Brief two variants on the same opening shot before it crosses 70.',

    versions: [
      { tag: 'v3', when: 'Jul 18', note: 'Recut opening to lead with the pool reveal — current' },
      { tag: 'v2', when: 'Jul 09', note: 'Added price overlay at 0:12' },
      { tag: 'v1', when: 'Jun 28', note: 'Original guest-supplied cut' },
    ],
  },
};
