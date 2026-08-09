/* The five sources.
 *
 * Cadences are the Analytics Engine page's stage-1 SLA — "realtime – 15 min"
 * — resolved per source: the two that can push, push; the three that cannot,
 * poll at the far end of that range. `wins` is checked against the precedence
 * table at registration, so a source cannot quietly claim authority it does
 * not have.
 */

const SOURCES = {
  meta_ads: {
    id: 'meta_ads',
    name: 'Meta Ads',
    system: 'ads',
    cadence: { mode: 'poll', every: 900, sla: 'realtime – 15 min' },
    /* `adset` and `audience` are configuration, not measurement: how each ad
       set was built and how recent each custom audience is. They are what the
       funnel badge is read from — see lib/creative-funnel.js. */
    kinds: ['campaign_day', 'adset_day', 'ad_day', 'creative', 'adset', 'audience'],
    wins: ['spendDelivery'],
  },

  google_ads: {
    id: 'google_ads',
    name: 'Google Ads',
    system: 'ads',
    cadence: { mode: 'poll', every: 900, sla: 'realtime – 15 min' },
    kinds: ['campaign_day', 'adgroup_day', 'keyword_day'],
    wins: ['spendDelivery'],
  },

  /* TeleCRM pushes on lead creation and stage change, which is what makes the
     44-minute median first response on the dashboard measurable at all. */
  telecrm: {
    id: 'telecrm',
    name: 'TeleCRM',
    system: 'crm',
    cadence: { mode: 'stream', every: 300, sla: 'realtime' },
    kinds: ['lead', 'lead_event', 'deal'],
    wins: ['leadStage', 'campaignIds'],
  },

  pms: {
    id: 'pms',
    name: 'Property management system',
    system: 'pms',
    cadence: { mode: 'poll', every: 900, sla: 'realtime – 15 min' },
    kinds: ['booking', 'folio', 'inventory_day'],
    wins: ['revenue', 'bookingStatus'],
  },

  razorpay: {
    id: 'razorpay',
    name: 'Razorpay',
    system: 'gateway',
    cadence: { mode: 'stream', every: 300, sla: 'realtime' },
    kinds: ['payment', 'refund'],
    wins: ['payment'],
  },
};

const list = () => Object.values(SOURCES);
const get = (id) => SOURCES[id] || null;

module.exports = { SOURCES, list, get };
