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
  if (!workspaceStores.has(workspaceId)) workspaceStores.set(workspaceId, new RawStore(path.join(ROOT, workspaceId)));
  return workspaceStores.get(workspaceId);
}

async function sync(sourceId, { window = null, store = new RawStore(), transport = createTransport(), fetchedAt } = {}) {
  const connector = connectors.get(sourceId);
  if (!connector) throw new Error(`no connector for source "${sourceId}"`);

  const records = await connector.pull(window, transport);
  const written = store.append(sourceId, records, { window, fetchedAt });

  return { source: sourceId, pulled: records.length, written: written.length, transport: transport.name };
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
  const written = store.append(sourceId, records, { window: null, fetchedAt });
  return { source: sourceId, received: records.length, written: written.length };
}

function snapshot({ store = new RawStore() } = {}) {
  return canonical.build(store.replay());
}

module.exports = { sync, syncAll, receive, snapshot, RawStore, storeFor, createTransport, sources };
