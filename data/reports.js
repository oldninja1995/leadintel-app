/* Reports & Dashboards — builder, scorecard, presentation, schedule,
 * templates. AUTHORED — see PHASES.md, Phase 1.
 *
 * `repTabs` is not defined here: the server supplies it from the sub-view map. */

const { UP, DOWN, WARN, NA, seg } = require('./_tokens');

/* A canvas widget is a discriminated union: the builder branches on six `is*`
   flags, so every widget declares all six rather than only its own. An absent
   flag reads the same as a false one, which is exactly why a mistyped flag
   would render an empty card in silence. */
const KINDS = ['isKpi', 'isLine', 'isBar', 'isDonut', 'isFunnel', 'isTable', 'isAi'];
const widget = (kind, w) => ({
  ...Object.fromEntries(KINDS.map((k) => [k, k === kind])),
  value: '', delta: '', deltaColor: NA, text: '',
  ...w,
});

module.exports = {
  up: UP,
  down: DOWN,

  /* ── Builder ── */

  widgetGroups: [
    { label: 'Metrics', items: [
      { icon: 'ph ph-number-square-one', name: 'KPI tile' },
      { icon: 'ph ph-rows', name: 'KPI row' },
      { icon: 'ph ph-gauge', name: 'Gauge' },
    ] },
    { label: 'Charts', items: [
      { icon: 'ph ph-chart-line', name: 'Line' },
      { icon: 'ph ph-chart-bar', name: 'Bar' },
      { icon: 'ph ph-chart-donut', name: 'Donut' },
      { icon: 'ph ph-funnel', name: 'Funnel' },
    ] },
    { label: 'Tables', items: [
      { icon: 'ph ph-table', name: 'Metric table' },
      { icon: 'ph ph-list-numbers', name: 'Leaderboard' },
    ] },
    { label: 'Narrative', items: [
      { icon: 'ph-fill ph-sparkle', name: 'AI summary' },
      { icon: 'ph ph-text-align-left', name: 'Text block' },
    ] },
  ],

  dashTabs: [
    { label: 'Owner weekly', ...seg(true) },
    { label: 'GM daily', ...seg(false) },
    { label: 'Marketing', ...seg(false) },
  ],

  /* The KPI tiles on the builder canvas name their registry metric, so a
     dashboard being composed shows the same figure as the dashboard it is
     composed from. The chart and table widgets carry no `metric` — there is no
     registry entry for a series, only for a number. */
  canvasWidgets: [
    widget('isKpi', { metric: 'revenue.net', title: 'Net revenue', span: '1', h: '96px', value: '₹52.3L', delta: '+12.4%', deltaColor: UP }),
    widget('isKpi', { metric: 'roas.net', title: 'Net ROAS', span: '1', h: '96px', value: '4.8x', delta: '+0.6x', deltaColor: UP }),
    widget('isKpi', { metric: 'bookings.confirmed', title: 'Bookings', span: '1', h: '96px', value: '312', delta: '+38', deltaColor: UP }),
    widget('isKpi', { metric: 'occupancy.rate', title: 'Occupancy', span: '1', h: '96px', value: '78%', delta: '−4pt', deltaColor: WARN }),
    widget('isLine', { title: 'Revenue vs ad spend', span: '3', h: '184px' }),
    widget('isDonut', { title: 'Revenue by source', span: '1', h: '184px' }),
    /* Both widgets mirror the executive dashboard — the builder canvas is
       showing the same metrics, so the same funnel widths and the same
       campaigns at spend × ROAS. */
    widget('isFunnel', { title: 'Reservation funnel', span: '2', h: '168px',
      bars: ['100%', '90%', '47%', '25%', '16%'] }),
    widget('isTable', { title: 'Top campaigns', span: '2', h: '168px', rows: [
      { a: 'Munnar Honeymoon — Meta', b: '₹10.1L' },
      { a: 'Alleppey Houseboat Weekend — Meta', b: '₹7.8L' },
      { a: 'Kumarakom Ayurveda Retreat — Google', b: '₹5.6L' },
    ] }),
    widget('isAi', { title: 'AI summary', span: '4', h: '112px',
      text: 'Net ROAS reached 4.8x against a 4.0x target, driven by a 22% CPL fall on Munnar Honeymoon. Cancellations at 3.4% are the one open risk.' }),
  ],

  /* ── Scorecard ── */

  /* Every tile on the scorecard names its registry metric, so the scorecard
     reads the same definitions as the dashboards rather than being a second
     place the same KPI is written down (Phase 8). */
  scorecardKpis: [
    { metric: 'revenue.net', label: 'NET REVENUE', value: '₹52.3L', delta: '+12.4%', deltaColor: UP },
    { metric: 'roas.net', label: 'NET ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP },
    { metric: 'bookings.confirmed', label: 'BOOKINGS', value: '312', delta: '+38', deltaColor: UP },
    { metric: 'rate.adr', label: 'ADR', value: '₹8,940', delta: '+6.0%', deltaColor: UP },
    { metric: 'occupancy.rate', label: 'OCCUPANCY', value: '78%', delta: '−4pt', deltaColor: WARN },
    { metric: 'cancellation.rate', label: 'CANCEL RATE', value: '3.4%', delta: '+0.9pt', deltaColor: DOWN },
  ],

  scoreOpps: [
    { text: 'Email/WhatsApp at 21.8x net on the smallest budget in the account', value: '+₹3.2L/mo' },
    { text: 'Brand search underspending at 52% pace with 6.9x net ROAS', value: '+₹1.9L/mo' },
    { text: 'Corporate offsite budget better spent on Munnar Honeymoon', value: '+₹2.8L/mo' },
  ],

  scoreRisks: [
    { text: 'Cancellations above 3% for a third consecutive day', value: '₹1.8L' },
    { text: 'Kumarakom Retreat pacing at 76% of prior month', value: '₹2.4L' },
    { text: 'Monsoon Package spending at 1.7x net ROAS with fatigue 71', value: '₹1.26L' },
  ],

  /* ── Presentation ── */

  presentKpis: [
    { metric: 'revenue.net', label: 'NET REVENUE', value: '₹52.3L', delta: '+12.4% vs June', deltaColor: UP },
    { metric: 'roas.net', label: 'NET ROAS', value: '4.8x', delta: 'target 4.0x', deltaColor: UP },
    { metric: 'bookings.confirmed', label: 'BOOKINGS', value: '312', delta: '+38 vs June', deltaColor: UP },
    { label: 'AUGUST FORECAST', value: '₹61.0L', delta: '+16.6% projected', deltaColor: UP },
  ],

  /* ── Schedule & sharing ── */

  schedules: [
    { name: 'Owner weekly', icon: 'ph ph-crown-simple', freq: 'Mondays 08:00 IST', to: 'Anand P', next: 'Aug 04', status: 'Active', statusColor: UP, channels: ['Email', 'WhatsApp'] },
    { name: 'GM daily digest', icon: 'ph ph-buildings', freq: 'Daily 07:30 IST', to: '3 GMs', next: 'Tomorrow', status: 'Active', statusColor: UP, channels: ['Email'] },
    { name: 'Marketing performance', icon: 'ph ph-megaphone', freq: 'Fridays 17:00 IST', to: 'Marketing Director', next: 'Aug 01', status: 'Active', statusColor: UP, channels: ['Email', 'Slack'] },
    { name: 'Reservations pace', icon: 'ph ph-calendar-check', freq: 'Daily 09:00 IST', to: 'Reservations Manager', next: 'Tomorrow', status: 'Paused', statusColor: WARN, channels: ['Email'] },
    { name: 'Month-end board pack', icon: 'ph ph-presentation-chart', freq: 'Last day, 18:00 IST', to: 'Owner, GMs', next: 'Aug 31', status: 'Active', statusColor: UP, channels: ['Email', 'PDF'] },
  ],

  shareRows: [
    { who: 'Anand P', init: 'AP', meta: 'Owner · all properties', access: 'Full access' },
    { who: 'Reshma Menon', init: 'RM', meta: 'Sales Manager · all properties', access: 'Can edit' },
    { who: 'Deepa Krishnan', init: 'DK', meta: 'Marketing Director', access: 'Can edit' },
    { who: 'Suresh Nair', init: 'SN', meta: 'GM · Munnar Hillside', access: 'View — Munnar only' },
    { who: 'Latha Rajan', init: 'LR', meta: 'Revenue Manager', access: 'Can edit' },
  ],

  exportOpts: [
    { name: 'PDF', icon: 'ph ph-file-pdf', color: DOWN, meta: 'Branded, print-ready' },
    { name: 'Excel', icon: 'ph ph-file-xls', color: UP, meta: 'Raw rows plus pivots' },
    { name: 'CSV', icon: 'ph ph-file-csv', color: NA, meta: 'Single table' },
    { name: 'Link', icon: 'ph ph-link-simple', color: 'var(--color-accent-300)', meta: 'Live, permission-filtered' },
  ],

  /* ── Templates ── */

  reportList: [
    { go: '/reports?v=repTemplates', name: 'Owner weekly summary', icon: 'ph ph-crown-simple', iconColor: 'var(--color-accent-300)', freq: 'Weekly · Mondays', bg: 'var(--color-accent-900)', border: 'var(--color-accent-800)' },
    { go: '/reports?v=repTemplates', name: 'GM daily digest', icon: 'ph ph-buildings', iconColor: NA, freq: 'Daily · 07:30', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Marketing performance', icon: 'ph ph-megaphone', iconColor: NA, freq: 'Weekly · Fridays', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Campaign deep dive', icon: 'ph ph-chart-line-up', iconColor: NA, freq: 'On demand', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Creative scorecard', icon: 'ph ph-film-strip', iconColor: NA, freq: 'Fortnightly', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Sales team review', icon: 'ph ph-handshake', iconColor: NA, freq: 'Monthly', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Reservations pace', icon: 'ph ph-calendar-check', iconColor: NA, freq: 'Daily · 09:00', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Attribution comparison', icon: 'ph ph-tree-structure', iconColor: NA, freq: 'On demand', bg: 'transparent', border: 'var(--color-neutral-800)' },
    { go: '/reports?v=repTemplates', name: 'Month-end board pack', icon: 'ph ph-presentation-chart', iconColor: NA, freq: 'Monthly · last day', bg: 'transparent', border: 'var(--color-neutral-800)' },
  ],

  selReport: {
    name: 'Owner weekly summary',
    period: 'Jul 24 – Jul 30, 2026',
    summary:
      'Net revenue of ₹52.3L, up 12.4%, at a net ROAS of 4.8x against a 4.0x target. The improvement is real efficiency rather than a mix shift — holding channel mix constant still yields 4.7x. Munnar Honeymoon drove it, with CPL down 22% after a creative reallocation. Two risks are open: cancellations at 3.4% and Kumarakom pacing 24 points behind.',
    top: [
      { name: 'Munnar Honeymoon', val: '4.8x net ROAS' },
      { name: 'Brand search', val: '6.9x net ROAS' },
      { name: 'Email / WhatsApp', val: '21.8x net ROAS' },
      { name: 'UGC video 03', val: '78 winning score' },
    ],
    worst: [
      { name: 'Corporate offsite', val: '2.6x net ROAS' },
      { name: 'Monsoon Package', val: 'fatigue 71' },
      { name: 'Kumarakom Retreat', val: '76% of pace' },
      { name: 'Cancellation rate', val: '3.4% vs 2.0% target' },
    ],
    recs: [
      'Move ₹40K/day from Corporate offsite to Munnar Honeymoon — est. +₹2.8L/mo',
      'Restore the payment reminder automation paused on Jul 24 and shorten the window to 48h — est. +₹1.1L/mo',
      'Triple the Email/WhatsApp budget from ₹0.18L — est. +₹3.2L/mo, softer estimate',
      'Brief two variants on UGC video 03 before fatigue crosses 70',
    ],
  },
};
