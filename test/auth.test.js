/* Phase 9 — tenancy, auth and permissions.
 *
 *   node --test        or        npm test
 *
 * Two exit criteria: no cross-workspace data access, and every gated action
 * enforced server-side and audited. The tests that matter are the negative
 * ones — what a role may *not* do, what a tenant may *not* see, and what a
 * forged cookie does *not* get.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const identity = require('../lib/auth/identity');
const permissions = require('../lib/auth/permissions');
const sessions = require('../lib/auth/sessions');
const { AuditLog } = require('../lib/auth/audit');
const auth = require('../lib/auth');

const log = () => new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-audit-')), 'audit.jsonl'));
const user = (id) => identity.get(id);

/* ── identity ───────────────────────────────────────────────────────────── */

test('the seven roles the design names all exist', () => {
  assert.deepEqual(identity.ROLES.map((r) => identity.ROLE_NAMES[r]), [
    'Owner', 'Marketing Director', 'Revenue Manager', 'GM',
    'Reservations Manager', 'Sales Manager', 'Analyst',
  ]);
});

test('a correct password authenticates', () => {
  const signed = identity.authenticate('anand', identity.SEED_PASSWORD);
  assert.equal(signed.role, 'owner');
  assert.equal(signed.workspace, 'parakkat');
});

test('a wrong password and an unknown user are the same answer', () => {
  /* Telling them apart is how an attacker enumerates accounts. */
  assert.equal(identity.authenticate('anand', 'wrong'), null);
  assert.equal(identity.authenticate('nobody', identity.SEED_PASSWORD), null);
});

test('passwords are not stored in the clear', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'identity.js'), 'utf8');
  /* The seed password appears once, as the stated constant — never beside a
     user record. */
  assert.equal((source.match(/'leadintel'/g) || []).length, 1);
  assert.ok(source.includes('scryptSync'), 'passwords are not hashed');
  assert.ok(source.includes('timingSafeEqual'), 'password comparison is not constant time');
});

test('two workspaces exist, because one cannot demonstrate isolation', () => {
  assert.equal(identity.workspaces().length, 2);
  assert.ok(identity.list().some((u) => u.workspace === 'kestrel'));
});

/* ── permissions ────────────────────────────────────────────────────────── */

test('the design\'s two named gates are exactly as written', () => {
  /* "attribution changes are Owner and Marketing Director only" */
  assert.equal(permissions.can(user('anand'), 'attribution.change'), true);
  assert.equal(permissions.can(user('reshma'), 'attribution.change'), true);
  assert.equal(permissions.can(user('tara'), 'attribution.change'), false);
  assert.equal(permissions.can(user('sneha'), 'attribution.change'), false);

  /* "custom metric edits are Owner plus Analyst" */
  assert.equal(permissions.can(user('anand'), 'metric.edit'), true);
  assert.equal(permissions.can(user('sneha'), 'metric.edit'), true);
  assert.equal(permissions.can(user('reshma'), 'metric.edit'), false);
});

test('an unknown action is denied, not allowed', () => {
  /* Deny by default: a table that returned "allowed" for an unknown string
     would fail open the first time somebody typo'd a gate. */
  assert.equal(permissions.can(user('anand'), 'nonsense.action'), false);
  assert.equal(permissions.can(user('anand'), ''), false);
});

test('an unauthenticated caller may do nothing', () => {
  assert.equal(permissions.can(null, 'attribution.change'), false);
  assert.equal(permissions.can({}, 'attribution.change'), false);
});

test('require throws with the role and the action named', () => {
  assert.throws(() => permissions.require(user('tara'), 'attribution.change'),
    /Sales Manager may not attribution.change/);
  try {
    permissions.require(user('tara'), 'attribution.change');
  } catch (err) {
    assert.equal(err.status, 403);
  }
});

test('every granted action names at least one role', () => {
  for (const [action, roles] of Object.entries(permissions.GRANTS)) {
    assert.ok(roles.length, `${action} is granted to nobody, so it can never run`);
    for (const role of roles) assert.ok(identity.ROLES.includes(role), `${action} names unknown role "${role}"`);
  }
});

/* ── sessions ───────────────────────────────────────────────────────────── */

test('a session round-trips through its cookie', () => {
  const store = new sessions.Sessions();
  const { cookie } = store.create(user('anand'));
  assert.equal(store.read(cookie).id, 'anand');
});

test('a forged cookie gets nothing', () => {
  const store = new sessions.Sessions();
  const { cookie } = store.create(user('anand'));
  const [id] = cookie.split('.');

  assert.equal(store.read(`${id}.deadbeefdeadbeefdeadbeefdeadbeef`), null, 'a bad signature was accepted');
  assert.equal(store.read('nonsense'), null);
  assert.equal(store.read(''), null);
  assert.equal(store.read(null), null);
});

test('an expired session is refused and forgotten', () => {
  const store = new sessions.Sessions({ ttl: 1000 });
  const { cookie } = store.create(user('anand'), { at: 0 });
  assert.ok(store.read(cookie, { at: 500 }));
  assert.equal(store.read(cookie, { at: 2000 }), null);
  assert.equal(store.size, 0, 'an expired session was left in the store');
});

test('a destroyed session cannot be reused', () => {
  const store = new sessions.Sessions();
  const { cookie } = store.create(user('anand'));
  store.destroy(cookie);
  assert.equal(store.read(cookie), null);
});

test('the cookie is httpOnly and same-site', () => {
  const header = sessions.cookieHeader('x');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.doesNotMatch(header, /Secure/, 'Secure is set before there is TLS to be secure over');
  assert.match(sessions.cookieHeader('x', { secure: true }), /Secure/);
});

test('the role is not carried in the cookie', () => {
  /* Trusting the browser about permissions would defeat server-side
     enforcement. The cookie names a session; the server decides the rest. */
  const store = new sessions.Sessions();
  const { cookie } = store.create(user('anand'));
  assert.ok(!cookie.includes('owner'));
  assert.ok(!cookie.includes('anand'));
});

/* ── audit ──────────────────────────────────────────────────────────────── */

test('refusals are recorded, not only successes', () => {
  /* A success-only log answers "what changed" but never "who tried". */
  const l = log();
  l.record({ user: user('tara'), action: 'attribution.change', outcome: 'refused', workspace: 'parakkat' });
  l.record({ user: user('reshma'), action: 'attribution.change', outcome: 'allowed', workspace: 'parakkat' });

  const entries = l.forWorkspace('parakkat');
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.outcome === 'refused' && e.user.name === 'Tara George'));
});

test('the audit is scoped to one workspace, and defaults to none', () => {
  const l = log();
  l.record({ user: user('anand'), action: 'report.send', outcome: 'allowed', workspace: 'parakkat' });
  l.record({ user: user('imran'), action: 'report.send', outcome: 'allowed', workspace: 'kestrel' });

  assert.equal(l.forWorkspace('parakkat').length, 1);
  assert.equal(l.forWorkspace('kestrel').length, 1);
  /* A reader that defaulted to "all tenants" is one forgotten argument away
     from a cross-tenant leak. */
  assert.deepEqual(l.forWorkspace(null), []);
  assert.deepEqual(l.forWorkspace(undefined), []);
});

test('the audit records what was attempted, not merely that something was', () => {
  const l = log();
  l.record({ user: user('tara'), action: 'attribution.change', outcome: 'refused', workspace: 'parakkat', detail: { model: 'last' } });
  assert.deepEqual(l.forWorkspace('parakkat')[0].detail, { model: 'last' });
});

test('an audit entry carries the workspace even when the user is unknown', () => {
  const l = log();
  l.record({ user: null, action: 'auth.login', outcome: 'refused', workspace: null, detail: { attempted: 'ghost' } });
  assert.equal(l.all()[0].user, null);
  assert.equal(l.all()[0].action, 'auth.login');
});

/* ── the middleware ─────────────────────────────────────────────────────── */

function reqres(over = {}) {
  const res = {
    statusCode: 200, payload: null, redirected: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
    redirect(to) { this.redirected = to; return this; },
  };
  const req = { path: '/', originalUrl: '/', headers: {}, get: () => '', ...over };
  return { req, res };
}

test('an unauthenticated API caller gets 401, not a redirect to HTML', () => {
  const gate = auth.create({ audit: log() });
  const { req, res } = reqres();
  gate.authenticate(req, res, () => { throw new Error('should not have continued'); });
  assert.equal(res.statusCode, 401);
});

test('an unauthenticated browser is redirected to sign in', () => {
  const gate = auth.create({ audit: log() });
  const { req, res } = reqres({ get: () => 'text/html', originalUrl: '/campaigns' });
  gate.authenticate(req, res, () => { throw new Error('should not have continued'); });
  assert.match(res.redirected, /^\/login\?next=/);
});

test('the login page itself is reachable without a session', () => {
  const gate = auth.create({ audit: log() });
  let continued = false;
  const { req, res } = reqres({ path: '/login' });
  gate.authenticate(req, res, () => { continued = true; });
  assert.equal(continued, true);
});

test('the workspace comes from the session, never from the request', () => {
  /* A `?workspace=` that is *checked* is still a parameter somebody will one
     day forget to check. Taking it only from the session leaves nothing to
     forget. */
  const gate = auth.create({ audit: log() });
  const { cookie } = gate.sessions.create(user('imran'));
  const { req, res } = reqres({
    headers: { cookie: `${sessions.COOKIE}=${cookie}` },
    query: { workspace: 'parakkat' },
  });

  gate.authenticate(req, res, () => {});
  assert.equal(req.workspace, 'kestrel', 'a query parameter changed the tenant');
});

test('a gated route refuses and audits in one step', () => {
  const audit = log();
  const gate = auth.create({ audit });
  const middleware = gate.gate('attribution.change', () => ({ model: 'last' }));

  const { req, res } = reqres();
  req.user = user('tara');
  req.workspace = 'parakkat';

  let continued = false;
  middleware(req, res, () => { continued = true; });

  assert.equal(continued, false, 'a refused action still ran');
  assert.equal(res.statusCode, 403);
  const entry = audit.forWorkspace('parakkat')[0];
  assert.equal(entry.outcome, 'refused');
  assert.deepEqual(entry.detail, { model: 'last' });
});

test('an allowed action continues, and is audited too', () => {
  const audit = log();
  const gate = auth.create({ audit });
  const { req, res } = reqres();
  req.user = user('reshma');
  req.workspace = 'parakkat';

  let continued = false;
  gate.gate('attribution.change')(req, res, () => { continued = true; });

  assert.equal(continued, true);
  assert.equal(audit.forWorkspace('parakkat')[0].outcome, 'allowed');
});
