/* Metric-driven alert rules.
 *
 * Phase 8. The eight rules below are the Analytics Engine page's own alert
 * table — names, conditions, severities and recipients verbatim — so this is
 * reviewed design content rather than a set I invented.
 *
 * Every rule watches a **registry metric**, which is what makes it
 * metric-driven in the sense the scope asks for: a rule cannot reference a
 * number the dashboards do not also show, and it evaluates on the cadence of
 * the metric it watches rather than on a schedule of its own.
 *
 * Three of the eight cannot be evaluated, and they say so rather than being
 * quietly dropped:
 *
 *   Occupancy below forecast   there is no forecast metric — forecasting is
 *                              a model output nothing in the registry produces
 *   Creative fatigue           no fatigue score; creatives are ingested but
 *                              never scored
 *   Booking slowdown           "pace" compares against a plan, and no plan or
 *                              target series exists to compare with
 *
 * `evaluate` returns a verdict per rule — fired, held, or unevaluable with a
 * reason — because a rule nobody can compute is a different state from a rule
 * whose condition was not met, and a dashboard that showed both as "quiet"
 * would be reassuring about the wrong thing.
 */

const registry = require('../metrics/registry');

/* Verbatim from the page's alert table. `metric` and `test` are the
   implementation of the stated `cond`; where none is possible, `unevaluable`
   says why. */
const RULES = [
  {
    id: 'roas-below-target',
    name: 'ROAS below target',
    cond: 'net_roas < 4.0 for 3d',
    metric: 'roas.net',
    severity: 'warning',
    to: ['Marketing Dir.'],
    channels: ['email', 'slack'],
    /* "for 3d" — the page's own sustain window. A single dip is not the
       condition; three consecutive days below is. */
    sustain: 3,
    test: (v) => v !== null && v < 4.0,
    describe: (v, metric) => `Net ROAS is ${fmt(metric, v)}, below the 4.0x target`,
  },
  {
    id: 'occupancy-below-forecast',
    name: 'Occupancy below forecast',
    cond: 'occupancy < forecast − 5pt',
    metric: 'occupancy.rate',
    severity: 'warning',
    to: ['GM', 'Revenue Mgr'],
    channels: ['email'],
    unevaluable: 'there is no forecast metric — forecasting is a model output the registry does not produce',
  },
  {
    id: 'revenue-decline',
    name: 'Revenue decline',
    cond: 'revenue.net WoW < −10%',
    metric: 'revenue.net',
    severity: 'critical',
    to: ['Owner'],
    channels: ['email', 'slack'],
    /* Week on week, so it needs the comparison window rather than a level. */
    comparative: true,
    test: (v, previous) => previous !== null && previous !== 0 && v !== null && ((v - previous) / previous) < -0.10,
    describe: (v, metric, previous) => `Net revenue fell ${pctDrop(previous, v)} week on week, `
      + `from ${fmt(metric, previous)} to ${fmt(metric, v)}`,
  },
  {
    id: 'booking-slowdown',
    name: 'Booking slowdown',
    cond: 'bookings.pace < 80% of prior',
    metric: 'bookings.confirmed',
    severity: 'warning',
    to: ['Res. Manager'],
    channels: ['email'],
    unevaluable: 'pace compares against a plan, and no target or plan series is ingested',
  },
  {
    id: 'high-cancellation-rate',
    name: 'High cancellation rate',
    cond: 'cancel_rate > 3%',
    metric: 'cancellation.rate',
    severity: 'critical',
    to: ['Owner', 'Res. Mgr'],
    channels: ['email', 'whatsapp'],
    test: (v) => v !== null && v > 0.03,
    describe: (v, metric) => `Cancellation rate is ${fmt(metric, v)}, above the 3% ceiling`,
  },
  {
    id: 'creative-fatigue',
    name: 'Creative fatigue',
    cond: 'fatigue_score > 70',
    metric: null,
    severity: 'warning',
    to: ['Performance Mkt.'],
    channels: ['slack'],
    unevaluable: 'no fatigue score exists — creatives are ingested but never scored',
  },
  {
    id: 'sales-response-breach',
    name: 'Sales response breach',
    cond: 'response_time > 2h',
    metric: 'lead.response_minutes',
    severity: 'warning',
    to: ['Sales Manager'],
    channels: ['email', 'whatsapp'],
    test: (v) => v !== null && v > 120,
    describe: (v, metric) => `Median first response is ${fmt(metric, v)}, past the two-hour breach`,
  },
  {
    id: 'connector-down',
    name: 'Connector down',
    cond: 'sync_lag > 60 min',
    /* The only rule that watches the pipeline rather than a registry metric —
       it reads the 4.5 run log, which is why it takes `status` instead. */
    metric: null,
    operational: true,
    severity: 'critical',
    to: ['Owner', 'admins'],
    channels: ['email', 'slack'],
    describe: (sources) => `${sources.join(', ')} ${sources.length === 1 ? 'has' : 'have'} not synced in over an hour`,
  },
];

const BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

function fmt(metric, value) {
  if (!metric || value === null || value === undefined) return '—';
  /* Required lazily: lib/metrics requires scope, which requires registry, and
     pulling the formatter in at module load would close a cycle. */
  return require('../metrics').format(metric, value);
}

const pctDrop = (from, to) => `${Math.abs(Math.round(((to - from) / from) * 100))}%`;

/* A rule evaluates on the cadence of the metric it watches — the scope's
   words. An operational rule follows the fastest source it could be about. */
function cadenceOf(rule) {
  if (rule.operational) return 'realtime';
  const metric = rule.metric && registry.get(rule.metric);
  return metric ? metric.refresh : 'hourly';
}

/* `current` and `previous` are registry evaluations; `sustained` is an array of
   per-day values for rules with a sustain window; `status` is the sync
   runner's, for the one operational rule. */
function evaluate(rule, { current = {}, previous = {}, sustained = null, status = [] } = {}) {
  const base = { rule: rule.id, name: rule.name, cond: rule.cond, severity: rule.severity, to: rule.to, cadence: cadenceOf(rule) };

  if (rule.unevaluable) {
    return { ...base, state: 'unevaluable', reason: rule.unevaluable };
  }

  if (rule.operational) {
    const down = status.filter((s) => s.lagSeconds !== null && s.lagSeconds > 3600).map((s) => s.name);
    const never = status.filter((s) => s.lagSeconds === null).map((s) => s.name);
    const offenders = [...down, ...never];
    return offenders.length
      ? { ...base, state: 'fired', reason: rule.describe(offenders) }
      : { ...base, state: 'held' };
  }

  const metric = registry.get(rule.metric);
  if (!metric) return { ...base, state: 'unevaluable', reason: `metric "${rule.metric}" is not in the registry` };

  const value = current[rule.metric] === undefined ? null : current[rule.metric];
  if (value === null) {
    /* Unknown is not "condition not met" — see the same distinction in the
       reasoning layer and the projections. */
    return { ...base, state: 'unevaluable', reason: `${metric.name} could not be computed for this window` };
  }

  if (rule.comparative) {
    const before = previous[rule.metric] === undefined ? null : previous[rule.metric];
    if (before === null) return { ...base, state: 'unevaluable', reason: `${metric.name} is unknown in the comparison window` };
    return rule.test(value, before)
      ? { ...base, state: 'fired', value, reason: rule.describe(value, metric, before) }
      : { ...base, state: 'held', value };
  }

  if (rule.sustain) {
    if (!Array.isArray(sustained) || sustained.length < rule.sustain) {
      return { ...base, state: 'unevaluable', reason: `needs ${rule.sustain} consecutive readings; ${sustained ? sustained.length : 0} available` };
    }
    const window = sustained.slice(-rule.sustain);
    if (window.some((v) => v === null)) {
      return { ...base, state: 'unevaluable', reason: 'a reading in the sustain window is unknown' };
    }
    return window.every((v) => rule.test(v))
      ? { ...base, state: 'fired', value, reason: `${rule.describe(value, metric)} on ${rule.sustain} consecutive days` }
      : { ...base, state: 'held', value };
  }

  return rule.test(value)
    ? { ...base, state: 'fired', value, reason: rule.describe(value, metric) }
    : { ...base, state: 'held', value };
}

const list = () => RULES.slice();
const get = (id) => BY_ID[id] || null;

module.exports = { RULES, BY_ID, list, get, evaluate, cadenceOf };
