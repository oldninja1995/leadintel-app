/* Stage 7 — explanations that read the registry.
 *
 * Phase 7. The Analytics Engine page is unusually prescriptive here, and the
 * prescription is the whole design: *"AI reads the same registry — never the
 * raw tables — so explanations match the dashboards."* An explanation that
 * queried entities directly could disagree with the number on screen, and a
 * product whose narrative contradicts its own dashboard is worse than one with
 * no narrative.
 *
 * So every claim below is derived from a registry evaluation and carries the
 * metric and the window it came from. `assertSourced` enforces that rather than
 * trusting it — the exit criterion says *no unsourced assertion*, and a rule
 * that is merely intended is not a rule.
 *
 * The six-step contract, in the page's own order:
 *
 *   1 state the change          metric, both windows, direction, size
 *   2 decompose the drivers     quantified shares over the dependency graph
 *   3 name related metrics      what it feeds and what feeds it
 *   4 cause, not mix            for a ratio, which side actually moved
 *   5 recommend with a value    an expected effect and its assumption
 *   6 declare confidence        a percentage plus the systems it rests on
 *
 * Two rules make it honest rather than merely structured. **Unquantifiable
 * drivers are declared, not estimated** — a base metric has no decomposition
 * and says so instead of inventing one. And **confidence below 60 suppresses
 * the recommendation**, showing the gap that would have to close first.
 *
 * There is no language model here. This is deterministic analysis over the
 * registry, which is what makes it testable and what makes every claim
 * traceable. `lib/ai/reasoner.js` holds the seam for a model-backed one.
 */

const registry = require('../metrics/registry');
const { format } = require('../metrics');

const SUPPRESS_BELOW = 60;

/* ── change ─────────────────────────────────────────────────────────────── */

const pct = (from, to) => (from === 0 || from === null ? null : ((to - from) / Math.abs(from)) * 100);

function direction(metric, from, to) {
  /* Unknown is not unchanged. Collapsing the two here produced "Net ROAS did
     not move. No action indicated." for a metric that could not be computed in
     either window — a confident sentence about nothing. */
  if (from === null || from === undefined || to === null || to === undefined) return 'unknown';
  if (from === to) return 'flat';
  const up = to > from;
  if (metric.favourability === 'neutral') return up ? 'up' : 'down';
  const good = metric.favourability === 'lower' ? !up : up;
  return good ? 'better' : 'worse';
}

/* Step 1. Both windows are named, because "revenue is up 12%" without saying
   up from when is the commonest unsourced assertion in analytics. */
function stateChange(metric, before, after, windows) {
  const change = pct(before, after);
  return {
    claim: 'change',
    metric: metric.id,
    window: windows.after,
    comparedTo: windows.before,
    from: format(metric, before),
    to: format(metric, after),
    change: change === null ? null : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`,
    direction: direction(metric, before, after),
    text: before === null || after === null
      ? `${metric.name} cannot be compared across these windows — it is unknown in at least one.`
      : `${metric.name} moved from ${format(metric, before)} to ${format(metric, after)}`
        + (change === null ? '' : ` (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`) + '.',
  };
}

/* ── drivers ────────────────────────────────────────────────────────────── */

/* Step 2, for a ratio. Sequential decomposition: hold the denominator, move the
   numerator, then move the denominator. The two contributions sum to the whole
   change exactly, which is what makes the shares quantified rather than
   indicative. */
function decomposeRatio(metric, deps, beforeValues, afterValues) {
  const [numerator, denominator] = deps;
  const n0 = beforeValues[numerator];
  const n1 = afterValues[numerator];
  const d0 = beforeValues[denominator];
  const d1 = afterValues[denominator];

  if ([n0, n1, d0, d1].some((v) => v === null || v === undefined) || d0 === 0 || d1 === 0) return null;

  const total = (n1 / d1) - (n0 / d0);
  if (total === 0) return null;

  const fromNumerator = (n1 / d0) - (n0 / d0);
  const fromDenominator = (n1 / d1) - (n1 / d0);

  const share = (part) => `${Math.round((part / total) * 100)}%`;
  const describe = (id, part, from, to) => ({
    metric: id,
    from: format(registry.get(id), from),
    to: format(registry.get(id), to),
    share: share(part),
    shareValue: part / total,
  });

  return {
    total,
    parts: [
      describe(numerator, fromNumerator, n0, n1),
      describe(denominator, fromDenominator, d0, d1),
    ],
  };
}

function drivers(metric, beforeValues, afterValues, windows) {
  /* A base metric reads a source directly. There is nothing in the registry to
     decompose it into, and guessing at what moved underneath it is exactly the
     estimate the page forbids. */
  if (!metric.formula) {
    return {
      claim: 'drivers',
      metric: metric.id,
      window: windows.after,
      quantified: false,
      parts: [],
      text: `${metric.name} is read directly from ${metric.sources.join(' and ').toUpperCase()}, `
        + 'so the registry cannot decompose it further. Any driver below this point is unquantified here.',
    };
  }

  const decomposition = metric.dependencies.length === 2
    ? decomposeRatio(metric, metric.dependencies, beforeValues, afterValues)
    : null;

  if (!decomposition) {
    return {
      claim: 'drivers',
      metric: metric.id,
      window: windows.after,
      quantified: false,
      parts: metric.dependencies.map((id) => ({ metric: id })),
      text: `${metric.name} depends on ${metric.dependencies.join(' and ')}, but the change cannot be `
        + 'split between them over these windows — at least one input is unknown or zero. Declared, not estimated.',
    };
  }

  const [first, second] = decomposition.parts;
  return {
    claim: 'drivers',
    metric: metric.id,
    window: windows.after,
    quantified: true,
    parts: decomposition.parts,
    text: `${share(first)} and ${share(second)}.`,
  };

  function share(part) {
    return `${part.share} of the move came from ${registry.get(part.metric).name} `
      + `(${part.from} → ${part.to})`;
  }
}

/* ── related ────────────────────────────────────────────────────────────── */

/* Step 3. Straight off the dependency graph — nothing here is a judgement
   about which metrics are "related", it is what the registry says. */
function related(metric) {
  const feeds = registry.list().filter((m) => m.dependencies.includes(metric.id)).map((m) => m.id);
  return {
    claim: 'related',
    metric: metric.id,
    dependsOn: metric.dependencies,
    feeds,
    text: [
      metric.dependencies.length ? `Computed from ${metric.dependencies.join(', ')}.` : null,
      feeds.length ? `Feeds ${feeds.join(', ')}.` : null,
    ].filter(Boolean).join(' ') || 'Stands alone in the registry.',
  };
}

/* ── cause, not mix ─────────────────────────────────────────────────────── */

/* Step 4. The page's wording: "Say explicitly whether this is real efficiency
   or a change in composition." For a ratio that is answerable — did the thing
   being measured move, or the base it is measured against? */
function causeOrMix(metric, driverStep) {
  if (!driverStep.quantified) {
    return {
      claim: 'cause',
      metric: metric.id,
      verdict: 'undetermined',
      text: 'Whether this is efficiency or composition cannot be determined from the registry alone.',
    };
  }

  const [numerator, denominator] = driverStep.parts;
  const dominant = Math.abs(numerator.shareValue) >= Math.abs(denominator.shareValue) ? numerator : denominator;
  const isMix = dominant === denominator;

  return {
    claim: 'cause',
    metric: metric.id,
    verdict: isMix ? 'composition' : 'efficiency',
    dominant: dominant.metric,
    text: isMix
      ? `Mostly composition: ${registry.get(denominator.metric).name} moved more than `
        + `${registry.get(numerator.metric).name}, so the base changed rather than the performance.`
      : `Mostly real: ${registry.get(numerator.metric).name} moved more than `
        + `${registry.get(denominator.metric).name}, so this is a change in the measured quantity, not the base.`,
  };
}

/* ── confidence ─────────────────────────────────────────────────────────── */

/* Step 6, and the gate on step 5. Every component is an observation the product
   already makes — nothing here is a feeling about the data. */
function confidence({ match = null, problems = 0, sampleSize = 0, unknowns = 0 }) {
  const components = [];
  let score = 100;

  if (match && match.rate !== null) {
    const penalty = Math.round((1 - match.rate) * 40);
    score -= penalty;
    components.push({ factor: 'identity match rate', value: match.pct, penalty });
  } else {
    score -= 25;
    components.push({ factor: 'identity match rate', value: 'unknown', penalty: 25 });
  }

  if (problems > 0) {
    const penalty = Math.min(20, problems * 2);
    score -= penalty;
    components.push({ factor: 'normalisation problems', value: String(problems), penalty });
  }

  /* Small samples are the honest limit at fixture scale, and saying so is more
     use than a confident number computed from two bookings. */
  if (sampleSize < 30) {
    const penalty = sampleSize < 5 ? 30 : sampleSize < 15 ? 20 : 10;
    score -= penalty;
    components.push({ factor: 'sample size', value: String(sampleSize), penalty });
  }

  if (unknowns > 0) {
    const penalty = Math.min(20, unknowns * 10);
    score -= penalty;
    components.push({ factor: 'unknown inputs', value: String(unknowns), penalty });
  }

  return { score: Math.max(0, Math.min(100, score)), components };
}

/* ── recommendation ─────────────────────────────────────────────────────── */

/* Step 5. Suppressed below the threshold — enforced here rather than left to
   the caller, because the exit criterion says the rule is not advisory. */
function recommend(metric, changeStep, causeStep, score, windows) {
  if (score < SUPPRESS_BELOW) {
    return {
      claim: 'recommendation',
      metric: metric.id,
      window: windows.after,
      suppressed: true,
      text: `No recommendation: confidence is ${score}%, below the ${SUPPRESS_BELOW}% floor. `
        + 'The gap has to close before an action can be justified.',
    };
  }

  if (changeStep.direction === 'unknown') {
    return {
      claim: 'recommendation',
      metric: metric.id,
      window: windows.after,
      suppressed: true,
      text: `No recommendation: ${metric.name} could not be computed in ${windows.after}`
        + ` or ${windows.before}, so there is no change to act on. That is different from it not having moved.`,
    };
  }

  if (changeStep.direction === 'flat') {
    return {
      claim: 'recommendation',
      metric: metric.id,
      window: windows.after,
      suppressed: false,
      text: `${metric.name} did not move. No action indicated.`,
    };
  }

  const worse = changeStep.direction === 'worse';
  const lever = causeStep.dominant ? registry.get(causeStep.dominant) : null;

  return {
    claim: 'recommendation',
    metric: metric.id,
    window: windows.after,
    suppressed: false,
    lever: lever ? lever.id : null,
    text: lever
      ? `${worse ? 'To recover' : 'To hold'} ${metric.name}, act on ${lever.name} — it accounts for most of the move. `
        + `Expected effect: returning ${lever.name} to ${changeStep.comparedTo} levels restores `
        + `${metric.name} to ${changeStep.from}, assuming the other input holds.`
      : `${metric.name} moved ${changeStep.direction}, but the registry names no single lever behind it.`,
  };
}

/* ── the whole explanation ──────────────────────────────────────────────── */

/* `before` and `after` are evaluations — `{ values, over }` from
   lib/metrics. Handing in evaluations rather than entities is what keeps this
   reading the registry and never the raw tables. */
function explain(metricId, { before, after, match = null, problems = 0, sampleSize = 0 }) {
  const metric = registry.get(metricId);
  if (!metric) throw new Error(`no metric "${metricId}"`);

  const windows = {
    before: windowLabel(before),
    after: windowLabel(after),
  };

  const changeStep = stateChange(metric, before.values[metricId], after.values[metricId], windows);
  const driverStep = drivers(metric, before.values, after.values, windows);
  const relatedStep = related(metric);
  const causeStep = causeOrMix(metric, driverStep);

  const unknowns = [before.values[metricId], after.values[metricId]].filter((v) => v === null).length;
  const { score, components } = confidence({ match, problems, sampleSize, unknowns });

  const confidenceStep = {
    claim: 'confidence',
    metric: metric.id,
    window: windows.after,
    score,
    components,
    sources: metric.sources.map((s) => s.toUpperCase()),
    text: `Confidence ${score}% — sources: ${metric.sources.map((s) => s.toUpperCase()).join(', ')}.`
      + (components.length ? ` Reduced by ${components.map((c) => `${c.factor} (${c.value})`).join(', ')}.` : ''),
  };

  const recommendationStep = recommend(metric, changeStep, causeStep, score, windows);

  return {
    metric: metric.id,
    name: metric.name,
    windows,
    confidence: score,
    suppressed: recommendationStep.suppressed === true,
    steps: [changeStep, driverStep, relatedStep, causeStep, recommendationStep, confidenceStep],
  };
}

const windowLabel = (evaluation) => (evaluation.over && evaluation.over.label)
  || (evaluation.over ? `${evaluation.over.from} – ${evaluation.over.to}` : 'all time');

/* Enforcement, not intent. Every step must name the metric it is about, and
   every step that asserts something about a number must name the window. */
const NEEDS_WINDOW = new Set(['change', 'drivers', 'recommendation', 'confidence']);

function assertSourced(explanation) {
  const unsourced = [];
  for (const step of explanation.steps) {
    if (!step.metric || !registry.get(step.metric)) {
      unsourced.push({ claim: step.claim, missing: 'metric' });
      continue;
    }
    if (NEEDS_WINDOW.has(step.claim) && !step.window) unsourced.push({ claim: step.claim, missing: 'window' });
  }
  return unsourced;
}

module.exports = { explain, assertSourced, confidence, drivers, related, causeOrMix, stateChange, SUPPRESS_BELOW };
