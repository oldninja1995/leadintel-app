/* Sales Analytics — team and calls. AUTHORED — see PHASES.md, Phase 1.
 * NOTE: this screen's markup is incomplete — the design file was truncated
 * mid-block by the read cap, so part of the calls table is missing. */

const { UP, DOWN, WARN, NA } = require('./_tokens');

module.exports = {
  salesTabs: [
    { label: 'Team', color: 'var(--color-accent-300)', border: 'var(--color-accent-400)' },
    { label: 'Calls', color: 'var(--color-neutral-500)', border: 'transparent' },
  ],

  salesRows: [
    { name: 'Reshma Menon', init: 'RM', abv: 'RM', bookings: '38', rev: '₹9.4L', close: '21.4%', closeColor: UP, resp: '21 min', respColor: UP, calls: '284', wa: '412', rating: '4.8', comp: '96%', compColor: UP, coach: 'Model performer — pair on objection handling' },
    { name: 'Arun Kurian', init: 'AK', abv: 'AK', bookings: '31', rev: '₹7.8L', close: '18.9%', closeColor: UP, resp: '34 min', respColor: UP, calls: '261', wa: '388', rating: '4.6', comp: '92%', compColor: UP, coach: 'Strong close, slow on first touch after 6pm' },
    { name: 'Sneha Nair', init: 'SN', abv: 'SN', bookings: '27', rev: '₹6.2L', close: '16.2%', closeColor: NA, resp: '52 min', respColor: NA, calls: '243', wa: '341', rating: '4.4', comp: '88%', compColor: NA, coach: 'Cancellation rate 4.4% — review payment follow-up' },
    { name: 'Vishnu Joseph', init: 'VJ', abv: 'VJ', bookings: '19', rev: '₹4.1L', close: '12.8%', closeColor: WARN, resp: '1h 48m', respColor: DOWN, calls: '198', wa: '224', rating: '4.1', comp: '74%', compColor: WARN, coach: 'Response time is the single biggest gap' },
    { name: 'Tara George', init: 'TG', abv: 'TG', bookings: '14', rev: '₹3.0L', close: '11.1%', closeColor: WARN, resp: '2h 12m', respColor: DOWN, calls: '164', wa: '186', rating: '4.0', comp: '68%', compColor: DOWN, coach: 'New joiner — shadow Reshma for two weeks' },
  ],

  callKpis: [
    { label: 'Calls placed', value: '1,150', delta: '+8.4%', deltaColor: NA },
    { label: 'Connected', value: '842', delta: '+11.2%', deltaColor: UP },
    { label: 'Connect rate', value: '73.2%', delta: '+1.8pt', deltaColor: UP },
    { label: 'Avg duration', value: '4m 18s', delta: '+22s', deltaColor: UP },
    { label: 'Calls per booking', value: '3.7', delta: '−0.4', deltaColor: UP },
    { label: 'After-hours misses', value: '48', delta: '+12', deltaColor: DOWN },
  ],
};
