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
} = {}) {
  const make = DRIVERS[driver];
  if (!make) {
    throw new Error(`unknown repository driver "${driver}" — have ${Object.keys(DRIVERS).join(', ')}`);
  }
  const repo = assertImplements(make({ workspace, connections }), driver);
  return schema.enabled ? checked(repo) : repo;
}

module.exports = { createRepository, DRIVERS };
