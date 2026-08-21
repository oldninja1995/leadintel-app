/* Evaluating the registry.
 *
 * Sub-phase 6.1. Stage 5's own words: "Registry formulas evaluate in
 * dependency order." So the order is computed from the dependency graph, not
 * from the order metrics happen to be written in — a registry that only worked
 * because its definitions were listed conveniently would break the first time
 * somebody added one in the wrong place.
 *
 * Everything here is a pure function of a snapshot of canonical entities. That
 * is what makes sub-phase 6.2's promise — "any past number reproduces exactly"
 * — achievable at all: the same entities in must give the same numbers out,
 * with no clock, no ambient state and no ordering luck.
 */

const registry = require('./registry');
const formula = require('./formula');
const scope = require('./scope');
const period = require('./period');

/* Depth-first topological sort. Cycles are reported with the path that closes
   them, because "circular dependency" without the ring is a puzzle rather than
   a message. */
function order(metrics = registry.list()) {
  const byId = Object.fromEntries(metrics.map((m) => [m.id, m]));
  const sorted = [];
  const state = {};

  function visit(id, path) {
    if (state[id] === 'done') return;
    if (state[id] === 'visiting') {
      throw new Error(`circular dependency: ${[...path, id].join(' → ')}`);
    }

    const metric = byId[id];
    if (!metric) throw new Error(`"${id}" is not in the registry`);

    state[id] = 'visiting';
    for (const dep of metric.dependencies) visit(dep, [...path, id]);
    state[id] = 'done';
    sorted.push(metric);
  }

  for (const metric of metrics) visit(metric.id, []);
  return sorted;
}

/* One pass over the registry against one snapshot of entities.
 *
 * A metric that throws is recorded as a failure and does not stop the rest:
 * one bad definition should cost you one number, not the whole dashboard.
 * Its dependents then evaluate to null through the usual null-propagation, so
 * a broken input never silently becomes a zero. */
function evaluate(entities, { metrics = registry.list(), at = null, over = null } = {}) {
  const sorted = order(metrics);
  const values = {};
  const problems = [];
  const notApplicable = [];

  /* A grain and a period both narrow the **entities** once, up front, and every
     metric then reads the narrowed set — see scope.js and period.js for why
     narrowing entities rather than definitions is what keeps one definition per
     KPI. They compose: a campaign, last month. */
  const scoped = period.within(
    at ? scope.scope(entities, at.dimension, at.value) : entities,
    over
  );

  for (const metric of sorted) {
    /* Not every metric is meaningful at every grain. Occupancy per campaign is
       nonsense, and answering it with the workspace figure would be wrong in a
       way nobody would catch. */
    if (at && !scope.supports(metric.id, at.dimension, at.value)) {
      values[metric.id] = null;
      notApplicable.push(metric.id);
      continue;
    }

    try {
      values[metric.id] = typeof metric.source === 'function'
        ? normalise(metric.source(scoped))
        : formula.run(metric.formula, values);
    } catch (err) {
      values[metric.id] = null;
      problems.push({ metric: metric.id, error: err.message });
    }
  }

  return { values, problems, notApplicable, at, over, order: sorted.map((m) => m.id) };
}

/* A source that returns undefined, NaN or a non-number is unknown, not zero. */
function normalise(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/* ── presentation ───────────────────────────────────────────────────────── */

/* The formatter is built once per decimal setting and kept.
 *
 * `Number.prototype.toLocaleString(locale, options)` constructs a fresh
 * `Intl.NumberFormat` on **every call** — V8 caches the no-argument form and
 * nothing else — and that construction costs ~75µs against ~2µs to format
 * through one already built. It did not matter while a screen formatted twelve
 * KPI cards. It matters now that a table formats a row: Google Ads rolls up
 * 4,889 search terms and prices three columns on each, so one page view paid
 * for ten thousand constructions and spent most of its server time inside
 * `Intl` rather than reading anything.
 *
 * Verified byte-identical to the expression it replaces over 800,000 cases,
 * including NaN, ±Infinity, -0 and 1e21 — which is what makes a cache safe
 * here: `toLocaleString` is specified as exactly this call. */
const MONEY_FORMATS = new Map();
const moneyFormat = (decimals) => {
  let formatter = MONEY_FORMATS.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
    MONEY_FORMATS.set(decimals, formatter);
  }
  return formatter;
};

/* Counts take no options, which is the one form V8 does cache — but behind a
   lookup this skips. Same reasoning, same guarantee. */
const COUNT_FORMAT = new Intl.NumberFormat('en-IN');

const rupees = (paise, decimals) => '₹' + moneyFormat(decimals).format(paise / 100);

/* Formatting is the registry's job, not each screen's — that is the point of
   carrying `format` as a field. Money is in paise and divides here. */
function format(metric, value) {
  if (value === null || value === undefined) return '—';
  const decimals = metric.format.decimals ?? 0;

  switch (metric.format.kind) {
    case 'currency': return rupees(value, decimals);
    case 'percent': return `${(value * 100).toFixed(decimals)}%`;
    case 'ratio': return `${value.toFixed(decimals)}${metric.format.suffix || ''}`;
    /* The unit is the definition's to state — a response time in minutes and a
       booking window in days are both durations, and defaulting either way
       would silently mislabel the other. */
    case 'duration': return `${value.toFixed(decimals)} ${metric.format.unit || 'days'}`;
    case 'count': return COUNT_FORMAT.format(Math.round(value));
    default: return String(value);
  }
}

/* Good / warning / critical, read through favourability. This is the field the
   page singles out — "a falling CPL must render green" — and the reason the
   comparison cannot be hardcoded as `>=`. */
function band(metric, value) {
  if (value === null || value === undefined || !metric.thresholds) return 'none';
  const { good, warning } = metric.thresholds;
  const better = metric.favourability === 'lower'
    ? (a, b) => a <= b
    : (a, b) => a >= b;

  if (better(value, good)) return 'good';
  if (better(value, warning)) return 'warning';
  return 'critical';
}

/* Against the internal target, in the direction favourability says is good. */
function vsBenchmark(metric, value) {
  if (value === null || !metric.benchmark || metric.benchmark.target == null) return null;
  const delta = value - metric.benchmark.target;
  const favourable = metric.favourability === 'lower' ? delta <= 0 : delta >= 0;
  return {
    target: format(metric, metric.benchmark.target),
    category: metric.benchmark.category == null ? null : format(metric, metric.benchmark.category),
    delta: format(metric, Math.abs(delta)),
    favourable,
  };
}

/* The registry as a screen would read it: definition, value, formatting and
   the judgement the definition itself supplies. */
function report(entities, options = {}) {
  const { values, problems, notApplicable, at, over, order: evaluated } = evaluate(entities, options);
  const inapplicable = new Set(notApplicable);

  const metrics = registry.list().map((metric) => ({
    /* Stated on the row rather than inferred from a null: "we do not measure
       this here" and "we could not compute it" are different answers. */
    applicable: !inapplicable.has(metric.id),
    id: metric.id,
    name: metric.name,
    description: metric.description,
    category: metric.category || null,
    formula: metric.formula || null,
    derivedFrom: metric.dependencies,
    sources: metric.sources,
    refresh: metric.refresh,
    owner: metric.owner,
    favourability: metric.favourability,
    aiContext: metric.aiContext,
    value: values[metric.id],
    display: format(metric, values[metric.id]),
    band: band(metric, values[metric.id]),
    benchmark: vsBenchmark(metric, values[metric.id]),
  }));

  return { metrics, values, problems, notApplicable, at, over, order: evaluated };
}

/* Required at the bottom, and handed `evaluate` explicitly rather than
   requiring it back — versions.js records what this module computes, so the
   dependency only runs one way. */
const versions = require('./versions');
const { DefinitionLog } = require('./definition-log');

const evaluations = new versions.Evaluations();
const recordEvaluation = (entities, options = {}) => evaluations.record(entities, { ...options, evaluate });
const reproduceEvaluation = (id) => evaluations.reproduce(id, { evaluate });

const definitionLog = new DefinitionLog();

module.exports = {
  order, evaluate, report, format, band, vsBenchmark,
  registry, formula, scope, period, versions,
  evaluations, recordEvaluation, reproduceEvaluation,
  definitionLog, DefinitionLog,
};
