/* Telling a demo payload apart from a real one, after the fact.
 *
 * A source with no credential reads `fixtures/<source>.json`, and what it reads
 * is appended to the raw store exactly like a live payload — same envelope,
 * same path, no marker. That was invisible for as long as every source was on
 * fixtures. It stopped being invisible the day Meta got a credential: the store
 * is append-only, no live pull ever restates a fixture's external id, and so
 * three invented campaigns went on being replayed as current truth beside the
 * real ones. "Munnar Honeymoon — JUL" sat at the top of Campaign Analytics next
 * to campaigns that actually ran.
 *
 * Envelopes written from here on carry `transport`, so origin is simply read
 * off them. The ones already on disk carry nothing, and this is how they are
 * classified: **by identity, not by content.** A stored payload is demo-origin
 * if its external id is one the fixture file would produce.
 *
 * Matching the body instead was the first attempt and it was wrong. The store
 * keeps a superseded line beside its replacement, so a fixture edited after it
 * was ingested leaves an older line that no longer matches any fixture body —
 * which read as a *live* payload, and one live payload is enough to retire
 * every real fixture row beside it. Four of the five seeded leads vanished and
 * the demo revenue went with them. An external id survives an edit to the row
 * it names, which is exactly the property this needs.
 *
 * Read once per source and cached: the fixtures are files in the image, and
 * nothing rewrites them while the process is running.
 */

const fs = require('fs');
const path = require('path');

const { EXTERNAL_ID } = require('./connectors');

const FIXTURES = path.join(__dirname, 'fixtures');

const cache = new Map();

function demoIds(sourceId, kind) {
  const key = `${sourceId}:${kind}`;
  if (cache.has(key)) return cache.get(key);

  const file = path.join(FIXTURES, `${sourceId}.json`);
  const ids = new Set();
  const name = EXTERNAL_ID[kind];

  if (name && fs.existsSync(file)) {
    let parsed = null;
    /* A malformed fixture must not take the store down with it. Nothing
       matches, every stored record reads as real, and the screens show what
       they showed before this file existed. */
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    for (const body of (parsed && parsed[kind]) || []) {
      let id = null;
      /* A fixture the naming rule cannot key is not a match and not a crash. */
      try {
        id = name(body);
      } catch {
        id = null;
      }
      if (id) ids.add(String(id));
    }
  }

  cache.set(key, ids);
  return ids;
}

/* An envelope's origin: what it says, or what its identity implies. */
function fromDemo(envelope) {
  if (envelope.transport) return envelope.transport === 'fixture';
  return demoIds(envelope.source, envelope.kind).has(String(envelope.externalId));
}

/* Whether an envelope is evidence that its source has started reporting for
 * real — which is the thing that retires the demo rows beside it.
 *
 * Not every non-fixture record is. A webhook probe left behind by a test —
 * `{"lead_id":"L-2"}`, no name, no phone, no stage — is not the CRM reporting a
 * lead, and treating it as one retired the four seeded leads and every figure
 * derived from them. A body carrying nothing but the field its external id is
 * read from is an identifier, not a report, and it decides nothing.
 */
function retiresDemo(envelope) {
  if (fromDemo(envelope)) return false;
  const body = envelope.body;
  if (!body || typeof body !== 'object') return false;
  return Object.keys(body).length > 1;
}

module.exports = { demoIds, fromDemo, retiresDemo };
