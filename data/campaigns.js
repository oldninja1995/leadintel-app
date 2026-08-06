/* Campaign Analytics — list, the four table tabs, and the drill-down.
 * AUTHORED — see PHASES.md, Phase 1. The drill-down is Munnar Honeymoon, the
 * campaign the design's own hardcoded detail header describes: health 92,
 * Meta, Active, objective Leads, ₹3,000/day, 78% paced. */

const { UP, DOWN, WARN, NA, seg, spark } = require('./_tokens');

module.exports = {
  up: UP,
  dName: 'Munnar Honeymoon',
  campCrumb: 'Campaign Analytics',

  /* Revenue-chart granularity, held in the URL so the view is shareable. */
  select(query) {
    const options = ['Daily', 'Weekly', 'Monthly'];
    const gran = options.includes(query.gran) ? query.gran : 'Daily';
    return {
      revGran: gran,
      dGrans: options.map((g) => ({
        label: g,
        go: `/campaigns?v=campDetail&v=dRevenue&gran=${g}`,
        ...seg(g === gran),
      })),
    };
  },

  campTabs: [
    { label: 'Campaigns', color: 'var(--color-accent-300)', border: 'var(--color-accent-400)' },
    { label: 'Ad sets', color: 'var(--color-neutral-500)', border: 'transparent' },
    { label: 'Ads', color: 'var(--color-neutral-500)', border: 'transparent' },
    { label: 'Keywords', color: 'var(--color-neutral-500)', border: 'transparent' },
  ],

  campRows: [
    { go: '/campaigns?v=campDetail', name: 'Munnar Honeymoon', platform: 'Meta', status: 'Active', objective: 'Leads', health: '92', healthColor: UP, spend: '₹2.10L', impr: '9.8L', ctr: '3.41%', leads: '604', cpl: '₹348', bookings: '94', rev: '₹10.1L', roas: '4.8x', roasColor: UP, pace: '78%', paceLabel: 'on pace', paceColor: UP, spark: spark([44, 48, 46, 54, 58, 57, 64, 68, 72, 77]) },
    { go: '/campaigns?v=campDetail', name: 'Alleppey Houseboat Weekend', platform: 'Meta', status: 'Active', objective: 'Leads', health: '84', healthColor: UP, spend: '₹1.82L', impr: '8.1L', ctr: '3.02%', leads: '471', cpl: '₹386', bookings: '71', rev: '₹7.8L', roas: '4.3x', roasColor: UP, pace: '71%', paceLabel: 'on pace', paceColor: UP, spark: spark([40, 44, 43, 49, 52, 55, 58, 61, 65, 68]) },
    { go: '/campaigns?v=campDetail', name: 'Kumarakom Ayurveda Retreat', platform: 'Google', status: 'Active', objective: 'Conversions', health: '76', healthColor: NA, spend: '₹1.44L', impr: '5.4L', ctr: '2.64%', leads: '302', cpl: '₹477', bookings: '48', rev: '₹5.6L', roas: '3.9x', roasColor: NA, pace: '64%', paceLabel: 'behind', paceColor: WARN, spark: spark([48, 46, 50, 49, 53, 51, 56, 54, 58, 57]) },
    { go: '/campaigns?v=campDetail', name: 'Monsoon Package · Kerala', platform: 'Meta', status: 'Active', objective: 'Leads', health: '58', healthColor: WARN, spend: '₹1.26L', impr: '6.2L', ctr: '1.88%', leads: '388', cpl: '₹325', bookings: '39', rev: '₹4.3L', roas: '3.4x', roasColor: WARN, pace: '92%', paceLabel: 'overspending', paceColor: DOWN, spark: spark([62, 58, 56, 51, 49, 44, 42, 38, 35, 31]) },
    { go: '/campaigns?v=campDetail', name: 'Brand search', platform: 'Google', status: 'Active', objective: 'Conversions', health: '96', healthColor: UP, spend: '₹0.61L', impr: '1.2L', ctr: '8.94%', leads: '214', cpl: '₹285', bookings: '44', rev: '₹4.2L', roas: '6.9x', roasColor: UP, pace: '52%', paceLabel: 'underspending', paceColor: WARN, spark: spark([70, 72, 71, 74, 76, 75, 78, 80, 79, 82]) },
    { go: '/campaigns?v=campDetail', name: 'Corporate offsite', platform: 'Google', status: 'Paused', objective: 'Leads', health: '41', healthColor: DOWN, spend: '₹0.84L', impr: '2.1L', ctr: '1.42%', leads: '118', cpl: '₹712', bookings: '12', rev: '₹2.2L', roas: '2.6x', roasColor: DOWN, pace: '38%', paceLabel: 'paused', paceColor: NA, spark: spark([50, 46, 42, 39, 34, 31, 28, 24, 21, 18]) },
  ],

  adsetRows: [
    { go: '/campaigns?v=campTabAds', name: 'HM · Lookalike 1%', audience: 'LAL 1% bookers', placement: 'Feed + Reels', opt: 'Leads', spend: '₹0.92L', freq: '2.1', freqColor: UP, ctr: '3.62%', leads: '284', bookings: '46', rev: '₹4.9L', roas: '5.3x', roasColor: UP, sat: '38%', satColor: UP },
    { go: '/campaigns?v=campTabAds', name: 'HM · Honeymoon interest', audience: 'Interest 25–34', placement: 'Feed + Stories', opt: 'Leads', spend: '₹0.71L', freq: '2.4', freqColor: UP, ctr: '3.28%', leads: '198', bookings: '31', rev: '₹3.4L', roas: '4.8x', roasColor: UP, sat: '44%', satColor: UP },
    { go: '/campaigns?v=campTabAds', name: 'HM · Retargeting 30d', audience: 'Site visitors', placement: 'Feed', opt: 'Leads', spend: '₹0.31L', freq: '4.2', freqColor: DOWN, ctr: '4.11%', leads: '86', bookings: '14', rev: '₹1.5L', roas: '4.8x', roasColor: UP, sat: '79%', satColor: DOWN },
    { go: '/campaigns?v=campTabAds', name: 'HM · Broad', audience: 'Broad India', placement: 'Advantage+', opt: 'Leads', spend: '₹0.16L', freq: '1.6', freqColor: UP, ctr: '2.14%', leads: '36', bookings: '3', rev: '₹0.3L', roas: '1.9x', roasColor: DOWN, sat: '18%', satColor: UP },
  ],

  adRows: [
    { name: 'UGC video 03 — honeymoon walkthrough', adset: 'HM · Lookalike 1%', type: 'Video', platform: 'Meta', thumbIcon: 'ph-fill ph-play-circle', grad: 'linear-gradient(135deg,#2b2741,#5d5294)', body: 'Two nights in the clouds, from ₹8,900', cta: 'Enquire now', spend: '₹1.26L', ctr: '3.41%', freq: '2.1', bookings: '58', rev: '₹6.1L', roas: '4.8x', roasColor: UP, saves: '412', shares: '188', comments: '96', neg: '0.04%', negColor: UP, spark: spark([44, 48, 47, 55, 58, 60, 66, 70, 73, 78]) },
    { name: 'Houseboat sunset — reel cut', adset: 'HM · Honeymoon interest', type: 'Reel', platform: 'Meta', thumbIcon: 'ph-fill ph-play-circle', grad: 'linear-gradient(135deg,#233a33,#3f7a63)', body: 'Sunset on the backwaters', cta: 'Book now', spend: '₹0.94L', ctr: '3.02%', freq: '2.4', bookings: '41', rev: '₹4.2L', roas: '4.5x', roasColor: UP, saves: '298', shares: '141', comments: '64', neg: '0.06%', negColor: UP, spark: spark([40, 43, 45, 50, 53, 56, 59, 63, 66, 70]) },
    { name: 'Monsoon package — static', adset: 'HM · Broad', type: 'Static', platform: 'Meta', thumbIcon: 'ph-fill ph-image', grad: 'linear-gradient(135deg,#23313a,#446070)', body: 'Monsoon rates, 30% off', cta: 'Learn more', spend: '₹0.72L', ctr: '1.88%', freq: '4.6', bookings: '14', rev: '₹1.2L', roas: '1.7x', roasColor: DOWN, saves: '61', shares: '18', comments: '9', neg: '0.31%', negColor: DOWN, spark: spark([58, 54, 50, 46, 41, 38, 33, 29, 25, 21]) },
  ],

  kwRows: [
    { kw: 'munnar resort honeymoon', match: 'Phrase', clicks: '2,140', cpc: '₹18', ctr: '9.24%', qs: '9', qsColor: UP, bookings: '31', rev: '₹3.1L', roas: '7.8x', roasColor: UP },
    { kw: 'parakkat munnar', match: 'Exact', clicks: '1,864', cpc: '₹11', ctr: '14.8%', qs: '10', qsColor: UP, bookings: '28', rev: '₹2.7L', roas: '12.6x', roasColor: UP },
    { kw: 'kerala honeymoon package', match: 'Broad', clicks: '3,220', cpc: '₹26', ctr: '4.12%', qs: '7', qsColor: NA, bookings: '22', rev: '₹2.2L', roas: '2.6x', roasColor: NA },
    { kw: 'alleppey houseboat booking', match: 'Phrase', clicks: '1,410', cpc: '₹22', ctr: '5.68%', qs: '8', qsColor: UP, bookings: '14', rev: '₹1.4L', roas: '4.4x', roasColor: UP },
    { kw: 'ayurveda resort kerala', match: 'Broad', clicks: '2,680', cpc: '₹31', ctr: '2.94%', qs: '5', qsColor: DOWN, bookings: '9', rev: '₹0.9L', roas: '1.1x', roasColor: DOWN },
  ],

  searchTerms: [
    { term: 'munnar resort with private pool', n: '412' },
    { term: 'parakkat nature resort tariff', n: '388' },
    { term: 'kerala honeymoon 3 nights', n: '311' },
    { term: 'alleppey houseboat 2 bedroom', n: '264' },
    { term: 'munnar resort monsoon offer', n: '208' },
    { term: 'best ayurveda resort kumarakom', n: '176' },
  ],

  /* ── drill-down: Munnar Honeymoon ── */

  dTabs: [
    { label: 'Overview', color: 'var(--color-accent-300)', border: 'var(--color-accent-400)' },
    { label: 'Revenue', color: 'var(--color-neutral-500)', border: 'transparent' },
    { label: 'Res', color: 'var(--color-neutral-500)', border: 'transparent' },
    { label: 'Insights', color: 'var(--color-neutral-500)', border: 'transparent' },
  ],

  /* Every KPI card on this screen is about **one campaign**, not the
     workspace, so the registry is evaluated at that grain (sub-phase 6.5).
     Without this, `ads.spend` here would print total spend across all
     campaigns on a single campaign's page.

     The key is the cleaned campaign name the ingest layer joins on. The
     authored drill-down calls it "Munnar Honeymoon" and the ad platforms
     report it as "meta | Munnar Honeymoon — JUL"; both normalise to this. */
  metricScope: { dimension: 'campaign', value: 'munnar honeymoon jul' },

  dMkt: [
    { metric: 'ads.spend', label: 'Spend', value: '₹2.10L', delta: '+8.2%', deltaColor: NA },
    { metric: 'ads.impressions', label: 'Impressions', value: '9.8L', delta: '+12.1%', deltaColor: NA },
    { metric: 'ads.ctr', label: 'CTR', value: '3.41%', delta: '+0.34pt', deltaColor: UP },
    { metric: 'ads.cpm', label: 'CPM', value: '₹214', delta: '−3.8%', deltaColor: UP },
    /* Frequency needs reach, which no campaign_day payload carries. */
    { label: 'Frequency', value: '2.1', delta: '+0.2', deltaColor: NA },
    { metric: 'cost.per_lead', label: 'CPL', value: '₹348', delta: '−22.0%', deltaColor: UP },
  ],

  dBiz: [
    { metric: 'leads.count', label: 'Leads', value: '604', delta: '+18.4%', deltaColor: UP },
    /* "Qualified" is a lead-stage count; the registry has no stage-filtered
       metric yet. */
    { label: 'Qualified', value: '318', delta: '+21.0%', deltaColor: UP },
    { metric: 'bookings.confirmed', label: 'Bookings', value: '94', delta: '+26', deltaColor: UP },
    { metric: 'revenue.net', label: 'Revenue', value: '₹10.1L', delta: '+31.2%', deltaColor: UP },
    /* Cancelled *revenue*, not the cancelled booking count — a folio settles a
       cancellation at zero, so the lost value is not recorded anywhere. */
    { label: 'Cancellations', value: '₹1.8L', delta: '+0.4L', deltaColor: DOWN },
    { metric: 'roas.net', label: 'Net ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP },
  ],

  dFunnel: [
    { label: 'Impressions', n: '9.8L', pct: '100%', w: '100%' },
    { label: 'Clicks', n: '33,418', pct: '3.41%', w: '64%' },
    { label: 'Leads', n: '604', pct: '1.81%', w: '42%' },
    { label: 'Qualified', n: '318', pct: '52.6%', w: '28%' },
    { label: 'Bookings', n: '94', pct: '29.6%', w: '16%' },
  ],

  dRooms: [
    { name: 'Honeymoon suite', rev: '₹4.20L', w: '100%' },
    { name: 'Cliff-view villa', rev: '₹2.80L', w: '67%' },
    { name: 'Premium double', rev: '₹1.90L', w: '45%' },
    { name: 'Garden cottage', rev: '₹1.20L', w: '29%' },
  ],

  dPkgs: [
    { name: 'Honeymoon 3N/4D', rev: '₹5.10L', w: '100%' },
    { name: 'Weekend escape 2N', rev: '₹2.60L', w: '51%' },
    { name: 'Candlelight add-on', rev: '₹1.40L', w: '27%' },
    { name: 'Room only', rev: '₹1.00L', w: '20%' },
  ],

  /* dGrans and revGran are supplied by select() so the control reflects the URL. */

  dRevStats: [
    /* Gross revenue, cancelled revenue and OTA commission are all folio lines
       the registry does not carry as metrics — `revenue.net` is the settled
       total. Three real definitions, none of them derivable from what stage 2
       keeps today. */
    { label: 'Gross revenue', value: '₹12.50L' },
    { label: 'Cancellations', value: '−₹1.80L' },
    { label: 'OTA commissions', value: '−₹0.60L' },
    { metric: 'revenue.net', label: 'Net revenue', value: '₹10.10L' },
    { metric: 'ads.spend', label: 'Ad spend', value: '₹2.10L' },
    { metric: 'roas.net', label: 'Net ROAS', value: '4.8x' },
  ],

  resRows: [
    { guest: 'Ananya & Rohit Sharma', init: 'AS', room: 'Honeymoon suite', pkg: 'Honeymoon 3N/4D', checkin: 'Aug 12', nights: '3', src: 'Meta', rev: '₹42,800', status: 'Confirmed', statusColor: UP },
    { guest: 'Karthik Iyer', init: 'KI', room: 'Cliff-view villa', pkg: 'Weekend escape 2N', checkin: 'Aug 08', nights: '2', src: 'Meta', rev: '₹28,400', status: 'Confirmed', statusColor: UP },
    { guest: 'Meera Pillai', init: 'MP', room: 'Premium double', pkg: 'Room only', checkin: 'Aug 15', nights: '2', src: 'Meta', rev: '₹18,600', status: 'Pending payment', statusColor: WARN },
    { guest: 'Daniel & Sara Thomas', init: 'DT', room: 'Honeymoon suite', pkg: 'Honeymoon 3N/4D', checkin: 'Aug 21', nights: '4', src: 'Meta', rev: '₹54,200', status: 'Confirmed', statusColor: UP },
    { guest: 'Nikhil Raghavan', init: 'NR', room: 'Garden cottage', pkg: 'Weekend escape 2N', checkin: 'Aug 03', nights: '2', src: 'Meta', rev: '₹16,900', status: 'Cancelled', statusColor: DOWN },
  ],

  dAi: [
    { icon: 'ph ph-trend-up', title: 'CPL fell 22% without losing volume', body: 'UGC video 03 took 60% of the ad set budget on Jul 18 and CPL dropped from ₹446 to ₹348 while lead volume rose 18%. This is a creative effect, not a bidding one.', action: 'See creative', chips: [] },
    { icon: 'ph ph-warning-diamond', title: 'Retargeting frequency at 4.2', body: 'The 30-day retargeting ad set is the only one above frequency 3. Negative feedback is still low at 0.06%, but this is where fatigue will appear first.', action: 'Cap frequency', chips: [] },
    { icon: 'ph ph-currency-inr', title: 'Cancellations concentrated in one package', body: '₹1.8L of the ₹1.8L cancelled came from Weekend escape 2N bookings held past the 72-hour payment window.', action: 'Simulate 48h', chips: [] },
  ],
};
