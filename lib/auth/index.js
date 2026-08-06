/* The middleware that ties identity, permissions, tenancy and audit together.
 *
 * Phase 9. Two exit criteria, and each has a piece here:
 *
 *   no cross-workspace data access    `req.workspace` comes from the session,
 *                                     never from the request, so a caller
 *                                     cannot ask for another tenant's data by
 *                                     changing a parameter
 *   gated actions enforced and audited `gate` refuses server-side and records
 *                                     the attempt either way
 *
 * The workspace rule is worth stating twice because it is the one that is easy
 * to get subtly wrong: a `?workspace=` parameter that is *checked* against the
 * session is still a parameter somebody will one day forget to check. Taking it
 * only from the session means there is nothing to forget.
 */

const identity = require('./identity');
const permissions = require('./permissions');
const sessions = require('./sessions');
const { AuditLog } = require('./audit');

/* Paths served before a session exists. Everything else requires one. */
/* `/health` is public because a load balancer cannot present credentials, and
   it deliberately carries no tenant data — see the route in server.js. */
const PUBLIC = ['/login', '/assets', '/favicon.ico', '/health'];

const isPublic = (url) => PUBLIC.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));

function create({ store, audit = new AuditLog(), loginPath = '/login' } = {}) {
  const sessionStore = store || new sessions.Sessions();

  /* Attaches `req.user` and `req.workspace`, or redirects to the login. API
     callers get 401 rather than a redirect — a JSON client following a 302 to
     an HTML page is a confusing way to learn it is logged out. */
  function authenticate(req, res, next) {
    if (isPublic(req.path)) return next();

    const user = sessionStore.read(sessions.fromRequest(req));
    if (!user) {
      if ((req.get('accept') || '').includes('text/html')) {
        return res.redirect(`${loginPath}?next=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).json({ error: 'not signed in' });
    }

    req.user = user;
    /* From the session. Never from the request — see the note at the top. */
    req.workspace = user.workspace;
    return next();
  }

  /* Wraps a handler so the action is checked before it runs and recorded
     whichever way it goes. `detail` is computed from the request, so the log
     says what was attempted and not merely that something was. */
  function gate(action, detail = () => null) {
    return (req, res, next) => {
      try {
        permissions.require(req.user, action);
      } catch (err) {
        audit.record({ user: req.user, action, outcome: 'refused', workspace: req.workspace, detail: detail(req) });
        return res.status(403).json({ error: err.message, action });
      }
      audit.record({ user: req.user, action, outcome: 'allowed', workspace: req.workspace, detail: detail(req) });
      return next();
    };
  }

  return { sessions: sessionStore, audit, authenticate, gate, identity, permissions, isPublic };
}

module.exports = { create, identity, permissions, sessions, AuditLog, PUBLIC, isPublic };
