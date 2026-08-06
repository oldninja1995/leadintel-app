/* AI Command Center — eight tabs. AUTHORED — see PHASES.md, Phase 1.
 *
 * Written to the explanation contract the Analytics Engine page specifies:
 * state the change, decompose drivers with quantified shares, name related
 * metrics, separate real efficiency from mix, recommend with an expected
 * value, declare confidence and sources. The worked example on that page —
 * Net ROAS 4.2x → 4.8x, driven 58/27/15 by CPL, response time and ADR — is
 * carried through here so the two artefacts agree.
 *
 * `aiTabs` is not defined here: the server supplies it from the sub-view map. */

const { UP, DOWN, WARN, NA, seg } = require('./_tokens');

module.exports = {
  up: UP,
  down: DOWN,
  warn: WARN,

  /* ── Command centre ── */

  sumTitle: 'July in one paragraph',
  sumNarrative:
    'Net revenue closed at ₹52.3L, up 12.4%, on ad spend of ₹10.9L — a net ROAS of 4.8x against a 4.0x target, and the ninth consecutive day above it. The gain is real efficiency rather than a mix shift: holding channel mix constant still yields 4.7x. Munnar Honeymoon carried it, with CPL down 22% after UGC video 03 took 60% of ad set budget. Two things are working against you — cancellations crossed 3% for a third day, and Kumarakom is pacing at 76% of prior month. Confidence 94%; the gap is 3% of bookings with no traceable first touch.',

  /* sumRanges, fcRanges, benchModes and the simulator controls are supplied by
     select() below so each reflects the URL. */

  sumKpis: [
    { label: 'NET REVENUE', value: '₹52.3L', delta: '+12.4%', deltaColor: UP },
    { label: 'NET ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP },
    { label: 'BOOKINGS', value: '312', delta: '+38', deltaColor: UP },
    { label: 'OCCUPANCY', value: '78%', delta: '−4pt', deltaColor: WARN },
    { label: 'CANCEL RATE', value: '3.4%', delta: '+0.9pt', deltaColor: DOWN },
    { label: 'CONFIDENCE', value: '94%', delta: 'composite', deltaColor: UP },
  ],

  aiRisks: [
    { dot: DOWN, text: 'Cancellation rate above 3% for three consecutive days', meta: '₹1.8L at risk · payment-window driven' },
    { dot: WARN, text: 'Kumarakom Retreat pacing at 76% of prior month', meta: '18 days to recover August' },
    { dot: WARN, text: 'Monsoon Package fatigue at 71 and still spending', meta: '₹1.26L spent · 1.7x net ROAS' },
    { dot: WARN, text: 'Retargeting frequency 4.2 on Munnar Honeymoon', meta: 'first place fatigue will show' },
  ],

  aiOpps: [
    { text: 'Email/WhatsApp returns 21.8x net on ₹0.18L — the smallest budget in the account', meta: 'est. +₹3.2L/mo at 3x budget' },
    { text: 'Brand search underspending at 52% pace with 6.9x net ROAS', meta: 'est. +₹1.9L/mo' },
    { text: 'Honeymoon suite sells out first at every property', meta: 'ADR headroom ~8%' },
  ],

  aiActions: [
    { text: 'Move ₹40K/day from Corporate offsite to Munnar Honeymoon', meta: 'CPL 2.0x higher, close rate half', btn: 'Simulate' },
    { text: 'Shorten payment window to 48h with a 24h reminder', meta: 'recovers ~5 of 8 monthly cancellations', btn: 'Simulate' },
    { text: 'Brief two variants on UGC video 03 before fatigue crosses 70', meta: 'protects ₹4.1L of monthly revenue', btn: 'Brief' },
  ],

  aiCaps: [
    'Reads the metric registry, never the raw tables',
    'Every claim resolves to a metric and a time window',
    'Quantifies driver shares or declares it cannot',
    'Separates real efficiency from mix shift',
    'Suppresses recommendations below 60% confidence',
    'Cites the systems each claim rests on',
  ],

  /* ── Health ── */

  healthMinis: [
    { name: 'Marketing', score: '84', color: UP, w: '84%', chips: ['CPL −18%', 'CTR +0.2pt', 'Fatigue 1 alert'] },
    { name: 'Sales', score: '71', color: NA, w: '71%', chips: ['Response 44m', '2 reps over 1h'] },
    { name: 'Revenue', score: '88', color: UP, w: '88%', chips: ['ADR +6%', 'RevPAR +9.2%'] },
    { name: 'Operations', score: '62', color: WARN, w: '62%', chips: ['Cancel 3.4%', 'Occ −4pt'] },
  ],

  healthCards: [
    { name: 'Media efficiency', icon: 'ph ph-megaphone', score: '84', color: UP, dash: '84,100', trend: '+7', trendColor: UP, bench: '3.4x category', risk: 'Low', riskColor: UP, reason: 'CPL fell 22% while lead volume rose 18% — efficiency, not throttling.', rec: 'Scale Munnar Honeymoon by 20%' },
    { name: 'Sales responsiveness', icon: 'ph ph-timer', score: '71', color: NA, dash: '71,100', trend: '+14', trendColor: UP, bench: '30 min target', risk: 'Medium', riskColor: WARN, reason: 'Median is 44 minutes, but two reps sit above two hours and take 31% of leads.', rec: 'Reassign after-hours routing' },
    { name: 'Revenue quality', icon: 'ph ph-currency-inr', score: '88', color: UP, dash: '88,100', trend: '+5', trendColor: UP, bench: 'ADR ₹8,940', risk: 'Low', riskColor: UP, reason: 'ADR and RevPAR both up with no discounting — mix improved toward suites.', rec: 'Test 8% suite ADR increase' },
    { name: 'Booking integrity', icon: 'ph ph-shield-warning', score: '62', color: WARN, dash: '62,100', trend: '−9', trendColor: DOWN, bench: '2.0% target', risk: 'High', riskColor: DOWN, reason: 'Cancellations cluster at the 72-hour payment window, not at any one property.', rec: 'Shorten window to 48h' },
    { name: 'Data freshness', icon: 'ph ph-arrows-clockwise', score: '94', color: UP, dash: '94,100', trend: '+2', trendColor: UP, bench: '15 min SLA', risk: 'Low', riskColor: UP, reason: 'CRM 4 minutes, ads 12 minutes. One Google lag of 22 minutes this month.', rec: 'No action' },
    { name: 'Demand pacing', icon: 'ph ph-gauge', score: '68', color: WARN, dash: '68,100', trend: '−6', trendColor: DOWN, bench: '82% occupancy', risk: 'Medium', riskColor: WARN, reason: 'Kumarakom is 24 points behind prior month; the other two properties are on pace.', rec: 'Kumarakom-only promotion' },
  ],

  /* ── Forecast ── */

  fcLabel: 'August projection',
  fcConf: '89%',
  fcNote:
    'Built on 18 months of booking curves, current pace and the 30-day lookback. The band widens after Aug 20 because the Onam window has only two comparable years.',


  fcKpis: [
    { label: 'PROJECTED REVENUE', value: '₹61.0L', range: '₹55.2L – ₹66.9L', delta: '+16.6%', deltaColor: UP },
    { label: 'BOOKINGS', value: '468', range: '431 – 502', delta: '+50', deltaColor: UP },
    { label: 'OCCUPANCY', value: '83%', range: '79% – 87%', delta: '+5pt', deltaColor: UP },
    { label: 'RECOMMENDED BUDGET', value: '₹9.6L', range: '₹8.8L – ₹10.4L', delta: '−12%', deltaColor: UP },
  ],

  /* ── Anomalies ── */

  anomalies: [
    { title: 'Cancellation spike', scope: 'All properties', dev: '+2pt', devColor: DOWN, when: 'Jul 26 – Jul 30', status: 'Root cause found', statusColor: UP, dot: DOWN },
    { title: 'Kumarakom booking pace drop', scope: 'Kumarakom Retreat', dev: '−24%', devColor: DOWN, when: 'Jul 22 onward', status: 'Investigating', statusColor: WARN, dot: DOWN },
    { title: 'Monsoon Package CTR collapse', scope: 'Meta · Monsoon Package', dev: '−41%', devColor: DOWN, when: 'Jul 19 onward', status: 'Root cause found', statusColor: UP, dot: WARN },
    { title: 'Google Ads sync lag', scope: 'Connector', dev: '22 min', devColor: WARN, when: 'Jul 29', status: 'Resolved', statusColor: UP, dot: NA },
    { title: 'Brand search underspend', scope: 'Google · Brand search', dev: '−48%', devColor: WARN, when: 'Jul 12 onward', status: 'Open', statusColor: WARN, dot: WARN },
  ],

  rootChain: [
    { n: '1', text: 'Cancellations rose from 2.5% to 3.4% between Jul 26 and Jul 30', evidence: 'PMS · 8 cancellations on 236 bookings', line: true },
    { n: '2', text: 'All eight sat in the 72-hour unpaid window at the moment of cancellation', evidence: 'PMS folio status at cancellation', line: true },
    { n: '3', text: 'Seven of eight received no payment reminder before the window closed', evidence: 'CRM · no reminder task logged', line: true },
    { n: '4', text: 'Reminder automation was paused during the Jul 24 template migration', evidence: 'Audit log · automation disabled by admin', line: true },
    { n: '5', text: 'Not a demand or media problem: enquiry volume and CPL both improved over the same window', evidence: 'Meta + CRM · leads +18%, CPL −22%', line: false },
  ],

  /* ── Simulator ── */


  /* ── Goals & benchmarks ── */

  goals: [
    { name: 'Monthly net revenue', cur: '₹52.3L', target: '₹55.0L', w: '95%', pace: '95% · on track', paceColor: UP, barColor: 'linear-gradient(90deg,var(--color-accent-700),var(--color-accent-400))' },
    { name: 'Net ROAS', cur: '4.8x', target: '4.0x', w: '100%', pace: '120% · exceeded', paceColor: UP, barColor: 'linear-gradient(90deg,var(--color-accent-700),var(--color-accent-400))' },
    { name: 'Occupancy', cur: '78%', target: '82%', w: '95%', pace: '95% · slightly behind', paceColor: WARN, barColor: 'linear-gradient(90deg,#7a6a45,#c8be78)' },
    { name: 'Cancellation rate', cur: '3.4%', target: '2.0%', w: '59%', pace: '59% · off target', paceColor: DOWN, barColor: 'linear-gradient(90deg,#7a4444,#c88a8a)' },
    { name: 'Lead response time', cur: '44 min', target: '30 min', w: '68%', pace: '68% · improving', paceColor: WARN, barColor: 'linear-gradient(90deg,#7a6a45,#c8be78)' },
  ],

  benchModes: [
    { label: 'vs last period', ...seg(true) },
    { label: 'vs last year', ...seg(false) },
    { label: 'vs category', ...seg(false) },
  ],

  benchCol1: 'Metric',
  benchCol2: 'Previous',
  benchCol3: 'Current',

  benchRows: [
    { metric: 'Net ROAS', prev: '4.2x', cur: '4.8x', delta: '+0.6x', deltaColor: UP, w: '78%', barColor: 'var(--color-accent-400)' },
    { metric: 'CPL', prev: '₹521', cur: '₹427', delta: '−18.0%', deltaColor: UP, w: '64%', barColor: 'var(--color-accent-400)' },
    { metric: 'ADR', prev: '₹8,434', cur: '₹8,940', delta: '+6.0%', deltaColor: UP, w: '71%', barColor: 'var(--color-accent-400)' },
    { metric: 'RevPAR', prev: '₹6,385', cur: '₹6,973', delta: '+9.2%', deltaColor: UP, w: '69%', barColor: 'var(--color-accent-400)' },
    { metric: 'Occupancy', prev: '81%', cur: '78%', delta: '−3pt', deltaColor: DOWN, w: '58%', barColor: '#c8be78' },
    { metric: 'Cancellation rate', prev: '2.5%', cur: '3.4%', delta: '+0.9pt', deltaColor: DOWN, w: '42%', barColor: '#c88a8a' },
    { metric: 'Lead response', prev: '3h 06m', cur: '44 min', delta: '−76%', deltaColor: UP, w: '82%', barColor: 'var(--color-accent-400)' },
  ],

  /* ── Recommendations feed ── */

  aiFeed: [
    { title: 'Reallocate Corporate offsite budget', cat: 'Budget', icon: 'ph ph-arrows-left-right', color: 'var(--color-accent-300)', body: 'Corporate offsite runs a ₹712 CPL against a ₹348 CPL on Munnar Honeymoon, and closes at half the rate. Moving ₹40K/day is worth an estimated ₹2.8L a month at unchanged total spend. Confidence 86% — sources: Meta Ads, TeleCRM.', action: 'Simulate', chips: ['+₹2.8L/mo', '86% confidence', 'Meta · CRM'] },
    { title: 'Shorten the payment window to 48 hours', cat: 'Operations', icon: 'ph ph-clock-countdown', color: WARN, body: 'Every one of the eight July cancellations sat unpaid in the 72-hour window, and seven never received a reminder because automation was paused on Jul 24. Restoring it and shortening to 48h recovers an estimated five of eight. Confidence 91% — sources: PMS, TeleCRM, audit log.', action: 'Simulate', chips: ['+₹1.1L/mo', '91% confidence', 'PMS · CRM'] },
    { title: 'Fund Email/WhatsApp properly', cat: 'Budget', icon: 'ph ph-whatsapp-logo', color: 'var(--color-accent-300)', body: 'It returns 21.8x net on ₹0.18L — the highest return and the smallest budget in the account. Tripling it is worth an estimated ₹3.2L a month, though returns will compress as the list saturates. Confidence 72% — the list is small enough that the estimate is soft.', action: 'Review', chips: ['+₹3.2L/mo', '72% confidence', 'CRM'] },
    { title: 'Refresh UGC video 03 before it fatigues', cat: 'Creative', icon: 'ph ph-film-strip', color: 'var(--color-accent-300)', body: 'Fatigue is 42 and healthy, but hold rate has slipped 4 points in ten days — the usual first signal. It carries 60% of Munnar spend, so a late refresh puts ₹4.1L of monthly revenue at risk. Confidence 78% — sources: Meta Ads.', action: 'Brief', chips: ['protects ₹4.1L', '78% confidence', 'Meta'] },
    { title: 'Route after-hours leads away from two reps', cat: 'Sales', icon: 'ph ph-timer', color: WARN, body: 'Median response is 44 minutes, but Vishnu and Tara sit above two hours and take 31% of incoming leads. Response time explained 27% of the Net ROAS improvement, so this is a revenue lever, not an admin one. Confidence 84% — sources: TeleCRM.', action: 'Configure', chips: ['+₹1.4L/mo', '84% confidence', 'CRM'] },
  ],

  /* ── URL-driven controls ──────────────────────────────────────────────────
     The simulator genuinely computes: it is a what-if tool, so a fixed answer
     regardless of the inputs would be worse than useless. The model below is
     deliberately simple and its assumptions are stated on screen:

       · incremental Meta spend returns net ROAS 4.6x, degraded 15% because
         the marginal impression is worth less than the average one
       · bookings move with revenue at the ₹31,400 average deal size
       · a shorter payment window recovers cancelled revenue directly; the
         24h option also costs 2% of bookings from guests who need longer

     These are assumptions, not measurements. Replace them once Phase 5 makes
     real marginal-return data available. */

  select(query) {
    const pick = (options, want, fallback) => (options.includes(want) ? want : fallback);

    const sumRange = pick(['7d', '30d', 'Quarter'], query.sumRange, '30d');
    const fcRange = pick(['August', 'Q3', 'Rest of year'], query.fcRange, 'August');
    const benchMode = pick(['vs last period', 'vs last year', 'vs category'], query.bench, 'vs last period');

    const metaOpt = pick(['−20%', 'Hold', '+20%', '+40%'], query.simMeta, '+20%');
    const adrOpt = pick(['Hold', '+4%', '+8%'], query.simAdr, 'Hold');
    const cancelOpt = pick(['72h window', '48h + reminder', '24h'], query.simCancel, '48h + reminder');

    const url = (extra) => {
      const p = new URLSearchParams({
        v: 'aiSim', simMeta: metaOpt, simAdr: adrOpt, simCancel: cancelOpt, ...extra,
      });
      return `/ai?${p.toString()}`;
    };

    /* — the model — */
    const BASE = { revenue: 52.3, spend: 10.9, bookings: 312, cancelPt: 3.4, metaSpend: 6.42 };
    const MARGINAL_ROAS = 4.6 * 0.85;
    const DEAL = 0.314; /* ₹31,400 in lakhs */

    const metaMult = { '−20%': -0.2, Hold: 0, '+20%': 0.2, '+40%': 0.4 }[metaOpt];
    const adrMult = { Hold: 0, '+4%': 0.04, '+8%': 0.08 }[adrOpt];
    const cancel = {
      '72h window': { pt: 0, bookingPenalty: 0 },
      '48h + reminder': { pt: -1.1, bookingPenalty: 0 },
      '24h': { pt: -1.6, bookingPenalty: -0.02 },
    }[cancelOpt];

    const extraSpend = BASE.metaSpend * metaMult;
    const extraRevenue = extraSpend * MARGINAL_ROAS;
    const recovered = BASE.revenue * (-cancel.pt / 100);
    const revenue = (BASE.revenue + extraRevenue + recovered) * (1 + adrMult);
    const spend = BASE.spend + extraSpend;
    const bookings = Math.round(
      (BASE.bookings + (extraRevenue + recovered) / DEAL) * (1 + cancel.bookingPenalty)
    );
    const cancelPt = BASE.cancelPt + cancel.pt;
    const roas = revenue / spend;

    const d = (n, unit = 'L', dp = 1) =>
      `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toFixed(dp)}${unit}`;
    const sign = (n) => (n >= 0 ? UP : DOWN);

    /* Confidence falls as more levers move away from the observed baseline. */
    const assumptions = [metaMult !== 0, adrMult !== 0, cancel.pt !== 0].filter(Boolean).length;
    const confidence = [94, 88, 82, 74][assumptions];

    return {
      sumRanges: ['7d', '30d', 'Quarter'].map((l) => ({
        label: l, go: `/ai?v=aiCommand&sumRange=${encodeURIComponent(l)}`, ...seg(l === sumRange),
      })),
      fcRanges: ['August', 'Q3', 'Rest of year'].map((l) => ({
        label: l, go: `/ai?v=aiForecast&fcRange=${encodeURIComponent(l)}`, ...seg(l === fcRange),
      })),
      benchModes: ['vs last period', 'vs last year', 'vs category'].map((l) => ({
        label: l, go: `/ai?v=aiGoals&bench=${encodeURIComponent(l)}`, ...seg(l === benchMode),
      })),

      simMetaOpts: ['−20%', 'Hold', '+20%', '+40%'].map((l) => ({
        label: l, go: url({ simMeta: l }), ...seg(l === metaOpt),
      })),
      simAdrOpts: ['Hold', '+4%', '+8%'].map((l) => ({
        label: l, go: url({ simAdr: l }), ...seg(l === adrOpt),
      })),
      simCancelOpts: ['72h window', '48h + reminder', '24h'].map((l) => ({
        label: l, go: url({ simCancel: l }), ...seg(l === cancelOpt),
      })),

      simScenario: `Meta budget ${metaOpt} · ADR ${adrOpt} · payment window ${cancelOpt}`,
      simNote:
        `Incremental Meta spend is modelled at ${MARGINAL_ROAS.toFixed(1)}x net — the current 4.6x degraded 15% for marginal return. Bookings move with revenue at the ₹31,400 average deal size. ${assumptions === 0 ? 'No levers moved, so this is the observed baseline.' : `${assumptions} lever${assumptions > 1 ? 's' : ''} moved from baseline.`}`,

      simOut: [
        { label: 'PROJECTED REVENUE', value: `₹${revenue.toFixed(1)}L`, delta: d(revenue - BASE.revenue), deltaColor: sign(revenue - BASE.revenue) },
        { label: 'NET ROAS', value: `${roas.toFixed(1)}x`, delta: `${roas - BASE.revenue / BASE.spend >= 0 ? '+' : '−'}${Math.abs(roas - BASE.revenue / BASE.spend).toFixed(1)}x`, deltaColor: sign(roas - BASE.revenue / BASE.spend) },
        { label: 'BOOKINGS', value: String(bookings), delta: `${bookings - BASE.bookings >= 0 ? '+' : '−'}${Math.abs(bookings - BASE.bookings)}`, deltaColor: sign(bookings - BASE.bookings) },
        { label: 'CANCEL RATE', value: `${cancelPt.toFixed(1)}%`, delta: `${cancel.pt === 0 ? 'unchanged' : `${cancel.pt.toFixed(1)}pt`}`, deltaColor: cancel.pt < 0 ? UP : NA },
        { label: 'AD SPEND', value: `₹${spend.toFixed(1)}L`, delta: d(spend - BASE.spend), deltaColor: NA },
        { label: 'CONFIDENCE', value: `${confidence}%`, delta: assumptions === 0 ? 'observed' : `${assumptions} assumption${assumptions > 1 ? 's' : ''}`, deltaColor: confidence >= 85 ? UP : WARN },
      ],
    };
  },
};
