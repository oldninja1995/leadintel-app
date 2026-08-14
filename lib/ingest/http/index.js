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
 *   pms          has no vendor yet. There is no such thing as "the PMS API".
 *   razorpay     publicly documented and straightforward (Basic auth,
 *                /v1/payments, /v1/refunds) — simply not written yet.
 *
 * **TeleCRM was in that list for five sessions and should not have been.** The
 * note read "publishes exactly one endpoint and it *writes*", which is true of
 * `https://docs.telecrm.in/` — a document titled "Telecrm Async APIs". The read
 * side is fully published at `https://docs.telecrm.in/sync`, on a different
 * host, unlinked from the async page and absent from search. The lesson is not
 * about TeleCRM: a vendor's documentation root is not necessarily all of its
 * documentation, and "no read API is published" is a claim worth one more probe
 * before it goes in a comment.
 */

const metaAds = require('./meta-ads');
const googleAds = require('./google-ads');
const telecrm = require('./telecrm');

const CONNECTORS = { [metaAds.id]: metaAds, [googleAds.id]: googleAds, [telecrm.id]: telecrm };

const get = (sourceId) => CONNECTORS[sourceId] || null;
const has = (sourceId) => Boolean(CONNECTORS[sourceId]);
const list = () => Object.keys(CONNECTORS);

module.exports = { CONNECTORS, get, has, list };
