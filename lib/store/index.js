/* Which medium the stores run on, decided in one place.
 *
 * `DATABASE_URL` present means Postgres; absent means the filesystem. Nothing
 * else decides it, and no module asks — each takes a `backend` and does not
 * care where it came from. A local run and the whole test suite have no
 * database and therefore keep the file behaviour they have always had.
 *
 * The env var is read on each call rather than cached at require time, because
 * a test may set it after this module is first loaded.
 */

const pg = require('./pg');
const { PgDocs, PgLineLog, PgSessions } = require('./pg-docs');
const { PgRawStore } = require('./pg-raw-store');

function usingPostgres() {
  return pg.configured();
}

/* One PgDocs is enough for every document store — they share a table and differ
   only by key — but the line logs need one each, keyed by what was their
   filename. Built once per process; they hold no state beyond the key. */
let _cache = null;

function backends() {
  if (!usingPostgres()) {
    /* Every store treats a null backend as "use the file path", so this is the
       whole of the fallback. */
    return {
      docs: null, runs: null, audit: null, fires: null,
      evaluations: null, dispatches: null, sessions: null,
    };
  }
  if (!_cache) {
    const docs = new PgDocs();
    _cache = {
      docs,
      runs: new PgLineLog('runs'),
      audit: new PgLineLog('audit'),
      fires: new PgLineLog('fires'),
      /* The two directory-shaped stores share the docs table and take the same
         object; their namespace is the key prefix each was given. */
      evaluations: docs,
      dispatches: docs,
      sessions: new PgSessions(),
    };
  }
  return _cache;
}

/* The raw store, which is the one with a dedicated table rather than a generic
   backend — see lib/store/pg-raw-store.js for why its read path had to change
   when the others' did not. */
function rawStoreFor(workspaceId, { RawStore, root } = {}) {
  if (!workspaceId) throw new Error('a raw store needs a workspace');
  if (usingPostgres()) return new PgRawStore(workspaceId);
  const path = require('path');
  return new RawStore(path.join(root, workspaceId));
}

/* Documents are fetched together rather than one query per store: `entitiesFor`
   asks `connections.configured()` on essentially every render, so a round trip
   per store would put four of them in front of every page. */
async function hydrateDocuments(stores) {
  if (!usingPostgres()) return;
  const named = Object.entries(stores).filter(([, s]) => s && s.docKey);
  if (!named.length) return;

  const found = await backends().docs.getMany(named.map(([, s]) => s.docKey));
  await Promise.all(named.map(([, s]) => s.hydrate(found.get(s.docKey) ?? null)));
}

function reset() {
  _cache = null;
  pg.reset();
}

module.exports = { usingPostgres, backends, rawStoreFor, hydrateDocuments, reset };
