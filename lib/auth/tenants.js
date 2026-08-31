/* Real, self-serve workspaces — the other half of tenancy from identity.js.
 *
 * identity.js's USERS/WORKSPACES are seeded fixtures, hardcoded so isolation
 * could be proven before anyone had signed up (see its own header). This is
 * the store a real /signup writes to: a workspace and its one owner, created
 * at runtime, with a real password nobody printed on a login page.
 *
 * Deliberately a SEPARATE store rather than a rewrite of identity.js. Phase 9's
 * fixtures and the tests built against them stay exactly as they were; this
 * only adds a second place `authenticate()` can find a match. Nothing else in
 * the app cares which store a user came from — `req.workspace` is read off
 * `user.workspace` (lib/auth/index.js), `ingest.storeFor(workspaceId)`
 * partitions by that same string, and permissions.js checks `user.role` — so a
 * dynamically created workspace works everywhere a seeded one does without
 * either of those modules changing.
 *
 * Same doc-store shape as lib/site-config.js and lib/account-overrides.js:
 * one JSON document, lazy read/write, the optional Postgres backend seam.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE = path.join(__dirname, '..', '..', 'var', 'tenants.json');
const DOC_KEY = 'tenants';

const ROLE = 'owner';
const ROLE_NAME = 'Owner';
const TRIAL_DAYS = 14;

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function verify(password, salt, expected) {
  const candidate = Buffer.from(hash(password, salt));
  const known = Buffer.from(expected);
  if (candidate.length !== known.length) return false;
  return crypto.timingSafeEqual(candidate, known);
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
}

function initialsOf(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (words[0]?.[0] || 'W').toUpperCase() + (words[1]?.[0] || '').toUpperCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Tenants {
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
    this._state = (stored && typeof stored === 'object') ? stored : { workspaces: {} };
    return this;
  }

  flush() {
    return this._pending;
  }

  state() {
    if (this._state) return this._state;
    if (this.backend) {
      this._state = { workspaces: {} };
      return this._state;
    }
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this._state = { workspaces: {} };
    }
    return this._state;
  }

  _save() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return this._pending;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n', { mode: 0o600 });
    return undefined;
  }

  /* Every record this store has ever issued a workspace id for, seeded ids
     included — checked so a signup can never collide with `parakkat` or
     `kestrel`, which would silently join someone's data to a real customer's. */
  _idTaken(id) {
    const { WORKSPACES } = require('./identity');
    return Boolean(this.state().workspaces[id]) || WORKSPACES.some((w) => w.id === id);
  }

  _uniqueId(name) {
    const base = slugify(name);
    if (!this._idTaken(base)) return base;
    let n = 2;
    while (this._idTaken(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  emailTaken(email) {
    const needle = String(email).trim().toLowerCase();
    return Object.values(this.state().workspaces).some((w) => w.user.email === needle);
  }

  /* Creates a workspace and its owner, hashes the password, and returns the
     same describe() shape identity.js hands a session — so the caller (the
     /signup route) can pass it straight into `sessions.create()` unchanged. */
  create({ workspaceName, ownerName, email, password, plan = 'Starter' }) {
    workspaceName = String(workspaceName || '').trim();
    ownerName = String(ownerName || '').trim();
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');

    if (workspaceName.length < 2) throw new Error('Company / property name is required.');
    if (ownerName.length < 2) throw new Error('Your name is required.');
    if (!EMAIL.test(email)) throw new Error('That does not look like a valid email address.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    if (this.emailTaken(email)) throw new Error('An account with that email already exists — sign in instead.');

    const workspaceId = this._uniqueId(workspaceName);
    const userId = `${workspaceId}-owner`;
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 86400 * 1000).toISOString();

    const record = {
      workspace: {
        id: workspaceId, name: workspaceName, initials: initialsOf(workspaceName),
        plan, createdAt: now.toISOString(), trialEndsAt,
      },
      user: { id: userId, name: ownerName, email, role: ROLE, workspace: workspaceId },
      passwordSalt: salt,
      passwordHash: hash(password, salt),
    };

    const state = this.state();
    state.workspaces[workspaceId] = record;
    this._save();

    return this.describe(record.user);
  }

  describe(user) {
    const record = this.state().workspaces[user.workspace];
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      roleName: ROLE_NAME,
      workspace: user.workspace,
      workspaceName: record ? record.workspace.name : user.workspace,
    };
  }

  /* Matched by email, not id — a real signup does not remember a short
     fixture-style username, and two workspaces could otherwise pick the same
     owner name. Wrong email and wrong password read identically to the
     caller, the same anti-enumeration rule identity.js uses. */
  authenticate(email, password) {
    const needle = String(email || '').trim().toLowerCase();
    const record = Object.values(this.state().workspaces).find((w) => w.user.email === needle);
    if (!record) return null;
    if (!verify(password, record.passwordSalt, record.passwordHash)) return null;
    return this.describe(record.user);
  }

  get(workspaceId) {
    const record = this.state().workspaces[workspaceId];
    return record ? { ...record.workspace } : null;
  }

  list() {
    return Object.values(this.state().workspaces).map((w) => ({ ...w.workspace, ownerName: w.user.name, ownerEmail: w.user.email }));
  }

  reload() { this._state = null; return this; }
}

module.exports = { Tenants, STORE, DOC_KEY, TRIAL_DAYS };
