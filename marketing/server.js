/* LeadIntel — public marketing site, self-serve sign-up and internal ops.
 *
 * A SEPARATE deployment from the signed-in app (../server.js), on its own
 * Vercel project and domain — the user asked for this split explicitly so
 * the product deployment stops carrying the visitor-facing pages. It reuses
 * the app's own code rather than forking it: `lib/`, `views/` and
 * `public/assets` are required by relative path out of the parent directory,
 * so a change to site-config.js or the marketing templates is one edit, not
 * two kept in sync by hand.
 *
 * **It shares the app's Postgres database.** A workspace created by /signup
 * here has to be the SAME workspace the app signs into, and an /admin/config
 * change has to be the SAME config the app's sidebar reads — sharing
 * DATABASE_URL is what makes that true rather than two copies drifting apart.
 *
 * **What it deliberately does NOT do: set a session cookie.** A cookie set
 * on this domain is invisible to the app's domain — cookies do not cross
 * `*.vercel.app` subdomains — so a real cross-domain auth handoff would be
 * needed to auto-sign someone in after /signup. Not built. Instead /signup
 * redirects to the app's own /login, which already accepts the email and
 * password just created (lib/auth/tenants.js, shared via the database).
 * One extra click, not a broken flow.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');

const identity = require('../lib/auth/identity');
const { Connections } = require('../lib/connections');
const hardening = require('../lib/http/hardening');
const store = require('../lib/store');
const { SiteConfig } = require('../lib/site-config');
const { AccountOverrides } = require('../lib/account-overrides');
const { opsAuth } = require('../lib/auth/ops');
const adminAccounts = require('../data/admin-accounts');
const { Tenants } = require('../lib/auth/tenants');

const app = express();
const PORT = process.env.PORT || 3100;

/* The signed-in product's own URL — every internal link this deployment
   cannot itself serve (sign in, the dashboard, Connections) points here. */
const APP_URL = (process.env.LEADINTEL_APP_URL || 'https://leadintel-app.vercel.app').replace(/\/$/, '');

if (process.env.LEADINTEL_PROXIES) app.set('trust proxy', Number(process.env.LEADINTEL_PROXIES));

const TLS = process.env.LEADINTEL_TLS === 'on';
app.use(hardening.secureHeaders({ secure: TLS }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

/* Same fingerprinted-asset scheme as the app (server.js) — the two share the
   literal public/assets directory, so this only needs to exist once. */
const ASSETS = path.join(__dirname, '..', 'public', 'assets');
function fingerprint(name) {
  try {
    const body = fs.readFileSync(path.join(ASSETS, name));
    return crypto.createHash('sha1').update(body).digest('hex').slice(0, 8);
  } catch (err) {
    return '0';
  }
}
const assetVersions = new Map();
app.locals.asset = (name) => {
  if (!assetVersions.has(name)) assetVersions.set(name, fingerprint(name));
  return `/assets/${name}?v=${assetVersions.get(name)}`;
};
app.use('/assets', express.static(ASSETS, { maxAge: '30d' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-cache');
  next();
});

/* production refusal, mirroring server.js's own — a shared database with no
   secret configured here is a store this deployment could corrupt silently. */
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('refusing to start in production: DATABASE_URL is unset — this deployment has nowhere durable to write a sign-up');
}

const backends = store.backends();
const siteConfig = new SiteConfig(undefined, { backend: backends.docs });
const accountOverrides = new AccountOverrides(undefined, { backend: backends.docs });
const tenants = new Tenants(undefined, { backend: backends.docs });
/* Read-only here: onboarding shows connection state for an anonymous
   visitor only (see the /onboarding route below), so this never decrypts a
   real credential — LEADINTEL_SECRET does not need to be set on this
   deployment at all. */
const connections = new Connections({ secret: null });

async function hydrateAll() {
  if (!store.usingPostgres()) return;
  await Promise.all([siteConfig.hydrate(), accountOverrides.hydrate(), tenants.hydrate()]);
}

app.use(async (req, res, next) => {
  try {
    await hydrateAll();
  } catch (err) {
    console.error('marketing: hydrate failed —', err.message);
    return res.status(503).send('Temporarily unavailable — try again shortly.');
  }
  next();
});

app.get('/', (req, res) => res.redirect(303, '/home'));

app.get('/home', (req, res) => {
  res.render('app/home', { cfg: siteConfig.get(), active: 'home', appUrl: APP_URL });
});

app.get('/pricing', (req, res) => {
  res.render('app/pricing', {
    cfg: siteConfig.get(), active: 'pricing', appUrl: APP_URL,
    planDefaults: adminAccounts.PLAN_DEFAULTS, entitlementDefs: adminAccounts.ENTITLEMENTS,
  });
});

app.get('/signup', (req, res) => {
  const cfg = siteConfig.get();
  res.render('app/signup', {
    cfg, active: 'signup', appUrl: APP_URL, error: null,
    values: { plan: adminAccounts.PLAN_DEFAULTS[req.query.plan] ? req.query.plan : cfg.popular },
  });
});

const signupLimiter = new hardening.RateLimiter({ limit: 10, windowMs: 60_000 });

app.post('/signup',
  hardening.limit(signupLimiter, { message: 'too many sign-up attempts' }),
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const cfg = siteConfig.get();
    const body = req.body || {};

    if (!cfg.selfServe || !cfg.registration) {
      return res.render('app/signup', { cfg, active: 'signup', appUrl: APP_URL, error: 'Self-serve sign-up is turned off right now — talk to sales instead.', values: body });
    }

    let user;
    try {
      user = tenants.create({
        workspaceName: body.company,
        ownerName: body.name,
        email: body.email,
        password: body.password,
        plan: adminAccounts.PLAN_DEFAULTS[body.plan] ? body.plan : cfg.popular,
      });
    } catch (err) {
      return res.render('app/signup', { cfg, active: 'signup', appUrl: APP_URL, error: err.message, values: body });
    }

    const settled = tenants.flush();
    if (settled && typeof settled.then === 'function') {
      try { await settled; } catch (err) {
        console.error('signup: tenant store write failed —', err.message);
        return res.render('app/signup', { cfg, active: 'signup', appUrl: APP_URL, error: 'Sign-up could not be saved — try again.', values: body });
      }
    }

    /* No session set here — see the header note. The app's own /login
       already accepts this email/password (same tenants store, same
       database), and /connections is the real next step onboarding used to
       stand in for. */
    return res.redirect(303, `${APP_URL}/login?welcome=1&next=${encodeURIComponent('/connections')}`);
  });

app.get('/onboarding', (req, res) => {
  const cfg = siteConfig.get();
  const featured = ['meta_ads', 'google_ads', 'google_analytics', 'pms'];
  const sourceCards = featured.map((id) => connections.describe('__anonymous__', id));
  res.render('app/onboarding', { cfg, active: 'onboarding', user: null, sourceCards, appUrl: APP_URL });
});

/* ── Internal ops: control plane + accounts ──────────────────────────────── */

app.get('/admin', (req, res) => res.redirect(303, '/admin/accounts'));

function adminAccountRows() {
  const real = [
    ...identity.workspaces().map((w) => ({
      id: w.id, name: w.name, initials: w.initials, real: true,
      sub: w.id === 'parakkat' ? 'Seeded — live customer' : 'Seeded — proves tenant isolation',
      signup: null, status: 'active',
    })),
    ...tenants.list().map((t) => ({
      id: t.id, name: t.name, initials: t.initials, real: true,
      sub: `${t.ownerName} · ${t.ownerEmail}`,
      signup: t.createdAt.slice(0, 10),
      status: new Date(t.trialEndsAt) > new Date() ? 'trial' : 'active',
    })),
  ];
  const sample = adminAccounts.ACCOUNTS.map((a) => ({ ...a, real: false }));
  return [...real, ...sample];
}

app.get('/admin/accounts', opsAuth, (req, res) => {
  const rows = adminAccountRows().map((a) => {
    const override = accountOverrides.get(a.id);
    const plan = (override && override.plan) || a.plan || 'Starter';
    const entitlements = { ...adminAccounts.PLAN_DEFAULTS[plan], ...(override || {}) };
    return { ...a, plan, entitlements, customized: Boolean(override) };
  });
  res.render('app/admin-accounts', {
    active: 'accounts', rows,
    plans: Object.keys(adminAccounts.PLAN_DEFAULTS),
    entitlementDefs: adminAccounts.ENTITLEMENTS,
    supportLevels: adminAccounts.SUPPORT_LEVELS,
  });
});

app.post('/admin/accounts/:id/override', opsAuth, express.urlencoded({ extended: false }), async (req, res) => {
  const body = req.body || {};
  const draft = {};
  if (body.plan) draft.plan = body.plan;
  if (body.support) draft.support = body.support;
  for (const ent of adminAccounts.ENTITLEMENTS) {
    if (body[ent.key] !== undefined && body[ent.key] !== '') draft[ent.key] = Number(body[ent.key]);
  }
  accountOverrides.set(req.params.id, draft);
  const settled = accountOverrides.flush();
  if (settled && typeof settled.then === 'function') {
    try { await settled; } catch (err) { console.error('admin: override save failed —', err.message); }
  }
  res.redirect(303, `/admin/accounts#${req.params.id}`);
});

app.post('/admin/accounts/:id/reset', opsAuth, async (req, res) => {
  accountOverrides.reset(req.params.id);
  const settled = accountOverrides.flush();
  if (settled && typeof settled.then === 'function') {
    try { await settled; } catch (err) { console.error('admin: override reset failed —', err.message); }
  }
  res.redirect(303, `/admin/accounts#${req.params.id}`);
});

app.get('/admin/config', opsAuth, (req, res) => {
  res.render('app/admin-config', { active: 'config', cfg: siteConfig.get() });
});

app.post('/admin/config', opsAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const body = req.body || {};
  const current = siteConfig.get();
  const patch = {
    selfServe: body.selfServe === 'on',
    registration: body.registration === 'on',
    googleSSO: body.googleSSO === 'on',
    seededAuth: body.seededAuth === 'on',
    showBadgeSystem: body.showBadgeSystem === 'on',
    popular: current.tiers[body.popular] ? body.popular : current.popular,
    freeConnections: Number(body.freeConnections) || 0,
    freeLookback: Number(body.freeLookback) || 0,
    freeSeats: Number(body.freeSeats) || 0,
    tiers: {}, modules: {}, connectors: {},
  };
  for (const tier of Object.keys(current.tiers)) {
    const rupees = Number(body.tiers && body.tiers[tier] && body.tiers[tier].price);
    if (!Number.isNaN(rupees) && body.tiers && body.tiers[tier]) patch.tiers[tier] = { price: Math.round(rupees * 100) };
  }
  for (const mod of Object.keys(current.modules)) {
    patch.modules[mod] = Boolean(body.modules && body.modules[mod] === 'on');
  }
  for (const conn of Object.keys(current.connectors)) {
    patch.connectors[conn] = Boolean(body.connectors && body.connectors[conn] === 'on');
  }
  siteConfig.patch(patch);
  const settled = siteConfig.flush();
  if (settled && typeof settled.then === 'function') {
    try { await settled; } catch (err) { console.error('admin: config save failed —', err.message); }
  }
  res.redirect(303, '/admin/config');
});

app.get('/health', (req, res) => res.json({ status: 'ok', usingPostgres: store.usingPostgres() }));

app.use((req, res) => res.status(404).send('Not found.'));

if (require.main === module) {
  app.listen(PORT, () => console.log(`LeadIntel marketing site on http://localhost:${PORT}`));
}

module.exports = app;
