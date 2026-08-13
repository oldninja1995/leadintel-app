/* Staying logged in.
 *
 * Phase 9. A signed cookie carrying a session id, with the session itself held
 * server-side — the cookie proves which session, the server decides what that
 * session may do. Putting the role in the cookie would mean trusting the
 * browser about permissions, and the exit criterion says enforcement is
 * server-side.
 *
 * The signing secret comes from `LEADINTEL_SECRET`. When it is absent a random
 * one is generated per process and a warning is printed: sessions then survive
 * until restart and no further, which is the right behaviour for a machine
 * with no configured secret and the wrong behaviour to discover silently in
 * production. A hardcoded default would be worse than either.
 *
 * Sessions live in memory. That is honest for a single process and wrong for
 * several — two instances would not share logins — and it moves to a shared
 * store at Phase 10 alongside the sync loop, which has the same shape of
 * problem.
 */

const crypto = require('crypto');

const TTL_MS = 12 * 3600 * 1000;
const COOKIE = 'leadintel_session';

function secret() {
  if (process.env.LEADINTEL_SECRET) return process.env.LEADINTEL_SECRET;
  if (!secret._warned) {
    console.warn('auth: LEADINTEL_SECRET is not set — sessions will not survive a restart');
    secret._warned = true;
  }
  if (!secret._ephemeral) secret._ephemeral = crypto.randomBytes(32).toString('hex');
  return secret._ephemeral;
}

const sign = (value) => crypto.createHmac('sha256', secret()).update(value).digest('hex').slice(0, 32);

/* `id.signature`. Verified in constant time so a forged cookie cannot be
   refined by timing. */
function seal(id) {
  return `${id}.${sign(id)}`;
}

function unseal(cookie) {
  if (typeof cookie !== 'string' || !cookie.includes('.')) return null;
  const index = cookie.lastIndexOf('.');
  const id = cookie.slice(0, index);
  const signature = cookie.slice(index + 1);

  const expected = Buffer.from(sign(id));
  const given = Buffer.from(signature);
  if (expected.length !== given.length) return null;
  return crypto.timingSafeEqual(expected, given) ? id : null;
}

class Sessions {
  /* With a backend these three methods return promises; without one they behave
     exactly as they always have. Every caller goes through `Promise.resolve`,
     which is correct either way — see `authenticate` in ./index.js.

     The in-process Map is not merely slower on a serverless runtime, it is
     wrong: a session minted on one instance is unknown to the next, and the
     user is signed out at random. */
  constructor({ ttl = TTL_MS, backend = null } = {}) {
    this.ttl = ttl;
    this.backend = backend;
    this.store = new Map();
  }

  create(user, { at = Date.now() } = {}) {
    const id = crypto.randomBytes(18).toString('hex');
    const session = { user, createdAt: at, expiresAt: at + this.ttl };
    if (this.backend) {
      return this.backend.put(id, session, session.expiresAt).then(() => ({ id, cookie: seal(id) }));
    }
    this.store.set(id, session);
    return { id, cookie: seal(id) };
  }

  /* Returns the user, or null for a cookie that is forged, unknown or expired
     — three different failures with the same answer, because distinguishing
     them for the caller would leak which sessions exist. */
  read(cookieValue, { at = Date.now() } = {}) {
    const id = unseal(cookieValue);
    if (!id) return this.backend ? Promise.resolve(null) : null;
    if (this.backend) {
      /* Expiry is enforced in the query, so a stale row is never returned even
         if nothing has swept it yet. */
      return this.backend.get(id, { at }).then((session) => (session ? session.user : null));
    }
    const session = this.store.get(id);
    if (!session) return null;
    if (session.expiresAt <= at) {
      this.store.delete(id);
      return null;
    }
    return session.user;
  }

  destroy(cookieValue) {
    const id = unseal(cookieValue);
    if (!id) return this.backend ? Promise.resolve() : undefined;
    if (this.backend) return this.backend.remove(id);
    this.store.delete(id);
    return undefined;
  }

  /* Expired sessions are dropped on read, but a session nobody reads again
     would linger — this is what stops the map growing without bound. */
  sweep({ at = Date.now() } = {}) {
    let removed = 0;
    for (const [id, session] of this.store) {
      if (session.expiresAt <= at) { this.store.delete(id); removed += 1; }
    }
    return removed;
  }

  get size() { return this.store.size; }
}

/* Set on the response. `httpOnly` so script cannot read it, `sameSite=lax` so
   it does not ride cross-site requests, `secure` once there is TLS to be
   secure over — which is Phase 10. */
function cookieHeader(value, { maxAgeMs = TTL_MS, secure = false } = {}) {
  const parts = [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const clearHeader = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/* Express does not parse cookies without middleware, and one header is not
   worth a dependency. */
function fromRequest(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

module.exports = { Sessions, COOKIE, TTL_MS, seal, unseal, cookieHeader, clearHeader, fromRequest };
