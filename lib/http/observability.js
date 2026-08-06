/* Knowing what the server is doing, and whether it is fast enough.
 *
 * Phase 10. The design states a budget — *"< 200 ms p95"* for served queries —
 * and an exit criterion that says p95 must be within it under realistic load.
 * A budget nobody measures is a wish, so this measures it.
 *
 * **Percentiles are computed from kept samples, not from a running average.**
 * A mean hides exactly the tail the budget is about: a hundred 5 ms responses
 * and one 3-second one average to 35 ms and pass a 200 ms budget that they
 * plainly fail. Samples are capped per route so memory cannot grow without
 * bound, and the cap is stated in the output — a p95 over the last thousand
 * requests is a different claim from one over all of them, and the reader
 * should not have to guess which they are looking at.
 */

const DEFAULT_CAP = 1000;

/* Route rather than URL: `/campaigns?v=campDetail` and `/campaigns` are the
   same work, and a per-URL breakdown would scatter the samples that make a
   percentile meaningful. */
function routeOf(req) {
  const path = (req.route && req.route.path) || req.path || req.url.split('?')[0];

  /* Ids in a path fragment the samples the same way a query string would, and
     one sample per id is not a percentile. Every generated id in this app is a
     long segment containing a digit — `2026-08-06T12-14-21-152Z-e0cec708`,
     a metric snapshot, a dispatch. Matching on *shape* rather than on hex
     catches all of them; matching on hex caught none, because the timestamps
     carry `T` and `Z`. */
  return String(path)
    .split('/')
    .map((segment) => (segment.length >= 8 && /\d/.test(segment) ? ':id' : segment))
    .join('/');
}

class Timings {
  constructor({ cap = DEFAULT_CAP } = {}) {
    this.cap = cap;
    this.routes = new Map();
    this.started = Date.now();
  }

  record(route, ms, status) {
    if (!this.routes.has(route)) this.routes.set(route, { samples: [], count: 0, errors: 0, dropped: 0 });
    const entry = this.routes.get(route);

    entry.count += 1;
    if (status >= 500) entry.errors += 1;

    entry.samples.push(ms);
    if (entry.samples.length > this.cap) {
      entry.samples.shift();
      entry.dropped += 1;
    }
  }

  /* Nearest-rank, which for a small sample is the honest one: it always returns
     a value that actually happened rather than interpolating one that did not. */
  static percentile(samples, p) {
    if (!samples.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
  }

  report({ budgetMs = 200 } = {}) {
    const routes = [];
    for (const [route, entry] of this.routes) {
      const p95 = Timings.percentile(entry.samples, 95);
      routes.push({
        route,
        count: entry.count,
        /* Stated so a reader knows what the percentile is over. */
        sampled: entry.samples.length,
        dropped: entry.dropped,
        p50: round(Timings.percentile(entry.samples, 50)),
        p95: round(p95),
        p99: round(Timings.percentile(entry.samples, 99)),
        max: round(Math.max(...entry.samples)),
        errors: entry.errors,
        withinBudget: p95 !== null ? p95 <= budgetMs : null,
      });
    }

    routes.sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
    const measured = routes.filter((r) => r.p95 !== null);

    return {
      budgetMs,
      uptimeSeconds: Math.round((Date.now() - this.started) / 1000),
      requests: routes.reduce((t, r) => t + r.count, 0),
      /* The whole-server figure a budget is really about — the worst route, not
         an average across routes, because a user waits on the page they asked
         for and not on the mean of all pages. */
      worstRoute: measured.length ? measured[0].route : null,
      worstP95: measured.length ? measured[0].p95 : null,
      withinBudget: measured.length ? measured.every((r) => r.withinBudget) : null,
      routes,
    };
  }

  reset() { this.routes.clear(); this.started = Date.now(); }
}

const round = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

/* Times every request and logs the slow ones. Logging all of them would bury
   the interesting ones; logging none would mean the first anyone hears of a
   slow route is a complaint. */
function timing(timings, { slowMs = 200, log = console } = {}) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = routeOf(req);
      timings.record(route, ms, res.statusCode);
      if (ms > slowMs) log.warn(`slow: ${req.method} ${route} ${ms.toFixed(0)}ms (${res.statusCode})`);
    });

    next();
  };
}

module.exports = { Timings, timing, routeOf, DEFAULT_CAP };
