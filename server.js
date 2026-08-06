/* Routing and composition.
 *
 * This file knows about screens, templates and the URL. It does not know where
 * content comes from: every read goes through the repository (lib/repository),
 * whose static implementation is the only thing that touches `data/`.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const { createRepository } = require('./lib/repository');
const { subviewState } = require('./lib/view-state');
const schema = require('./lib/schema');
const ingest = require('./lib/ingest');
const { SyncRunner } = require('./lib/ingest/runner');
const filters = require('./lib/filters');
const alerts = require('./lib/alerts');
const commandPalette = require('./lib/palette');
const identity = require('./lib/identity');
const attribution = require('./lib/attribution');
const metrics = require('./lib/metrics');
const resolve = require('./lib/metrics/resolve');
const reports = require('./lib/reports');
const { createReasoner } = require('./lib/ai/reasoner');
const rules = require('./lib/rules');
const channels = require('./lib/rules/channels');
const { FireLog } = require('./lib/rules/firelog');
const schedules = require('./lib/schedules');
const auth = require('./lib/auth');
const authSessions = require('./lib/auth/sessions');
const hardening = require('./lib/http/hardening');
const observability = require('./lib/http/observability');

const app = express();
const PORT = process.env.PORT || 3000;
const repo = createRepository();

/* Phase 9 — the raw store is partitioned per workspace: `var/raw/<workspace>/`.
   Isolation is a property of *where the data is*, not of a filter applied on
   the way out. A tenant with no ingested data gets an empty store rather than
   somebody else's, because there is nothing else in its directory. */
/* Entities for one workspace. Everything downstream — metrics, rules,
   explanations — reads through this, so none of them needs to know tenancy
   exists. The partitioning itself lives in lib/ingest. */
function entitiesFor(workspaceId) {
  return ingest.snapshot({ store: ingest.storeFor(workspaceId) });
}

const runner = new SyncRunner({ store: ingest.storeFor('parakkat') });
const workspace = new attribution.Workspace();
const dispatches = new reports.Dispatches();
const reasoner = createReasoner();
const fires = new FireLog();

/* Phase 8. A rule watches a registry metric and evaluates on that metric's
   cadence — so the rules are checked whenever the pipeline is, not on a
   schedule of their own. */
function evaluateRules(workspaceId) {
  const status = runner.status();
  const current = metricValues(workspaceId).values || {};
  const previous = periodValues(workspaceId, '7d');
  const week = previous ? previous.values || {} : {};

  /* The sustain window: one reading per day for the last three days, which is
     what "for 3d" in the design's condition means. */
  const now = new Date();
  const sustained = {};
  for (const offset of [3, 2, 1]) {
    const end = new Date(now.getTime() - (offset - 1) * 86400000).toISOString();
    const start = new Date(now.getTime() - offset * 86400000).toISOString();
    const day = metricValues(workspaceId, null, { from: start, to: end, label: `day-${offset}` }).values || {};
    for (const [id, value] of Object.entries(day)) {
      (sustained[id] = sustained[id] || []).push(value);
    }
  }

  return rules.list().map((rule) => rules.evaluate(rule, {
    current,
    previous: week,
    sustained: rule.metric ? sustained[rule.metric] : null,
    status,
  }));
}

/* The background rule loop and the sync runner both belong to the workspace
   whose sources are configured. A second tenant with no connectors has nothing
   to watch, so nothing ticks for it — which is correct, not an omission. */
const SYNCED_WORKSPACE = 'parakkat';

/* A verdict becomes a fire only once per cadence — a rule that stays true must
   not shout on every tick. */
function fireDueRules({ at = new Date().toISOString(), workspace: workspaceId = SYNCED_WORKSPACE } = {}) {
  const recent = new Map();
  for (const f of fires.resolved()) recent.set(f.rule, f.at);

  const fired = [];
  for (const verdict of evaluateRules(workspaceId)) {
    if (verdict.state !== 'fired') continue;

    const last = recent.get(verdict.rule);
    if (last && Date.now() - Date.parse(last) < 3600000) continue;

    const rule = rules.get(verdict.rule);
    const fire = {
      id: `${at.replace(/[:.]/g, '-')}-${verdict.rule}`,
      kind: 'fire',
      rule: verdict.rule,
      name: verdict.name,
      severity: verdict.severity,
      reason: verdict.reason,
      value: verdict.value === undefined ? null : verdict.value,
      to: verdict.to,
      at,
    };
    fire.delivery = channels.deliver(fire, rule.channels);
    fires.append(fire);
    fired.push(fire);
  }
  return fired;
}

/* The attribution model is a workspace parameter on **every** revenue read —
   that is the distinction 5.2 exists to make, so it is threaded in here rather
   than being read by whichever module happens to want it. A screen with no
   model-dependent content simply ignores it. */
const readParams = (query) => ({ ...(query || {}), model: workspace.model() });

/* A screen may declare the grain its KPI cards are about — Campaign Analytics'
   drill-down is one campaign, not the workspace — and the registry is then
   evaluated there. See lib/metrics/scope.js. */
function resolveMetrics(payload, workspaceId) {
  const at = payload && payload.metricScope ? payload.metricScope : null;
  const { values, notApplicable } = metricValues(workspaceId, at);
  return resolve.resolve(payload, {
    values,
    notApplicable,
    useRegistryValues: USE_REGISTRY_VALUES,
    valuesFor: (label) => periodValues(workspaceId, label, at),
  });
}

/* The command index is the same on every request — it depends on the screen
   registry and the sub-view map, neither of which varies by request. */
let paletteCache = null;
async function palette() {
  if (!paletteCache) paletteCache = await commandPalette.build(repo);
  return paletteCache;
}

/* Normalisation problems only change when a sync writes, so replaying the
   whole raw store on every page render would be waste. Cached briefly; the
   panel is a status display, not an audit trail. */
const PIPELINE_TTL = 30_000;
let pipeline = { at: 0, workspace: null, problems: [], match: null, unattributed: 0 };
function pipelineState(workspaceId) {
  if (pipeline.workspace === workspaceId && Date.now() - pipeline.at < PIPELINE_TTL) return pipeline;
  try {
    const entities = entitiesFor(workspaceId);
    const resolutions = identity.resolve(entities);
    pipeline = {
      at: Date.now(),
      workspace: workspaceId,
      problems: entities.problems,
      match: identity.matchRate(resolutions),
      unattributed: identity.unattributedRevenue(entities, resolutions),
    };
  } catch (err) {
    /* A store that cannot be replayed is itself worth knowing about, but not
       at the cost of every page 500ing on it. */
    console.warn('pipeline: could not replay the raw store —', err.message);
    pipeline = { at: Date.now(), workspace: workspaceId, problems: [], match: null, unattributed: 0 };
  }
  return pipeline;
}

/* Sent reports whose figures have moved since (5.3). Evaluated at each
   dispatch's own grain — comparing a campaign report against workspace totals
   would invent a restatement that never happened. */
function restatements(workspaceId) {
  try {
    const sent = dispatches.list();
    if (!sent.length) return [];
    return reports.stale(sent, (at) => metricValues(workspaceId, at).values || {});
  } catch (err) {
    console.warn('reports: could not check for restatements —', err.message);
    return [];
  }
}

function notifications(workspaceId) {
  const { problems, match, unattributed } = pipelineState(workspaceId);
  /* Fires from the last day — the panel is the channel that always works. */
  const since = new Date(Date.now() - 86400000).toISOString();
  let fired = [];
  try {
    fired = fires.resolved().filter((f) => f.at >= since && !f.falsePositive);
  } catch (err) {
    console.warn('rules: could not read the fire log —', err.message);
  }
  return alerts.build({ status: runner.status(), problems, match, unattributed, restatements: restatements(workspaceId), fired });
}

/* Registry values are only substituted under the ingested driver, where the
   number is genuinely derived. Under `static` the definition still travels
   with every card — that is the half of 6.4 that matters most — but the
   authored figure stays, because a fixture-scale number dropped into an
   authored dashboard would be neither one thing nor the other. */
const USE_REGISTRY_VALUES = repo.name === 'ingested';

const METRIC_TTL = 30_000;
let evaluated = { stamp: 0, byGrain: new Map() };

/* Keyed by grain and period, because a screen about one campaign, a screen
   about the workspace, and a card about the last 24 hours are three different
   evaluations of the same registry. */
function metricValues(workspaceId, at = null, over = null) {
  /* The workspace is part of the cache key, not an afterthought — two tenants
     sharing a cache entry would be the same leak the partitioned store exists
     to prevent, arriving by a different door. */
  const key = `${workspaceId}|${at ? `${at.dimension}:${at.value}` : ''}|${over ? over.label || `${over.from}..${over.to}` : ''}`;
  if (Date.now() - evaluated.stamp > METRIC_TTL) evaluated = { stamp: Date.now(), byGrain: new Map() };
  if (evaluated.byGrain.has(key)) return evaluated.byGrain.get(key);

  let result = { values: null, notApplicable: [] };
  try {
    const { values, notApplicable } = metrics.evaluate(entitiesFor(workspaceId), { at, over });
    result = { values, notApplicable };
  } catch (err) {
    console.warn('metrics: could not evaluate the registry —', err.message);
  }
  evaluated.byGrain.set(key, result);
  return result;
}

/* A relative window needs a reference instant. The clock is read here, at the
   edge, and never inside the metric layer — 6.2's reproducibility rests on
   evaluation being a pure function of its inputs. */
function periodValues(workspaceId, label, at = null) {
  try {
    return metricValues(workspaceId, at, metrics.period.fromLabel(label, new Date().toISOString()));
  } catch (err) {
    console.warn(`metrics: unknown period "${label}" —`, err.message);
    return null;
  }
}

/* What the chips offer. Derived from the payload *before* filtering, so
   choosing "Munnar Hillside" does not leave the dropdown holding only Munnar
   Hillside — a filter you cannot change is a filter you cannot undo. */
function filterData(unfiltered, active = {}) {
  const options = unfiltered ? filters.optionsFor(unfiltered) : {};
  return {
    dimensions: filters.DIMENSIONS.map((d) => ({ key: d.key, chip: d.chip, options: options[d.key] || [] })),
    inert: filters.INERT,
    active,
  };
}

/* The same URL with every filter dropped, for the note's Clear link. */
function clearUrl(originalUrl, active) {
  const url = new URL(originalUrl, 'http://local');
  for (const key of Object.keys(active)) url.searchParams.delete(`f_${key}`);
  return url.pathname + (url.search || '');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* Phase 10. Behind a proxy the socket address is the proxy's, so rate limiting
   would key every visitor to one bucket unless the hop count is declared.
   `LEADINTEL_PROXIES` says how many to trust; unset means none, which is
   correct for running this directly. */
if (process.env.LEADINTEL_PROXIES) app.set('trust proxy', Number(process.env.LEADINTEL_PROXIES));

const TLS = process.env.LEADINTEL_TLS === 'on';
app.use(hardening.secureHeaders({ secure: TLS }));

/* Timing every request, so the design's "< 200 ms p95" is measured rather than
   hoped for. Reported at /health. */
const timings = new observability.Timings();
app.use(observability.timing(timings, { slowMs: 200 }));

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), {
  /* Fingerprinting is not in place, so a long max-age would serve stale CSS
     after a deploy. An hour is short enough to be safe and long enough to
     matter across a session. */
  maxAge: '1h',
}));

/* Phase 9. Everything past this line needs a session, and `req.workspace` comes
   from that session rather than from the request — a caller cannot reach
   another tenant's data by changing a parameter, because there is no parameter.
   `LEADINTEL_AUTH=off` disables the gate for local work on the screens; it is
   refused outright in production below. */
const gatekeeper = auth.create();
const AUTH_OFF = process.env.LEADINTEL_AUTH === 'off';

/* Phase 10 — configuration that is merely unwise locally and unsafe in
   production is refused there rather than warned about. A warning in a startup
   log is read once, by the person who already knew. */
if (process.env.NODE_ENV === 'production') {
  const refusals = [];
  if (AUTH_OFF) refusals.push('LEADINTEL_AUTH=off — there is no safe way to serve a multi-tenant app with the door open');
  if (!process.env.LEADINTEL_SECRET) refusals.push('LEADINTEL_SECRET is unset — sessions would not survive a restart or be shared between instances');
  if (process.env.LEADINTEL_TLS !== 'on') refusals.push('LEADINTEL_TLS is not on — the session cookie would be sent without the Secure flag');
  if (refusals.length) {
    throw new Error(`refusing to start in production:\n  - ${refusals.join('\n  - ')}`);
  }
}

/* Liveness and the performance budget, before the session gate: a health check
   that needs credentials is a health check a load balancer cannot use. It
   carries no tenant data — timings by route, and whether p95 is within the
   design's 200 ms. */
app.get('/health', (req, res) => {
  const report = timings.report({ budgetMs: 200 });
  res.json({
    status: 'ok',
    uptimeSeconds: report.uptimeSeconds,
    requests: report.requests,
    budgetMs: report.budgetMs,
    withinBudget: report.withinBudget,
    worstRoute: report.worstRoute,
    worstP95: report.worstP95,
    routes: report.routes,
  });
});

app.get('/login', (req, res) => {
  res.render('app/login', {
    users: auth.identity.list(),
    workspaces: auth.identity.workspaces(),
    next: typeof req.query.next === 'string' ? req.query.next : '/',
    error: req.query.error || null,
    seedPassword: auth.identity.SEED_PASSWORD,
  });
});

/* The sign-in route is the door — everything else already needs a session, so
   an attacker who can reach it has got past this. Ten attempts a minute per
   address. */
const loginLimiter = new hardening.RateLimiter({ limit: 10, windowMs: 60_000 });

app.post('/login',
  hardening.limit(loginLimiter, { message: 'too many sign-in attempts' }),
  express.urlencoded({ extended: false }), express.json(),
  (req, res) => {
  const body = req.body || {};
  const user = auth.identity.authenticate(body.user, body.password);
  const wantsHtml = (req.get('accept') || '').includes('text/html');

  if (!user) {
    gatekeeper.audit.record({ user: null, action: 'auth.login', outcome: 'refused', workspace: null, detail: { attempted: body.user || null } });
    if (wantsHtml) return res.redirect(`/login?error=${encodeURIComponent('That username and password do not match.')}`);
    return res.status(401).json({ error: 'that username and password do not match' });
  }

  const session = gatekeeper.sessions.create(user);
  res.setHeader('Set-Cookie', authSessions.cookieHeader(session.cookie, { secure: TLS }));
  gatekeeper.audit.record({ user, action: 'auth.login', outcome: 'allowed', workspace: user.workspace });

  if (wantsHtml) return res.redirect(typeof body.next === 'string' && body.next.startsWith('/') ? body.next : '/');
  return res.json({ user });
});

app.post('/logout', (req, res) => {
  gatekeeper.sessions.destroy(authSessions.fromRequest(req));
  res.setHeader('Set-Cookie', authSessions.clearHeader());
  if ((req.get('accept') || '').includes('text/html')) return res.redirect('/login');
  return res.json({ ok: true });
});

if (!AUTH_OFF) {
  app.use(gatekeeper.authenticate);
} else {
  /* Still attach an identity, or every workspace-scoped read would have none.
     The Owner is used, so nothing is accidentally gated while the door is off. */
  console.warn('auth: LEADINTEL_AUTH=off — serving as Owner with no sign-in');
  app.use((req, _res, next) => {
    req.user = auth.identity.get('anand');
    req.workspace = req.user.workspace;
    next();
  });
}

app.get('/whoami', (req, res) => {
  res.json({
    user: req.user,
    workspace: auth.identity.workspace(req.workspace),
    may: auth.permissions.allowed(req.user),
  });
});

app.get('/audit', (req, res) => {
  /* Scoped to the caller's own workspace, always. */
  res.json({
    workspace: req.workspace,
    entries: gatekeeper.audit.forWorkspace(req.workspace, { action: req.query.action || null }),
  });
});

/* Ingest endpoints. Nothing here feeds a screen — the views still read the
   repository, and will until sub-phase 4.6 — so these are deliberately outside
   the screen routing above: an intake and a status page, nothing more.
   Registered before the screen routes so `/ingest/*` can never be read as a
   screen slug. */
app.use('/ingest', express.json({ limit: '1mb' }));

/* Webhook intake for the two sources that stream. A delivery takes the same
   path as a pull, so the reply is the same shape either way: how many records
   arrived, and how many of them were new. */
/* Behind the session gate, which is safe and also means no real source could
   call it — a webhook needs its own credential, a signature from the sending
   system, not a browser session. That is not built, and until it is, this route
   is reachable only by a signed-in Owner. Stated rather than left as a
   surprise. */
app.post('/ingest/webhook/:source', gatekeeper.gate('ingest.webhook', (req) => ({ source: req.params.source })), async (req, res) => {
  try {
    res.json(await ingest.receive(req.params.source, req.body));
  } catch (err) {
    /* A malformed delivery is the sender's problem, not a server fault — and
       it must say so, or a source will retry a payload that can never work. */
    res.status(400).json({ error: err.message });
  }
});

/* Pipeline health, exposed: stage 1–2 sync lag and the stage 3 match rate.
   The Analytics Engine files both under operational health, and the Phase 8
   "Connector down" alert reads the first half of this. */
app.get('/ingest/status', (req, res) => {
  const { match, unattributed } = pipelineState(req.workspace);
  res.json({
    transport: runner.transport.name,
    sources: runner.status(),
    match,
    unattributedRevenuePaise: unattributed,
  });
});

/* The metric registry (6.1). One definition per KPI, evaluated in dependency
   order against the current entities. Exposed because a registry nobody can
   read is a registry nobody can check — `?id=` returns one metric with its
   full definition, so "where does this number come from" has an answer that is
   not "read the source". */
app.get('/metrics', (req, res) => {
  let entities;
  try {
    entities = entitiesFor(req.workspace);
  } catch (err) {
    return res.status(503).json({ error: `the raw store could not be replayed: ${err.message}` });
  }

  /* `?at=campaign:munnar honeymoon jul` evaluates the registry at that grain.
     Metrics that are not meaningful there come back marked, not zeroed. */
  let at = null;
  if (req.query.at) {
    const [dimension, ...rest] = String(req.query.at).split(':');
    if (!metrics.scope.DIMENSIONS.includes(dimension)) {
      return res.status(400).json({ error: `unknown dimension "${dimension}"`, dimensions: metrics.scope.DIMENSIONS });
    }
    at = { dimension, value: rest.join(':') };
  }

  const report = metrics.report(entities, { at });
  if (!req.query.id) {
    return res.json({
      count: report.metrics.length,
      at: report.at,
      grains: metrics.scope.available(entities),
      notApplicable: report.notApplicable,
      order: report.order,
      problems: report.problems,
      metrics: report.metrics,
    });
  }

  const one = report.metrics.find((m) => m.id === req.query.id);
  if (!one) return res.status(404).json({ error: `no metric "${req.query.id}"`, known: report.order });

  const definition = metrics.registry.get(one.id);
  return res.json({
    ...one,
    governance: metrics.definitionLog.governance(one.id),
    thresholds: definition.thresholds,
    format: definition.format,
    /* What it feeds, which the definition itself cannot know. */
    feeds: metrics.registry.list().filter((m) => m.dependencies.includes(one.id)).map((m) => m.id),
  });
});

/* Report schedules (Phase 8). Due-ness is computed from each schedule's last
   dispatch, not from a timer — a process that was down over Monday morning
   sends the Monday report when it returns rather than skipping it. */
function lastRuns() {
  const seen = {};
  for (const d of dispatches.list()) {
    if (!d.schedule) continue;
    if (!seen[d.schedule] || d.sentAt > seen[d.schedule]) seen[d.schedule] = d.sentAt;
  }
  return seen;
}

function runDueSchedules({ now = new Date().toISOString() } = {}) {
  const sent = [];
  for (const state of schedules.due(lastRuns(), now)) {
    if (!state.due) continue;
    const schedule = schedules.get(state.schedule);

    const evaluation = metrics.recordEvaluation(entitiesFor(req.workspace), { note: `scheduled: ${schedule.name}` });
    const dispatch = dispatches.send(schedule.name, {
      evaluation,
      metrics: schedule.metrics,
      recipients: schedule.to,
      channels: schedule.channels,
      sentAt: now,
    });

    /* The same delivery seam the rules use, so a scheduled report and a fired
       alert report their channels the same way. */
    dispatch.schedule = schedule.id;
    dispatch.delivery = channels.deliver({
      rule: schedule.name, severity: 'info', reason: `scheduled report for ${schedule.freq}`, to: schedule.to, at: now,
    }, schedule.channels);
    dispatches.update(dispatch);
    sent.push(dispatch);
  }
  return sent;
}

app.get('/schedules', (req, res) => {
  const now = new Date().toISOString();
  res.json({
    schedules: schedules.list().map((s) => {
      const state = schedules.due(lastRuns(), now).find((d) => d.schedule === s.id);
      return {
        id: s.id, name: s.name, freq: s.freq, status: s.status,
        to: s.to, channels: s.channels, metrics: s.metrics,
        lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt, due: state.due,
      };
    }),
  });
});

app.post('/schedules/run', express.json(), gatekeeper.gate('schedule.run'), (req, res) => {
  try {
    const sent = runDueSchedules();
    res.json({ sent: sent.map(({ definitions, inputs, ...d }) => d) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Alert rules (Phase 8). Each carries its 90-day fire count and false-positive
   rate, so a noisy threshold stays visible rather than becoming background. */
app.get('/rules', (req, res) => {
  const verdicts = new Map(evaluateRules(req.workspace).map((v) => [v.rule, v]));
  res.json({
    rules: rules.list().map((rule) => {
      const verdict = verdicts.get(rule.id);
      return {
        id: rule.id,
        name: rule.name,
        condition: rule.cond,
        metric: rule.metric,
        severity: rule.severity,
        to: rule.to,
        channels: rule.channels,
        cadence: rules.cadenceOf(rule),
        state: verdict ? verdict.state : 'unknown',
        reason: verdict ? verdict.reason || null : null,
        stats: fires.stats(rule.id),
      };
    }),
  });
});

/* Evaluating is a read; firing writes and delivers, so it is a POST. */
app.post('/rules/evaluate', express.json(), gatekeeper.gate('rule.evaluate'), (req, res) => {
  try {
    res.json({ fired: fireDueRules({ workspace: req.workspace }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/rules/fires', (req, res) => {
  const all = fires.resolved();
  const filtered = req.query.rule ? all.filter((f) => f.rule === req.query.rule) : all;
  res.json({ count: filtered.length, fires: filtered.slice(-100).reverse() });
});

/* A false positive is a judgement somebody makes, never something the product
   infers — see lib/rules/firelog.js. */
app.post('/rules/fires/:id/judge', express.json(),
  gatekeeper.gate('rule.judge', (req) => ({ fire: req.params.id, falsePositive: (req.body || {}).falsePositive })),
  (req, res) => {
  const body = req.body || {};
  if (typeof body.falsePositive !== 'boolean') {
    return res.status(400).json({ error: 'judge needs falsePositive: true or false' });
  }
  const judgement = fires.judge(req.params.id, { falsePositive: body.falsePositive, by: body.by || null, note: body.note || null });
  if (!judgement) return res.status(404).json({ error: `no fire "${req.params.id}"` });
  return res.json(judgement);
});

/* Explanations (Phase 7). The AI reads the registry, never the raw tables, so
   an explanation and the dashboard cannot disagree. Compares two windows —
   `?over=7d&against=30d` — and refuses to ship a claim it cannot source. */
app.get('/metrics/:id/explain', (req, res) => {
  const metricId = req.params.id;
  if (!metrics.registry.get(metricId)) {
    return res.status(404).json({ error: `no metric "${metricId}"`, known: metrics.registry.ids() });
  }

  try {
    const at = req.query.at ? parseGrain(req.query.at) : null;
    if (req.query.at && !at) return res.status(400).json({ error: `unknown dimension in "${req.query.at}"` });

    const after = periodValues(req.workspace, req.query.over || '7d', at);
    const against = periodValues(req.workspace, req.query.against || '30d', at);
    if (!after || !against) return res.status(400).json({ error: 'unknown period' });

    const entities = entitiesFor(req.workspace);
    const { match } = pipelineState(req.workspace);

    const explanation = reasoner.explain(metricId, {
      before: { values: against.values || {}, over: metrics.period.fromLabel(req.query.against || '30d', new Date().toISOString()) },
      after: { values: after.values || {}, over: metrics.period.fromLabel(req.query.over || '7d', new Date().toISOString()) },
      match,
      problems: entities.problems.length,
      sampleSize: entities.bookings.length + entities.leads.length,
    });

    return res.json(explanation);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function parseGrain(raw) {
  const [dimension, ...rest] = String(raw).split(':');
  if (!metrics.scope.DIMENSIONS.includes(dimension)) return null;
  return { dimension, value: rest.join(':') };
}

/* Definition versions (6.3). Definitions live in code, so the log reconciles
   against what is in force rather than being told about edits. */
app.get('/metrics/definitions', (req, res) => {
  const log = metrics.definitionLog;
  if (req.query.id) {
    const governance = log.governance(req.query.id);
    if (!governance) return res.status(404).json({ error: `no definition history for "${req.query.id}"` });
    return res.json({ ...governance, history: log.historyOf(req.query.id) });
  }
  return res.json({
    fingerprint: metrics.versions.fingerprint(),
    metrics: metrics.registry.ids().map((id) => log.governance(id)).filter(Boolean),
    history: log.historyOf().slice(0, 50),
  });
});

/* Sent reports (5.3). Nothing is actually dispatched — there is no mail
   transport, no PDF renderer and no scheduler, all of which are Phase 8. This
   records that a report went out carrying particular figures, which is the fact
   restatement flagging needs and nothing had. */
app.post('/reports/send', express.json(),
  gatekeeper.gate('report.send', (req) => ({ report: (req.body || {}).report || null })),
  (req, res) => {
  const body = req.body || {};
  try {
    if (!body.report) return res.status(400).json({ error: 'a dispatch needs a report name' });
    const at = body.at && metrics.scope.DIMENSIONS.includes(body.at.dimension) ? body.at : null;

    /* The report carries an evaluation, so one is recorded at send time — that
       is what makes it reproducible later. */
    const evaluation = metrics.recordEvaluation(entitiesFor(req.workspace), { at, note: `sent: ${body.report}` });
    const dispatch = dispatches.send(body.report, {
      evaluation,
      metrics: body.metrics || null,
      recipients: body.recipients || [],
      channels: body.channels || [],
    });

    const { definitions, ...summary } = dispatch;
    return res.status(201).json(summary);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/reports/dispatches', (req, res) => {
  const sent = dispatches.list();
  const drift = new Map(restatements(req.workspace).map((r) => [r.dispatch, r]));
  res.json({
    count: sent.length,
    stale: drift.size,
    dispatches: sent.map(({ definitions, ...d }) => ({ ...d, restatement: drift.get(d.id) || null })),
  });
});

app.get('/reports/dispatches/:id', (req, res) => {
  let dispatch;
  try {
    dispatch = dispatches.get(req.params.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!dispatch) return res.status(404).json({ error: `no dispatch "${req.params.id}"` });

  const current = metricValues(req.workspace, dispatch.at).values || {};
  const { definitions, ...summary } = dispatch;
  /* The sent copy is returned as sent — `restatement` reports the drift beside
     it rather than correcting it in place. */
  return res.json({ ...summary, restatement: reports.restatement(dispatch, current) });
});

/* Versioned results (6.2). A snapshot keeps the entities an evaluation read
   alongside what came out, so a past number can be reproduced rather than
   taken on trust. Recording is a POST because it writes. */
app.post('/metrics/snapshot', express.json(), gatekeeper.gate('snapshot.record'), (req, res) => {
  try {
    const body = req.body || {};
    const at = body.at && metrics.scope.DIMENSIONS.includes(body.at.dimension) ? body.at : null;
    const record = metrics.recordEvaluation(entitiesFor(req.workspace), { at, note: body.note || null });
    /* The record itself carries the whole entity set; the reply does not need
       to hand it back to the caller that just supplied it. */
    const { inputs, definitions, ...summary } = record;
    res.status(201).json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/metrics/snapshots', (req, res) => {
  res.json({ registryFingerprint: metrics.versions.fingerprint(), snapshots: metrics.evaluations.list() });
});

app.get('/metrics/snapshots/:id', (req, res) => {
  let record;
  try {
    record = metrics.evaluations.get(req.params.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!record) return res.status(404).json({ error: `no evaluation "${req.params.id}"` });

  /* `?inputs=1` to see what it was computed from — the point of keeping it. */
  if ('inputs' in req.query) return res.json(record);
  const { inputs, definitions, ...summary } = record;
  return res.json(summary);
});

app.get('/metrics/snapshots/:id/reproduce', (req, res) => {
  let result;
  try {
    result = metrics.reproduceEvaluation(req.params.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!result) return res.status(404).json({ error: `no evaluation "${req.params.id}"` });
  return res.json(result);
});

/* Phase 6's exit criterion, made checkable: "every KPI in the UI resolves to a
   registry entry; none is hardcoded in markup". Walks every screen and counts
   the KPI cards that name a metric against those that do not, naming the ones
   that do not. A claim like that belongs in a response, not only in a document. */
app.get('/metrics/coverage', async (req, res) => {
  try {
    const screens = await repo.screens();
    const perScreen = [];
    let total = 0;
    let resolved = 0;

    for (const screen of screens) {
      const payload = await repo.read(screen.view, readParams({}));
      if (!payload) continue;
      const cover = resolve.coverage(payload);
      if (!cover.total) continue;

      total += cover.total;
      resolved += cover.resolved;
      perScreen.push({ screen: screen.slug || 'dashboard', ...cover });
    }

    res.json({
      total,
      resolved,
      pct: total ? `${Math.round((resolved / total) * 100)}%` : '—',
      complete: total > 0 && resolved === total,
      valuesFrom: USE_REGISTRY_VALUES ? 'registry' : 'authored',
      screens: perScreen,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* The workspace attribution model (5.2). A GET reads the setting and, given a
   candidate, the impact of switching to it; a POST applies one. Applying is a
   POST because it changes what every revenue figure in the product means —
   that is not something a link should do. */
app.get('/workspace/attribution', (req, res) => {
  const state = workspace.state();
  const candidate = req.query.candidate;
  res.json({
    model: state.model,
    name: attribution.MODELS[state.model].name,
    changedAt: state.changedAt,
    justification: state.justification,
    models: attribution.ORDER.map((k) => ({ key: k, name: attribution.MODELS[k].name, character: attribution.MODELS[k].character })),
    credit: attribution.credit(state.model),
    preview: attribution.isModel(candidate) ? attribution.impact(state.model, candidate) : null,
    history: state.history,
  });
});

app.post('/workspace/attribution',
  express.urlencoded({ extended: false }), express.json(),
  /* The design's own gate: "attribution changes are Owner and Marketing
     Director only". */
  gatekeeper.gate('attribution.change', (req) => ({ model: (req.body || {}).model || null })),
  (req, res) => {
  const body = req.body || {};
  try {
    const change = workspace.apply(body.model, { justification: body.justification });
    /* A form post redirects so a refresh does not re-apply; an API caller gets
       the change record back. */
    if ((req.get('accept') || '').includes('text/html')) return res.redirect('/attribution');
    return res.json(change);
  } catch (err) {
    if ((req.get('accept') || '').includes('text/html')) {
      const back = attribution.isModel(body.model) ? `/attribution?preview=${body.model}&err=${encodeURIComponent(err.message)}` : '/attribution';
      return res.redirect(back);
    }
    return res.status(400).json({ error: err.message });
  }
});

/* A screen with no template renders its chrome and an explanatory body rather
   than crashing. */
function hasView(view) {
  return fs.existsSync(path.join(__dirname, 'views', 'screens', `${view}.ejs`));
}

/* Chrome data: the repository supplies the date range and filter chips,
   the route supplies the parts that are request state — which nav item is
   active, whether the sidebar is open, whether the workspace menu is down. */
async function shellData(activeSlug, query) {
  const content = (await repo.read('_shell', readParams(query))) || {};
  const shell = {
    ...content,
    navGroups: await repo.navigation(activeSlug),
    expanded: true,
    sidebarWidth: '214px',
    collapseIcon: 'ph ph-caret-double-left',
    wsOpen: query ? 'ws' in query : false,
  };
  schema.audit('_shell', shell, { requireAll: true, label: 'the shell payload' });
  return shell;
}

function screenRoute(screen) {
  return async (req, res, next) => {
    try {
      const groups = await repo.subviewGroups(screen.view);
      const { flags, tabLists } = subviewState(groups, screen.slug, req.query);

      /* 6.4 — every KPI card that names a registry metric carries its
         definition from here on, whichever driver supplied the payload. */
      const unfiltered = resolveMetrics((await repo.read(screen.view, readParams(req.query))) || {}, req.workspace);

      /* Filtering sits between the repository and the view: it narrows rows the
         repository returned rather than asking it a narrower question, because
         the authored modules hold one snapshot each. See lib/filters.js. */
      const result = filters.applyFilters(unfiltered, req.query);
      const note = filters.summarise(result);

      const data = {
        ...result.payload,
        ...flags,
        ...tabLists,
        /* Dashboard edit mode is a display flag, not a sub-view. */
        editing: 'edit' in req.query,
      };
      schema.audit(screen.view, data, { requireAll: true, label: `the ${screen.slug || 'dashboard'} view payload` });

      /* The creative drawer is a standalone overlay, not part of any screen. */
      const drawer = 'cr' in req.query
        ? { data: (await repo.read('overlay-creative-detail', readParams(req.query))) || {} }
        : null;

      /* A candidate model the user is looking at but has not applied. The
         screen behind the bar already shows the candidate's figures, so the
         bar has to say which model is still crediting revenue. */
      const candidate = req.query.preview;
      const attrPreview = attribution.isModel(candidate) && candidate !== workspace.model()
        ? { ...attribution.impact(workspace.model(), candidate), error: req.query.err || null }
        : null;

      res.render('layout', {
        screen,
        screens: await repo.screens(),
        shell: await shellData(screen.slug, req.query),
        hasView: hasView(screen.view),
        data,
        drawer,
        palette: await palette(),
        notifications: notifications(req.workspace),
        filterData: filterData(unfiltered, result.active),
        filterNote: note && { ...note, clearUrl: clearUrl(req.originalUrl, result.active) },
        attrPreview,
      }, (err, html) => (err ? next(err) : res.send(html)));
    } catch (err) {
      next(err);
    }
  };
}

async function start() {
  for (const screen of await repo.screens()) {
    app.get('/' + screen.slug, screenRoute(screen));
  }

  app.use(async (req, res, next) => {
    try {
      res.status(404).render('layout', {
        screen: { slug: '404', view: '404', name: 'Not found', icon: 'ph ph-question' },
        screens: await repo.screens(),
        shell: await shellData(null, null),
        hasView: false,
        data: null,
        drawer: null,
        palette: await palette(),
        notifications: notifications(req.workspace),
        filterData: filterData(null),
        filterNote: null,
        attrPreview: null,
      });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).type('text/plain').send(err.stack);
  });

  /* The sync loop runs in-process. That is the right shape for one node and
     the wrong one for several — two instances would both poll — so it comes
     out into its own worker at Phase 10, not before. `LEADINTEL_SYNC=off`
     silences it meanwhile. Catching up at boot is deliberate: a process that
     has been down an hour is exactly when the lag matters. */
  /* Definitions live in code, so a version can only be minted by noticing the
     code changed. Reconciling at boot is the earliest honest moment. */
  try {
    const minted = metrics.definitionLog.reconcile({ note: 'reconciled at boot' });
    const edits = minted.filter((m) => m.change === 'redefined');
    if (edits.length) {
      console.log(`metrics: ${edits.length} definition(s) changed since last run`);
      for (const e of edits) console.log(`  ${e.metric} -> v${e.version} (${e.fields.join(', ')})`);
    }
  } catch (err) {
    console.warn('metrics: could not reconcile definition versions —', err.message);
  }

  if (process.env.LEADINTEL_SYNC !== 'off') {
    runner.runDue().catch((err) => console.error('boot sync failed:', err.message));
    runner.start();

    /* Rules ride the sync loop rather than owning a timer: they watch metrics
       computed from ingested data, so there is nothing to re-check until a
       sync has run. `LEADINTEL_ALERTS=off` silences them separately. */
    if (process.env.LEADINTEL_ALERTS !== 'off') {
      const tick = () => {
        try {
          const fired = fireDueRules();
          for (const f of fired) console.log(`rule fired: ${f.name} — ${f.reason}`);
        } catch (err) {
          console.warn('rules: evaluation failed —', err.message);
        }
      };
      const timer = setInterval(tick, 300000);
      if (timer.unref) timer.unref();
      tick();
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`LeadIntel app on http://localhost:${PORT}`);
  });

  /* Graceful shutdown. The sync runner writes JSONL a line at a time, so being
     killed mid-append is survivable — but an in-flight request that is halfway
     through writing a dispatch is not, and a container that kills the process
     after ten seconds will do exactly that. Stop taking new work, let what is
     running finish, then exit. */
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} — finishing in-flight requests`);

      runner.stop();
      server.close(() => {
        console.log('closed cleanly');
        process.exit(0);
      });

      /* A request that never finishes must not hold the process forever. */
      setTimeout(() => {
        console.warn('shutdown timed out — exiting anyway');
        process.exit(1);
      }, 10_000).unref();
    });
  }
}

start();
