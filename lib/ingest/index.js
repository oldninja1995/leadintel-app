/* Running a sync, and reading the result.
 *
 * Two calls. `sync` pulls one source and appends whatever is new to the raw
 * store. `snapshot` rebuilds the canonical entities from the store alone,
 * touching no connector and no transport — which is what makes it a replay:
 * the same stored payloads must produce the same entities whether they arrived
 * a minute ago or last month.
 *
 * Scheduling is not here. Cadence, run records and lag are sub-phase 4.5; this
 * is the seam they will attach to.
 */

const path = require('path');

const connectors = require('./connectors');
const canonical = require('./canonical');
const sources = require('./sources');
const { RawStore, ROOT } = require('./raw-store');
const { createTransport } = require('./transport');

/* Phase 9 partitioned the raw store per workspace: `var/raw/<workspace>/`.
 * Isolation is a property of *where the data is* rather than of a filter
 * applied on the way out, so a tenant's store simply has nothing else in it.
 *
 * There is no default workspace on purpose. A `RawStore` with no tenant would
 * be a store pointing at the directory that *contains* the tenants, which
 * reads as empty and would look like "no data yet" rather than like a mistake.
 */
const workspaceStores = new Map();
function storeFor(workspaceId) {
  if (!workspaceId) throw new Error('a raw store needs a workspace');
  if (!workspaceStores.has(workspaceId)) {
    /* Required here rather than at the top of the file: lib/store pulls in the
       Postgres driver and this module is loaded by every test, most of which
       have no database. */
    const store = require('../store');
    workspaceStores.set(workspaceId, store.rawStoreFor(workspaceId, { RawStore, root: ROOT }));
  }
  return workspaceStores.get(workspaceId);
}

/* Test seam: the map is keyed by workspace and lives for the process, so a test
   that changes which medium is configured needs it dropped. */
function resetStores() {
  workspaceStores.clear();
}

async function sync(sourceId, { window = null, store = new RawStore(), transport = createTransport(), fetchedAt } = {}) {
  const connector = connectors.get(sourceId);
  if (!connector) throw new Error(`no connector for source "${sourceId}"`);

  const records = await connector.pull(window, transport);
  /* Awaited: the Postgres store returns a promise here where the file store
     returns the written envelopes directly. */
  const written = await store.append(sourceId, records, { window, fetchedAt, transport: transport.name });

  /* `connectors.pull` isolates a failing kind so one refusal cannot cost the
     account its other data — and it attaches what failed to the returned array.
     Nothing used to read it, so the isolation was silent: a source whose
     `creative` kind failed on every single sync still reported `health: ok`,
     `recentFailures: 0`, `lastError: null`, because a partial failure never
     left this function. Carried through here so the run log can record it and
     `/ingest/status` can show it. */
  return {
    source: sourceId,
    pulled: records.length,
    written: written.length,
    transport: transport.name,
    failures: records.failures || [],
  };
}

async function syncAll(options = {}) {
  const results = [];
  for (const source of sources.list()) results.push(await sync(source.id, options));
  return results;
}

/* A webhook delivery takes the same path as a pull — named, checked, appended
   — so a streamed record and a polled one are indistinguishable downstream. */
async function receive(sourceId, event, { store = new RawStore(), fetchedAt } = {}) {
  const connector = connectors.get(sourceId);
  if (!connector) throw new Error(`no connector for source "${sourceId}"`);

  const records = await connector.receive(event);
  /* A webhook is the vendor calling us; nothing about it came out of a fixture,
     so it is marked real rather than left unclassified. */
  const written = await store.append(sourceId, records, { window: null, fetchedAt, transport: 'webhook' });
  return { source: sourceId, received: records.length, written: written.length };
}

/* Which sources must not serve demo data.
 *
 * The same rule `transportFor` in server.js uses to decide what a source pulls
 * *with*, asked here about what it may still serve *from*. The two have to
 * agree: a source pulling for real while its fixtures keep replaying is the
 * state that put three invented campaigns at the top of Campaign Analytics.
 *
 * `LEADINTEL_TRANSPORT=http` forces every source live, which is how the
 * deployed app runs — so nothing there serves fixtures at all, whether or not a
 * given source has succeeded yet or has a credential. A local run with the
 * default fixture transport is unaffected, and that is what demo mode is.
 */
function liveSources({
  connections = null,
  workspace = null,
  httpConnectors = null,
  forced = process.env.LEADINTEL_TRANSPORT,
} = {}) {
  const ids = sources.list().map((s) => s.id);
  if (forced === 'http') return new Set(ids);
  if (!connections || !workspace) return new Set();

  const configured = connections.configured(workspace);
  return new Set(ids.filter((id) => configured.has(id)
    && (!httpConnectors || httpConnectors.has(id))));
}

/* `connected` names the sources that must not serve demo data — see
   `liveSources`. It travels from the caller because the raw store knows what
   arrived, not what the app is configured to pull. */
/* Returns entities directly from a file store and a promise of them from a
 * Postgres one, because `replay` does.
 *
 * A function that is sometimes async is normally a defect — the caller cannot
 * know whether it has a value or a promise. It is safe *here*, and only here,
 * because the medium is chosen once from the environment at boot and never
 * varies within a process: a deployment is entirely one or entirely the other.
 * Every production caller awaits, which is correct for both.
 *
 * The alternative was making it unconditionally async, which would have meant
 * awaiting it at twenty-five call sites across eight test files that have no
 * database and no reason to care. That is churn bought with no safety.
 */
function snapshot({ store = new RawStore(), connected = null } = {}) {
  const replayed = store.replay(null, null, { connected });
  return replayed && typeof replayed.then === 'function'
    ? replayed.then((rows) => canonical.build(rows))
    : canonical.build(replayed);
}

module.exports = {
  sync, syncAll, receive, snapshot, liveSources, RawStore, storeFor, resetStores, createTransport, sources,
  /* Re-exported so the snapshot cache can key on the shape of what canonical
     produces, not only on the rows that went in. */
  SHAPE: canonical.SHAPE,
};
