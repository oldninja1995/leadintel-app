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

function httpTransport() {
  return {
    name: 'http',
    async fetch({ source }) {
      throw new Error(
        `no credentials for ${source.name}: the live transport is not implemented, ` +
        'because there is nothing to authenticate against or test with yet'
      );
    },
  };
}

const TRANSPORTS = { fixture: fixtureTransport, http: httpTransport };

function createTransport(name = process.env.LEADINTEL_TRANSPORT || 'fixture') {
  const make = TRANSPORTS[name];
  if (!make) throw new Error(`unknown transport "${name}" — have ${Object.keys(TRANSPORTS).join(', ')}`);
  return make();
}

module.exports = { createTransport, fixtureTransport, httpTransport, DATE_FIELD };
