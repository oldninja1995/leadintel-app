/* Per-account plan/entitlement overrides on the internal ops Accounts panel.
 *
 * Modeled on lib/layout.js's `Layouts`: one JSON document, lazy read/write,
 * the same optional Postgres backend seam. An account with no entry here is
 * simply on its plan's defaults (data/admin-accounts.js PLAN_DEFAULTS) —
 * "customized" is a fact worth storing, "on the plan" is not a fact at all.
 */

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'var', 'account-overrides.json');
const DOC_KEY = 'account-overrides';

class AccountOverrides {
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

  /* The draft for one account, or null if it has never been customized. */
  get(id) {
    const stored = this.state()[id];
    return stored && typeof stored === 'object' ? stored : null;
  }

  set(id, draft) {
    const state = { ...this.state(), [id]: draft };
    this._state = state;
    this._write();
    return draft;
  }

  reset(id) {
    const state = { ...this.state() };
    delete state[id];
    this._state = state;
    this._write();
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

module.exports = { AccountOverrides, STORE, DOC_KEY };
