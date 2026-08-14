/* Screens resolving to registry entries.
 *
 * Sub-phase 6.4, against Phase 6's exit criterion: "Every KPI in the UI
 * resolves to a registry entry; none is hardcoded in markup."
 *
 * A KPI card declares which metric it *is* — `metric: 'roas.net'` — instead of
 * only carrying a number and a tooltip. Two things follow, and the first is
 * worth more than the second.
 *
 * **The definition travels with the number.** Owner, formula, sources, refresh,
 * favourability, thresholds and the AI's licence to talk about it are attached
 * to every card that names a metric, under whichever driver is running. That is
 * what stops two screens disagreeing about what "Net ROAS" means, and it is
 * true even when the value itself is authored.
 *
 * **Where the value comes from is a separate question.** Under the `ingested`
 * driver the registry's own computed figure replaces the card's, because there
 * the number is genuinely derived. Under `static` the authored figure stays:
 * substituting a fixture-scale number into an authored dashboard would produce
 * a screen that is neither one thing nor the other. A resolved card records
 * which of the two it got, so nothing has to guess.
 *
 * Coverage is reported rather than assumed. A KPI with no `metric` is not
 * quietly tolerated — it is counted, named, and available at `/metrics/coverage`,
 * because "every KPI resolves to a registry entry" is a claim that should be
 * checkable rather than asserted in a document.
 */

const registry = require('./registry');
const { format, band, vsBenchmark } = require('./index');
const { UP, DOWN, NA } = require('../../data/_tokens');

/* The change against the previous period.
 *
 * The topbar has said "vs previous period" since the design was drawn and
 * nothing computed one: every registry-backed card rendered a bare "·". The
 * label was an assertion the code declined to make.
 *
 * How a change is *expressed* depends on what the metric is, and getting this
 * wrong is how a dashboard starts lying quietly:
 *
 *   a rate      moves in points, not percent. A CTR going 1.0% → 1.5% rose by
 *               0.5 points and by 50 percent, and "+50%" beside a CTR reads as
 *               the rate itself.
 *   a ratio     moves in its own unit — ROAS 4.2x → 4.8x is "+0.6x".
 *   everything  moves in percent, which is what a spend or a lead count means
 *   else        by "up 18%".
 *
 * Null rather than zero when there is nothing to compare against: a metric with
 * no previous figure has not held steady. Dividing by a previous zero is the
 * same problem — every first week of spend would read "+∞%" — so that declines
 * too rather than inventing a number.
 */
function deltaOf(metric, value, before) {
  if (value === null || value === undefined) return { delta: '—', deltaColor: NA };
  if (before === null || before === undefined) return { delta: '·', deltaColor: NA };

  const kind = (metric.format && metric.format.kind) || 'number';
  const sign = (n) => (n > 0 ? '+' : '−');
  const move = value - before;

  /* Identical is identical, whatever the unit. Stated rather than left to a
     "+0.0%" that reads like a measurement. */
  if (move === 0) return { delta: 'no change', deltaColor: NA };

  let text;
  if (kind === 'percent') {
    text = `${sign(move)}${Math.abs(move * 100).toFixed(2)}pt`;
  } else if (kind === 'ratio') {
    text = `${sign(move)}${Math.abs(move).toFixed(1)}x`;
  } else if (!before) {
    /* No baseline to be a percentage of. */
    return { delta: '·', deltaColor: NA };
  } else {
    text = `${sign(move)}${Math.abs((move / before) * 100).toFixed(1)}%`;
  }

  /* Green means better, which is not the same as bigger — a falling cost per
     lead is good news and the card should say so. The registry already knows
     which way each metric wants to go. */
  const better = metric.favourability === 'lower' ? move < 0 : move > 0;
  const colour = metric.favourability === 'neutral' ? NA : (better ? UP : DOWN);

  return { delta: text, deltaColor: colour };
}

/* A collection is KPI-shaped if its rows carry a label and a value. Looking for
   the shape rather than a list of field names keeps this working when the
   converter emits a new card list. */
const isKpiRows = (rows) => Array.isArray(rows) && rows.length > 0
  && rows.every((r) => r && typeof r === 'object' && 'label' in r && 'value' in r);

/* The definition, flattened onto the card. `metricMissing` is deliberate: a
   card naming a metric the registry does not define is a bug worth seeing on
   the page rather than a silently ignored field. */
function definitionOf(id) {
  const metric = registry.get(id);
  if (!metric) return { metric: id, metricMissing: true };

  return {
    metric: id,
    metricName: metric.name,
    metricDescription: metric.description,
    metricFormula: metric.formula || null,
    metricSources: metric.sources.join(' · ').toUpperCase(),
    metricRefresh: metric.refresh,
    metricOwner: metric.owner,
    metricFavourability: metric.favourability,
    metricAiContext: metric.aiContext,
  };
}

/* One card. `values` is the registry evaluation; `useRegistryValues` decides
   whether it replaces the card's own figure or only annotates it. */
function resolveCard(card, values, useRegistryValues, notApplicable = null, previous = null) {
  if (!card.metric) return card;

  const definition = definitionOf(card.metric);
  if (definition.metricMissing) return { ...card, ...definition, valueSource: 'authored' };

  const metric = registry.get(card.metric);
  const value = values ? values[card.metric] : undefined;
  const resolved = { ...card, ...definition };

  /* "We do not measure this at this grain" is a different answer from "we
     could not compute it", and a card that conflated them would invite someone
     to go looking for missing data that was never meant to exist. */
  if (notApplicable && notApplicable.has(card.metric)) {
    return {
      ...resolved,
      metricApplicable: false,
      ...(useRegistryValues ? { value: '—', delta: 'not measured at this grain' } : {}),
      valueSource: useRegistryValues ? 'not-applicable' : 'authored',
    };
  }

  if (!useRegistryValues || value === undefined) {
    return { ...resolved, valueSource: 'authored' };
  }

  const benchmark = vsBenchmark(metric, value);
  return {
    ...resolved,
    value: format(metric, value),
    /* The band comes from the registry's own thresholds read through
       favourability, so a falling cost renders green without the card knowing
       anything about costs. */
    metricBand: band(metric, value),
    metricBenchmark: benchmark ? benchmark.target : null,
    metricFavourable: benchmark ? benchmark.favourable : null,
    valueSource: 'registry',
    /* Against the same metric over the window before this one — the comparison
       the topbar has always claimed. A card whose previous figure is unknown
       still gets "·" rather than a made-up change. */
    ...deltaOf(metric, value, previous ? previous[card.metric] : undefined),
  };
}

/* `valuesFor(label)` supplies an evaluation over a named period, for cards that
   declare one — "New leads today" and "Lost this month" are the same metric
   over different windows, not different metrics. Cards with no `period` use the
   screen's own evaluation.

   `valuesAt(at, period)` is the same idea one axis over: a card may declare the
   *grain* it is about rather than the window. "Meta spend" and "Google spend"
   are both `ads.spend` at `channel:meta` and `channel:google` — one definition
   read at two grains, not two definitions that could drift apart. Adding
   `ads.spend.meta` to the registry instead would be the second copy of a
   formula this whole layer exists to prevent, and the day a third platform
   connects it would need a third.

   Both callbacks return `{ values, notApplicable, previous }`, because the
   comparison has to be narrowed too: Meta's spend this period against the
   *workspace's* spend last period is a change nobody made. */
function resolve(payload, {
  values = null, useRegistryValues = false, notApplicable = null,
  valuesFor = null, valuesAt = null, previous = null,
} = {}) {
  if (!payload) return payload;

  const inapplicable = notApplicable ? new Set(notApplicable) : null;
  const out = { ...payload };

  for (const [name, rows] of Object.entries(payload)) {
    /* Any collection with at least one card naming a metric, not only the
       uniformly KPI-shaped ones. The report builder's canvas mixes KPI tiles
       with charts and tables, and the tiles deserve resolving even though
       their neighbours have no value to replace. `coverage` still counts only
       KPI-shaped rows, so the Phase 6 figure means the same thing it did. */
    if (!Array.isArray(rows) || !rows.length) continue;
    if (!rows.some((r) => r && typeof r === 'object' && r.metric)) continue;

    out[name] = rows.map((card) => {
      /* A card about one grain is evaluated there, over the screen's own window
         unless it also names a period. `metricAt` is stated on the card so the
         page can say which slice a figure is — a tile reading a narrowed number
         under an unqualified label is the failure this is meant to avoid. */
      if (card.at && valuesAt) {
        const there = valuesAt(card.at, card.period || null);
        if (there) {
          const resolved = resolveCard(
            card, there.values, useRegistryValues,
            there.notApplicable ? new Set(there.notApplicable) : null,
            there.previous || null,
          );
          return {
            ...resolved,
            metricAt: `${card.at.dimension}:${card.at.value}`,
            ...(card.period ? { metricPeriod: card.period } : {}),
          };
        }
      }

      if (!card.period || !valuesFor) {
        return resolveCard(card, values, useRegistryValues, inapplicable, previous);
      }

      const over = valuesFor(card.period);
      if (!over) return resolveCard(card, values, useRegistryValues, inapplicable, previous);
      /* A card naming its own window — "New leads today" — is compared against
         the window before *its* own, which `valuesFor` supplies alongside the
         current one. Comparing it against the screen's range instead would
         measure today against the last thirty days. */
      const resolved = resolveCard(
        card, over.values, useRegistryValues,
        over.notApplicable ? new Set(over.notApplicable) : null,
        over.previous || null,
      );
      /* The window is stated on the card, so a reader can tell a "today"
         figure from an all-time one without checking the label. */
      return { ...resolved, metricPeriod: card.period };
    });
  }
  return out;
}

/* How much of a screen actually resolves. Counted from the payload rather than
   declared, so it cannot drift from what is on the page. */
function coverage(payload) {
  const collections = [];
  let total = 0;
  let resolved = 0;

  for (const [name, rows] of Object.entries(payload || {})) {
    if (!isKpiRows(rows)) continue;
    const named = rows.filter((r) => r.metric);
    const unnamed = rows.filter((r) => !r.metric).map((r) => r.label);
    const unknown = named.filter((r) => !registry.get(r.metric)).map((r) => r.metric);

    total += rows.length;
    resolved += named.length - unknown.length;
    collections.push({ collection: name, kpis: rows.length, resolved: named.length - unknown.length, unresolved: unnamed, unknownMetrics: unknown });
  }

  return {
    total,
    resolved,
    pct: total ? `${Math.round((resolved / total) * 100)}%` : '—',
    complete: total > 0 && resolved === total,
    collections,
  };
}

module.exports = { resolve, resolveCard, coverage, definitionOf, isKpiRows };
