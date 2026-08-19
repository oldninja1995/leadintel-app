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

/* Every read the request edge is about to make, in one round trip.
 *
 * `hydrateDocuments` below already batches the document stores, and that left
 * five reads still going one at a time: two directory listings and three line
 * logs. Server-Timing on production had them completing exactly 200ms apart —
 * eight asks, 1.6 seconds, before a page began rendering.
 *
 * This asks for all of them at once and hands each store its rows, so the
 * `hydrate()` calls that follow find their answers already there. Nothing
 * about those stores changes: they still read the same shapes through the
 * same methods, and a store whose rows were not primed still fetches its own.
 *
 * The plan is passed in rather than discovered here, because which limit each
 * log hydrates with belongs to the log — a prime keyed on 500 does not satisfy
 * a read asking for 1,000, and it must not, or a caller would silently get a
 * shorter history than it asked for.
 *
 * Best effort throughout. A failure here means the stores fetch for
 * themselves exactly as they did before, which is slow and correct. */
async function prefetch({ documents = {}, lists = [], logs = [] } = {}) {
  if (!usingPostgres()) return;
  const b = backends();

  const jobs = [];

  const keys = Object.values(documents).filter((s) => s && s.docKey).map((s) => s.docKey).sort();
  if (keys.length) {
    jobs.push({ name: 'docs', query: PgDocs.manyQuery(keys), apply: (rows) => b.docs.primeMany(keys, rows) });
  }

  for (const store of lists) {
    if (!store || !store.prefix || !store.backend) continue;
    const prefix = store.prefix;
    jobs.push({ name: prefix.replace(/\W+$/, ''), query: PgDocs.listQuery(prefix), apply: (rows) => store.backend.primeList(prefix, rows) });
  }

  for (const { store, kind, limit } of logs) {
    const log = store && store.backend;
    if (!log || typeof log.lastQuery !== 'function') continue;
    if (kind === 'hydrate') {
      jobs.push({ name: log.key, query: log.hydrateQuery(limit), apply: (rows) => log.primeHydrate(limit, rows) });
    } else {
      jobs.push({ name: log.key, query: log.lastQuery(limit), apply: (rows) => log.primeLast(limit, rows) });
    }
  }

  if (!jobs.length) return;

  try {
    await pg.ensureSchema();
    const results = await pg.batch(jobs.map((j) => j.query));
    if (!Array.isArray(results) || results.length !== jobs.length) return;
    jobs.forEach((job, i) => job.apply(results[i]));
    /* Rows AND bytes moved, per job, plus which driver moved them.
     *
     * Rows alone were not enough to act on: "runs:429" is the same note
     * whether those rows are 40KB or 900KB, and the second is a transfer bill
     * as well as a wait. The driver is here because the two have round-trip
     * costs an order apart and which one a deployment is on is otherwise
     * invisible — this deployment moved off Neon's HTTP driver, which silently
     * turned every batched read back into one query at a time. */
    const volume = (rows) => (rows || []).reduce((n, r) => n + ((r && (r.line || r.value)) || '').length, 0);
    const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
    return `${pg.driver()} ${jobs.map((job, i) => `${job.name}:${(results[i] || []).length}/${kb(volume(results[i]))}`).join(' ')}`;
  } catch (err) {
    console.warn('store: prefetch failed, each store will read for itself —', err.message);
  }
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

module.exports = { usingPostgres, backends, rawStoreFor, prefetch, hydrateDocuments, reset };
