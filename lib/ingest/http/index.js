/* Which sources have a real request shape written.
 *
 * The registry is deliberately sparse. `transport.js` used to throw the same
 * "no connector" for all five, which was accurate then and would be misleading
 * now that one of them works — a source missing from here still gets that
 * error, and it still names what is missing rather than failing vaguely.
 *
 * What it takes to add one: the vendor's own documentation, read, and a request
 * shape written from it. Not a credential. The four that are absent are absent
 * for specific reasons worth keeping written down:
 *
 *   telecrm      publishes exactly one endpoint — POST .../autoupdatelead — and
 *                it *writes*. The read side ("sync") is referenced in its own
 *                schema descriptions but no path or auth for it is published.
 *                Its account UI does offer Sync tokens whose operations are
 *                GETs, so the endpoints exist; they have to come from an
 *                account, not the internet. Until then TeleCRM arrives by
 *                webhook (lib/auth/webhooks.js), which needs no read API.
 *   pms          has no vendor yet. There is no such thing as "the PMS API".
 *   razorpay     publicly documented and straightforward (Basic auth,
 *                /v1/payments, /v1/refunds) — simply not written yet.
 */

const metaAds = require('./meta-ads');
const googleAds = require('./google-ads');

const CONNECTORS = { [metaAds.id]: metaAds, [googleAds.id]: googleAds };

const get = (sourceId) => CONNECTORS[sourceId] || null;
const has = (sourceId) => Boolean(CONNECTORS[sourceId]);
const list = () => Object.keys(CONNECTORS);

module.exports = { CONNECTORS, get, has, list };
