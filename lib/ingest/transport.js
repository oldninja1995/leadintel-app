/* How a connector gets its bytes.
 *
 * A transport answers one question — "give me this source's records of this
 * kind, for this window" — and knows nothing else. Two exist:
 *
 *   fixtureTransport   reads lib/ingest/fixtures/<source>.json
 *   httpTransport      the live one, which cannot be written yet
 *
 * The second is a stub on purpose. Writing a speculative HTTP client for five
 * APIs whose auth, pagination and rate limits cannot be tested would be five
 * guesses dressed as progress; it throws with the reason instead. Everything
 * upstream and downstream of it is real and finished.
 */

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

/* Which field carries the record's own timestamp, per kind. Windowing has to
   happen somewhere, and the source is the only place that knows. */
const DATE_FIELD = {
  campaign_day: 'date', adset_day: 'date', ad_day: 'date',
  adgroup_day: 'date', keyword_day: 'date', inventory_day: 'date',
  creative: 'updated_at',
  lead: 'created_at', lead_event: 'at', deal: 'updated_at',
  booking: 'updated_at', folio: 'closed_at',
  payment: 'created_at', refund: 'created_at',
};

function within(body, kind, window) {
  if (!window || !window.from) return true;
  const field = DATE_FIELD[kind];
  const at = field && body[field];
  if (!at) return true;
  const t = Date.parse(at);
  return Number.isNaN(t) ? true : t >= Date.parse(window.from) && t < Date.parse(window.to);
}

function fixtureTransport() {
  return {
    name: 'fixture',
    async fetch({ source, kind, window }) {
      const file = path.join(FIXTURES, `${source.id}.json`);
      if (!fs.existsSync(file)) return [];
      const all = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (all[kind] || []).filter((body) => within(body, kind, window));
    },
  };
}

/* The live transport. A credential can now be stored (lib/connections.js and
 * the Connections screen), which closes half the gap — but a stored key and a
 * working connector are different things, and this is where that distinction
 * lives.
 *
 * Each source needs its own request shape: endpoint per record kind, auth
 * header, pagination, and the field names its payloads actually use. None of
 * that can be written from a credential alone, and writing it from a guess
 * would produce a connector that looks configured and returns nothing. So this
 * says which half is missing, specifically, rather than failing vaguely.
 */
function httpTransport({ credentials = null } = {}) {
  return {
    name: 'http',
    credentials,
    async fetch({ source }) {
      if (!credentials) {
        throw new Error(
          `no credential stored for ${source.name} — add one on the Connections screen`
        );
      }
      throw new Error(
        `${source.name} has a credential but no connector: the request shape for its API `
        + '(endpoints per record kind, auth header, pagination) is not written yet. '
        + 'It needs that vendor\'s API documentation, not another key.'
      );
    },
  };
}

const TRANSPORTS = { fixture: fixtureTransport, http: httpTransport };

function createTransport(name = process.env.LEADINTEL_TRANSPORT || 'fixture', options = {}) {
  const make = TRANSPORTS[name];
  if (!make) throw new Error(`unknown transport "${name}" — have ${Object.keys(TRANSPORTS).join(', ')}`);
  return make(options);
}

module.exports = { createTransport, fixtureTransport, httpTransport, DATE_FIELD };
