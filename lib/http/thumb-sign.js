'use strict';

/* Signed thumbnail addresses.
 *
 * Creative Intelligence draws ~30 cards and each card's image is a request to
 * `/creatives/:adId/thumbnail`. Looking the ad up meant hydrating the whole
 * entity snapshot per request — on a cold instance an 8 MB read plus a marker
 * query — and thirty of those at once exhausted the Supavisor pool
 * (ECHECKOUTRETRIES): half the images and any page loaded alongside them
 * timed out at 60s.
 *
 * The page already knows every image's address when it renders, so it now
 * puts the address in the link and signs it. The route checks the signature
 * and fetches, touching no store at all. This is still not an open proxy: an
 * address is fetched only if this server signed it for that ad id, and the
 * host allowlist is checked after that as well. */

const crypto = require('crypto');

function secret() {
  if (process.env.LEADINTEL_SECRET) return process.env.LEADINTEL_SECRET;
  /* Per process. A link signed by one instance then fails on another and falls
     back to the lookup path — slower, never wrong. */
  if (!secret._ephemeral) secret._ephemeral = crypto.randomBytes(32).toString('hex');
  return secret._ephemeral;
}

const mac = (adId, url) => crypto.createHmac('sha256', secret())
  .update(`thumb\n${adId}\n${url}`).digest('base64url').slice(0, 32);

/* The query string to append — `u` the address, `s` its signature. */
function signedQuery(adId, url) {
  return `u=${Buffer.from(String(url)).toString('base64url')}&s=${mac(String(adId), String(url))}`;
}

/* The address, if the signature holds; null otherwise. */
function verify(adId, u, s) {
  if (typeof u !== 'string' || typeof s !== 'string' || !u || !s) return null;
  let url;
  try { url = Buffer.from(u, 'base64url').toString('utf8'); } catch (err) { return null; }
  const want = Buffer.from(mac(String(adId), url));
  const got = Buffer.from(s);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return url;
}

module.exports = { signedQuery, verify };
