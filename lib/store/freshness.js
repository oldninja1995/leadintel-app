/* Whether a cached entity snapshot is still the store's.
 *
 * The invalidation this backs up: `dropEntities` in server.js marks the
 * snapshot stale **in the process that performed the write**. On one long-lived
 * server that is the whole story. On Vercel it is not — the cron that syncs and
 * the instance that renders a page are different lambdas, so a page-serving
 * instance is never told about a sync it did not run. It answers "not stale"
 * for its whole life and serves the snapshot it warmed up with.
 *
 * That is not theoretical. Google Ads spend read ₹83,809 for 1–19 Aug on the
 * Marketing dashboard while the store held ₹93,427: the connector had been
 * reconnected and backfilled that morning and the instance answering the page
 * predated it. Nothing was down, nothing logged, and the figure was simply old.
 *
 * So freshness is asked of the store rather than remembered locally, using the
 * marker lib/store/snapshot.js already defines — `count:max(seq):connected` —
 * which moves if and only if a replay would produce something different. Two
 * properties matter and are what the tests hold:
 *
 *   cheap    the probe is one aggregate query, throttled to `ttl`, so a burst
 *            of requests costs one query rather than one apiece. A *rebuild* is
 *            the expensive thing (it reads the materialised snapshot back, and
 *            once cost a transfer quota), and it happens only on a real change.
 *
 *   safe     a probe that throws serves the cached snapshot. Turning a database
 *            hiccup into a replay storm is the failure this whole file exists
 *            downstream of.
 */

function tracker({ markerFor, ttl = 15_000, now = () => Date.now(), onError = null } = {}) {
  /* The marker each cached snapshot was built against, and when we last
     bothered to ask the store for its own. */
  const known = new Map();
  const checkedAt = new Map();

  async function current(workspace) {
    try {
      return await markerFor(workspace);
    } catch (err) {
      if (onError) onError(workspace, err);
      return null;
    }
  }

  return {
    /* Has the store changed under the snapshot we are holding for `workspace`? */
    async moved(workspace) {
      if (!markerFor) return false;

      const last = checkedAt.get(workspace) || 0;
      if (now() - last < ttl) return false;
      checkedAt.set(workspace, now());

      const marker = await current(workspace);
      if (marker === null) return false;

      /* Nothing recorded means we are holding a snapshot of unknown vintage —
         rebuild once rather than adopt a marker it may predate. */
      const mark = known.get(workspace);
      return mark === undefined || mark !== marker;
    },

    /* Read *before* the rebuild, never after: a sync landing mid-rebuild must
       leave the snapshot looking older than the store so the next probe
       rebuilds again. A marker taken afterwards would claim the entities
       include a write they were built without. */
    marker: (workspace) => (markerFor ? current(workspace) : Promise.resolve(null)),

    record(workspace, marker) {
      known.set(workspace, marker);
      checkedAt.set(workspace, now());
    },

    forget(workspace) {
      known.delete(workspace);
      checkedAt.delete(workspace);
    },
  };
}

module.exports = { tracker };
