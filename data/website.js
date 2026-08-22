/* Website Analytics — overview, landing pages, funnels.
 * AUTHORED — see PHASES.md, Phase 1. Direct/booking-engine revenue reconciles
 * to the dashboard's 38% source share of ₹52.3L. */

const { UP, DOWN, WARN, NA } = require('./_tokens');

module.exports = {
  webTabs: [
    { label: 'Overview', color: 'var(--color-accent-300)', border: 'var(--color-accent-400)' },
    { label: 'Landing pages', color: 'var(--color-neutral-500)', border: 'transparent' },
    { label: 'Funnels', color: 'var(--color-neutral-500)', border: 'transparent' },
  ],

  webKpis: [
    { label: 'Sessions', value: '1.84L', delta: '+14.2%', deltaColor: UP },
    { label: 'Users', value: '1.41L', delta: '+12.8%', deltaColor: UP },
    { label: 'Bounce rate', value: '46.2%', delta: '−3.1pt', deltaColor: UP },
    { label: 'Avg session', value: '2m 41s', delta: '+18s', deltaColor: UP },
    { label: 'Booking engine starts', value: '4,218', delta: '+22.4%', deltaColor: UP },
    { label: 'Direct revenue', value: '₹19.9L', delta: '+16.1%', deltaColor: UP },
  ],

  webSources: [
    { src: 'Organic search', sessions: '64,200', rev: '₹5.2L', w: '100%' },
    { src: 'Paid social', sessions: '48,900', rev: '₹6.1L', w: '76%' },
    { src: 'Direct', sessions: '38,400', rev: '₹10.5L', w: '60%' },
    { src: 'Paid search', sessions: '21,100', rev: '₹4.4L', w: '33%' },
    { src: 'Referral', sessions: '7,200', rev: '₹1.1L', w: '11%' },
    { src: 'Email / WhatsApp', sessions: '4,200', rev: '₹4.2L', w: '7%' },
  ],

  topPages: [
    { page: '/munnar-hillside', views: '42,180', avg: '3m 12s', exit: '38.4%', clicks: '6,240' },
    { page: '/offers/honeymoon', views: '28,940', avg: '4m 02s', exit: '29.1%', clicks: '5,110' },
    { page: '/alleppey-lake-villas', views: '24,310', avg: '2m 51s', exit: '41.2%', clicks: '3,880' },
    { page: '/kumarakom-retreat', views: '18,620', avg: '2m 34s', exit: '44.8%', clicks: '2,410' },
    { page: '/booking/dates', views: '14,208', avg: '1m 48s', exit: '52.6%', clicks: '4,218' },
    { page: '/offers/monsoon', views: '11,940', avg: '1m 22s', exit: '68.1%', clicks: '1,020' },
  ],

  lpRows: [
    { lp: '/offers/honeymoon', sessions: '28,940', bounce: '31.2%', bounceColor: UP, scroll: '78%', formStart: '3,420', formDone: '2,180', conv: '7.5%', clicks: '5,110', rev: '₹8.4L', audit: 'Strong', auditColor: UP, auditBorder: 'var(--color-accent-800)' },
    { lp: '/munnar-hillside', sessions: '42,180', bounce: '38.4%', bounceColor: UP, scroll: '71%', formStart: '4,120', formDone: '2,410', conv: '5.7%', clicks: '6,240', rev: '₹9.1L', audit: 'Strong', auditColor: UP, auditBorder: 'var(--color-accent-800)' },
    { lp: '/alleppey-lake-villas', sessions: '24,310', bounce: '41.2%', bounceColor: NA, scroll: '64%', formStart: '2,180', formDone: '1,140', conv: '4.7%', clicks: '3,880', rev: '₹5.2L', audit: 'Adequate', auditColor: NA, auditBorder: 'var(--color-neutral-800)' },
    { lp: '/kumarakom-retreat', sessions: '18,620', bounce: '44.8%', bounceColor: NA, scroll: '58%', formStart: '1,410', formDone: '682', conv: '3.7%', clicks: '2,410', rev: '₹3.1L', audit: 'Adequate', auditColor: NA, auditBorder: 'var(--color-neutral-800)' },
    { lp: '/offers/monsoon', sessions: '11,940', bounce: '68.1%', bounceColor: DOWN, scroll: '34%', formStart: '480', formDone: '164', conv: '1.4%', clicks: '1,020', rev: '₹0.8L', audit: 'Needs work', auditColor: DOWN, auditBorder: 'var(--color-neutral-800)' },
  ],

  /* **The journey this property's booking engine actually reports.**
   *
   * It was six authored steps — landing, availability, booking started, guest
   * details, payment page, confirmed — and two of them describe a checkout this
   * engine does not tag: there is no guest-details event and no payment event in
   * GA4, so those rows could only ever be dashes. The engine's own sequence is
   * check availability, view the rooms, and book; the labels say that.
   *
   * The figures are counted in lib/repository/projections.js from GA4's event
   * report, and every one of these is dropped from the screen if its event is
   * absent — so this list is a shape, never a claim.
   */
  webFunnel: [
    { label: 'Landing page view', n: '—', pct: '—', w: '0%', drop: '—' },
    { label: 'Availability checked', n: '—', pct: '—', w: '0%', drop: '—' },
    { label: 'Room selection viewed', n: '—', pct: '—', w: '0%', drop: '—' },
    /* **Booked online**, not booked. This is the website's funnel and the row
       is GA4's purchase count on this property — the bookings the engine
       reported here. The CRM's own count, for the same window and every
       channel, is stated beneath the funnel so the two cannot be mistaken for
       each other. */
    { label: 'Booked online', n: '—', pct: '—', w: '0%', drop: '—' },
  ],
};
