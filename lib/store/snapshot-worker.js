/* Builds and materialises a workspace's snapshot off the main thread.
 *
 * On the self-hosted server a rebuild is ~25 s of replay and canonicalisation,
 * and on the main thread it stalled every request for seconds at a time while
 * it ran. Here it runs in a worker: the worker replays the store, writes the
 * compressed snapshot row through `snapshot.through`, and answers `done`. The
 * main thread then reads that row back — a decode of a few hundred
 * milliseconds — instead of building it. Nothing but the `ok` flag crosses the
 * thread boundary, so no 70 MB entity set is ever cloned between heaps. */

const { parentPort, workerData } = require('worker_threads');

const snapshot = require('./snapshot');
const ingest = require('../ingest');

(async () => {
  const { workspace, connected, shape } = workerData;
  const started = Date.now();
  await snapshot.through(workspace, {
    connected,
    shape,
    build: () => ingest.snapshot({ store: ingest.storeFor(workspace), connected: new Set(connected) }),
  });
  const read = snapshot.lastRead();
  parentPort.postMessage({ ok: true, ms: Date.now() - started, source: read && read.source });
})().catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
