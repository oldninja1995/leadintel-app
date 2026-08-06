/* CRM Dashboard. AUTHORED — see PHASES.md, Phase 1.
 * Stage counts reconcile to the dashboard's reservation funnel. */

const { UP, DOWN, WARN, NA, SRC, spark } = require('./_tokens');

module.exports = {
  warn: WARN,

  crmHero: [
    { metric: 'leads.open', label: 'Open leads', value: '1,142', delta: '+186', deltaColor: UP, sub: 'across 3 properties', tip: 'Leads not yet booked or lost', icon: 'ph ph-users', spark: spark([48, 52, 51, 58, 61, 64, 68, 71, 74, 78]), ...SRC.crm },
    /* Pipeline value needs a per-lead opportunity value. The CRM deal carries
       one, but canonical only uses deals to resolve a booking's revenue and
       never exposes them as an entity — so there is nothing to sum. The
       probability weighting is a model output besides, which is Phase 7. */
    { label: 'Pipeline value', value: '₹38.4L', delta: '+22.1%', deltaColor: UP, sub: 'probability weighted ₹14.2L', tip: 'Sum of open opportunity values', icon: 'ph ph-currency-inr', spark: spark([42, 46, 49, 54, 58, 62, 66, 70, 74, 79]), ...SRC.crm },
    { metric: 'lead.conversion', label: 'Close rate', value: '16.1%', delta: '+2.4pt', deltaColor: UP, sub: 'lead → confirmed booking', tip: 'Share of leads that become bookings', icon: 'ph ph-target', spark: spark([38, 41, 44, 46, 51, 54, 58, 61, 65, 68]), ...SRC.crm },
    { metric: 'lead.response_minutes', label: 'Median response', value: '44 min', delta: '−2.4 hrs', deltaColor: UP, sub: 'target under 30 min', tip: 'First response to a new lead', icon: 'ph ph-timer', spark: spark([82, 76, 70, 62, 55, 48, 42, 36, 30, 26]), ...SRC.crm },
  ],

  /* `period` names the window a card is about (sub-phase 6.4). The same metric
     over a different window is the same definition — `leads.count` over the
     last 24 hours is still leads.count. See lib/metrics/period.js. */
  crmKpis: [
    { metric: 'leads.count', period: 'last-24h', label: 'New leads today', value: '87', delta: '+12', deltaColor: UP, tip: 'Created in the last 24 hours', ...SRC.crm },
    /* "Older than two hours" is the period; "nobody replied" is the metric. */
    { metric: 'leads.unanswered', period: 'last-2h', label: 'Untouched > 2h', value: '14', delta: '+5', deltaColor: DOWN, tip: 'No first response yet', ...SRC.crm },
    /* A follow-up is a scheduled task. No source carries one — the CRM fixture
       has leads, events and deals, and none of them is a diary. */
    { label: 'Follow-ups due', value: '46', delta: '−8', deltaColor: UP, tip: 'Scheduled for today', ...SRC.crm },
    { metric: 'booking.value', label: 'Avg deal size', value: '₹31,400', delta: '+6.2%', deltaColor: UP, tip: 'Mean confirmed booking value', ...SRC.pms },
    /* Stage velocity needs the time between a lead's creation and its booking;
       `leadEvents` carries stage changes but nothing links a booking back to
       the moment its lead converted. */
    { label: 'Stage velocity', value: '3.8 days', delta: '−0.9', deltaColor: UP, tip: 'Median lead to booking', ...SRC.crm },
    { metric: 'leads.lost', period: 'this-month', label: 'Lost this month', value: '284', delta: '+31', deltaColor: DOWN, tip: 'Marked lost or gone cold', ...SRC.crm },
  ],

  crmStages: [
    { label: 'New', n: '412', rev: '₹12.8L', w: '100%' },
    { label: 'Contacted', n: '318', rev: '₹9.9L', w: '77%' },
    { label: 'Qualified', n: '214', rev: '₹7.4L', w: '52%' },
    { label: 'Quoted', n: '128', rev: '₹5.1L', w: '31%' },
    { label: 'Negotiation', n: '70', rev: '₹3.2L', w: '17%' },
    { label: 'Booked', n: '312', rev: '₹9.8L', w: '76%' },
  ],

  reps: [
    { init: 'RM', name: 'Reshma Menon', meta: '38 bookings · 21 min response', rev: '₹9.4L' },
    { init: 'AK', name: 'Arun Kurian', meta: '31 bookings · 34 min response', rev: '₹7.8L' },
    { init: 'SN', name: 'Sneha Nair', meta: '27 bookings · 52 min response', rev: '₹6.2L' },
    { init: 'VJ', name: 'Vishnu Joseph', meta: '19 bookings · 1h 48m response', rev: '₹4.1L' },
    { init: 'TG', name: 'Tara George', meta: '14 bookings · 2h 12m response', rev: '₹3.0L' },
  ],

  followups: [
    { dot: DOWN, name: 'Ananya Sharma', what: 'Quote sent Jul 28 — no reply', when: 'Overdue 2 days', meta: 'Munnar · ₹42,800' },
    { dot: WARN, name: 'Karthik Iyer', what: 'Asked to be called after 6pm', when: 'Due today', meta: 'Alleppey · ₹28,400' },
    { dot: WARN, name: 'Meera Pillai', what: 'Payment link expires tonight', when: 'Due today', meta: 'Munnar · ₹18,600' },
    { dot: NA, name: 'Daniel Thomas', what: 'Confirm anniversary add-on', when: 'Tomorrow', meta: 'Munnar · ₹54,200' },
    { dot: NA, name: 'Priya Varghese', what: 'Send Kumarakom package options', when: 'Aug 03', meta: 'Kumarakom · ₹22,100' },
  ],
};
