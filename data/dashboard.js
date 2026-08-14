/* Executive Dashboard.
 *
 * AUTHORED, not transcribed — see PHASES.md, Phase 1. Figures are held
 * consistent with the values the design hardcodes in its own markup: ₹52.3L
 * July revenue, a 38/27/19/16 source split, 78% occupancy against an 82%
 * target, a 16.1% lead→check-in rate averaging 6.2 days, and an August
 * forecast of ₹61.0L. */

const { UP, DOWN, WARN, NA, SRC, spark } = require('./_tokens');

module.exports = {
  up: UP,
  warn: WARN,
  editLabel: 'Edit layout',
  editColor: 'var(--color-neutral-400)',
  editBorder: 'var(--color-neutral-800)',

  /* `metric` names the registry entry a card *is* (sub-phase 6.4). The
     definition — owner, formula, sources, favourability, thresholds — travels
     with the card under every driver; the number itself is replaced by the
     registry's own only under `ingested`, where it is genuinely derived.
     A card with no `metric` has no registry entry yet and is counted as
     unresolved at /metrics/coverage rather than quietly passing. */
  heroKpis: [
    {
      metric: 'revenue.net',
      label: 'Net revenue', value: '₹52.3L', delta: '+12.4%', deltaColor: UP,
      sub: 'after cancellations & commissions', tip: 'Collected revenue net of cancellations and OTA commissions',
      icon: 'ph ph-currency-inr', spark: spark([38, 42, 40, 51, 55, 52, 63, 68, 71, 76]), ...SRC.pms,
    },
    {
      metric: 'roas.net',
      label: 'Net ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP,
      sub: 'gross 6.2x · target 4.0x', tip: 'Net revenue against ad spend, on the workspace attribution model',
      icon: 'ph ph-chart-line-up', spark: spark([48, 45, 52, 50, 58, 61, 60, 68, 72, 78]), ...SRC.blended,
    },
    {
      metric: 'bookings.confirmed',
      label: 'Bookings', value: '312', delta: '+38', deltaColor: UP,
      sub: '94 from paid · 218 direct & organic', tip: 'Confirmed reservations in the period',
      icon: 'ph ph-calendar-check', spark: spark([40, 44, 41, 49, 53, 58, 56, 64, 69, 74]), ...SRC.crm,
    },
    {
      metric: 'occupancy.rate',
      label: 'Occupancy', value: '78%', delta: '−4pt vs target', deltaColor: WARN,
      sub: 'target 82% · 3 properties', tip: 'Room nights sold against available room nights',
      icon: 'ph ph-buildings', spark: spark([62, 66, 64, 70, 68, 74, 71, 76, 74, 78]), ...SRC.pms,
    },
  ],

  miniKpis: [
    /* One metric, two grains — `ads.spend` at `channel:meta` and
       `channel:google`. Split because the blended tile answered a question
       nobody asks: the two platforms are bought, budgeted and judged
       separately, and a single figure moving tells you nothing about which one
       moved. The combined total is still on the Marketing dashboard, which
       says so in its own tooltip; adding the platforms together is that
       screen's job and not this one's.

       These stay two cards over one registry entry rather than becoming
       `ads.spend.meta` and `ads.spend.google` — see lib/metrics/resolve.js.
       The authored figures still sum to the ₹10.9L this tile used to show. */
    { metric: 'ads.spend', at: { dimension: 'channel', value: 'meta' }, label: 'Meta spend', value: '₹7.6L', delta: '+2.4%', deltaColor: NA, tip: 'Meta Ads only — Google is the tile beside it', ...SRC.ads },
    { metric: 'ads.spend', at: { dimension: 'channel', value: 'google' }, label: 'Google spend', value: '₹3.3L', delta: '+4.7%', deltaColor: NA, tip: 'Google Ads only — Meta is the tile beside it', ...SRC.ads },
    /* Split for the same reason spend is, and one more: **the CRM holds organic
       and referral leads beside the paid ones.** Blended CPL divided paid spend
       by every lead in the CRM — 2,554 of them — which is not a cost per lead
       at all. It reads ₹53 and falls whenever the website has a good week,
       which looks like advertising getting cheaper.

       Each tile now divides a channel's spend by the leads that channel is
       tagged with. An untagged lead counts toward neither: it is unattributed,
       not organic, and guessing would move both figures. */
    { metric: 'cost.per_lead', at: { dimension: 'channel', value: 'meta' }, label: 'Meta CPL', value: '₹352', delta: '−12%', deltaColor: UP, tip: 'Meta spend ÷ leads tagged to Meta', ...SRC.ads },
    { metric: 'cost.per_lead', at: { dimension: 'channel', value: 'google' }, label: 'Google CPL', value: '₹541', delta: '−6%', deltaColor: UP, tip: 'Google spend ÷ leads tagged to Google', ...SRC.ads },
    { metric: 'cost.per_booking', label: 'Cost per booking', value: '₹3,480', delta: '−11%', deltaColor: UP, tip: 'Paid spend per confirmed booking', ...SRC.blended },
    { metric: 'rate.adr', label: 'ADR', value: '₹8,940', delta: '+6.0%', deltaColor: UP, tip: 'Average daily rate', ...SRC.pms },
    { metric: 'rate.revpar', label: 'RevPAR', value: '₹6,973', delta: '+9.2%', deltaColor: UP, tip: 'Revenue per available room', ...SRC.pms },
    { metric: 'cancellation.rate', label: 'Cancellation rate', value: '3.4%', delta: '+0.9pt', deltaColor: DOWN, tip: 'Share of bookings cancelled', ...SRC.pms },
    { metric: 'lead.response_minutes', label: 'Lead response', value: '44 min', delta: '−2.4 hrs', deltaColor: UP, tip: 'Median first response to a new lead', ...SRC.crm },
    /* MER is revenue over *total* marketing cost, not attributed revenue over
       ad spend. Total marketing cost is not a thing any connected system
       reports, so there is no registry entry and no formula pretending there
       is. */
    { label: 'MER', value: '4.8x', delta: '+0.5x', deltaColor: UP, tip: 'Marketing efficiency ratio', ...SRC.blended },
  ],

  funnel: [
    { label: 'Leads', n: '2,554', pct: '100%', w: '100%' },
    { label: 'Contacted', n: '2,301', pct: '90.1%', w: '90%' },
    { label: 'Qualified', n: '1,187', pct: '46.5%', w: '47%' },
    { label: 'Quoted', n: '648', pct: '25.4%', w: '25%' },
    { label: 'Booked', n: '412', pct: '16.1%', w: '16%' },
    { label: 'Checked in', n: '398', pct: '15.6%', w: '16%' },
  ],

  campaigns: [
    { name: 'Munnar Honeymoon', platform: 'Meta', spend: '₹2.10L', leads: 604, cpl: '₹348', bookings: 94, roas: '4.8x', roasColor: UP },
    { name: 'Alleppey Houseboat Weekend', platform: 'Meta', spend: '₹1.82L', leads: 471, cpl: '₹386', bookings: 71, roas: '4.3x', roasColor: UP },
    { name: 'Kumarakom Ayurveda Retreat', platform: 'Google', spend: '₹1.44L', leads: 302, cpl: '₹477', bookings: 48, roas: '3.9x', roasColor: NA },
    { name: 'Monsoon Package · Kerala', platform: 'Meta', spend: '₹1.26L', leads: 388, cpl: '₹325', bookings: 39, roas: '3.4x', roasColor: WARN },
    { name: 'Brand search', platform: 'Google', spend: '₹0.61L', leads: 214, cpl: '₹285', bookings: 44, roas: '6.9x', roasColor: UP },
    { name: 'Corporate offsite', platform: 'Google', spend: '₹0.84L', leads: 118, cpl: '₹712', bookings: 12, roas: '2.6x', roasColor: DOWN },
  ],

  properties: [
    { rank: '1', name: 'Munnar Hillside', meta: '84% occ · ADR ₹9,720', rev: '₹22.4L' },
    { rank: '2', name: 'Alleppey Lake Villas', meta: '76% occ · ADR ₹8,910', rev: '₹18.1L' },
    { rank: '3', name: 'Kumarakom Retreat', meta: '71% occ · ADR ₹7,840', rev: '₹11.8L' },
  ],

  reps: [
    { init: 'RM', name: 'Reshma Menon', meta: '38 bookings · 3.1% cancel', rev: '₹9.4L' },
    { init: 'AK', name: 'Arun Kurian', meta: '31 bookings · 2.8% cancel', rev: '₹7.8L' },
    { init: 'SN', name: 'Sneha Nair', meta: '27 bookings · 4.4% cancel', rev: '₹6.2L' },
    { init: 'VJ', name: 'Vishnu Joseph', meta: '19 bookings · 3.6% cancel', rev: '₹4.1L' },
  ],

  recs: [
    { icon: 'ph ph-trend-up', text: 'Shift ₹40K/day from Corporate offsite to Munnar Honeymoon — CPL is 2.0x higher on the former at half the close rate.', impact: '+₹2.8L/mo', action: 'Review' },
    { icon: 'ph ph-film-strip', text: 'UGC video 03 is carrying 60% of Munnar spend at 78 winning score. Build two variants before fatigue crosses 70.', impact: 'protect ₹4.1L', action: 'Brief' },
    { icon: 'ph ph-clock-countdown', text: 'Cancellations cluster at the 72-hour payment window. Shortening it to 48h with a 24h reminder recovers an estimated 5 of 8 monthly.', impact: '+₹1.1L/mo', action: 'Simulate' },
  ],

  alerts: [
    { dot: WARN, text: 'Booking pace on Kumarakom Retreat is 76% of prior month', when: '2h ago' },
    { dot: DOWN, text: 'Cancellation rate crossed 3% for the third consecutive day', when: '6h ago' },
    { dot: WARN, text: 'Creative fatigue on Monsoon Package hit 71', when: 'yesterday' },
    { dot: NA, text: 'Google Ads sync recovered after a 22-minute lag', when: 'yesterday' },
  ],

  activity: [
    { icon: 'ph ph-user-plus', text: 'Reshma Menon converted a Munnar Honeymoon lead — ₹42,800', when: '18 min ago' },
    { icon: 'ph ph-arrows-clockwise', text: 'TeleCRM sync completed · 94 bookings reconciled', when: '4 min ago' },
    { icon: 'ph ph-note-pencil', text: 'Anand P changed attribution to Data driven', when: '3h ago' },
    { icon: 'ph ph-paper-plane-tilt', text: 'GM weekly report sent to 6 recipients', when: 'yesterday' },
    { icon: 'ph ph-x-circle', text: 'Booking #4471 cancelled — refund ₹18,400', when: 'yesterday' },
  ],
};
