/* Routing and composition.
 *
 * This file knows about screens, templates and the URL. It does not know where
 * content comes from: every read goes through the repository (lib/repository),
 * whose static implementation is the only thing that touches `data/`.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { createRepository } = require('./lib/repository');
const { subviewState } = require('./lib/view-state');
const schema = require('./lib/schema');
const ingest = require('./lib/ingest');
const { SyncRunner, RunLog } = require('./lib/ingest/runner');
const httpConnectors = require('./lib/ingest/http');
const backfill = require('./lib/ingest/backfill');
/* Directly, for the account picker — that call is a Connections-screen concern
   rather than part of any sync. */
const googleAds = require('./lib/ingest/http/google-ads');
const filters = require('./lib/filters');
/* The design's own segmented-control colours, so a chip the server builds is
   drawn exactly like the chips the converter emitted. */
const tokens = require('./data/_tokens');
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
const { Connections, stateOf, REQUIREMENTS } = require('./lib/connections');
const ota = require('./lib/ota');
const hardening = require('./lib/http/hardening');
const observability = require('./lib/http/observability');
const store = require('./lib/store');
const snapshot = require('./lib/store/snapshot');
const { Layouts } = require('./lib/layout');

const app = express();
const PORT = process.env.PORT || 3000;

/* Vercel sets VERCEL=1 on every runtime. It decides two things: nothing listens
   on a socket, and the in-process sync timer is not started — see /cron/sync. */
const SERVERLESS = Boolean(process.env.VERCEL);
const repo = createRepository();

/* Phase 9 — the raw store is partitioned per workspace: `var/raw/<workspace>/`.
   Isolation is a property of *where the data is*, not of a filter applied on
   the way out. A tenant with no ingested data gets an empty store rather than
   somebody else's, because there is nothing else in its directory. */
/* Entities for one workspace. Everything downstream — metrics, rules,
   explanations — reads through this, so none of them needs to know tenancy
   exists. The partitioning itself lives in lib/ingest. */

/* Cached per workspace, and this is load-bearing rather than an optimisation.
 *
 * `ingest.snapshot` replays the whole raw store: `readFileSync` plus a
 * `JSON.parse` per line of every `.jsonl` the workspace has, then
 * `canonical.build` over all of it. Synchronously — so it does not merely cost
 * its own time, it **blocks the event loop and serialises every other
 * request behind it**.
 *
 * Uncached, that ran on each of the eleven call sites below, per request. The
 * measured cost on production was 20–56s a page, getting worse as the
 * append-only store grew, and Creative Intelligence was the worst case by
 * construction: its page emits 42 thumbnail URLs, each of which is a request
 * that replayed the entire store again, so one page view queued 42 full
 * replays behind itself and the proxied images timed out into 502s.
 *
 * The repository driver already had exactly this cache (`entities()` in
 * lib/repository/ingested.js) and exactly this invalidation hook; this path
 * simply bypassed both. So the fix is to join the existing seam rather than to
 * invent a second one — `dropEntities` is called wherever `repo.refresh` is.
 *
 * Safe to share the object across requests because nothing mutates it:
 * `period.within` copies (`{...entities}` and `filter`), and every other reader
 * only reads. */
const entityCache = new Map();

/* `connected` retires a source's demo rows once somebody stores a credential
   for it — see lib/ingest/raw-store.js. The metric layer reads through here, so
   it must see the same entities the screens do or a headline could be computed
   over invented rows the table below it no longer shows. */
function snapshotFor(workspaceId) {
  const connected = ingest.liveSources({ connections, workspace: workspaceId, httpConnectors });
  const build = () => ingest.snapshot({ store: ingest.storeFor(workspaceId), connected });

  /* On Postgres the built snapshot is materialised and read back as one
     compressed row — see lib/store/snapshot.js. Replaying 25,000 envelopes to
     draw a dashboard is what exhausted a transfer quota and took the app down;
     a cache in front of it makes that read rarer, not cheaper, and every cold
     instance still paid full price.

     On the file store nothing changes: the replay is a local read, there is no
     transfer to save, and every test exercises this path. */
  if (!store.usingPostgres()) return build();
  return snapshot.through(workspaceId, { connected: [...connected], build });
}

/* Filling the cache is the async half; reading it is not.
 *
 * A Postgres store replays over the network, so the snapshot is a promise. Made
 * `entitiesFor` itself async and the eleven call sites below would each need an
 * await — but two of them are `pipelineState` and `metricValues`, which are
 * called from a dozen more places apiece, and the ripple would have reached most
 * of this file for what is a storage detail.
 *
 * So the resolution happens once, at the request edge, exactly as it does for
 * the document stores: `hydrateEntities` is awaited by the middleware and every
 * synchronous reader afterwards finds a resolved value. */
async function hydrateEntities(workspaceId) {
  if (!shouldRebuild(workspaceId)) return entityCache.get(workspaceId);
  const entities = await snapshotFor(workspaceId);
  entityCache.set(workspaceId, entities);
  staleAt.delete(workspaceId);
  return entities;
}

function entitiesFor(workspaceId) {
  if (!shouldRebuild(workspaceId)) return entityCache.get(workspaceId);

  const entities = snapshotFor(workspaceId);
  /* Against a file store this is already a value and nothing had to be
     hydrated, which is what keeps every existing test and every local run
     working unchanged. Against Postgres, reaching here means the edge did not
     hydrate — a programming error, and one that would otherwise surface as a
     promise being treated as an entity set and every figure reading as empty. */
  if (entities && typeof entities.then === 'function') {
    throw new Error(`entities for "${workspaceId}" were not hydrated for this request`);
  }
  entityCache.set(workspaceId, entities);
  staleAt.delete(workspaceId);
  return entities;
}

/* Dropped on the two events that change what a replay would produce: a sync
   writing new rows, and a credential being stored or removed — the latter
   because `connected` decides whether a source's demo rows are still replayed,
   so connecting a source changes the entities without writing anything. */
/* A write marks the snapshot stale; it does not throw it away.
 *
 * Deleting it outright is correct and was ruinously expensive. `replay()`
 * transfers **every current row's body** — ~25,000 of them once the CRM was
 * backfilled — so a rebuild is tens of megabytes off the database. A backfill
 * writes on every chunk, so thirteen chunks dropped the cache thirteen times
 * and every page view in between paid for a full replay. That is what exhausted
 * the Neon transfer quota and took the whole app down with HTTP 402: not one
 * expensive query, but a cheap one made unboundedly often.
 *
 * So a stale snapshot keeps being served until `MIN_REBUILD_MS` has passed.
 * The cost is freshness measured in minutes on a screen whose sources poll
 * every fifteen; the alternative is a rebuild per write, which is what the
 * quota actually bought. `dropEntities(id, { now: true })` still forces one
 * where a reader must not see stale data — storing a credential changes which
 * demo rows replay, and the operator is looking at the result. */
const MIN_REBUILD_MS = 5 * 60_000;
const staleAt = new Map();

function dropEntities(workspaceId = null, { now = false } = {}) {
  const ids = workspaceId ? [workspaceId] : [...entityCache.keys()];
  for (const id of ids) {
    if (now) { entityCache.delete(id); staleAt.delete(id); continue; }
    if (!staleAt.has(id)) staleAt.set(id, Date.now());
  }
  if (!workspaceId && now) entityCache.clear();
}

/* Whether the snapshot for a workspace should be rebuilt now. */
function shouldRebuild(workspaceId) {
  if (!entityCache.has(workspaceId)) return true;
  const since = staleAt.get(workspaceId);
  return Boolean(since) && Date.now() - since >= MIN_REBUILD_MS;
}

/* Which medium the stores run on is decided once, in lib/store, from whether
   DATABASE_URL is set. Every store takes a `backend` and a null one means "use
   the file path", so a local run and the whole test suite are unaffected. */
const backends = store.backends();

const workspace = new attribution.Workspace(undefined, { backend: backends.docs });
const dispatches = new reports.Dispatches(undefined, { backend: backends.dispatches });
const connections = new Connections({ backend: backends.docs });
/* Which cards each person keeps on each screen — see lib/layout.js. */
const layouts = new Layouts(undefined, { backend: backends.docs });

/* Three stores are constructed inside the modules that own them rather than
   here — the definition log and the evaluation store by lib/metrics, the audit
   log by lib/auth. They are reachable afterwards, and the backend is the only
   thing they need, so it is attached rather than threaded through three
   constructors that exist for other reasons. */
if (store.usingPostgres()) {
  metrics.definitionLog.backend = backends.docs;
  metrics.evaluations.backend = backends.evaluations;
}

/* Which transport each source gets, decided per sync rather than once at boot.
 *
 * A source pulls for real only when **both** halves are present: a stored
 * credential, and a request shape written from that vendor's documentation. Any
 * source missing either keeps reading fixtures, which is why connecting Meta
 * Ads does not disturb the other four — and why storing a TeleCRM key does not
 * silently make its screens go empty.
 *
 * `LEADINTEL_TRANSPORT` still overrides everything, so a run can be forced onto
 * fixtures or onto http wholesale for testing.
 */
function transportFor(sourceId) {
  const forced = process.env.LEADINTEL_TRANSPORT;
  if (forced) {
    return ingest.createTransport(forced, {
      credentials: connections.secretsFor(SYNC_WORKSPACE, sourceId),
    });
  }

  if (!httpConnectors.has(sourceId)) return ingest.createTransport('fixture');

  const credentials = connections.secretsFor(SYNC_WORKSPACE, sourceId);
  if (!credentials) return ingest.createTransport('fixture');

  return ingest.createTransport('http', { credentials });
}

/* The sync loop serves one workspace, as it has since it was written — the
   store it was given is that workspace's. Named rather than repeated, so the
   assumption is visible instead of appearing three times as a literal. */
const SYNC_WORKSPACE = 'parakkat';

/* How much history a scheduled pull asks for.
 *
 * It used to ask for none, and a connector with no window falls back to its own
 * cheap default — Meta's is `date_preset=last_30d`. That was invisible until the
 * date-range chips started working: the store had never held more than thirty
 * days, so **"90d" silently meant "everything we happen to have"** and read only
 * ₹11,930 above the 30-day figure. A period control is worthless if the store
 * cannot answer the longest period it offers.
 *
 * So the window is stated here rather than inherited: the *product* decides what
 * history its screens need, and the connector's default goes back to being what
 * it says it is — a cheap connection test. Re-pulling the same days every cycle
 * is safe because the raw store keys rows by external id and a repeat is a
 * no-op; it costs requests, not correctness. */
const SYNC_LOOKBACK_DAYS = 90;

/* Half-open, and `to` is the start of *tomorrow* — deliberately. Meta's `until`
   is inclusive and `timeRange()` steps `to` back a day to bridge the two, so a
   `to` of "now" would ask for everything up to yesterday and today's spend
   would never arrive. The "Today" chip would then read ₹0 for ever, which is
   the same class of quiet wrongness this window exists to fix. */
/* How far back a *refresh* asks, once a source has pulled successfully before.
 *
 * The 90-day window above is what the period control needs the store to be able
 * to answer, and it is the right ask exactly once — on a source's first pull.
 * Asking for it every time is what made the sync exceed a serverless function's
 * 60-second ceiling: Meta pages ad-level insights 100 rows at a time, so 90 days
 * across six kinds is dozens of round trips, repeated in full every cycle to
 * re-fetch days that had already been stored.
 *
 * A refresh only has to cover what can still change. Meta restates recent days
 * as attribution windows close, so a fortnight is generous; anything older is
 * already in the store and the store never forgets. The 90-day chip keeps
 * working because history accumulates rather than being re-fetched. */
const SYNC_REFRESH_DAYS = 14;

/* Set per request by /cron/sync?days=N. A module-level latch rather than a
   threaded argument because the window function is handed to SyncRunner at
   construction and reaches runOne through it; cleared in a finally so one
   forced backfill cannot widen every later tick. */
let FORCED_DAYS = null;

/* An explicit window, for a backfill that cannot be expressed as "the last N
   days". `days=N` always ends at today, so widening it re-fetches everything
   already held and the invocation gets longer every time — which is exactly how
   a 30-day TeleCRM backfill hit the function ceiling twice, since its API caps
   a page at 100 rows and this account creates ~260 leads a day. Chunking
   backwards a week at a time is bounded work per call, and the raw store
   deduplicates the overlaps. Same latch discipline as FORCED_DAYS. */
let FORCED_WINDOW = null;

/* How long /cron/sync keeps starting new sources. Well under the 60s function
   ceiling declared in vercel.json, because the check happens before a source
   starts and the source that follows it still needs room to finish. */
const SYNC_BUDGET_MS = 40_000;

/* How often /cron/sync is genuinely called, in seconds — a fact about the
   deployment, so it is read from the deployment. Vercel Hobby allows one cron a
   day and vercel.json asks for `0 2 * * *`, so production sets 86400 and every
   source stops being reported down for missing a 15-minute cadence nothing can
   offer. Point a more frequent caller at the route and lower this with it; left
   unset, health is judged exactly as it always was. */
const SYNC_EVERY = Number(process.env.LEADINTEL_SYNC_EVERY) || null;

function syncWindow(now = new Date(), sourceId = null) {
  if (FORCED_WINDOW) return FORCED_WINDOW;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  /* A source that has never succeeded has nothing stored, so it gets the full
     history. One that has is only catching up. */
  /* Backfilled means "has real history", and a **fixture** run is not that.
   *
   * This read `lastSuccess` alone, and a fixture sync counts as a success — so
   * a source whose only prior run replayed fixtures was treated as already
   * backfilled and its first live pull asked for a fortnight instead of ninety
   * days. Meta went live holding 13 days, which made every 30-day figure on the
   * dashboard short without anything reporting an error. */
  const last = sourceId ? runner.log.lastSuccess(sourceId) : null;
  const backfilled = Boolean(last && last.transport && last.transport !== 'fixture');
  /* Overridable, so a source that was short-changed once can be refilled
     without waiting for a first pull it has already had. */
  const days = FORCED_DAYS || (backfilled ? SYNC_REFRESH_DAYS : SYNC_LOOKBACK_DAYS);
  return {
    from: new Date(midnight - (days - 1) * 86400000).toISOString(),
    to: new Date(midnight + 86400000).toISOString(),
  };
}

const runner = new SyncRunner({
  store: ingest.storeFor(SYNC_WORKSPACE),
  log: new RunLog(undefined, { backend: backends.runs }),
  transportFor,
  window: syncWindow,
  scheduledEvery: SYNC_EVERY,
  /* The ingested driver caches its snapshot of the raw store, so newly synced
     records are invisible to every screen until something drops that cache.
     Dropped here, on write, rather than per request: replaying the whole store
     on each page load would put the p95 budget out of reach for no benefit
     between syncs. */
  onWrite: () => {
    if (typeof repo.refresh === 'function') repo.refresh();
    /* The same staleness, one layer up. `entitiesFor` is what the metric layer,
       the rules and the creative routes read through, and it cached nothing —
       so before this the screens were fresh on write and everything computed
       *about* them was replayed per request. */
    dropEntities(SYNC_WORKSPACE);
  },
});
const reasoner = createReasoner();
const fires = new FireLog(undefined, { backend: backends.fires });

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
/* ── the date range control ─────────────────────────────────────────────────
 *
 * The chips were authored markup with no behaviour: `data/_shell.js` gave each
 * one a colour and the topbar rendered `data-action=""`, so clicking 7d did
 * nothing at all and the screen carried on showing every record the store held
 * under a highlighted "30d". Decoration that looks like a control is worse than
 * no control — it answers a question the reader asked, wrongly.
 *
 * The mechanism already existed on the metric side: a period narrows the
 * entities and the whole dependency graph narrows with them. So this is a
 * matter of reading the choice off the URL and handing it to both readers —
 * the registry and the repository — rather than of computing anything new.
 */
const PERIOD_CHIPS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  /* Calendar windows beside the rolling ones. A month-on-month comparison is
     the question every operator actually asks, and a rolling 30 days cannot
     answer it — it straddles two months for all but one day of the year. */
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'this-year', label: 'This year' },
];

/* Matches the chip the design draws as selected. Stated once: the default and
   the highlight have to agree or the screen lies on first load. */
const DEFAULT_PERIOD = '30d';

/* The clock is read here, at the edge, and nowhere inside the metric layer —
   6.2's reproducibility rests on evaluation being a pure function of what it
   is given. An unknown period falls back rather than throwing: it arrives from
   a URL, and a hand-edited query string should not be a 500. */
function periodFor(query) {
  /* A custom range from the date control, which the four chips cannot express.
     Parsed in lib/metrics/period.js, where the half-open rule lives. */
  const custom = metrics.period.fromRange((query || {}).from, (query || {}).to);
  if (custom) return { id: 'custom', over: custom };

  const wanted = String((query || {}).period || DEFAULT_PERIOD);
  const id = PERIOD_CHIPS.some((c) => c.id === wanted) ? wanted : DEFAULT_PERIOD;
  try {
    return { id, over: metrics.period.fromLabel(id, new Date().toISOString()) };
  } catch (err) {
    return { id: DEFAULT_PERIOD, over: null };
  }
}

/* `over` travels with the read so the repository narrows the same rows the
   registry does. Named apart from the raw `period` string the URL carries,
   because one is a label and the other is a resolved window. */
const readParams = (query) => ({ ...(query || {}), model: workspace.model(), over: periodFor(query).over });

/* Every KPI card a screen offers, flattened for the edit panel.
 *
 * Read from the resolved payload rather than from the view, so the panel lists
 * exactly what the screen would draw — including cards the reader has hidden,
 * which is the whole point of a panel they use to bring one back. The
 * collection travels with each card because two collections can hold a card of
 * the same name and the reader should be able to tell them apart. */
function offeredCards(payload) {
  const cards = [];
  for (const [collection, rows] of Object.entries(payload || {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (!('label' in row) || !('value' in row)) continue;
      const id = row.metric || row.label;
      if (!id) continue;
      cards.push({ id, label: row.label, collection, source: row.src || null });
    }
  }
  return cards;
}

/* A screen may declare the grain its KPI cards are about — Campaign Analytics'
   drill-down is one campaign, not the workspace — and the registry is then
   evaluated there. See lib/metrics/scope.js. */
function resolveMetrics(payload, workspaceId, over = null, { hidden = null, editing = false } = {}) {
  const at = payload && payload.metricScope ? payload.metricScope : null;
  /* Evaluated over the selected range. A card that names its own period —
     "New leads today" — still carries that period through `valuesFor`, and
     keeps it: a card about today does not become a card about 90 days
     because the chip above it moved. */
  const { values, notApplicable } = metricValues(workspaceId, at, over);
  /* The same metrics over the window immediately before this one, which is what
     the topbar's "vs previous period" has always claimed and nothing computed.
     `metricValues` is cached per window, so this is one extra evaluation per
     distinct range rather than one per request. */
  const back = metrics.period.previous(over);
  const previous = back ? metricValues(workspaceId, at, back).values : null;

  /* The same metrics with no grain applied, for cards marked `unscoped`. Free
     when the screen has no scope — it is the identical cache entry — and one
     extra evaluation per range when it does. */
  const base = at ? metricValues(workspaceId, null, over) : { values, notApplicable };
  const basePrevious = at && back ? metricValues(workspaceId, null, back).values : previous;

  return resolve.resolve(payload, {
    values,
    notApplicable,
    previous,
    baseValues: base.values,
    basePrevious,
    scoped: Boolean(at),
    at,
    hidden,
    editing,
    useRegistryValues: USE_REGISTRY_VALUES,
    valuesFor: (label) => periodValues(workspaceId, label, at),
    /* A card's own grain overrides the screen's. The dashboard is a workspace
       screen carrying two tiles about one channel each, so the narrowing has to
       come from the card rather than the payload. `metricValues` is keyed by
       grain *and* window, so the two extra tiles cost two cached evaluations
       per range, not two per request. */
    valuesAt: (cardAt, label) => (label
      ? periodValues(workspaceId, label, cardAt)
      : {
        ...metricValues(workspaceId, cardAt, over),
        previous: back ? metricValues(workspaceId, cardAt, back).values : null,
      }),
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
  /* Keyed by the window's *bounds*, never by its label. It used to prefer the
     label, which is fine while every label names one window and silently wrong
     the moment two do not: every range from the date picker was labelled
     "custom", so June and July shared a cache entry and the second one asked
     for answered with the first one's figures — to the rupee, which is exactly
     how it looked correct. A window is its bounds; the label is a caption. */
  const key = `${workspaceId}|${at ? `${at.dimension}:${at.value}` : ''}|${over ? `${over.from}..${over.to}` : ''}`;
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
    const over = metrics.period.fromLabel(label, new Date().toISOString());
    const back = metrics.period.previous(over);
    return {
      ...metricValues(workspaceId, at, over),
      /* A card naming its own window is compared against the window before its
         own, not against the screen's range. */
      previous: back ? metricValues(workspaceId, at, back).values : null,
    };
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

/* Assets carry a fingerprint of their own contents.
 *
 * They used to be served with a flat one-hour max-age and no fingerprint,
 * reasoned as "short enough to be safe". It is not: for an hour after every
 * deploy a returning browser keeps running the *previous* JavaScript, so a
 * fix ships, the server serves it, and the person looking at the page still
 * has the broken version — with nothing on screen to say so. That is exactly
 * how the new date picker reached production and stayed invisible.
 *
 * The hash is of the file, so the URL changes when and only when the file does.
 * `express.static` ignores the query string, so this needs nothing of it.
 */
const ASSETS = path.join(__dirname, 'public', 'assets');

function fingerprint(name) {
  try {
    const body = fs.readFileSync(path.join(ASSETS, name));
    return crypto.createHash('sha1').update(body).digest('hex').slice(0, 8);
  } catch (err) {
    /* A missing asset is the view's problem to show, not a reason not to boot. */
    return '0';
  }
}

const assetVersions = new Map();
/* Available to every render: Express merges `app.locals` into view locals, so
   the layout does not have to be handed this by each of the routes. */
app.locals.asset = (name) => {
  if (!assetVersions.has(name)) assetVersions.set(name, fingerprint(name));
  return `/assets/${name}?v=${assetVersions.get(name)}`;
};

app.use('/assets', express.static(ASSETS, {
  /* Safe to cache hard now that the URL changes with the file. A request for a
     version that is current cannot be stale by construction. */
  maxAge: '30d',
}));

/* Phase 9. Everything past this line needs a session, and `req.workspace` comes
   from that session rather than from the request — a caller cannot reach
   another tenant's data by changing a parameter, because there is no parameter.
   `LEADINTEL_AUTH=off` disables the gate for local work on the screens; it is
   refused outright in production below. */
/* The audit log gets the same treatment as the other stores. Constructed here
   rather than defaulted inside auth.create so it can carry a backend. */
const gatekeeper = auth.create({
  audit: new auth.AuditLog(undefined, { backend: backends.audit }),
  /* Sessions move off the in-process Map for the same reason as everything
     else: a session minted on one serverless instance is unknown to the next,
     which the user experiences as being signed out at random. */
  store: new authSessions.Sessions({ backend: backends.sessions }),
});
const AUTH_OFF = process.env.LEADINTEL_AUTH === 'off';

/* Bearer credentials for the sources that push. Separate from `connections`,
   which holds credentials this app presents *outward*; these are the ones it
   accepts *inward*, and they are hashed rather than encrypted because they are
   only ever checked. */
const webhookTokens = new auth.webhooks.Webhooks({ backend: backends.docs });

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
  async (req, res) => {
  const body = req.body || {};
  const user = auth.identity.authenticate(body.user, body.password);
  const wantsHtml = (req.get('accept') || '').includes('text/html');

  if (!user) {
    gatekeeper.audit.record({ user: null, action: 'auth.login', outcome: 'refused', workspace: null, detail: { attempted: body.user || null } });
    if (wantsHtml) return res.redirect(303, `/login?error=${encodeURIComponent('That username and password do not match.')}`);
    return res.status(401).json({ error: 'that username and password do not match' });
  }

  /* Awaited: the Postgres session store returns a promise here. A cookie set
     before the row lands would be a session the next request cannot find.
     Caught explicitly because Express 4 does not catch a rejection out of an
     async handler — it would take the process down rather than answer. */
  let session;
  try {
    session = await gatekeeper.sessions.create(user);
  } catch (err) {
    console.error('login: the session store refused a write —', err.message);
    if (wantsHtml) return res.redirect(303, `/login?error=${encodeURIComponent('Sign-in is unavailable right now.')}`);
    return res.status(503).json({ error: 'the session store is unavailable' });
  }
  res.setHeader('Set-Cookie', authSessions.cookieHeader(session.cookie, { secure: TLS }));
  gatekeeper.audit.record({ user, action: 'auth.login', outcome: 'allowed', workspace: user.workspace });

  if (wantsHtml) return res.redirect(303, typeof body.next === 'string' && body.next.startsWith('/') ? body.next : '/');
  return res.json({ user });
});

app.post('/logout', async (req, res) => {
  /* A failed delete must still clear the cookie — leaving somebody signed in
     because the store was unreachable is the wrong way to fail. */
  try {
    await gatekeeper.sessions.destroy(authSessions.fromRequest(req));
  } catch (err) {
    console.error('logout: the session store refused a delete —', err.message);
  }
  res.setHeader('Set-Cookie', authSessions.clearHeader());
  if ((req.get('accept') || '').includes('text/html')) return res.redirect(303, '/login');
  return res.json({ ok: true });
});

/* ── Webhook intake ──────────────────────────────────────────────────────────
 *
 * Registered **before** the session gate, because that gate is precisely what
 * made this route unreachable by any real source. A delivery authenticates with
 * a webhook token instead (lib/auth/webhooks.js), which carries its own
 * workspace and source — so `req.workspace` still does not come from the
 * request, it comes from the credential.
 *
 * A request with no token falls through untouched, which leaves the original
 * session-gated route below working for a signed-in Owner testing by hand.
 */
app.post('/ingest/webhook/:source', express.json({ limit: '1mb' }), async (req, res, next) => {
  /* Header first; `?token=` second, because some senders cannot set headers on
     an outbound hook and a credential in a query string is worth supporting
     while saying it is the weaker of the two. */
  const header = req.get('authorization') || '';
  const presented = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : (req.query.token || '');

  if (!presented) return next();

  /* Hydrated here, because this route runs BEFORE the request-edge middleware
     that hydrates everything else — it has to, since it authenticates by token
     rather than session and must not sit behind the session gate.
   *
   * On a file store that middleware's absence cost nothing and this route
   * worked. On Postgres it meant `webhookTokens` was an empty in-memory map on
   * every fresh instance, so a token minted seconds earlier came back
   * "not recognised" and the whole push intake had never once worked on
   * Vercel. The audit trail said the tokens were unverifiable, which reads like
   * a forged credential rather than an unread store. */
  await webhookTokens.hydrate();

  const claim = webhookTokens.verify(presented);
  if (!claim) {
    /* Audited with no user, because there is no user — an unverifiable token is
       exactly the event somebody would want to find later. */
    gatekeeper.audit.record({
      user: null,
      action: 'ingest.webhook',
      outcome: 'refused',
      workspace: null,
      detail: { source: req.params.source, reason: 'unverifiable webhook token' },
    });
    return res.status(401).json({ error: 'webhook token not recognised' });
  }

  /* A token is minted for one source. Posting it to another source's intake is
     refused rather than accepted under the token's own source, which would let
     one credential write records it was never issued for. */
  if (claim.source !== req.params.source) {
    gatekeeper.audit.record({
      user: null,
      action: 'ingest.webhook',
      outcome: 'refused',
      workspace: claim.workspace,
      detail: { source: req.params.source, reason: `token is for ${claim.source}` },
    });
    return res.status(403).json({ error: `this token is for ${claim.source}, not ${req.params.source}` });
  }

  try {
    const result = await ingest.receive(req.params.source, req.body, {
      store: ingest.storeFor(claim.workspace),
    });
    webhookTokens.recordDelivery(claim.id, { records: result && result.received });
    gatekeeper.audit.record({
      user: null,
      action: 'ingest.webhook',
      outcome: 'allowed',
      workspace: claim.workspace,
      detail: { source: req.params.source, received: result && result.received },
    });
    /* Awaited before answering, because a function is frozen the moment it
       responds — the delivery count would be stranded in a promise that never
       settles, and the Connections card would go on saying "stored, no data
       yet" while records were arriving. Same reason `gate()` does it for every
       session-authenticated write. */
    await webhookTokens.flush();
    return res.json(result);
  } catch (err) {
    /* Still counted as a delivery: a source that is reaching us with a payload
       we cannot read is a different problem from one that is not reaching us at
       all, and the Connections screen has to be able to say which. */
    webhookTokens.recordDelivery(claim.id, { records: 0 });
    await webhookTokens.flush();
    return res.status(400).json({ error: err.message });
  }
});

/* The sync, driven from outside the process.
 *
 * `runner.start()` is a setInterval, which needs a process that stays alive
 * between requests. A serverless function does not: it is frozen the moment it
 * answers, so the timer either never fires or fires inside an unrelated
 * request. Vercel Cron calls this instead, on the schedule in vercel.json.
 *
 * Registered before the session gate and authenticated by a shared secret,
 * because the caller is a scheduler and has no session. Vercel presents
 * `Authorization: Bearer $CRON_SECRET`; the comparison is timing-safe and a
 * missing secret refuses rather than defaulting open — an unauthenticated route
 * that makes the app talk to Meta and write to the store is not something to
 * leave to a truthy check.
 *
 * The staleness logic is untouched: `due()` still decides, so a tick that
 * arrives early does nothing and one that arrives after downtime catches up.
 *
 * **The schedule in vercel.json is daily, and that is not the intended
 * cadence.** Vercel's Hobby plan refuses any cron more frequent than once a day
 * — it rejects the deploy outright rather than downgrading it quietly. The
 * sources still declare a 15-minute SLA and `due()` still enforces it, so the
 * schedule is a floor on how often the app is *asked*, not a change to what it
 * considers stale. Anything holding CRON_SECRET can call this route as often as
 * the SLA actually wants: an external scheduler, or Vercel Pro.
 */
/* GET as well as POST: Vercel Cron issues a GET. */
app.all('/cron/sync', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set — the sync cannot be driven' });

  const presented = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'not authorised' });
  }

  try {
    /* The scheduler's request does not pass through the hydration middleware —
       it has no session and no workspace — so the two stores this needs are
       filled here: the run log to know what is due, and the credentials to pull
       with. */
    await Promise.all([
      runner.log.hydrate(),
      store.hydrateDocuments({ connections, workspace, webhookTokens, definitionLog: metrics.definitionLog }),
    ]);

    /* As many due sources as fit the invocation, not all eleven and not one.
     *
     * `runDue()` walks every due source in turn, which is right for a process
     * that owns its own time and wrong for a function with a hard 60-second
     * ceiling — the first full run hit it and returned nothing at all, having
     * done real work. So this took exactly one source, which was bounded but
     * starved the queue: on a daily cron every source is due at every tick, so
     * "the first due source" was the same one every day and the other ten never
     * synced from the schedule at all.
     *
     * `runner.due()` now returns most-starved-first, so taking what fits is
     * fair over time. The budget is wall-clock: keep starting sources while
     * there is comfortably room for another, and stop before the platform kills
     * the invocation mid-write. `remaining` still tells a caller to come back.
     *
     * `?source=` targets one directly, which is what makes a first backfill
     * drivable by hand, and `?only=N` caps the drain for a caller that would
     * rather come back often than run long. */
    const due = runner.due();
    /* A named source with an explicit window is a backfill, and due-ness is not
       the question — it asks about *staleness*, and a chunk of March is not
       stale because a chunk of April was fetched a minute ago. Without this the
       second chunk of any backfill answers `ran: 0` and the operator has to
       wait out a cadence between every call. A named source with no window is
       still gated, so this cannot become a way to hammer a vendor. */
    const backfilling = Boolean(req.query.source && (req.query.from || req.query.days));
    const wanted = req.query.source
      ? (backfilling
        ? ingest.sources.list().filter((s) => s.id === req.query.source)
        : due.filter((s) => s.id === req.query.source))
      : due;

    const asked = Number(req.query.days);
    FORCED_DAYS = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 400) : null;

    /* An explicit window wins over a day count — a caller that names both meant
       the specific one. Both bounds are required and must parse, because half a
       window silently becoming "the default" is the kind of backfill that looks
       done and is not. */
    const from = Date.parse(req.query.from);
    const to = Date.parse(req.query.to);
    if (req.query.from || req.query.to) {
      if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
        return res.status(400).json({ error: 'from and to must both be parseable dates with from before to' });
      }
      FORCED_WINDOW = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    }

    const cap = Number(req.query.only);
    const limit = Number.isFinite(cap) && cap > 0 ? cap : wanted.length;
    const startedAt = Date.now();

    const runs = [];
    try {
      for (const source of wanted) {
        if (runs.length >= limit) break;
        /* Checked before starting, never mid-source: a pull that is cut off
           part way writes some kinds and not others, and a partial sync that
           reports success is worse than one that never ran. A forced backfill
           is the expensive case, so it gets the whole budget to itself. */
        if (runs.length && Date.now() - startedAt > SYNC_BUDGET_MS) break;
        runs.push(await runner.runOne(source.id));
        if (FORCED_DAYS || FORCED_WINDOW) break;
      }
    } finally {
      FORCED_DAYS = null;
      FORCED_WINDOW = null;
    }
    await runner.log.flush();

    return res.json({
      ran: runs.length,
      due: due.length,
      remaining: Math.max(0, due.length - runs.length),
      runs: runs.map((r) => ({
        source: r.source, ok: r.ok, pulled: r.pulled, written: r.written,
        partialFailures: r.partialFailures || [], error: r.error || null,
      })),
    });
  } catch (err) {
    console.error('cron sync failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
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

/* Pull this request's state out of Postgres before anything reads it.
 *
 * Every store below keeps its reads synchronous — that is what let the storage
 * move happen without rewriting the metric layer, the scheduler and their
 * tests — and the price is that something has to fill them first. This is that
 * something, and it sits here because `req.workspace` is set by the middleware
 * immediately above and nothing workspace-scoped is served before it.
 *
 * **Per request, not per process.** A serverless instance handles one request
 * and may never handle another, and the next one may be a different instance
 * entirely. A credential saved on one and cached in another's memory is
 * invisible to it — the user stores a key and the Connections screen goes on
 * saying it is not configured.
 *
 * Concurrently, so this costs one round trip of latency rather than seven. The
 * document stores collapse into a single query between them.
 *
 * Against a file store this is a no-op: every `hydrate` returns immediately and
 * the synchronous file reads happen as they always did. */
app.use((req, res, next) => {
  if (!store.usingPostgres() || !req.workspace) return next();

  Promise.all([
    store.hydrateDocuments({ connections, workspace, webhookTokens, definitionLog: metrics.definitionLog }),
    runner.log.hydrate(),
    layouts.hydrate(),
    gatekeeper.audit.hydrate(),
    fires.hydrate(),
    dispatches.hydrate(),
    metrics.evaluations.hydrate(),
    hydrateEntities(req.workspace),
    /* The repository keeps its own snapshot — the screens read through it while
       the metric layer reads through `entitiesFor` — so it hydrates too. */
    typeof repo.hydrate === 'function' ? repo.hydrate() : null,
  ]).then(() => next(), next);
});

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
    /* Into the caller's own workspace store. Omitting this wrote deliveries to
       the root of `var/raw/` — the directory that *contains* the tenants — so
       the records landed nowhere any screen reads and the delivery still
       answered 200. The token-authenticated route above had to get this right
       to work at all; this one was quietly wrong. */
    res.json(await ingest.receive(req.params.source, req.body, {
      store: ingest.storeFor(req.workspace),
    }));
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

/* Connections — where a credential goes. The design draws no integrations
   screen, so until this existed there was nowhere to put a token and every
   connector read fixtures. Owner only: a credential can read a whole external
   system. */
async function renderConnections(req, res, {
  error = null, saved = null, mintedToken = null, errorSource = null, accounts = null, before = null,
} = {}) {
  const screen = (await repo.screens()).find((s) => s.slug === 'connections');

  /* The base a source should post to. Taken from the platform's own domain
     where it publishes one, because telling somebody to point TeleCRM at
     `localhost` is telling them to point it at TeleCRM's own server. */
  const publicBase = process.env.LEADINTEL_PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

  /* The sync loop serves one workspace, so its run log describes that
     workspace's syncs and nobody else's. Shown only there: rendering it for a
     second tenant would put one workspace's connector health on another's
     screen, which is both wrong and a leak. That tenant sees exactly what it
     saw before — webhook deliveries and nothing more. */
  const syncing = req.workspace === SYNC_WORKSPACE;
  const status = syncing ? new Map(runner.status().map((s) => [s.source, s])) : new Map();

  res.render('layout', {
    screen,
    screens: await repo.screens(),
    shell: await shellData('connections', req.query, req.path, req.workspace, req.user),
    hasView: false,
    data: {
      connections: connections.list(req.workspace).map((c) => {
        const webhook = webhookTokens.describe(req.workspace, c.source);
        const sync = status.get(c.source) || null;
        return {
          ...c,
          /* Which sources can be *pushed to* at all. A poll-only source has no
             intake, and offering a webhook URL for one would be an invitation to
             configure something that can never fire. */
          streams: (ingest.sources.get(c.source) || {}).cadence
            ? ingest.sources.get(c.source).cadence.mode === 'stream'
            : false,
          webhook,
          webhookUrl: publicBase ? `${publicBase}/ingest/webhook/${c.source}` : null,
          /* What the pipeline knows about this source, brought to the screen
             where somebody would act on it. Derived here rather than in the
             template so the rule has a test. */
          sync,
          ...stateOf({ configured: c.configured, readable: c.readable, webhook, sync }),
        };
      }),
      publicBase,
      /* Shown once, immediately after minting, and never retrievable again. */
      mintedToken,
      errorSource,
      /* The account list, only for the source it was fetched for. */
      accounts,
      before,
      workspaceName: auth.identity.workspace(req.workspace).name,
      canManage: auth.permissions.can(req.user, 'connection.manage'),
      secretSet: Boolean(process.env.LEADINTEL_SECRET),
      error,
      saved,
    },
    drawer: null,
    palette: await palette(),
    notifications: notifications(req.workspace),
    filterData: filterData(null),
    filterNote: null,
    attrPreview: null,
  });
}

app.get('/connections', (req, res, next) => {
  renderConnections(req, res, {
    error: req.query.error || null,
    saved: req.query.saved || null,
    errorSource: req.query.source || null,
    /* Where a part-finished backfill stopped, so the button continues rather
       than starting the year again. */
    before: req.query.before || null,
  }).catch(next);
});

/* Every control on the Connections screen posts to `/connections/:source`, and
   a person who has just saved a credential there reasonably tries to go back to
   it — from history, from a bookmark, or by typing what the form's action said.
   There was no GET, so the URL fell to the not-found handler. It is the one
   screen the source is a part of, so it answers by opening that source on it
   rather than by saying the address does not exist. */
app.get('/connections/:source', (req, res) =>
  res.redirect(`/connections?source=${encodeURIComponent(req.params.source)}`));

app.post('/connections/:source',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'set' })),
  async (req, res, next) => {
    const source = req.params.source;
    try {
      /* A blank field means "keep what is stored" rather than "clear it", so
         updating one credential does not silently wipe the others. */
      const existing = connections.secretsFor(req.workspace, source) || {};
      const merged = { ...existing };
      for (const [key, value] of Object.entries(req.body || {})) {
        if (String(value || '').trim()) merged[key] = String(value).trim();
      }

      /* Every redirect out of a POST here is an explicit 303.
       *
       * `res.redirect` defaults to 302, and a 302 answering a POST leaves the
       * method up to the client. Vercel returns it as 307, which *preserves*
       * the method — so the browser re-POSTed to /connections, a path with no
       * POST route, and got a 404. The credential form looked simply broken:
       * no Connections screen, no error, nothing saved, and the redirect that
       * was carrying the explanation never rendered.
       *
       * 303 See Other is what POST-redirect-GET has always wanted — it tells
       * the client to GET the target — and it is correct on every platform
       * rather than a workaround for this one. */
      connections.set(req.workspace, source, merged, { by: req.user.name });
      /* Awaited before answering, and this is the whole reason `flush` exists.
         The write is issued by a synchronous method; a serverless function is
         frozen the moment it responds, so redirecting first can strand the
         credential in a promise that never settles — the user pastes a token,
         is told it was saved, and the next request finds nothing there. */
      await connections.flush();
      /* Connecting a source retires its demo rows, so the entities change
         without a sync having written anything — and the operator is looking
         straight at the result, so this one rebuilds immediately. */
      dropEntities(req.workspace, { now: true });
      return res.redirect(303, `/connections?saved=${encodeURIComponent(`${source} saved. The credential is encrypted and will not be shown again.`)}`);
    } catch (err) {
      /* The message names the field and what the value looked like — never the
         value itself, which must not travel in a URL. */
      return res.redirect(303, `/connections?source=${encodeURIComponent(source)}&error=${encodeURIComponent(err.message)}`);
    }
  });

/* Which accounts a stored credential can reach.
 *
 * The customer id is the one field on this screen with no feedback: a wrong
 * ten-digit number authenticates perfectly and then fails on every pull, which
 * reads as a broken connector rather than a typo. Google will say which
 * accounts the credential can see, so the screen asks it and offers the answer.
 *
 * Behind a button rather than fetched on render: it is a network round trip per
 * account, and a page that silently calls a vendor on every load is a page that
 * gets slow for reasons nobody can see. */
app.post('/connections/:source/accounts',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'list-accounts' })),
  async (req, res, next) => {
    const source = req.params.source;
    if (source !== 'google_ads') {
      return renderConnections(req, res, { error: `${source} does not publish an account list.` }).catch(next);
    }

    const credentials = connections.secretsFor(req.workspace, source);
    if (!credentials) {
      return renderConnections(req, res, {
        error: 'Save the OAuth credentials first — the account list is fetched with them.',
        errorSource: source,
      }).catch(next);
    }

    try {
      const accounts = await googleAds.accessibleCustomers(credentials);
      return renderConnections(req, res, {
        accounts: { source, list: accounts },
        saved: accounts.length
          ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} reachable with this credential.`
          : 'These credentials can reach no accounts at all.',
      }).catch(next);
    } catch (err) {
      return renderConnections(req, res, { error: err.message, errorSource: source }).catch(next);
    }
  });

app.post('/connections/:source/remove',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'remove' })),
  async (req, res) => {
    connections.remove(req.workspace, req.params.source);
    await connections.flush();
    /* Disconnecting puts the source's fixtures back into the replay, which is
       the same change in the other direction. */
    dropEntities(req.workspace, { now: true });
    return res.redirect(303, `/connections?saved=${encodeURIComponent(`${req.params.source} disconnected — it will read fixtures again.`)}`);
  });

/* Tests the credential by asking the live transport for one record. It throws
   with its reason until a connector for that source is written, which is the
   honest answer: a stored key and a working connector are different things. */
app.post('/connections/:source/test',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'test' })),
  async (req, res) => {
    const source = req.params.source;
    let result;
    try {
      const credentials = connections.secretsFor(req.workspace, source);
      if (!credentials) throw new Error('no credential stored');
      const transport = ingest.createTransport('http', { credentials });
      const rows = await transport.fetch({ source: ingest.sources.get(source), kind: ingest.sources.get(source).kinds[0], window: null });
      result = { ok: true, detail: `${rows.length} record(s) returned` };
    } catch (err) {
      result = { ok: false, detail: err.message };
    }
    connections.recordTest(req.workspace, source, result);
    await connections.flush();
    const query = `${result.ok ? 'saved' : 'error'}=${encodeURIComponent(`${source}: ${result.detail}`)}`;
    return res.redirect(303, `/connections?source=${encodeURIComponent(source)}&${query}`);
  });

/* Which cards this person keeps on a screen.
 *
 * Not gated by `connection.manage` or anything else: it changes what one reader
 * sees and nothing about what anything means. The session is the whole of the
 * authorisation, and the workspace and user come from it rather than the form —
 * the same rule that keeps `?workspace=` from existing anywhere in this app.
 */
app.post('/layout/:screen', express.urlencoded({ extended: false }), async (req, res) => {
  const screen = String(req.params.screen || 'dashboard');
  /* An unticked checkbox submits nothing, so the form carries what was offered
     as well as what was kept — otherwise "unticked" and "not on this form" are
     the same absence. */
  const offered = [].concat(req.body.offered || []);
  const visible = [].concat(req.body.visible || []);

  /* Wrapped, because Express 4 answers a rejected async handler by never
     answering: a thrown error here hung the request for a full minute instead
     of failing. A layout that will not save is worth an error; it is not worth
     a page that never loads. */
  try {
    layouts.set(req.workspace, req.user && req.user.id, screen, { offered, visible });
    await layouts.flush();
  } catch (err) {
    console.warn('layout: could not be saved —', err.message);
    return res.status(500).json({ error: `the layout could not be saved: ${err.message}` });
  }

  gatekeeper.audit.record({
    user: req.user, action: 'layout.set', outcome: 'allowed', workspace: req.workspace,
    detail: { screen, hidden: offered.length - visible.length },
  });

  /* Back where they were, still editing, so several changes are one visit. */
  const back = String(req.body.back || `/${screen === 'dashboard' ? '' : screen}`);
  return res.redirect(303, back.startsWith('/') ? back : '/');
});

/* Fetch a year of history for one source, from the screen.
 *
 * Backfills were a curl with the cron secret, which is fine for me and not a
 * feature. The reason it needed one at all is that a wide window cannot be
 * asked for in a single request: TeleCRM caps a page at 100 rows and this
 * workspace creates ~260 leads a day, so a year is thousands of sequential
 * round trips against a 60-second function ceiling. Two attempts at
 * `days=365` simply timed out.
 *
 * So this walks **backwards a week at a time** and stops when the invocation
 * budget is nearly spent, reporting the date it reached. Pressing the button
 * again continues from there — the `before` field carries the position, and
 * the raw store deduplicates the overlap, so a double press costs time and
 * never correctness.
 */
app.post('/connections/:source/backfill',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'backfill' })),
  async (req, res) => {
    const source = req.params.source;
    const definition = ingest.sources.get(source);
    if (!definition) return res.redirect(303, `/connections?error=${encodeURIComponent(`unknown source "${source}"`)}`);

    /* Where this press starts and where the whole walk ends — see
       lib/ingest/backfill.js, which owns the one property that matters here
       and states why it was wrong. `before` is the cursor the last press
       handed back, so a second press does not re-fetch what the first got. */
    const { asked, floor, cursor: from } = backfill.plan({ before: req.body.before, days: req.body.days });
    let cursor = from;

    const startedAt = Date.now();
    let pulled = 0;
    let written = 0;
    let chunks = 0;
    let failure = null;
    /* The longest chunk this press has taken, and it is the reason the walk
       stops when it does — see `roomForAnother`. */
    let slowest = 0;

    /* Whether there is time for ANOTHER chunk, not merely whether the budget
     * has already run out.
     *
     * Checking elapsed time alone is what produced the 504s: a chunk that
     * starts at 39s against a 40s budget passes the check and is then killed
     * at 60s by the platform, mid-flight. The press returns nothing at all —
     * no redirect, no cursor, no message — so the operator sees a spinner turn
     * into an error page and the walk loses its position.
     *
     * A chunk is the unit of work that can overrun, so the budget has to be
     * read against a chunk rather than against the clock. The longest one seen
     * so far is the estimate; there is no prior for the first, which is why
     * one chunk is always attempted — a press that walks nowhere is worse than
     * one that risks the ceiling.
     *
     * A quarter is added because these get slower as the walk goes back: the
     * history is denser and the pages are fuller. */
    const roomForAnother = () => {
      const elapsed = Date.now() - startedAt;
      if (!chunks) return elapsed < SYNC_BUDGET_MS;
      return elapsed + slowest * 1.25 < SYNC_BUDGET_MS;
    };

    while (!backfill.done(cursor, floor) && roomForAnother()) {
      const window = backfill.chunk(cursor, floor);
      const chunkAt = Date.now();
      FORCED_WINDOW = window;
      let run;
      try {
        run = await runner.runOne(source);
      } finally {
        FORCED_WINDOW = null;
      }
      slowest = Math.max(slowest, Date.now() - chunkAt);
      pulled += run.pulled || 0;
      written += run.written || 0;
      chunks += 1;
      /* A chunk that fails wholesale stops the walk: continuing would burn the
         budget repeating one error a week at a time. */
      if (!run.ok) { failure = run.error; break; }
      cursor = Date.parse(window.from);
    }

    await runner.log.flush();

    /* Show what was just fetched, rather than the snapshot from before it.
     *
     * The other half of "I pressed it and nothing happened". A write only marks
     * the snapshot stale and the previous one keeps being served for
     * MIN_REBUILD_MS — and a backfill writes on every chunk, so it re-arms that
     * timer continuously and guarantees the screens show pre-backfill figures
     * for the whole walk and five minutes past the end of it.
     *
     * This is the same exemption the credential routes take, for the same
     * reason: an operator is looking at the result of something they just did.
     * One forced rebuild per press is bounded work — it is the unbounded
     * rebuild-per-write that took the app down, and a chunk is not a page
     * view. */
    dropEntities(req.workspace, { now: true });

    const reached = new Date(cursor).toISOString().slice(0, 10);
    const done = backfill.done(cursor, floor);
    const daysLeft = backfill.daysLeft(cursor, floor);
    const detail = failure
      ? `${source}: stopped at ${reached} — ${failure}`
      : `${source}: ${written} row(s) written from ${chunks} step(s), back to ${reached}`
        + (done ? ` — complete, ${asked} days of history` : ` — ${daysLeft} more day(s) of history to fetch, press again to continue`);

    const key = failure ? 'error' : 'saved';
    return res.redirect(303, `/connections?source=${encodeURIComponent(source)}`
      + `&${key}=${encodeURIComponent(detail)}`
      + (done || failure ? '' : `&before=${encodeURIComponent(new Date(cursor).toISOString())}`));
  });

/* Mints the credential a pushing source uses to call `/ingest/webhook/:source`.
 *
 * Rendered rather than redirected, deliberately: a redirect would put a live
 * bearer token in a `Location` header, the browser's history and every proxy
 * log between here and the screen. It is shown once, on this response, and the
 * store keeps only its hash — so nobody, including this app, can show it again.
 */
app.post('/connections/:source/webhook',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'mint-webhook' })),
  (req, res, next) => {
    const source = req.params.source;
    const definition = ingest.sources.get(source);
    if (!definition) {
      return renderConnections(req, res, { error: `unknown source "${source}"` }).catch(next);
    }
    /* Refused for a source that cannot push, rather than minted and left to
       never fire — a credential that exists implies something can use it. */
    if (definition.cadence.mode !== 'stream') {
      return renderConnections(req, res, {
        error: `${definition.name} polls; it has no intake to call. A webhook token would never be used.`,
      }).catch(next);
    }

    const minted = webhookTokens.mint(req.workspace, source, { by: req.user.name });
    return renderConnections(req, res, {
      mintedToken: { source, token: minted.token, replaced: minted.replaced },
      saved: minted.replaced
        ? `${source}: new token minted. The previous one stopped working just now.`
        : `${source}: token minted.`,
    }).catch(next);
  });

app.post('/connections/:source/webhook/remove',
  express.urlencoded({ extended: false }), express.json(),
  gatekeeper.gate('connection.manage', (req) => ({ source: req.params.source, action: 'revoke-webhook' })),
  (req, res, next) => {
    const removed = webhookTokens.revoke(req.workspace, req.params.source);
    return renderConnections(req, res, {
      saved: removed
        ? `${req.params.source}: token revoked — deliveries using it will now be refused.`
        : `${req.params.source}: no token to revoke.`,
    }).catch(next);
  });

/* OTA Analytics — channel production.
 *
 * Not from the design, like Connections: the design draws no distribution
 * screen, and the OTAs are the half of hospitality revenue neither ad platform
 * can see. Every judgement it renders is made in lib/ota.js and every number is
 * formatted by the registry, so this route only assembles.
 *
 * Read at the workspace grain deliberately. `lib/metrics/scope.js` does not
 * narrow `otaReservations` by campaign — a channel's commission is not
 * attributable to the ad that sold the room — so an OTA figure is a workspace
 * question and `supports()` correctly refuses every dimension.
 */
const OTA_ROWS_SHOWN = 40;

async function renderOta(req, res) {
  const screen = (await repo.screens()).find((s) => s.slug === 'ota');
  const { over } = periodFor(req.query);

  /* The same window narrows the table and the headline row, from the same
     entities, for the reason the honesty pass made the date chips real: a
     headline must never sit over a table that disagrees with it. */
  const entities = metrics.period.within(entitiesFor(req.workspace), over);
  const all = entities.otaReservations || [];

  /* The filter chips are real on this screen, and they have to be: the topbar
     offers a **Channel** chip above a table that is entirely about channels,
     and one that did nothing would be exactly the decoration the honesty pass
     removed elsewhere. Property, Channel and Room type all answer, because
     every reservation carries all three — lib/filters.js requires that of every
     row before it will offer a chip.
   *
   * And unlike every other screen, the totals here **are** filtered: they are
   * recomputed from the narrowed rows rather than read from a second snapshot
   * that does not exist. That makes the shared note's standing caveat false
   * here, so it is told which case it is in rather than left to say the wrong
   * thing quietly. */
  const narrowed = filters.applyFilters({ reservations: all }, req.query);
  const reservations = narrowed.payload.reservations;
  const note = filters.summarise(narrowed);
  const { rows, totals, reporting } = ota.summary(reservations);

  /* Formatting is the registry's, not this route's — the same rupee on two
     screens has to look the same, and `format` is the field that guarantees it.
     A channel row is not a registry metric, so it borrows the definition of the
     workspace metric it is a slice of. */
  const asMetric = (id, value) => metrics.format(metrics.registry.get(id), value);

  /* Which of the six are still reading a fixture file.
   *
   * **`liveSources`, not `configured`** — and the difference is the whole point.
   * A source stops serving demo rows only when it has a credential *and* a
   * request shape, which is the rule lib/ingest/raw-store.js replays by. No OTA
   * has a shape written, so storing an Agoda key changes that card's status and
   * changes nothing about where its numbers come from. Deriving this banner
   * from the credential alone would have dropped Agoda from it the moment a key
   * was pasted, while the table below carried on showing invented reservations
   * — a screen saying its figures are real on the strength of a key nothing has
   * used yet. */
  const live = ingest.liveSources({ connections, workspace: req.workspace, httpConnectors });
  const configured = connections.configured(req.workspace);
  const syncStatus = req.workspace === SYNC_WORKSPACE
    ? new Map(runner.status().map((s) => [s.source, s])) : new Map();

  const decorated = rows.map((r) => {
    const state = stateOf({
      configured: configured.has(r.channel),
      readable: configured.has(r.channel) ? connections.decryptable(req.workspace, r.channel) : null,
      webhook: null,
      sync: syncStatus.get(r.channel) || null,
    });
    return {
      ...r,
      icon: (REQUIREMENTS[r.channel] || {}).icon || 'ph ph-bed',
      state: state.state,
      stateLabel: state.label,
      roomNightsText: r.roomNights === null ? null : asMetric('ota.room_nights', r.roomNights),
      grossText: r.gross === null ? null : asMetric('ota.gross_revenue', r.gross),
      commissionText: r.commission === null ? null : asMetric('ota.commission', r.commission),
      commissionRateText: r.commissionRate === null ? null : asMetric('ota.commission_rate', r.commissionRate),
      netText: r.net === null ? null : asMetric('ota.net_revenue', r.net),
      adrText: r.adr === null ? null : asMetric('ota.adr', r.adr),
    };
  });

  /* Latest stay first — a revenue manager reads the newest arrivals, not the
     oldest. Capped, and the cap is *stated* on the screen: a truncated list that
     looks complete is worse than a short one that admits it. */
  const listed = reservations
    .slice()
    .sort((a, b) => String(b.checkIn || '').localeCompare(String(a.checkIn || '')))
    .slice(0, OTA_ROWS_SHOWN);

  const stay = (from, to) => {
    if (!from) return null;
    const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return to ? `${day(from)} – ${day(to)}` : day(from);
  };

  res.render('layout', {
    screen,
    screens: await repo.screens(),
    shell: await shellData('ota', req.query, req.path, req.workspace, req.user),
    hasView: false,
    data: {
      rangeLabel: rangeLabel(over),
      rows: decorated,
      reporting,
      demoChannels: decorated.filter((r) => !live.has(r.channel)),
      /* Of those, the ones somebody has already pasted a key for. They are still
         on fixtures and the banner has to say why, or the next question is why
         connecting a channel did nothing. */
      awaitingConnector: decorated.filter((r) => !live.has(r.channel) && configured.has(r.channel)),
      /* Whether *any* channel could pull if it were given a key. On production
         `LEADINTEL_TRANSPORT=http` forces every source live, so the demo banner
         above is off and this screen is simply empty — and an empty screen that
         does not say why reads as a broken feature. This is the sentence that
         answers it. */
      shapesWritten: ingest.sources.OTA_IDS.filter((id) => httpConnectors.has(id)),
      netDerived: decorated.some((r) => r.netDerived),
      totals: {
        ...totals,
        roomNightsText: totals.roomNights === null ? null : asMetric('ota.room_nights', totals.roomNights),
        grossText: totals.gross === null ? null : asMetric('ota.gross_revenue', totals.gross),
        commissionText: totals.commission === null ? null : asMetric('ota.commission', totals.commission),
        commissionRateText: totals.commissionRate === null ? null : asMetric('ota.commission_rate', totals.commissionRate),
        netText: totals.net === null ? null : asMetric('ota.net_revenue', totals.net),
        adrText: totals.adr === null ? null : asMetric('ota.adr', totals.adr),
      },
      /* Net leads, and gross sits beside it, so the commission between the two
         reads as a subtraction rather than as a claim. */
      kpis: [
        { label: 'Net revenue', value: totals.net === null ? null : asMetric('ota.net_revenue', totals.net), note: 'what the property banks', lead: true },
        { label: 'Gross', value: totals.gross === null ? null : asMetric('ota.gross_revenue', totals.gross), note: 'what guests paid' },
        { label: 'Commission', value: totals.commission === null ? null : asMetric('ota.commission', totals.commission), note: totals.commissionRate === null ? null : `${asMetric('ota.commission_rate', totals.commissionRate)} effective` },
        { label: 'Reservations', value: asMetric('ota.reservations', totals.confirmed), note: 'confirmed' },
        { label: 'Room nights', value: totals.roomNights === null ? null : asMetric('ota.room_nights', totals.roomNights) },
        { label: 'Rate per night', value: totals.adr === null ? null : asMetric('ota.adr', totals.adr), note: 'gross, guest-paid' },
        { label: 'Cancelled', value: asMetric('ota.cancellations', totals.cancelled), note: totals.cancellationRate === null ? null : `${asMetric('ota.cancellation_rate', totals.cancellationRate)} of reservations` },
      ],
      shown: listed.length,
      truncated: reservations.length > listed.length,
      reservations: listed.map((r) => ({
        reference: r.reference,
        channelName: r.channelName,
        guest: r.guest,
        property: r.property,
        stay: stay(r.checkIn, r.checkOut),
        nights: r.nights,
        /* Gross stays on a cancelled row — it is the stay that fell through and
           worth seeing — but **net is dashed**, because a cancelled reservation
           banked nothing and a channel that bills no commission on one would
           otherwise render its full gross in the net column, reading as money
           the property received. The table above already excludes it; this row
           was the one place the entity's raw figure reached a screen. */
        grossText: r.gross === null ? null : asMetric('ota.gross_revenue', r.gross),
        netText: ota.isCancelled(r) || r.net === null ? null : asMetric('ota.net_revenue', r.net),
        cancelled: ota.isCancelled(r),
        /* The channel's own word, made readable — never re-interpreted. */
        statusLabel: String(r.status || 'unknown').replace(/_/g, ' '),
      })),
    },
    drawer: null,
    palette: await palette(),
    notifications: notifications(req.workspace),
    /* Options come from the *unfiltered* rows, so choosing Booking.com does not
       leave the Channel menu holding only Booking.com — a filter you cannot
       change is a filter you cannot undo. */
    filterData: filterData({ reservations: all }, narrowed.active),
    filterNote: note && {
      ...note,
      totalsFiltered: true,
      clearUrl: clearUrl(req.originalUrl, narrowed.active),
    },
    attrPreview: null,
  });
}

app.get('/ota', (req, res, next) => { renderOta(req, res).catch(next); });

/* Google Ads Analytics — its own screen, not a tab on the Meta one.
 *
 * Campaign Analytics is Meta-shaped: campaign, ad set, ad. Google's hierarchy is
 * campaign, ad **group**, ad, with keywords and search terms beneath it and no
 * ad-set concept at all. Rendering Google's rows through Meta's projection is
 * exactly what put ad groups under a column labelled "ad set", and renaming that
 * column would have left the wrong projection behind it.
 *
 * Everything here is summed from the canonical Google entities, which are kept
 * apart from Meta's for the same reason. Nothing is borrowed and nothing is
 * invented: a level with no rows says so.
 */
const GOOGLE_KEYWORD_TYPES = new Set(['SEARCH', 'DISPLAY', 'MULTI_CHANNEL', 'UNKNOWN', null]);

async function renderGoogleAds(req, res) {
  const screen = (await repo.screens()).find((s) => s.slug === 'google-ads');
  const { over } = periodFor(req.query);
  const entities = metrics.period.within(entitiesFor(req.workspace), over);

  const asMoney = (v) => (v === null || v === undefined ? null : metrics.format(metrics.registry.get('ads.spend'), v));

  /* One row per entity rather than per entity-day: the tables answer "how is
     this keyword doing over the range", and a row per day would be a different
     screen. Summed here rather than in the entity, because the entity is the
     day — that is what makes a period narrow it. */
  const rollUp = (rows, keyOf, shape) => {
    const by = new Map();
    for (const r of rows || []) {
      const key = keyOf(r);
      if (key === null || key === undefined) continue;
      const acc = by.get(key) || { ...shape(r), spend: 0, impressions: 0, clicks: 0, conversions: 0, measured: false };
      /* null is unknown, not zero — a row that reported no figure must not be
         summed as though it reported none. */
      if (r.spend !== null) { acc.spend += r.spend; acc.measured = true; }
      if (r.impressions !== null) acc.impressions += r.impressions;
      if (r.clicks !== null) acc.clicks += r.clicks;
      if (r.leads !== null) acc.conversions += r.leads;
      by.set(key, acc);
    }
    return [...by.values()]
      .map((a) => ({
        ...a,
        spendText: a.measured ? asMoney(a.spend) : null,
        /* Cost per conversion. **Null on zero, never Infinity** — a row that
           spent money and converted nobody has no cost *per* anything, and the
           registry's own rule is that a ratio with no denominator is unknown
           rather than infinitely bad. The wasted-spend flag on the search terms
           table is what surfaces those rows; a number here would only look like
           a very large price.
         *
         * Named cost-per-conversion rather than cost-per-lead in the column,
         * because Google's `conversions` counts every action the account
         * defines — a booking enquiry and a phone click alike. The Conversions
         * by action table below is where that total is broken apart, and until
         * a lead action is nominated this figure is not a cost per lead. */
        cplText: a.conversions > 0 ? asMoney(a.spend / a.conversions) : null,
        /* Cost per click, same rule: no clicks means no cost *per* click, so it
           is unknown rather than zero or infinite. */
        cpcText: a.clicks > 0 ? asMoney(a.spend / a.clicks) : null,
      }))
      .sort((x, y) => y.spend - x.spend);
  };

  const googleDays = (entities.campaignDays || []).filter((c) => c.platform === 'google_ads');
  const campaigns = rollUp(googleDays, (r) => r.campaign, (r) => ({
    campaign: r.campaign,
    channelType: r.channelType || null,
    /* Impression share is a rate, not a total, so it is taken from the most
       recent day rather than summed — adding percentages would be nonsense. */
    impressionShare: r.impressionShare ?? null,
    lostToBudget: r.lostToBudget ?? null,
    lostToRank: r.lostToRank ?? null,
  }));

  /* The account line. Summed from the same rows the table renders, so a total
     can never disagree with the column above it — the reason the honesty pass
     made every headline share its table's entities. */
  const campaignTotal = campaigns.reduce((t, c) => ({
    spend: t.spend + c.spend,
    impressions: t.impressions + c.impressions,
    clicks: t.clicks + c.clicks,
    conversions: t.conversions + c.conversions,
  }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  campaignTotal.spendText = campaigns.length ? asMoney(campaignTotal.spend) : null;
  campaignTotal.cpcText = campaignTotal.clicks > 0 ? asMoney(campaignTotal.spend / campaignTotal.clicks) : null;
  campaignTotal.cplText = campaignTotal.conversions > 0 ? asMoney(campaignTotal.spend / campaignTotal.conversions) : null;

  const adGroups = rollUp(entities.googleAdGroups, (r) => r.adgroupId, (r) => ({ adgroup: r.adgroup }));
  const ads = rollUp(entities.googleAds, (r) => r.adId, (r) => ({ ad: r.ad, adId: r.adId, adType: r.adType, status: r.status }));
  const keywords = rollUp(entities.googleKeywords, (r) => r.keyword, (r) => ({
    keyword: r.keyword, matchType: r.matchType, qualityScore: r.qualityScore,
  }));
  const searchTerms = rollUp(entities.googleSearchTerms, (r) => r.term, (r) => ({
    term: r.term, termStatus: r.termStatus, adgroupId: r.adgroupId,
  }));

  /* ── search term detail ───────────────────────────────────────────────────
   *
   * The rates are derived here rather than in the view so the two cannot
   * disagree, and both follow the registry's rule: a ratio with no denominator
   * is null, not zero. A term with no impressions has no click-through rate —
   * saying 0% would claim nobody clicked something nobody was shown. */
  const rate = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(2)}%` : null);
  const adgroupName = new Map(adGroups.map((g) => [g.adgroupId, g.adgroup]));

  const terms = searchTerms.map((t) => ({
    ...t,
    adgroup: adgroupName.get(t.adgroupId) || null,
    ctr: rate(t.clicks, t.impressions),
    convRate: rate(t.conversions, t.clicks),
    wasted: t.spend > 0 && !t.conversions,
  }));

  const wastedTerms = terms.filter((t) => t.wasted);
  const termSummary = {
    total: terms.length,
    converting: terms.filter((t) => t.conversions > 0).length,
    wasted: wastedTerms.length,
    wastedSpendText: wastedTerms.length ? asMoney(wastedTerms.reduce((s, t) => s + t.spend, 0)) : null,
  };

  /* Which *words* are costing money, as opposed to which phrases.
   *
   * A search term report is long and mostly one-off phrases — the same waste
   * shows up as fifty near-identical rows, each too small to notice. Rolling
   * spend up by word is what makes a negative keyword obvious: one token
   * appearing across a dozen non-converting terms is the thing worth excluding,
   * and no per-row view surfaces it.
   *
   * Deliberately not stemmed or stopword-filtered beyond the shortest tokens:
   * this is the account's own vocabulary, and guessing which words are
   * meaningful is how a tool starts hiding the answer. */
  const byWord = new Map();
  for (const t of terms) {
    const seen = new Set(String(t.term || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    for (const word of seen) {
      const acc = byWord.get(word) || { word, terms: 0, spend: 0, clicks: 0, conversions: 0 };
      acc.terms += 1;
      acc.spend += t.spend;
      acc.clicks += t.clicks;
      acc.conversions += t.conversions;
      byWord.set(word, acc);
    }
  }
  const words = [...byWord.values()]
    .filter((w) => w.terms > 1)
    .map((w) => ({ ...w, spendText: asMoney(w.spend), wasted: w.spend > 0 && !w.conversions }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 25);

  /* Conversions carry no spend — they are a breakdown of the campaign's — so
     they are rolled up on their own terms rather than through `rollUp`. */
  const byAction = new Map();
  for (const c of entities.googleConversions || []) {
    if (!c.action) continue;
    const acc = byAction.get(c.action) || { action: c.action, category: c.category, conversions: 0, value: 0 };
    if (c.conversions !== null) acc.conversions += c.conversions;
    if (c.conversionValue !== null) acc.value += c.conversionValue;
    byAction.set(c.action, acc);
  }
  const conversions = [...byAction.values()]
    .map((a) => ({
      ...a,
      /* Left fractional on purpose: Google splits conversion credit across
         touches, and rounding would discard the fraction on every row. */
      conversions: Math.round(a.conversions * 1e6) / 1e6,
      valueText: asMoney(a.value),
    }))
    .sort((x, y) => y.conversions - x.conversions);

  /* Whether keywords *apply*, which is not the same question as whether any
     were returned. App, Performance Max and Shopping campaigns have none by
     construction, and an empty table would state "no keywords" about a campaign
     type that cannot have them. Only claimed when every campaign in range is of
     such a type — a mixed account still has keywords worth showing. */
  const types = [...new Set(campaigns.map((c) => c.channelType).filter(Boolean))];
  const keywordsNotApplicable = (!keywords.length && types.length && types.every((t) => !GOOGLE_KEYWORD_TYPES.has(t)))
    ? `every campaign in this range is ${types.join(', ')}`
    : null;

  res.render('layout', {
    screen,
    screens: await repo.screens(),
    shell: await shellData('google-ads', req.query, req.path, req.workspace, req.user),
    hasView: false,
    data: {
      rangeLabel: rangeLabel(over),
      connected: ingest.liveSources({ connections, workspace: req.workspace, httpConnectors }).has('google_ads'),
      campaigns, campaignTotal, adGroups, ads, keywords, conversions,
      searchTerms: terms, termSummary, words,
      keywordsNotApplicable,
    },
    drawer: null,
    palette: await palette(),
    notifications: notifications(req.workspace),
    filterData: filterData(null),
    filterNote: null,
    attrPreview: null,
  });
}

app.get('/google-ads', (req, res, next) => { renderGoogleAds(req, res).catch(next); });

/* Creative thumbnails, proxied.
 *
 * The images are on Meta's CDN, and the page's CSP is `img-src 'self' data:` —
 * deliberately. Relaxing it to name Meta's image hosts would widen the policy
 * for every page in the app to solve one screen, and Meta's thumbnail URLs are
 * signed and expire, so a browser fetching them directly would show a wall of
 * broken images within weeks. Proxying keeps both problems in one place.
 *
 * **The URL is never taken from the request.** The route accepts an ad id,
 * looks the creative up in the caller's own entities, and fetches the address
 * *the pipeline stored*. A route that fetched a URL from the query string would
 * be an open proxy sitting inside the network perimeter — the classic shape of
 * a server-side request forgery, and the reason this reads a little
 * indirectly.
 */
const THUMBNAIL_HOSTS = /(^|\.)(fbcdn\.net|facebook\.com)$/i;

app.get('/creatives/:adId/thumbnail', async (req, res) => {
  let creative;
  try {
    creative = (entitiesFor(req.workspace).creatives || [])
      .find((c) => c.adId === req.params.adId);
  } catch (err) {
    return res.status(503).end();
  }

  if (!creative || !creative.thumbnailUrl) return res.status(404).end();

  /* Belt and braces: the address came from our own store, but it came
     originally from a third party, so it is still checked against the hosts
     Meta serves images from before anything is fetched. */
  let target;
  try {
    target = new URL(creative.thumbnailUrl);
  } catch (err) {
    return res.status(404).end();
  }
  if (target.protocol !== 'https:' || !THUMBNAIL_HOSTS.test(target.hostname)) {
    return res.status(404).end();
  }

  try {
    const upstream = await fetch(target, { redirect: 'follow' });
    if (!upstream.ok) return res.status(502).end();

    const type = upstream.headers.get('content-type') || '';
    /* Only images. Whatever else the far end might serve, this route will not
       hand it to a browser under this app's own origin. */
    if (!type.startsWith('image/')) return res.status(502).end();

    res.setHeader('content-type', type);
    /* Cached hard: a creative's thumbnail does not change, and every card on
       the screen is one of these. `private` because it is behind a session. */
    res.setHeader('cache-control', 'private, max-age=86400');
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    /* An expired signature or a CDN hiccup renders as a missing image, which
       the card already handles by falling back to its gradient. */
    return res.status(502).end();
  }
});

/* The creative itself, playing.
 *
 * A still is what an ad looks like paused, and most of this account is video —
 * so "see the creative" means watching the thing a guest actually saw, with its
 * hook, its pacing and its cut. The card and the drawer show the still; this is
 * the source behind it.
 *
 * **The same shape as the thumbnail proxy above, for the same reasons.** The
 * ad id comes from the request and the address does not: the video id is looked
 * up in the caller's own entities, resolved to a source through the Graph API
 * with the *server's* stored token, and only then fetched. A route that took a
 * video URL from the query string would be an open proxy inside the perimeter.
 *
 * The token never reaches the browser. Meta's own ad-preview iframe would have
 * been the easier route and it carries an access token in its src, which is
 * precisely why it is not used.
 */
const VIDEO_HOSTS = /(^|.)(fbcdn.net|facebook.com)$/i;

/* The ad as a guest saw it — video playing, copy, call to action, the lot.
 *
 * **This is the one that works on `ads_read`.** Reading a video's own source
 * needs `ads_management`, which this account's token does not have, so the
 * `/video` route below returns 404 for it. Meta's preview endpoint has no such
 * requirement and renders the whole ad rather than the asset.
 *
 * The preview URL is fetched per request and redirected to, never stored: it
 * carries a short-lived token and expires. That token is a *preview* token —
 * the account's access token stays on the server, which is what made framing
 * this acceptable at all. See PREVIEW_HOSTS in lib/http/hardening.js.
 *
 * The iframe on the page points at *this* route, so the browser never sees a
 * Meta URL until it follows the redirect, and nothing in the page markup has to
 * hold a credential.
 */
const PREVIEW_FORMATS = new Set([
  'MOBILE_FEED_STANDARD', 'DESKTOP_FEED_STANDARD', 'INSTAGRAM_STANDARD',
  'INSTAGRAM_STORY', 'INSTAGRAM_REELS',
]);

/* Why the preview is not there, rendered *inside the frame*.
 *
 * Every failure on this route used to be `res.status(404).end()` — six of them,
 * all empty, and none carrying the framing headers the success path sets. So
 * the browser refused to display the error response as well, and the drawer
 * showed a blank box whichever of the six things had gone wrong: no credential,
 * an ad that is no longer in the store, Meta returning no preview body, a
 * preview address that could not be parsed. Indistinguishable from each other
 * and from a bug in the app.
 *
 * A frame whose whole purpose is to show something must therefore always show
 * something. The status code is kept for anything reading this route as an API;
 * what changes is that a person looking at the box can now read what happened.
 */
function previewProblem(res, status, what, fix) {
  res.status(status);
  res.setHeader('cache-control', 'no-store');
  /* The same relaxation the success path needs, and for the same reason — an
     explanation the browser refuses to render explains nothing. */
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.type('html').send(
    '<!doctype html><html><body style="margin:0;height:100%;display:grid;place-items:center;'
    + 'background:#14161f;font-family:Inter,system-ui,sans-serif;color:#8b8fa3;text-align:center">'
    + '<div style="padding:20px;max-width:320px">'
    + '<div style="font-size:13px;color:#c9ccd8;line-height:1.5">' + escapeHtml(what) + '</div>'
    + (fix ? '<div style="font-size:11.5px;margin-top:7px;line-height:1.55">' + escapeHtml(fix) + '</div>' : '')
    + '</div></body></html>'
  );
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

app.get('/creatives/:adId/preview', async (req, res) => {
  let creative;
  try {
    creative = (entitiesFor(req.workspace).creatives || [])
      .find((c) => c.adId === req.params.adId);
  } catch (err) {
    return previewProblem(res, 503, 'The ingested data could not be read, so this ad could not be looked up.', err.message);
  }
  if (!creative) {
    return previewProblem(res, 404, 'This ad is not in the store.',
      'It falls outside the window the last sync pulled, or it has not been synced yet. Connections shows when Meta Ads last ran.');
  }

  const credentials = connections.secretsFor(req.workspace, 'meta_ads');
  if (!credentials || !credentials.accessToken) {
    return previewProblem(res, 404, 'No Meta Ads credential is stored.',
      'The preview is fetched from Meta on each open, so it needs a connected account. Add one on Connections.');
  }

  const format = PREVIEW_FORMATS.has(req.query.format) ? req.query.format : 'MOBILE_FEED_STANDARD';

  try {
    const url = new URL(`https://graph.facebook.com/v25.0/${encodeURIComponent(creative.adId)}/previews`);
    url.searchParams.set('ad_format', format);
    url.searchParams.set('access_token', String(credentials.accessToken).trim());

    const upstream = await fetch(url);
    const payload = await upstream.json().catch(() => null);
    const body = payload && payload.data && payload.data[0] && payload.data[0].body;
    if (!body) {
      /* Meta's own words where it gave any — "(#100) Missing permission" and an
         ad that simply has no renderable preview are different problems, and
         only one of them is fixable by the reader. */
      const said = payload && payload.error && (payload.error.error_user_msg || payload.error.message);
      return previewProblem(res, 404,
        said ? 'Meta refused the preview.' : 'Meta returned no preview for this ad.',
        said || 'Some ad formats have no renderable preview. The metrics beside this are unaffected.');
    }

    /* Meta answers with an `<iframe src="...">` rather than a URL, so the
       address is read out of it. Entities are decoded because the src arrives
       HTML-escaped inside that markup. */
    const match = /src="([^"]+)"/.exec(body);
    if (!match) {
      return previewProblem(res, 404, 'Meta’s preview could not be read.',
        'It answered with markup this app did not recognise — the shape of that reply has changed before.');
    }
    const target = match[1].replace(/&amp;/g, '&');

    let parsed;
    try {
      parsed = new URL(target);
    } catch (err) {
      return previewProblem(res, 404, 'Meta’s preview address could not be parsed.', err.message);
    }
    /* Only the hosts the policy frames. A preview address from anywhere else is
       not a preview. */
    if (parsed.protocol !== 'https:' || !/(^|.)facebook.com$/i.test(parsed.hostname)) {
      return previewProblem(res, 404, 'The preview address was not a Meta one, so it was refused.',
        'Only https on facebook.com is framed — the content policy names those hosts and nothing else.');
    }

    /* Never cached: the token in it expires, and a stale redirect renders as an
       empty frame with no explanation. */
    res.setHeader('cache-control', 'no-store');

    /* **This one route has to be framable, and only by us.**
     *
     * Every response carries `X-Frame-Options: DENY` and `frame-ancestors
     * 'none'` from lib/http/hardening.js, which is right for every screen in
     * the app and wrong for the one endpoint whose entire purpose is to be
     * loaded inside a frame on our own page. The browser refuses it and reports
     * "refused to connect" — naming our own host, which reads like the site
     * being down rather than a header doing its job.
     *
     * So it is relaxed here to `'self'`, on this response only. The page may
     * frame it; nobody else's page may. Nothing about the app-wide default
     * changes. */
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");

    return res.redirect(302, parsed.toString());
  } catch (err) {
    /* The last silent one: Meta unreachable, DNS, TLS, timeout. */
    return previewProblem(res, 502, 'Meta could not be reached for this preview.', err.message);
  }
});

app.get('/creatives/:adId/video', async (req, res) => {
  let creative;
  try {
    creative = (entitiesFor(req.workspace).creatives || [])
      .find((c) => c.adId === req.params.adId);
  } catch (err) {
    return res.status(503).end();
  }

  if (!creative || !creative.videoId) return res.status(404).end();

  const credentials = connections.secretsFor(req.workspace, 'meta_ads');
  if (!credentials || !credentials.accessToken) return res.status(404).end();

  try {
    /* One hop to learn where the video lives. `source` is a signed, expiring
       address, which is why it is resolved per request rather than stored. */
    const lookup = new URL(`https://graph.facebook.com/v25.0/${encodeURIComponent(creative.videoId)}`);
    lookup.searchParams.set('fields', 'source');
    lookup.searchParams.set('access_token', String(credentials.accessToken).trim());

    const meta = await fetch(lookup);
    const payload = await meta.json().catch(() => null);
    const source = payload && payload.source;

    /* Reading a video's source needs a wider permission than reading its
       performance. A token without it is a missing video, not a broken page —
       the drawer keeps showing the still. */
    if (!source) return res.status(404).end();

    let target;
    try {
      target = new URL(source);
    } catch (err) {
      return res.status(404).end();
    }
    if (target.protocol !== 'https:' || !VIDEO_HOSTS.test(target.hostname)) {
      return res.status(404).end();
    }

    /* Range requests forwarded, so a viewer can scrub rather than having to
       download the whole file before the first frame. */
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;

    const upstream = await fetch(target, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).end();

    const type = upstream.headers.get('content-type') || '';
    if (!type.startsWith('video/')) return res.status(502).end();

    res.status(upstream.status);
    res.setHeader('content-type', type);
    for (const header of ['content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(header);
      if (v) res.setHeader(header, v);
    }
    /* Private, because it is behind a session. A creative's video does not
       change under its id, so it caches as hard as the still. */
    res.setHeader('cache-control', 'private, max-age=86400');
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    return res.status(502).end();
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
    if ((req.get('accept') || '').includes('text/html')) return res.redirect(303, '/attribution');
    return res.json(change);
  } catch (err) {
    if ((req.get('accept') || '').includes('text/html')) {
      const back = attribution.isModel(body.model) ? `/attribution?preview=${body.model}&err=${encodeURIComponent(err.message)}` : '/attribution';
      return res.redirect(303, back);
    }
    return res.status(400).json({ error: err.message });
  }
});

/* A screen with no template renders its chrome and an explanatory body rather
   than crashing. */
function hasView(view) {
  return fs.existsSync(path.join(__dirname, 'views', 'screens', `${view}.ejs`));
}

/* The chips, as links. `seg()` in data/_tokens.js still supplies the selected
   and unselected colours, so the control looks exactly as the design draws it
   — what changes is that it now goes somewhere. */
function periodChips(query, path) {
  const active = periodFor(query).id;
  return PERIOD_CHIPS.map((chip) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      /* A chip clears a custom range as well as the previous chip. Leaving
         `from`/`to` behind would put two answers to the same question in one
         URL, and `periodFor` prefers the custom one — so the chip would appear
         selected while the numbers stayed on the old range. */
      if (key === 'period' || key === 'from' || key === 'to' || value === undefined) continue;
      params.set(key, String(value));
    }
    params.set('period', chip.id);
    return { label: chip.label, go: `${path}?${params.toString()}`, ...tokens.seg(chip.id === active) };
  });
}

/* The window in words. It was hardcoded as "Jul 1 – Jul 30" — a date range
   printed next to a range control, describing neither the data nor the
   selection. Same day both ends means one day, and says so. */
function rangeLabel(over) {
  if (!over || !over.from) return 'All time';
  const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  /* The last day the window actually covers, not the exclusive end. Windows are
     half-open, so a range picked as "1 Jul – 31 Jul" ends at midnight on 1 Aug
     — printing that raw told the reader their range ran to a day it excludes.
     A preset is unaffected: its end is a moment inside today, and a millisecond
     before it is still today. */
  const from = day(over.from);
  const to = day(new Date(Date.parse(over.to) - 1).toISOString());
  return from === to ? from : `${from} – ${to}`;
}

/* How stale the two systems the chrome names actually are.
 *
 * The filter bar carried "CRM 4m · Ads 12m" behind a green dot on every screen
 * — constants in the markup, green whatever the pipeline was doing. It sat
 * above Campaign Analytics claiming a freshness while Google Ads had not synced
 * in a day. The run log has always known the real figure. */
function freshness(workspaceId) {
  if (workspaceId !== SYNC_WORKSPACE) return null;

  const status = new Map(runner.status().map((s) => [s.source, s]));
  const say = (id) => {
    const row = status.get(id);
    if (!row || !row.lastSuccessAt) return { text: 'never', ok: false };
    if (row.recentFailures > 0 || row.health === 'down') return { text: 'failing', ok: false };
    return { text: shortLag(row.lagSeconds), ok: true };
  };

  const crm = say('telecrm');
  const ads = say('meta_ads');
  return { label: `CRM ${crm.text} · Ads ${ads.text}`, ok: crm.ok && ads.ok };
}

/* Compact enough to sit in a chip: "4m", "3h", "2d". */
function shortLag(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/* Chrome data: the repository supplies the filter chips, the route supplies
   the parts that are request state — which nav item is active, the selected
   date range, whether the sidebar is open, whether the workspace menu is
   down. */
/* Who is signed in, for the topbar's avatar.
 *
 * It was hardcoded: the markup carries `AP` and `title="Anand P — Owner"`, so
 * every user saw Anand's initials and Anand's role whoever they actually were.
 * Two seeded users exist precisely so tenant isolation is provable, and the one
 * piece of chrome that says who you are was a constant.
 *
 * Initials for the same reason the pipeline avatar takes them: it is a
 * 32-pixel circle, and a name does not fit in one. */
/* What a permission means, said the way a person would say it. The grant ids
   are the contract and are not for reading — "connection.manage" on a menu is a
   developer's word for someone else's screen. Only the consequential ones are
   named: a list of nine reads as a wall and hides the two that matter. */
const NOTABLE = {
  'connection.manage': 'connect data sources',
  'attribution.change': 'change the attribution model',
  'metric.edit': 'edit metric definitions',
  'report.send': 'send reports',
};

function me(user) {
  if (!user) return null;
  const words = String(user.name || '').trim().split(/\s+/).filter(Boolean);
  const granted = gatekeeper.permissions.allowed(user);

  return {
    initials: words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?',
    name: user.name || 'Signed in',
    /* The sign-in id, which is not the display name. Worth showing: it is what
       a person quotes when something has to be looked up, and what the audit
       trail records. */
    id: user.id || null,
    roleName: user.roleName || user.role || '',
    workspaceName: user.workspaceName || '',
    /* Computed from the same table the server enforces, so the menu cannot
       promise something a request would be refused for. */
    can: granted.map((action) => NOTABLE[action]).filter(Boolean),
    grants: granted.length,
    grantsTotal: gatekeeper.permissions.ACTIONS.length,
  };
}

async function shellData(activeSlug, query, path = '/', workspaceId = null, user = null) {
  const content = (await repo.read('_shell', readParams(query))) || {};
  const shell = {
    ...content,
    freshness: freshness(workspaceId),
    /* Null when nothing knows — the 404 page renders with no session. */
    me: me(user),
    /* The chips replace the authored ones. Each keeps the rest of the query —
       a filter, a sub-view tab — because changing the date range should not
       silently undo the other choices on screen. */
    ranges: periodChips(query, path),
    rangeLabel: rangeLabel(periodFor(query).over),
    navGroups: await repo.navigation(activeSlug),
    expanded: true,
    sidebarWidth: '214px',
    collapseIcon: 'ph ph-caret-double-left',
    wsOpen: query ? 'ws' in query : false,
  };
  schema.audit('_shell', shell, { requireAll: true, label: 'the shell payload' });
  return shell;
}

/* Tabs a screen should offer for *this* request.
 *
 * A keyword is a Google Ads object. Meta has no such thing, so the Keywords tab
 * is an invitation to a table that can never fill on a Meta-only workspace —
 * and it sat beside three Meta campaigns doing exactly that. It is offered when
 * the channel filter selects Google, and withheld otherwise.
 *
 * Withheld from the *group*, not hidden in the view: dropping it here means
 * `?v=campTabKeywords` falls back to the group's default rather than selecting
 * a tab nobody can see, and the flag the template reads is simply absent.
 */
const KEYWORD_TABS = { campTabKeywords: 'google' };

function tabsOffered(groups, query) {
  const channel = String((query && query.channel) || '').toLowerCase();

  return groups.map((group) => {
    const views = group.views.filter((v) => {
      const needs = KEYWORD_TABS[v.flag];
      return !needs || channel.includes(needs);
    });
    /* Never empty a group: a group with no views has no default and
       `subviewState` would have nothing to select. */
    return views.length ? { ...group, views } : group;
  });
}

function screenRoute(screen) {
  return async (req, res, next) => {
    try {
      const groups = tabsOffered(await repo.subviewGroups(screen.view), req.query);
      const { flags, tabLists } = subviewState(groups, screen.slug, req.query);

      /* 6.4 — every KPI card that names a registry metric carries its
         definition from here on, whichever driver supplied the payload. */
      const params = readParams(req.query);
      const payload = (await repo.read(screen.view, params)) || {};

      /* Which cards this reader keeps, and whether they are choosing right now.
         Hidden cards are removed in `resolve` rather than in the view, so
         coverage and every other consumer sees the same screen the reader
         does — and are *not* removed while editing, or the control that
         unhides one would have nothing to unhide. */
      const editing = 'edit' in req.query;
      const screenSlug = screen.slug || 'dashboard';
      const hiddenCards = layouts.hidden(req.workspace, req.user && req.user.id, screenSlug);

      /* A topbar chip narrows the *metrics*, not only the rows.
       *
       * The chips were row filters: choosing Google left every KPI above the
       * table reading the blended figure, so a screen could say "Google" at the
       * top and show Meta's spend underneath. Whatever the reader concluded
       * from that was wrong, and nothing on the page said so.
       *
       * A chosen dimension the scope layer understands now becomes the screen's
       * `metricScope`, which `resolveMetrics` already knows how to evaluate at —
       * the same machinery a campaign drill-down uses. A metric that is not
       * meaningful at that grain reports itself as not measured there rather
       * than quietly reusing the workspace figure. A screen that names its own
       * scope keeps it: a drill-down is already about one campaign. */
      if (!payload.metricScope) {
        /* Read through `filters.selected` rather than off `req.query` directly,
           because the chips are named `f_channel`, not `channel` — a detail
           that made this work when the URL was typed by hand and do nothing at
           all when the chip was clicked. One reader for one convention is what
           stops those two drifting apart again. */
        const active = filters.selected(req.query);
        const chosen = metrics.scope.DIMENSIONS.find((dimension) => active[dimension]);
        if (chosen) payload.metricScope = { dimension: chosen, value: String(active[chosen]).toLowerCase() };
      }

      const unfiltered = resolveMetrics(payload, req.workspace, params.over, { hidden: hiddenCards, editing });

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
        editing,
        /* Every card the screen offers and which of them are put away, so the
           edit panel is built from the payload rather than scraped from the
           rendered DOM. Only while editing — it is a list nobody else needs. */
        layoutCards: editing ? offeredCards(result.payload) : null,
        hiddenCards,
        layoutScreen: screenSlug,
        /* So saving returns to the same range and channel the reader was
           looking at, rather than to a bare dashboard. */
        currentUrl: req.originalUrl,
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
        shell: await shellData(screen.slug, req.query, req.path, req.workspace, req.user),
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

  /* On a serverless runtime there is no process to hold a timer: the function
     is frozen between requests, so `setInterval` either never fires or fires
     inside somebody's request. The sync is driven by Vercel Cron calling
     POST /cron/sync instead — see the route above and vercel.json. The
     staleness-based `due()` logic is unchanged, which is what makes a cron
     tick, a manual run and a post-downtime catch-up the same call. */
  if (process.env.LEADINTEL_SYNC !== 'off' && !SERVERLESS) {
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

  /* Nothing listens on a serverless runtime — the platform owns the socket and
     the app is handed requests as a function. `api/index.js` awaits `ready` and
     calls it. */
  if (SERVERLESS) return app;

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

  return app;
}

/* Routes are registered asynchronously — the screen list comes from the
   repository — so what a caller needs is the promise, not the app. A long-lived
   process starts listening as a side effect of this; a serverless one awaits
   `ready` per invocation and gets the same already-built app back. */
const ready = start();

/* The app itself is the export, with `ready` hung off it.
 *
 * `module.exports = { app, ready }` is the shape this wants to be, and it is
 * the shape that broke production: Vercel's Express preset makes server.js a
 * function entry and invokes its default export, which was an object — every
 * request it caught died with "Invalid export found in module server.js. The
 * default export must be a function or server." The preset is off now
 * (vercel.json), and exporting the handler as well means the failure cannot
 * come back if anything else ever loads this file expecting one.
 *
 * Callers still want `ready` rather than `app`: routes are registered
 * asynchronously, so the app is not complete until it resolves. */
module.exports = app;
module.exports.app = app;
module.exports.ready = ready;
