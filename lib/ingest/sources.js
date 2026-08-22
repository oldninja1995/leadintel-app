/* The sources: five systems, plus the online travel agencies.
 *
 * Cadences are the Analytics Engine page's stage-1 SLA — "realtime – 15 min"
 * — resolved per source: the two that can push, push; the ones that cannot,
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
    kinds: ['campaign_day', 'adset_day', 'ad_day', 'creative', 'adset', 'audience', 'demographic_day'],
    wins: ['spendDelivery'],
  },

  google_ads: {
    id: 'google_ads',
    name: 'Google Ads',
    system: 'ads',
    cadence: { mode: 'poll', every: 900, sla: 'realtime – 15 min' },
    kinds: ['campaign_day', 'adgroup_day', 'ad_day', 'keyword_day', 'search_term_day', 'conversion_day', 'keyword'],
    wins: ['spendDelivery'],
  },

  /* Google Analytics is `system: 'web'` and wins nothing.
   *
   * It measures sessions on the site, which no other connected system reports,
   * so there is nothing for it to contend over — and it must not be given
   * authority it would lose anyway: GA's own conversion counting disagrees with
   * both the ad platforms and the CRM by design (different attribution windows,
   * different definitions of a conversion). Its value here is the *behaviour*
   * nothing else can see, and the channel split — Paid Search against Organic
   * against Direct — which Google classifies with its own rules rather than
   * ours. */
  google_analytics: {
    id: 'google_analytics',
    name: 'Google Analytics',
    system: 'web',
    cadence: { mode: 'poll', every: 3600, sla: 'hourly' },
    kinds: ['session_day', 'channel_day', 'channel_revenue_day', 'source_medium_day', 'page_day', 'landing_page_day', 'city_day', 'city_revenue_day', 'event_day'],
    wins: [],
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

/* ── The online travel agencies ─────────────────────────────────────────────
 *
 * Six channels, one shape. An OTA reports the same thing whichever one it is —
 * a reservation, what the guest paid, and what the channel kept — so they are
 * built from a table rather than written out six times, the same reasoning that
 * makes connectors.js a factory.
 *
 * `system: 'ota'` is a sixth system, and it deliberately **wins nothing**. The
 * precedence table in contract.js is the Analytics Engine page's, and that page
 * was written before a channel was a source; giving an OTA authority over
 * `revenue` or `bookingStatus` would silently outrank the PMS folio on the
 * strength of a table nobody reviewed. A channel's reservation is therefore its
 * own entity (`otaReservations`) rather than a competing view of a booking —
 * see the note in canonical.js for why the two are kept apart rather than
 * merged into one number that would be neither.
 *
 * Polled, not streamed. Every one of these publishes a reservations *pull*;
 * the push side is a channel manager's job, and this app is not one.
 */
const OTA_CHANNELS = [
  { id: 'booking_com', name: 'Booking.com' },
  { id: 'expedia', name: 'Expedia Group' },
  { id: 'agoda', name: 'Agoda' },
  { id: 'airbnb', name: 'Airbnb' },
  /* MakeMyTrip and Goibibo merged and share one connectivity platform, but they
     are two extranets with two hotel codes and two commission agreements, and a
     revenue manager reads them apart. Two sources. */
  { id: 'makemytrip', name: 'MakeMyTrip' },
  { id: 'goibibo', name: 'Goibibo' },
];

for (const channel of OTA_CHANNELS) {
  SOURCES[channel.id] = {
    id: channel.id,
    name: channel.name,
    system: 'ota',
    cadence: { mode: 'poll', every: 900, sla: 'realtime – 15 min' },
    kinds: ['reservation'],
    wins: [],
  };
}

const OTA_IDS = OTA_CHANNELS.map((c) => c.id);
const isOta = (id) => OTA_IDS.includes(id);

const list = () => Object.values(SOURCES);
const get = (id) => SOURCES[id] || null;

module.exports = { SOURCES, list, get, OTA_CHANNELS, OTA_IDS, isOta };
