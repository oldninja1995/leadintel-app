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
    /* The three headline tiles read the CRM, not the PMS.
     *
     * They were `revenue.net`, `roas.net` and `bookings.confirmed`, all of
     * which are folio metrics — and with no PMS connected all three rendered
     * ₹0, 0.0x and 0 on the front page of the product. That was accurate and
     * useless: the CRM records a reservation value and a won status on every
     * converted lead, so the numbers existed the whole time and the dashboard
     * was reading the one system nobody had connected.
     *
     * They are **labelled as the CRM's**, not quietly substituted — the folio
     * figure is a different thing (settled, reconciled, after cancellations and
     * commissions) and the day a PMS arrives both belong on screen with the gap
     * between them worth reading. `revenue.net`, `roas.net` and
     * `bookings.confirmed` are untouched in the registry and still mean exactly
     * what they meant. */
    {
      metric: 'revenue.reservations',
      label: 'Reservation value', value: '₹52.3L', delta: '+12.4%', deltaColor: UP,
      sub: 'CRM-recorded, cancellations excluded', tip: 'What the CRM records on won leads — not settled folio revenue',
      icon: 'ph ph-currency-inr', spark: spark([38, 42, 40, 51, 55, 52, 63, 68, 71, 76]), ...SRC.crm,
    },
    {
      metric: 'roas.reservations',
      label: 'ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP,
      sub: 'reservation value ÷ ad spend · target 4.0x', tip: 'CRM reservation value against ad spend — pick a channel above for that platform’s own',
      icon: 'ph ph-chart-line-up', spark: spark([48, 45, 52, 50, 58, 61, 60, 68, 72, 78]), ...SRC.blended,
    },
    {
      metric: 'bookings.reservations',
      label: 'Reservations', value: '312', delta: '+38', deltaColor: UP,
      sub: 'won in the CRM, cancellations excluded', tip: 'Leads the CRM records as won, before the PMS confirms anything',
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
    /* One tile, governed by the topbar.
     *
     * This was briefly two — "Meta spend" and "Google spend" side by side —
     * which answered the question but answered it *permanently*: selecting
     * Google in the topbar still showed Meta's tile beside it, because a card
     * carrying its own `at:` grain overrides the screen's scope by design.
     * A dashboard filtered to one platform that keeps a rival's number on it is
     * the same failure the split was meant to fix, one level up.
     *
     * So the grain comes from the chip instead: no selection is Meta and Google
     * combined, choosing one rescopes this and every other card with it. The
     * per-card `at:` support stays in lib/metrics/resolve.js — a drill-down
     * about one campaign still needs it — it is simply not what a dashboard
     * tile should be pinned to. */
    { metric: 'ads.spend', label: 'Ad spend', value: '₹10.9L', delta: '+3.1%', deltaColor: NA, tip: 'Meta and Google combined — pick a channel in the topbar to narrow it', ...SRC.ads },
    /* Blended until the topbar says otherwise — and blended here means
       something specific and easy to misread: **the CRM holds organic and
       referral leads beside the paid ones**, so this divides paid spend by
       every lead in it. That figure falls whenever the website has a good week,
       which looks like advertising getting cheaper. Choosing a channel above
       narrows both halves of the division at once — that channel's spend over
       the leads tagged to it — which is the number worth acting on.

       An untagged lead is counted in neither channel: it is unattributed, not
       organic, and putting it in a bucket would move a cost per lead without
       anyone deciding to. */
    { metric: 'cost.per_lead', label: 'CPL', value: '₹427', delta: '−18%', deltaColor: UP, tip: 'Paid spend ÷ leads — pick a channel in the topbar for that platform’s own CPL', ...SRC.blended },
    /* The CRM's reservation value, which is the only revenue figure that exists
       while no PMS is connected. Narrows with the topbar like everything else,
       so choosing Meta shows the reservation value of leads Meta produced.
       Labelled as the CRM's, never as collected revenue — see the registry
       entry for why it is not folded into `revenue.net`. */
    /* The funnel the CRM is the only system that can measure: how many enquiries
       became interested, what an interested one cost, and how many closed.
       Every one narrows with the topbar, so "for Meta Ads" is a selection
       rather than four more tiles. */
    /* The workspace total, held there whatever the topbar says.
     *
     * Selecting Meta narrows every other tile, which is the point — and it also
     * takes the total off the screen, leaving nothing to read a channel's share
     * against. ₹12.6L means one thing beside ₹2.03Cr and another thing alone. */
    { metric: 'revenue.reservations', unscoped: true, hideWhenScoped: true, label: 'Total reservation value', value: '₹11.2L', delta: '·', deltaColor: NA, tip: 'Every channel and every untagged lead — does not follow the channel filter', ...SRC.crm },
    { metric: 'revenue.per_reservation', label: 'Avg reservation value', value: '₹28,400', delta: '·', deltaColor: NA, tip: 'Reservation value ÷ reservations — a mix measure, not a volume one', ...SRC.crm },
    { metric: 'leads.response_rate', label: 'Lead response rate', value: '91.2%', delta: '·', deltaColor: NA, tip: 'Share of leads worked rather than left at first contact — status movement, not reply events', ...SRC.crm },
    { metric: 'leads.interested_rate', label: 'Interested rate', value: '18.4%', delta: '·', deltaColor: NA, tip: 'Share of leads that reached interested or better', ...SRC.crm },
    { metric: 'cost.per_interested_lead', label: 'Cost / interested lead', value: '₹1,240', delta: '·', deltaColor: NA, tip: 'Ad spend ÷ interested leads — the cost worth optimising', ...SRC.blended },
    { metric: 'leads.conversion_rate', label: 'Lead → won', value: '4.2%', delta: '·', deltaColor: NA, tip: 'Share of leads that became a won reservation', ...SRC.crm },
    { metric: 'leads.interested_to_won', label: 'Interested → won', value: '22.8%', delta: '·', deltaColor: NA, tip: 'How well interested leads are closed — measures the team, not the channel', ...SRC.crm },
    { metric: 'cost.per_reservation', label: 'Cost / reservation', value: '₹3,480', delta: '·', deltaColor: NA, tip: 'Ad spend ÷ CRM-won reservations', ...SRC.blended },
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
