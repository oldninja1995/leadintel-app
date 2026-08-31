/* Gate for the internal ops screens: /admin/accounts and /admin/config.
 *
 * There is no staff/admin role in the tenant identity model — identity.js
 * models seven roles across two seeded *workspaces*, and these screens are
 * cross-tenant by nature (an ops accounts list spans every workspace at
 * once), so they sit outside that model rather than bolting an "admin" role
 * onto it. That would let a workspace role imply cross-tenant access, which
 * is exactly what Phase 9 (see lib/auth/index.js) was built to rule out.
 *
 * A single shared credential over HTTP Basic Auth is the same spirit as
 * CRON_SECRET for /cron/sync: the caller is staff running the app from a
 * browser, not a workspace user, so a session has nothing to attach to.
 * OPS_USER/OPS_PASSWORD default to a fixture pair for local work, the same
 * way the seeded logins print their password in the open — see the
 * production refusal in server.js for why that default cannot ship live.
 */

const crypto = require('crypto');

const DEFAULT_USER = 'ops';
const DEFAULT_PASSWORD = 'leadintel-ops';

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function credentials() {
  return {
    user: process.env.OPS_USER || DEFAULT_USER,
    password: process.env.OPS_PASSWORD || DEFAULT_PASSWORD,
  };
}

function opsAuth(req, res, next) {
  const { user, password } = credentials();
  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch (err) {
      decoded = '';
    }
    const sep = decoded.indexOf(':');
    const gotUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const gotPass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (timingSafeEqualStr(gotUser, user) && timingSafeEqualStr(gotPass, password)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="LeadIntel internal ops"');
  return res.status(401).send('Authentication required.');
}

module.exports = { opsAuth, credentials, DEFAULT_USER, DEFAULT_PASSWORD };
