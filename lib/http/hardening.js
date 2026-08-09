/* Headers and limits that should be on before anyone else can reach this.
 *
 * Phase 10. Nothing here is exotic; the point is that it is present and stated
 * rather than assumed. Each header is chosen for what this app actually does,
 * because a copied header block is how a Content-Security-Policy ends up
 * blocking the fonts the design depends on.
 *
 * **The CSP is the one worth reading.** The converted markup is wall-to-wall
 * inline `style=` attributes — that is how Claude Design emits it and the
 * converter deliberately preserves it — so `style-src` must allow
 * `'unsafe-inline'` or every screen renders unstyled. Scripts are a different
 * matter: all of ours are files under `/assets`, so `script-src` needs no
 * inline permission and does not get one. Saying this out loud matters, because
 * "unsafe-inline" in a policy usually means nobody looked.
 */

const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://unpkg.com'];

/* Meta's ad-preview iframe renders the real ad, video and all, and it is the
 * only way to watch a creative on a token scoped to `ads_read` — reading a
 * video's own source needs `ads_management`.
 *
 * Framing is narrowed to these two hosts rather than opened generally, and
 * nothing else in the policy moves: no script, style, image or connect
 * permission is granted to Facebook. The frame is a sealed box that loads its
 * own content.
 *
 * The URL the browser follows carries a short-lived *preview* token, not the
 * account's access token — the access token never leaves the server. That was
 * checked before this was allowed, and it is the reason it is allowed. */
const PREVIEW_HOSTS = ['https://business.facebook.com', 'https://www.facebook.com'];

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    /* No inline scripts anywhere in this app — see the note above. */
    "script-src 'self'",
    /* Required: the design's markup carries its styling inline. */
    `style-src 'self' 'unsafe-inline' ${FONT_HOSTS.join(' ')}`,
    `font-src 'self' data: ${FONT_HOSTS.join(' ')}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    `frame-src 'self' ${PREVIEW_HOSTS.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

/* `secure` turns on the headers that only make sense over TLS. Setting HSTS on
   a plain-HTTP origin teaches a browser to refuse the only scheme that works. */
function headers({ secure = false } = {}) {
  const set = {
    'Content-Security-Policy': contentSecurityPolicy(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  if (secure) set['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return set;
}

function secureHeaders(options) {
  const set = headers(options);
  return (req, res, next) => {
    for (const [name, value] of Object.entries(set)) res.setHeader(name, value);
    next();
  };
}

/* ── rate limiting ──────────────────────────────────────────────────────── */

/* A fixed window per key. Deliberately small and in-process: it is the right
 * shape for one node and the wrong one for several, exactly like the session
 * store, and both want the same shared backend the day there are two.
 *
 * It exists for the sign-in route above all. Everything else needs a session
 * already, so an attacker who can call it has got past the door; the login is
 * the door.
 */
class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /* Returns what happened rather than a bare boolean, so a caller can tell the
     client how long to wait instead of only that it may not. */
  check(key) {
    const at = this.now();
    const entry = this.hits.get(key);

    if (!entry || at >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: at + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterMs: 0 };
    }

    entry.count += 1;
    if (entry.count > this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - at };
    }
    return { allowed: true, remaining: this.limit - entry.count, retryAfterMs: 0 };
  }

  /* Expired windows are only dropped when their key is next seen, so a burst
     from many addresses would leave entries behind. */
  sweep() {
    const at = this.now();
    let removed = 0;
    for (const [key, entry] of this.hits) {
      if (at >= entry.resetAt) { this.hits.delete(key); removed += 1; }
    }
    return removed;
  }

  get size() { return this.hits.size; }
}

/* Keyed on the socket address. Behind a proxy that would be the proxy, which is
   why `trust proxy` has to be set before this means anything — noted rather
   than silently assumed. */
const addressOf = (req) => (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');

function limit(limiter, { key = addressOf, message = 'too many attempts' } = {}) {
  return (req, res, next) => {
    const result = limiter.check(key(req));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return next();

    const seconds = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(seconds));
    return res.status(429).json({ error: message, retryAfterSeconds: seconds });
  };
}

module.exports = { secureHeaders, headers, contentSecurityPolicy, RateLimiter, limit, addressOf, FONT_HOSTS };
