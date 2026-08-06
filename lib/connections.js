/* Credentials for the five sources, per workspace.
 *
 * Until now a connector read fixtures because there was nowhere to put a real
 * credential — `lib/ingest/transport.js` had a live transport that threw with
 * its reason, and no way to give it a token. This is that missing piece: a
 * place to store one, per workspace, so connecting a source stops being a code
 * change.
 *
 * **Secrets are encrypted at rest and never leave this module.** `list` and
 * `describe` return which fields are set and when, never what they are. A
 * credential store that could hand a token back to a screen would be one
 * `console.log` away from putting it in a request log. The only way out is
 * `secretsFor`, which the transport calls and nothing else should.
 *
 * AES-256-GCM with a key derived from `LEADINTEL_SECRET`, so the file on disk
 * is useless without the environment. That also means **rotating the secret
 * orphans every stored credential** — they cannot be decrypted and must be
 * re-entered. Stated here rather than discovered later; `decryptable()` reports
 * it rather than throwing on a page render.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'var', 'connections.json');

/* What each source needs before it can be called. Field names are the ones the
   source's own documentation uses, so somebody pasting from a dashboard is not
   also translating. `secret: true` means never render it back. */
const REQUIREMENTS = {
  telecrm: {
    name: 'TeleCRM',
    docs: 'https://docs.telecrm.in/',
    fields: [
      /* Confirmed from docs.telecrm.in. The enterprise id sits in the URL path
         rather than a header, so it is required, not optional. */
      { key: 'baseUrl', label: 'API base URL', secret: false, hint: 'https://next-api.telecrm.in' },
      { key: 'enterpriseId', label: 'Enterprise ID', secret: false, hint: 'the id in your integration URL, e.g. 6704d400d099f1891400e138' },
      {
        key: 'apiKey',
        label: 'Bearer token',
        secret: true,
        hint: 'Integration page → Website/API Integration → Create new token (max 3 per workspace)',
      },
      {
        key: 'tokenType',
        label: 'Token type',
        secret: false,
        optional: true,
        /* Worth recording: LeadIntel reads *out* of TeleCRM, and the documented
           Async API only writes leads *in*. A token created as "Async" will not
           serve this app however valid it is. */
        hint: 'Async or Sync — LeadIntel reads, so it needs a Sync token; an Async token only writes leads into TeleCRM',
      },
    ],
  },
  pms: {
    name: 'Property management system',
    docs: null,
    fields: [
      { key: 'baseUrl', label: 'API base URL', secret: false },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'propertyIds', label: 'Property ids, comma separated', secret: false, optional: true },
    ],
  },
  razorpay: {
    name: 'Razorpay',
    docs: 'https://razorpay.com/docs/api/',
    fields: [
      { key: 'keyId', label: 'Key ID', secret: false, hint: 'starts rzp_live_ or rzp_test_' },
      { key: 'keySecret', label: 'Key secret', secret: true },
    ],
  },
  meta_ads: {
    name: 'Meta Ads',
    docs: 'https://developers.facebook.com/docs/marketing-apis/',
    fields: [
      { key: 'accountId', label: 'Ad account id', secret: false, hint: 'act_XXXXXXXXXX' },
      { key: 'accessToken', label: 'Access token', secret: true, hint: 'a long-lived system user token' },
    ],
  },
  google_ads: {
    name: 'Google Ads',
    docs: 'https://developers.google.com/google-ads/api/docs/start',
    fields: [
      { key: 'customerId', label: 'Customer id', secret: false, hint: '10 digits, no dashes' },
      { key: 'developerToken', label: 'Developer token', secret: true },
      { key: 'refreshToken', label: 'OAuth refresh token', secret: true },
      { key: 'clientId', label: 'OAuth client id', secret: false },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
    ],
  },
};

const SOURCES = Object.keys(REQUIREMENTS);

/* ── encryption ─────────────────────────────────────────────────────────── */

/* Derived rather than used directly, so the session-signing secret and the
   credential-encryption key are not the same bytes. */
function keyFrom(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(`leadintel:connections:${secret}`).digest();
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(payload, key) {
  const [iv, tag, body] = String(payload).split('.');
  if (!iv || !tag || !body) throw new Error('malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

/* ── the store ──────────────────────────────────────────────────────────── */

class Connections {
  constructor({ file = FILE, secret = process.env.LEADINTEL_SECRET } = {}) {
    this.file = file;
    this.key = keyFrom(secret);
    this._state = null;
  }

  state() {
    if (this._state) return this._state;
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this._state = { workspaces: {} };
    }
    return this._state;
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    /* 0600: the file is useless without the key, but a credential store that
       is world-readable is still a bad habit to leave in a repo. */
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n', { mode: 0o600 });
  }

  /* Missing required fields are refused rather than stored half-configured — a
     connection that exists but cannot authenticate is worse than none, because
     the status screen says it is set up. */
  set(workspaceId, source, values, { by = null, at = new Date().toISOString() } = {}) {
    if (!this.key) throw new Error('LEADINTEL_SECRET is not set — credentials cannot be encrypted, so they will not be stored');
    const requirement = REQUIREMENTS[source];
    if (!requirement) throw new Error(`unknown source "${source}" — have ${SOURCES.join(', ')}`);

    const missing = requirement.fields
      .filter((f) => !f.optional && !String((values || {})[f.key] || '').trim())
      .map((f) => f.label);
    if (missing.length) throw new Error(`${requirement.name} needs ${missing.join(', ')}`);

    const stored = {};
    for (const field of requirement.fields) {
      const value = String((values || {})[field.key] || '').trim();
      if (!value) continue;
      stored[field.key] = field.secret
        ? { encrypted: encrypt(value, this.key) }
        : { value };
    }

    const state = this.state();
    state.workspaces[workspaceId] = state.workspaces[workspaceId] || {};
    state.workspaces[workspaceId][source] = { source, fields: stored, configuredAt: at, configuredBy: by, lastTest: null };
    this._save();
    return this.describe(workspaceId, source);
  }

  remove(workspaceId, source) {
    const state = this.state();
    if (!state.workspaces[workspaceId] || !state.workspaces[workspaceId][source]) return false;
    delete state.workspaces[workspaceId][source];
    this._save();
    return true;
  }

  /* **The only path to a plaintext secret.** Called by the transport; nothing
     else should. Returns null when the source is not configured, so a caller
     falls back to fixtures rather than half-authenticating. */
  secretsFor(workspaceId, source) {
    const entry = (this.state().workspaces[workspaceId] || {})[source];
    if (!entry || !this.key) return null;

    const out = {};
    for (const [key, held] of Object.entries(entry.fields)) {
      out[key] = held.encrypted ? decrypt(held.encrypted, this.key) : held.value;
    }
    return out;
  }

  /* Whether the stored ciphertext can still be read with the current secret.
     Rotating LEADINTEL_SECRET orphans credentials, and that should surface as
     a status rather than an exception on a page render. */
  decryptable(workspaceId, source) {
    try {
      return Boolean(this.secretsFor(workspaceId, source));
    } catch (err) {
      return false;
    }
  }

  /* Safe to render. Says which fields are set and when — never their values. */
  describe(workspaceId, source) {
    const requirement = REQUIREMENTS[source];
    const entry = (this.state().workspaces[workspaceId] || {})[source] || null;

    return {
      source,
      name: requirement.name,
      docs: requirement.docs,
      configured: Boolean(entry),
      configuredAt: entry ? entry.configuredAt : null,
      configuredBy: entry ? entry.configuredBy : null,
      readable: entry ? this.decryptable(workspaceId, source) : null,
      lastTest: entry ? entry.lastTest : null,
      fields: requirement.fields.map((f) => ({
        key: f.key,
        label: f.label,
        hint: f.hint || null,
        secret: Boolean(f.secret),
        optional: Boolean(f.optional),
        /* Set or not — never the value, not even masked. A mask still leaks
           length. */
        set: Boolean(entry && entry.fields[f.key]),
      })),
    };
  }

  list(workspaceId) {
    return SOURCES.map((source) => this.describe(workspaceId, source));
  }

  recordTest(workspaceId, source, result, { at = new Date().toISOString() } = {}) {
    const state = this.state();
    const entry = (state.workspaces[workspaceId] || {})[source];
    if (!entry) return null;
    entry.lastTest = { at, ok: Boolean(result.ok), detail: result.detail || null };
    this._save();
    return entry.lastTest;
  }

  reload() { this._state = null; return this; }
}

module.exports = { Connections, REQUIREMENTS, SOURCES, FILE, encrypt, decrypt, keyFrom };
