/* How a connector gets its bytes.
 *
 * A transport answers one question — "give me this source's records of this
 * kind, for this window" — and knows nothing else. Two exist:
 *
 *   fixtureTransport   reads lib/ingest/fixtures/<source>.json
 *   httpTransport      the live one
 *
 * The second was a stub for a long time, on purpose: writing a speculative HTTP
 * client for five APIs whose auth, pagination and rate limits could not be
 * tested would have been five guesses dressed as progress. That reasoning has
 * not changed — it is now applied per source rather than to all of them. A
 * source with a request shape written from its vendor's documentation is pulled
 * for real; the rest still throw with the reason. See ./http.
 */

const fs = require('fs');
const path = require('path');
const httpConnectors = require('./http');

const FIXTURES = path.join(__dirname, 'fixtures');

/* Which field carries the record's own timestamp, per kind. Windowing has to
   happen somewhere, and the source is the only place that knows. */
const DATE_FIELD = {
  campaign_day: 'date', adset_day: 'date', ad_day: 'date',
  adgroup_day: 'date', keyword_day: 'date', inventory_day: 'date',
  creative: 'updated_at',
  lead: 'created_at', lead_event: 'at', deal: 'updated_at',
  booking: 'updated_at', folio: 'closed_at',
  /* A reservation is pulled by when it last *changed*, not by when the stay is
     — a cancellation arriving today is news about a stay next month, and a
     window over `check_in` would never fetch it. */
  reservation: 'updated_at',
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

/* The live transport.
 *
 * Two things have to be true before a source can be pulled for real, and they
 * fail differently, so they are reported differently:
 *
 *   a credential   stored on the Connections screen (lib/connections.js)
 *   a request shape written from the vendor's documentation (./http)
 *
 * A source with neither, or with only the first, still gets the error that says
 * which half is missing — that was the whole point of the original stub and it
 * stays true for the four sources that have no shape written yet.
 *
 * `fetchImpl` is injected so the paging loop can be tested against a stub. The
 * network call is a parameter here for the same reason it always was: a
 * connector with a hard-wired `fetch` cannot be tested without one.
 */
function httpTransport({ credentials = null, fetchImpl = globalThis.fetch, maxPages = 50 } = {}) {
  return {
    name: 'http',
    credentials,

    async fetch({ source, kind, window }) {
      if (!credentials) {
        throw new Error(
          `no credential stored for ${source.name} — add one on the Connections screen`
        );
      }

      const connector = httpConnectors.get(source.id);
      if (!connector) {
        throw new Error(
          `${source.name} has a credential but no connector: the request shape for its API `
          + '(endpoints per record kind, auth header, pagination) is not written yet. '
          + 'It needs that vendor\'s API documentation, not another key.'
        );
      }

      const missing = (connector.requires || []).filter((field) => !credentials[field]);
      if (missing.length) {
        throw new Error(`${source.name} is missing ${missing.join(', ')} — add it on the Connections screen`);
      }

      const rows = [];
      let cursor = null;
      let page = 0;

      /* Some APIs refuse a page for being too large rather than serving it
         truncated. That is not a rate limit — waiting does not help and the
         identical request never succeeds — so the loop asks for less instead of
         retrying or giving up. A connector that does not know about this simply
         never triggers it. */
      let pageSize = connector.pageSizeFor ? connector.pageSizeFor(kind) : null;
      let reductions = 0;

      /* `for(;;)` rather than `do…while(cursor)`: a page that has to be
         re-requested smaller must repeat the *same* cursor, and on the first
         page that cursor is null — a `while(cursor)` would read the retry as
         the end of the results and stop with nothing. */
      for (;;) {
        /* Awaited, because a connector may have to buy a token before it can
           say what the request is — Google exchanges a refresh token first.
           `fetchImpl` is handed in for exactly that: the exchange is a network
           call the connector makes, and it must be stubbable too. */
        const {
          url, headers = {}, method = 'GET', body = undefined,
        } = await connector.request({ kind, window, credentials, cursor, fetchImpl, pageSize });

        let response;
        try {
          response = await fetchImpl(url, { headers, method, body });
        } catch (err) {
          /* A network failure and a refusal are different problems and the run
             log should not conflate them. */
          throw new Error(`${source.name} could not be reached: ${err.message}`);
        }

        let payload;
        try {
          payload = await response.json();
        } catch (err) {
          throw new Error(`${source.name} returned a body that is not JSON (HTTP ${response.status})`);
        }

        try {
          connector.checkForError(payload, response);
        } catch (err) {
          const canShrink = connector.isTooMuchData
            && connector.isTooMuchData(err)
            && pageSize
            && pageSize > (connector.MIN_PAGE || 25)
            && reductions < 4;

          if (!canShrink) {
            /* Which kind refused matters and was missing: a pull asks for four
               of them and dies on the first failure, so "Meta Ads refused"
               left the actual culprit to be guessed at. */
            err.message = `${err.message} [asking for ${kind}${pageSize ? ` at ${pageSize} per page` : ''}]`;
            throw err;
          }

          /* Quartered rather than halved: this refusal is about how much work
             the far end must do to assemble the page, and that does not fall
             off gently. Same cursor, so nothing is skipped. */
          pageSize = Math.max(connector.MIN_PAGE || 25, Math.floor(pageSize / 4));
          reductions += 1;
          continue;
        }

        const { rows: batch, nextCursor } = connector.extract(payload, { kind });
        rows.push(...batch);
        cursor = nextCursor;
        page += 1;

        if (!cursor) break;

        /* A cap, because a paging bug on the vendor's side or ours should stop
           rather than pull for ever. Reaching it is reported, never silent —
           a truncated pull that looks complete is the worst of both. */
        if (page >= maxPages) {
          throw new Error(
            `${source.name} returned more than ${maxPages} pages for ${kind} — `
            + 'the window is too wide, or paging is not terminating. Nothing was written.'
          );
        }
      }

      return rows;
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
