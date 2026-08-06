/* Audience Analytics. AUTHORED — see PHASES.md, Phase 1. */

const { UP, DOWN, WARN, NA } = require('./_tokens');

module.exports = {
  audGeo: [
    { name: 'Bengaluru', rev: '₹14.2L', w: '100%' },
    { name: 'Kochi', rev: '₹9.8L', w: '69%' },
    { name: 'Chennai', rev: '₹7.4L', w: '52%' },
    { name: 'Hyderabad', rev: '₹5.1L', w: '36%' },
    { name: 'Mumbai', rev: '₹4.3L', w: '30%' },
    { name: 'Delhi NCR', rev: '₹3.6L', w: '25%' },
  ],

  audSegs: [
    { name: 'Honeymoon 25–34 · metro', abv: 'HM', type: 'Interest', tip: 'Newly married, metro tier-1, travel intent', spend: '₹2.404L', leads: '712', bookings: '108', rev: '₹11.6L', roas: '4.8x', roasColor: UP, sat: '38%', satColor: UP },
    { name: 'Lookalike 1% — past bookers', abv: 'LAL', type: 'Lookalike', tip: 'Seeded on 18 months of confirmed bookings', spend: '₹1.92L', leads: '498', bookings: '81', rev: '₹8.9L', roas: '4.6x', roasColor: UP, sat: '44%', satColor: UP },
    { name: 'Weekend getaway · 500km radius', abv: 'WG', type: 'Geo', tip: 'Drive-distance leisure travellers', spend: '₹1.61L', leads: '441', bookings: '58', rev: '₹5.7L', roas: '3.5x', roasColor: NA, sat: '61%', satColor: WARN },
    { name: 'Retargeting — site visitors 30d', abv: 'RT', type: 'Custom', tip: 'Visited but did not enquire', spend: '₹0.98L', leads: '386', bookings: '47', rev: '₹4.8L', roas: '4.9x', roasColor: UP, sat: '79%', satColor: DOWN },
    { name: 'Ayurveda & wellness intent', abv: 'AY', type: 'Interest', tip: 'Wellness and treatment search intent', spend: '₹1.14L', leads: '268', bookings: '32', rev: '₹3.1L', roas: '2.7x', roasColor: DOWN, sat: '35%', satColor: UP },
    { name: 'Corporate offsite planners', abv: 'CO', type: 'Job title', tip: 'HR and admin decision makers', spend: '₹0.84L', leads: '118', bookings: '12', rev: '₹2.2L', roas: '2.6x', roasColor: DOWN, sat: '29%', satColor: UP },
  ],
};
