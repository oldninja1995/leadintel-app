/* Site-wide product & marketing configuration.
 *
 * Modeled directly on lib/layout.js's `Layouts`: one JSON document, lazy
 * read/write, the same optional Postgres backend seam as every other store
 * in lib/store/index.js. This is not per-workspace — it is the one dial a
 * small ops team turns for the whole product: plan prices, which app modules
 * are visible in the real sidebar, which connectors onboarding offers, and
 * whether the public site advertises self-serve signup at all.
 *
 * Read by /pricing, /signup, /onboarding, the real app's navGroups (see
 * lib/repository/static.js), and written by /admin/config.
 */

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'var', 'site-config.json');
const DOC_KEY = 'site-config';

/* Ported from the design canvas's own `cfg` state (LeadIntel v2.dc.html) —
   these are the plan numbers and defaults the mockup shipped with. */
const DEFAULTS = {
  tiers: {
    Starter: { name: 'Starter', price: 250000 },
    Growth: { name: 'Growth', price: 500000 },
    Enterprise: { name: 'Enterprise', price: 850000 },
  },
  popular: 'Growth',
  freeConnections: 2,
  freeLookback: 14,
  freeSeats: 1,
  /* Keyed by the exact screen name in data/screens.js, so filtering the real
     sidebar is a straight lookup — see lib/repository/static.js#navigation. */
  modules: {
    'Meta Ads Analytics': true,
    'Google Ads Analytics': true,
    'Creative Intelligence': true,
    'Audience Analytics': true,
    'Attribution': true,
    'Website Analytics': true,
    'AI Command Center': true,
    'Reports & Dashboards': true,
    'CRM Dashboard': true,
    'Lead Intelligence': true,
    'Sales Pipeline': true,
    'Sales Analytics': true,
  },
  connectors: { google: true, meta: true, pms: true, crm: true },
  selfServe: true,
  registration: true,
  googleSSO: true,
  seededAuth: true,
  showBadgeSystem: true,
};

/* One level of merge is enough for this shape: every nested value (tiers.*,
   modules.*, connectors.*) is itself a flat object or a primitive, so this
   never needs to recurse past depth 2. */
function mergeConfig(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = { ...base[key], ...value };
      /* Tier patches are one level deeper still (tiers.Growth.price). */
      for (const [k2, v2] of Object.entries(value)) {
        if (v2 && typeof v2 === 'object' && base[key][k2] && typeof base[key][k2] === 'object') {
          out[key][k2] = { ...base[key][k2], ...v2 };
        }
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

class SiteConfig {
  constructor(file = STORE, { backend = null, docKey = DOC_KEY } = {}) {
    this.file = file;
    this.backend = backend;
    this.docKey = docKey;
    this._state = null;
    this._pending = null;
  }

  async hydrate(value = undefined) {
    if (!this.backend) return this;
    const stored = value === undefined ? await this.backend.get(this.docKey) : value;
    this._state = stored && typeof stored === 'object' ? stored : {};
    return this;
  }

  flush() {
    return this._pending;
  }

  state() {
    if (this._state) return this._state;
    if (this.backend) {
      this._state = {};
      return this._state;
    }
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this._state = {};
    }
    return this._state;
  }

  /* Defaults layered under whatever has been saved, so a field nobody has
     ever touched still renders — the same reason a card added to a screen
     later shows for everybody in lib/layout.js. */
  get() {
    return mergeConfig(DEFAULTS, this.state());
  }

  patch(partial) {
    const next = mergeConfig(this.get(), partial);
    this._state = next;
    this._write();
    return next;
  }

  _write() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2));
  }
}

module.exports = { SiteConfig, STORE, DOC_KEY, DEFAULTS };
