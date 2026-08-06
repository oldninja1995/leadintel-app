/* The metric registry — one definition per KPI.
 *
 * Sub-phase 6.1, implementing stage 5. The page calls this the heart of the
 * product and gives it a schema of twelve fields; every definition below
 * carries all twelve, and `assertMetric` refuses one that does not. That is
 * the whole value of a registry: a metric whose owner or favourability is
 * "obvious" is a metric two screens will eventually disagree about.
 *
 *   id · name        stable slug plus display label used everywhere
 *   description      one plain sentence a GM would understand
 *   formula          expression over other registry metrics — never raw SQL
 *   sources[]        which systems feed it; drives the CRM/ADS/BLND badge
 *   refresh          realtime · 5min · 15min · hourly · nightly
 *   owner            the role accountable for the definition, not the number
 *   dependencies[]   upstream metrics — calculation order and impact analysis
 *   benchmark        internal target and, where available, a category figure
 *   thresholds       good / warning / critical bands driving colour and alerts
 *   favourability    whether up is good — a falling CPL must render green
 *   format           currency · percent · ratio · duration · count
 *   aiContext        what the AI may assert about drivers and caveats
 *
 * **Base metrics** carry a `source` function instead of a formula: they read
 * canonical entities directly and are the only place the registry touches
 * data. Everything else is arithmetic over other metrics, so a number can
 * always be explained by walking down its dependencies to the systems at the
 * bottom.
 *
 * Money is in **paise** throughout, as canonical entities carry it. Formatting
 * divides; arithmetic does not. See lib/repository/projections.js for the bug
 * that rule exists to prevent.
 */

const { references, compile } = require('./formula');

const REFRESH = ['realtime', '5min', '15min', 'hourly', 'nightly'];
const FAVOURABILITY = ['higher', 'lower', 'neutral'];
const FORMATS = ['currency', 'percent', 'ratio', 'duration', 'count'];

const sum = (rows, field) => rows.reduce((t, r) => t + (r[field] || 0), 0);
const value = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/* ── the metrics ────────────────────────────────────────────────────────── */

const METRICS = [
  {
    id: 'ads.spend',
    name: 'Ad spend',
    description: 'What the ad platforms report spending in the period, across every campaign.',
    source: (e) => sum(e.campaignDays, 'spend'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Delivery-side figure from Meta and Google. May restate for up to 72 hours as the platforms finalise. Never describe it as revenue-affecting on its own.',
  },
  {
    id: 'revenue.net',
    name: 'Revenue (net)',
    description: 'Settled room and extras revenue on confirmed bookings, after cancellations.',
    /* The PMS folio, not the CRM deal value — the precedence decision made in
       sub-phase 4.4, carried through so the registry cannot quietly disagree
       with the entity it reads. */
    source: (e) => sum(e.bookings.map((b) => ({ v: value(b.revenue) || 0 })), 'v'),
    sources: ['pms', 'crm'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Folio-settled, so it lags a booking by the length of the stay. A gap against CRM deal value is expected and is not an error.',
  },
  {
    id: 'bookings.confirmed',
    name: 'Confirmed bookings',
    description: 'Bookings that settled with revenue attached.',
    source: (e) => e.bookings.filter((b) => (value(b.revenue) || 0) > 0).length,
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A cancelled booking settles at zero and is excluded here, so this can fall while gross bookings rise.',
  },
  {
    id: 'leads.count',
    name: 'Leads',
    description: 'Enquiries the CRM recorded in the period.',
    source: (e) => e.leads.length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts enquiries, not people. One guest enquiring twice is two leads until identity resolution merges them.',
  },

  {
    id: 'leads.open',
    name: 'Open leads',
    description: 'Leads the CRM has neither booked nor lost.',
    /* Stage comes through `n.text`, which title-cases, so it is lowered before
       comparing — the same trap that made lead response read zero events. */
    source: (e) => e.leads.filter((l) => !['booked', 'lost', 'closed-won', 'closed-lost'].includes(String(l.stage || '').toLowerCase())).length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A stock, not a flow — it rises when leads arrive and falls when they resolve either way. A rise is not by itself good news.',
  },
  {
    id: 'leads.unanswered',
    name: 'Unanswered leads',
    description: 'Leads with no first response logged against them.',
    /* A period narrows *which* leads are considered; this counts the ones among
       them nobody replied to. Pairing it with the `last-2h` period — everything
       older than two hours — is what answers "Untouched > 2h" without the
       metric knowing anything about two hours. */
    source: (e) => {
      const answered = new Set(
        (e.leadEvents || [])
          .filter((ev) => String(ev.type || '').toLowerCase() === 'first_response')
          .map((ev) => ev.leadId)
      );
      return e.leads.filter((l) => !answered.has(l.id)).length;
    },
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: { good: 0, warning: 5 },
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts leads with no logged first response. A lead answered outside the CRM looks unanswered here, so treat it as an upper bound on neglect rather than a certainty.',
  },
  {
    id: 'leads.lost',
    name: 'Lost leads',
    description: 'Leads the CRM marked lost.',
    source: (e) => e.leads.filter((l) => ['lost', 'closed-lost'].includes(String(l.stage || '').toLowerCase())).length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts leads explicitly marked lost. A lead quietly abandoned is still open here, so this understates true loss.',
  },
  {
    id: 'ads.impressions',
    name: 'Impressions',
    description: 'Times an ad was shown, across both platforms.',
    source: (e) => sum(e.campaignDays, 'impressions'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A reach measure, not a performance one. Never cite a rise in impressions as evidence of improvement on its own.',
  },
  {
    id: 'ads.clicks',
    name: 'Clicks',
    description: 'Clicks on an ad, across both platforms.',
    source: (e) => sum(e.campaignDays, 'clicks'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Platform-reported. Clicks and site sessions will not agree, and the gap is not an error.',
  },
  {
    id: 'ads.reported_leads',
    name: 'Platform-reported leads',
    description: 'Leads the ad platforms claim, before the CRM confirms them.',
    /* Deliberately separate from `leads.count`. The platforms report far more
       than the CRM records, and collapsing the two would hide exactly the gap
       identity resolution exists to measure. */
    source: (e) => sum(e.campaignDays, 'leads'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Not the same as CRM leads and usually higher. Cite the CRM figure for anything about pipeline; cite this only for delivery.',
  },
  {
    id: 'ads.ctr',
    name: 'CTR',
    description: 'Share of impressions that produced a click.',
    formula: 'ads.clicks / ads.impressions',
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.clicks', 'ads.impressions'],
    benchmark: { target: 0.03, category: 0.024 },
    thresholds: { good: 0.03, warning: 0.015 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 2 },
    aiContext: 'Creative and audience quality together. A falling CTR beside steady bookings is a reach problem, not a conversion one.',
  },
  {
    id: 'ads.cpm',
    name: 'CPM',
    description: 'Cost of a thousand impressions.',
    formula: 'ads.spend * 1000 / ads.impressions',
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'ads.impressions'],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'An auction-price measure. A rising CPM with steady CTR is competition, not creative fatigue.',
  },

  {
    id: 'inventory.available',
    name: 'Available room nights',
    description: 'Room nights the properties had to sell in the period.',
    source: (e) => sum(e.inventoryDays || [], 'available'),
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Capacity, not demand. It moves only when rooms are taken out of service or added.',
  },
  {
    id: 'inventory.sold',
    name: 'Room nights sold (PMS)',
    description: 'Room nights the PMS recorded as sold.',
    /* Distinct from `stay.room_nights`, which counts nights on bookings that
       settled with revenue. This is the PMS's own nightly count and will not
       agree exactly — one is billing, the other is housekeeping. */
    source: (e) => sum(e.inventoryDays || [], 'sold'),
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'The PMS nightly count, not the billed one. Expect it to differ from room nights on settled bookings.',
  },
  {
    id: 'occupancy.rate',
    name: 'Occupancy',
    description: 'Room nights sold against room nights available.',
    formula: 'inventory.sold / inventory.available',
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: ['inventory.sold', 'inventory.available'],
    benchmark: { target: 0.82, category: null },
    thresholds: { good: 0.82, warning: 0.7 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 0 },
    aiContext: 'Occupancy bought by discounting is not the same as occupancy earned. Always read it beside ADR before calling a rise good.',
  },
  {
    id: 'rate.revpar',
    name: 'RevPAR',
    description: 'Net revenue for every room night available, sold or not.',
    formula: 'revenue.net / inventory.available',
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: ['revenue.net', 'inventory.available'],
    benchmark: { target: 697300, category: null },
    thresholds: { good: 697300, warning: 500000 },
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'The one figure that cannot be gamed by trading rate against occupancy, because it carries both.',
  },

  {
    id: 'bookings.all',
    name: 'Bookings (all)',
    description: 'Every booking the PMS holds for the period, cancelled or not.',
    source: (e) => e.bookings.length,
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A denominator, not a performance figure. Use confirmed bookings for anything about delivery.',
  },
  {
    id: 'bookings.cancelled',
    name: 'Cancelled bookings',
    description: 'Bookings the PMS marked cancelled.',
    source: (e) => e.bookings.filter((b) => String(value(b.bookingStatus) || '').toLowerCase() === 'cancelled').length,
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Status comes from the PMS, which wins that field over the CRM. A CRM deal still open against a cancelled booking is expected.',
  },
  {
    id: 'cancellation.rate',
    name: 'Cancellation rate',
    description: 'Share of bookings that were cancelled.',
    formula: 'bookings.cancelled / bookings.all',
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['bookings.cancelled', 'bookings.all'],
    benchmark: { target: 0.034, category: null },
    thresholds: { good: 0.034, warning: 0.06 },
    favourability: 'lower',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Cancellations concentrate near the payment window. Check the window length before attributing a rise to demand.',
  },
  {
    id: 'lead.response_minutes',
    name: 'Lead response',
    description: 'Median minutes from a lead arriving to its first response.',
    /* Median, not mean: one lead answered three days late would drag an
       average past anything a manager would recognise. */
    source: (e) => {
      const byLead = new Map(e.leads.map((l) => [l.id, l]));
      const waits = [];
      for (const event of e.leadEvents || []) {
        /* Compared case-insensitively on purpose: this metric silently read
           zero events for its first run because stage 2 was title-casing the
           type. The mapper is fixed, and this stays lenient so a future
           normalisation change cannot break it back without anyone noticing. */
        if (String(event.type || '').toLowerCase() !== 'first_response') continue;
        const lead = byLead.get(event.leadId);
        if (!lead || !lead.createdAt || !event.at) continue;
        const minutes = (Date.parse(event.at) - Date.parse(lead.createdAt)) / 60000;
        if (Number.isFinite(minutes) && minutes >= 0) waits.push(minutes);
      }
      if (!waits.length) return null;
      waits.sort((a, b) => a - b);
      const mid = Math.floor(waits.length / 2);
      return waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2;
    },
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: { target: 44, category: null },
    thresholds: { good: 44, warning: 120 },
    favourability: 'lower',
    format: { kind: 'duration', decimals: 0, unit: 'min' },
    aiContext: 'Only leads with a logged first response are counted; an unanswered lead is absent, not slow. Say so when the count is small.',
  },

  {
    id: 'stay.room_nights',
    name: 'Room nights sold',
    description: 'Nights stayed across bookings that settled with revenue.',
    source: (e) => e.bookings.filter((b) => (value(b.revenue) || 0) > 0).reduce((t, b) => t + (b.nights || 0), 0),
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts nights, not bookings — a three-night stay is three. Do not use it as a booking count.',
  },

  /* — derived — */

  {
    id: 'roas.net',
    name: 'Net ROAS',
    description: 'Net revenue for every rupee of ad spend, credited by the workspace attribution model.',
    formula: 'revenue.net / ads.spend',
    sources: ['crm', 'pms', 'ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['revenue.net', 'ads.spend'],
    benchmark: { target: 4.0, category: 3.4 },
    thresholds: { good: 4.0, warning: 3.0 },
    favourability: 'higher',
    format: { kind: 'ratio', decimals: 1, suffix: 'x' },
    aiContext: 'Follows the workspace attribution model, so it moves when the model changes without any underlying performance change. Say which model is in force before calling a shift real.',
  },
  {
    id: 'cost.per_booking',
    name: 'Cost per booking',
    description: 'Ad spend divided by the bookings that settled with revenue.',
    formula: 'ads.spend / bookings.confirmed',
    sources: ['ads', 'pms'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'bookings.confirmed'],
    benchmark: { target: 350000, category: null },
    thresholds: { good: 350000, warning: 500000 },
    /* Lower is better, which is exactly the case the favourability field
       exists for: the same colour rule applied to ROAS would paint a falling
       cost red. */
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Rises when bookings lag spend, which is normal early in a booking window. Compare against the booking lead time before calling it inefficiency.',
  },
  {
    id: 'cost.per_lead',
    name: 'Cost per lead',
    description: 'Ad spend divided by the enquiries it produced.',
    formula: 'ads.spend / leads.count',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'leads.count'],
    benchmark: { target: 35000, category: 42000 },
    thresholds: { good: 35000, warning: 50000 },
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'A delivery-side efficiency measure. A falling CPL beside a falling booking rate is worse news than a rising CPL alone.',
  },
  {
    id: 'booking.value',
    name: 'Average booking value',
    description: 'Net revenue divided by the bookings that produced it.',
    formula: 'revenue.net / bookings.confirmed',
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['revenue.net', 'bookings.confirmed'],
    benchmark: { target: 3140000, category: null },
    thresholds: { good: 3140000, warning: 2500000 },
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Moves with room mix and length of stay as much as with pricing. Do not attribute a change to rate without checking nights and room type.',
  },
  {
    id: 'rate.adr',
    name: 'ADR',
    description: 'Average daily rate — net revenue divided by the room nights that earned it.',
    /* Per room *night*, which is what makes ADR different from average booking
       value: a three-night stay is three nights, not one sale. */
    formula: 'revenue.net / stay.room_nights',
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['revenue.net', 'stay.room_nights'],
    benchmark: { target: 894000, category: null },
    thresholds: { good: 894000, warning: 700000 },
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Rate per night, independent of how many nights were sold. Pair it with room nights before calling a change a pricing decision — mix shifts move it too.',
  },
  {
    id: 'lead.conversion',
    name: 'Lead → booking rate',
    description: 'The share of enquiries that became a booking with revenue.',
    formula: 'bookings.confirmed / leads.count',
    sources: ['crm', 'pms'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: ['bookings.confirmed', 'leads.count'],
    benchmark: { target: 0.161, category: null },
    thresholds: { good: 0.161, warning: 0.1 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Enquiries and bookings settle on different clocks — a booking may belong to a lead from a previous period. Treat short-window readings as provisional.',
  },
];

/* ── validation ─────────────────────────────────────────────────────────── */

const TWELVE = ['id', 'name', 'description', 'sources', 'refresh', 'owner',
  'dependencies', 'benchmark', 'thresholds', 'favourability', 'format', 'aiContext'];

/* `benchmark` and `thresholds` may be null — a base metric legitimately has no
   target — but the key must be present. Absent and null are different claims:
   one is an omission, the other is a decision. */
function assertMetric(metric) {
  for (const field of TWELVE) {
    if (!Object.prototype.hasOwnProperty.call(metric, field)) {
      throw new Error(`metric "${metric.id || '(no id)'}" is missing ${field}`);
    }
  }

  const hasFormula = typeof metric.formula === 'string';
  const hasSource = typeof metric.source === 'function';
  if (hasFormula === hasSource) {
    throw new Error(`metric "${metric.id}" must have either a formula or a source, not ${hasFormula ? 'both' : 'neither'}`);
  }

  if (!REFRESH.includes(metric.refresh)) throw new Error(`metric "${metric.id}" has refresh "${metric.refresh}"`);
  if (!FAVOURABILITY.includes(metric.favourability)) throw new Error(`metric "${metric.id}" has favourability "${metric.favourability}"`);
  if (!metric.format || !FORMATS.includes(metric.format.kind)) throw new Error(`metric "${metric.id}" has no valid format`);
  if (!Array.isArray(metric.sources) || !metric.sources.length) throw new Error(`metric "${metric.id}" names no source system`);
  if (!metric.aiContext) throw new Error(`metric "${metric.id}" has no ai_context — the AI would be free to assert anything about it`);

  /* A declared dependency list that disagrees with the formula is worse than
     none: the calculation order comes from one and the impact analysis from
     the other, so they would silently diverge. */
  if (hasFormula) {
    const actual = references(compile(metric.formula));
    const declared = [...metric.dependencies].sort();
    if (JSON.stringify(actual.slice().sort()) !== JSON.stringify(declared)) {
      throw new Error(`metric "${metric.id}" declares dependencies [${declared}] but its formula uses [${actual.slice().sort()}]`);
    }
  } else if (metric.dependencies.length) {
    throw new Error(`metric "${metric.id}" reads a source directly and cannot also declare dependencies`);
  }

  return metric;
}

const BY_ID = {};
for (const metric of METRICS) {
  assertMetric(metric);
  if (BY_ID[metric.id]) throw new Error(`duplicate metric id "${metric.id}"`);
  BY_ID[metric.id] = metric;
}

/* Every dependency must exist, or calculation order is a lie. */
for (const metric of METRICS) {
  for (const dep of metric.dependencies) {
    if (!BY_ID[dep]) throw new Error(`metric "${metric.id}" depends on "${dep}", which is not in the registry`);
  }
}

const list = () => METRICS.slice();
const get = (id) => BY_ID[id] || null;
const ids = () => METRICS.map((m) => m.id);

module.exports = { METRICS, BY_ID, list, get, ids, assertMetric, TWELVE, REFRESH, FAVOURABILITY, FORMATS };
