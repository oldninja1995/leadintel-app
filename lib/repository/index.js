/* Repository selection.
 *
 * `LEADINTEL_REPO` picks the implementation; there is one today. Reads are
 * checked against `schemas/<resource>.json` in development regardless of which
 * one is in use — the check belongs to the contract, not to any implementation,
 * so a new driver inherits it on the day it is written.
 */

const { assertImplements } = require('./contract');
const schema = require('../schema');

const DRIVERS = {
  static: () => require('./static')(),
  /* Ingested answers what the canonical entities can and hands everything else
     to static — see lib/repository/ingested.js for why that is a seam rather
     than a fallback. `workspace` names whose raw store it reads (Phase 9). */
  ingested: (options) => require('./ingested')(require('./static')(), options),
};

/* Wraps `read` so every payload that leaves the repository is checked. Keys the
   route supplies itself are not required here — the view payload is checked
   separately, where they are. */
function checked(repo) {
  const read = repo.read.bind(repo);
  repo.read = async (resource, params) => {
    const payload = await read(resource, params);
    if (payload) schema.audit(resource, payload, { label: `${repo.name} repository read of "${resource}"` });
    return payload;
  };
  return repo;
}

/* `connections` is threaded through rather than looked up by the driver: which
   sources are connected decides whether their demo rows still replay, and a
   test needs to state that without writing a credential file. */
function createRepository({
  driver = process.env.LEADINTEL_REPO || 'static', workspace = 'parakkat', connections = null,
  /* Optional. The host passes the function that builds — and caches — the
     entity set, so the driver shares it instead of replaying the store a second
     time. See the constructor note in ingested.js. */
  snapshot = null, fillSnapshot = null,
  /* Whether to print the coverage report on the first hydration. It is a boot
     diagnostic, written for a process that boots once — and `report()` runs
     every projection over the whole entity set to produce it, which on a
     serverless runtime is a second of somebody's first page load, repeated on
     every cold instance, for a log line. See announce() in ingested.js. */
  announce = true,
} = {}) {
  const make = DRIVERS[driver];
  if (!make) {
    throw new Error(`unknown repository driver "${driver}" — have ${Object.keys(DRIVERS).join(', ')}`);
  }
  const repo = assertImplements(make({ workspace, connections, snapshot, fillSnapshot, announce }), driver);
  return schema.enabled ? checked(repo) : repo;
}

module.exports = { createRepository, DRIVERS };
