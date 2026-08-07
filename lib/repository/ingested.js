/* The read API, answered from ingested data.
 *
 * Sub-phase 4.6, and the point where Phases 3 and 4 meet. `LEADINTEL_REPO=ingested`
 * swaps this in for the static driver with no view change anywhere — which is
 * the thing Phase 3 was built to buy and, until now, the thing nothing proved.
 *
 * What it does *not* do is as deliberate as what it does.
 *
 * **Structure still comes from the static driver.** `screens`, `navigation` and
 * `subviewGroups` describe the design — which screens exist, how the sidebar
 * groups them, which sub-views a screen declares. None of that is a fact about
 * Meta or the PMS, and no amount of ingested data would ever answer it. Reading
 * it from anywhere else would be inventing a second source of truth for the
 * design.
 *
 * **Only projected collections are replaced.** A resource with no projection is
 * served exactly as the static driver serves it. The alternative — blanking
 * every unprojected screen — would make the driver unusable for the one thing
 * it is for, which is proving the swap works end to end.
 *
 * So a screen is either ingested or authored, never a silent blend, and
 * `report()` says which is which. That report is printed once at boot: a driver
 * that quietly served authored content under an ingested name would defeat its
 * own purpose.
 */

const { assertImplements } = require('./contract');
const ingest = require('../ingest');
const { PROJECTIONS, coverage } = require('./projections');

class IngestedRepository {
  /* `workspace` names whose data this driver reads. Phase 9 partitioned the raw
     store per tenant, so a driver with no workspace would be pointing at the
     directory that contains the tenants — which reads as empty and would look
     like "no data yet" rather than like a mistake. */
  constructor(fallback, { workspace = 'parakkat' } = {}) {
    this.name = 'ingested';
    this.fallback = fallback;
    this.workspace = workspace;
    this._entities = null;
  }

  /* Replaying the raw store on every read would re-parse every JSONL file per
     request. The store only changes when a sync writes, and a driver swap is a
     process-level decision, so the snapshot is taken once and refreshed
     explicitly. */
  entities() {
    if (!this._entities) this._entities = ingest.snapshot({ store: ingest.storeFor(this.workspace) });
    return this._entities;
  }

  refresh() {
    this._entities = null;
    return this;
  }

  /* — structure: the design's, not the sources' — */
  screens() { return this.fallback.screens(); }
  navigation(activeSlug) { return this.fallback.navigation(activeSlug); }
  subviewGroups(view) { return this.fallback.subviewGroups(view); }
  resources() { return this.fallback.resources(); }

  async read(resource, params = {}) {
    const base = await this.fallback.read(resource, params);
    const projection = PROJECTIONS[resource];
    if (!base || !projection) return base;

    /* The projection returns only the collections it can answer; everything
       else on the payload — headings, tab strips, chart scaffolding — is the
       design's own structure and stays.

       `params` reaches the projection because some screens are a *selection*:
       the creative detail overlay shows one creative, named by the request, and
       a projection that could not see which would have to guess — which is
       exactly the bug where every card opened the same panel. */
    return { ...base, ...projection(this.entities(), params) };
  }

  /* Which screens this driver actually answers for, and how completely. */
  report() {
    const entities = this.entities();
    return {
      counts: {
        campaignDays: entities.campaignDays.length,
        leads: entities.leads.length,
        bookings: entities.bookings.length,
        payments: entities.payments.length,
      },
      projected: Object.keys(PROJECTIONS),
      coverage: Object.fromEntries(
        Object.entries(PROJECTIONS).map(([resource, project]) => [resource, coverage(project(entities))])
      ),
    };
  }
}

/* Printed once at boot rather than logged per request: the shape of what this
   driver can answer is a property of the fixtures and the projections, not of
   any one page view. */
function announce(repo) {
  const { counts, coverage: cov } = repo.report();
  const entities = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`repository: ingested — ${entities}`);

  for (const [resource, collections] of Object.entries(cov)) {
    for (const c of collections) {
      const note = c.declined.length ? ` · ${c.declined.length}/${c.fields} fields not derivable (${c.declined.join(', ')})` : '';
      console.log(`  ${resource}.${c.collection}: ${c.rows} rows${note}`);
    }
  }
  console.log('  every other screen is served by the static driver — see lib/repository/ingested.js');
}

module.exports = (fallback, options) => {
  const repo = assertImplements(new IngestedRepository(fallback, options), 'ingested');
  if (process.env.LEADINTEL_REPO_QUIET !== 'on') announce(repo);
  return repo;
};
module.exports.IngestedRepository = IngestedRepository;
