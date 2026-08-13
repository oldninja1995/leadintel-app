/* Credentials for every source, per workspace.
 *
 * Until now a connector read fixtures because there was nowhere to put a real
 * credential — `lib/ingest/transport.js` had a live transport that threw with
 * its reason, and no way to give it a token. This is that missing piece: a
 * place to store one, per workspace, so connecting a source stops being a code
 * change.
 *
 * **Secrets are encrypted at rest and never leave this module.** `list` and
 * `describe` return which *secret* fields are set and when, never what they
 * are. A credential store that could hand a token back to a screen would be one
 * `console.log` away from putting it in a request log. The only way out is
 * `secretsFor`, which the transport calls and nothing else should.
 *
 * Fields declared `secret: false` are a different thing and are returned in
 * full: an ad account id, an OAuth client id, an API base URL. They are public
 * by construction — a client id travels in the consent URL in the user's own
 * browser — and hiding them costs something real. Google answering
 * `deleted_client` means the stored client id no longer exists in the Cloud
 * console, and the only way to see that is to compare the two.
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

/* ── Paste-time checks ──────────────────────────────────────────────────────
 *
 * A credential dashboard shows several strings that all look alike, and pasting
 * the wrong one is the single most likely way to get this screen wrong. Without
 * a check the wrong string stores happily, the screen says "connected", and the
 * mistake surfaces fifteen minutes later inside a sync log as the vendor's own
 * unhelpful wording — Meta answers "Cannot parse access token", which names
 * neither what was wrong nor what to do.
 *
 * So a value that is *recognisably a different credential* is refused where it
 * is pasted, and the message says which one it looks like. These identify the
 * wrong thing rather than validating the right thing: the aim is to catch the
 * App Secret in the token box, not to predict every shape a vendor might issue.
 * Anything not recognised is stored and left to the vendor to judge, because a
 * check that refuses a valid credential is worse than the error it prevents. */

const looksLikeAppId = (v) => /^\d{10,20}$/.test(v);
const looksLike32Hex = (v) => /^[a-f0-9]{32}$/i.test(v);
const hasInnerSpace = (v) => /\s/.test(v);

/* Meta issues user, page and system-user tokens with an `EAA` prefix. Treated
   as required rather than advisory: every token this app can use has it, and
   the failure it prevents is otherwise silent for a quarter of an hour. */
const META_TOKEN = /^EAA/;

const CHECKS = {
  metaAccessToken: (v) => {
    if (hasInnerSpace(v)) return 'contains a space or line break — the copy picked up more than the token';
    if (looksLikeAppId(v)) return 'looks like your App ID (all digits), not an access token';
    if (looksLike32Hex(v)) return 'looks like your App Secret or Client Token (32 hex characters), not an access token';
    if (!META_TOKEN.test(v)) return 'does not start with "EAA" — Meta access tokens do. Check you copied the token itself';
    if (v.length < 50) return 'is too short for a Meta access token — the copy was probably cut off';
    return null;
  },

  metaAccountId: (v) => {
    if (META_TOKEN.test(v)) return 'is an access token — it belongs in the Access token field';
    if (!/^(act_)?\d{5,}$/.test(v)) return 'should be act_ followed by digits, as shown in Ads Manager';
    return null;
  },

  googleCustomerId: (v) => {
    if (!/^[\d-]{8,}$/.test(v)) return 'should be the 10-digit customer id, with or without dashes';
    return null;
  },

  googleDeveloperToken: (v) => {
    if (v.includes('apps.googleusercontent.com')) return 'is your OAuth client id, not the developer token';
    if (v.startsWith('1//')) return 'is your refresh token, not the developer token';
    return null;
  },

  googleRefreshToken: (v) => {
    if (v.includes('apps.googleusercontent.com')) return 'is your OAuth client id, not the refresh token';
    if (hasInnerSpace(v)) return 'contains a space or line break — the copy picked up more than the token';
    return null;
  },

  googleClientId: (v) => {
    if (v.startsWith('1//')) return 'is your refresh token, not the OAuth client id';
    if (!v.includes('apps.googleusercontent.com')) return 'should end in .apps.googleusercontent.com';
    return null;
  },
};

/* What each source needs before it can be called. Field names are the ones the
   source's own documentation uses, so somebody pasting from a dashboard is not
   also translating. `secret: true` means never render it back. */
const REQUIREMENTS = {
  telecrm: {
    name: 'TeleCRM',
    docs: 'https://docs.telecrm.in/',
    icon: 'ph ph-address-book',
    /* What this source is for, in the product's terms rather than the
       vendor's — the point of connecting it, not what it sells itself as. */
    feeds: 'Leads, first-response times and deals — the CRM side of attribution',
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
    icon: 'ph ph-buildings',
    feeds: 'Bookings, folio revenue and room inventory — occupancy, ADR and RevPAR',
    fields: [
      { key: 'baseUrl', label: 'API base URL', secret: false },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'propertyIds', label: 'Property ids, comma separated', secret: false, optional: true },
    ],
  },
  razorpay: {
    name: 'Razorpay',
    docs: 'https://razorpay.com/docs/api/',
    icon: 'ph ph-credit-card',
    feeds: 'Payments and refunds — what actually settled, against what was invoiced',
    fields: [
      { key: 'keyId', label: 'Key ID', secret: false, hint: 'starts rzp_live_ or rzp_test_' },
      { key: 'keySecret', label: 'Key secret', secret: true },
    ],
  },
  meta_ads: {
    name: 'Meta Ads',
    docs: 'https://developers.facebook.com/docs/marketing-apis/',
    icon: 'ph ph-meta-logo',
    feeds: 'Spend, impressions, clicks and platform-reported leads',
    fields: [
      { key: 'accountId', label: 'Ad account id', secret: false, hint: 'act_XXXXXXXXXX, from Ads Manager', check: CHECKS.metaAccountId },
      {
        key: 'accessToken',
        label: 'Access token',
        secret: true,
        hint: 'a long-lived System User token — starts "EAA" and is several hundred characters. Not the App ID, App Secret or Client Token',
        check: CHECKS.metaAccessToken,
      },
    ],
  },
  google_ads: {
    name: 'Google Ads',
    docs: 'https://developers.google.com/google-ads/api/docs/start',
    icon: 'ph ph-google-logo',
    feeds: 'Spend in micros, impressions, clicks and conversions',
    fields: [
      { key: 'customerId', label: 'Customer id', secret: false, hint: 'the account to read, 10 digits — dashes are stripped', check: CHECKS.googleCustomerId },
      {
        key: 'developerToken',
        label: 'Developer token',
        secret: true,
        /* Worth recording: this one is applied for, not generated, and the
           level it is granted at decides whether it can read anything real. */
        hint: '22 characters, from ads.google.com/aw/apicenter — needs a manager (MCC) account, and test-level access cannot read a production account',
        check: CHECKS.googleDeveloperToken,
      },
      {
        key: 'refreshToken',
        label: 'OAuth refresh token',
        secret: true,
        hint: 'starts "1//" — for scope https://www.googleapis.com/auth/adwords',
        check: CHECKS.googleRefreshToken,
      },
      { key: 'clientId', label: 'OAuth client id', secret: false, hint: 'ends in .apps.googleusercontent.com', check: CHECKS.googleClientId },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
      {
        key: 'loginCustomerId',
        label: 'Manager (MCC) id',
        secret: false,
        optional: true,
        hint: 'only when the OAuth credentials belong to a manager account acting for the customer above — sent as login-customer-id',
      },
    ],
  },
};

/* ── The OTAs ───────────────────────────────────────────────────────────────
 *
 * Six channels, and one thing to be honest about before the forms below are
 * read as a promise: **none of them has a request shape written**
 * (lib/ingest/http has connectors for Meta and Google and nobody else), so
 * storing a credential here does not make a channel pull. The live transport
 * says exactly that when it is asked to — "has a credential but no connector"
 * — and that message is the truth, not a placeholder.
 *
 * They are here anyway because the missing half is different in kind. Every one
 * of these APIs is partner-gated: Booking.com wants a certified connectivity
 * provider, Expedia and Agoda want a signed agreement, Airbnb admits partners
 * by application. The credential comes first and it takes weeks, so a screen
 * with nowhere to put one is the actual blocker — which is the same reason this
 * screen was built in the first place.
 *
 * Field names follow each vendor's own documentation so somebody pasting from
 * an extranet is not also translating, but they are read from public docs and
 * have not been checked against a live account. Deliberately **no paste-time
 * checks**: the ones above identify a recognisably wrong credential, and
 * guessing the shape of a credential nothing here has ever seen would refuse
 * valid ones — worse than the error it would prevent.
 */
const OTA_REQUIREMENTS = {
  booking_com: {
    name: 'Booking.com',
    docs: 'https://connect.booking.com/',
    icon: 'ph ph-buildings',
    fields: [
      { key: 'propertyId', label: 'Property ID', secret: false, hint: 'the numeric property (hotel) id shown in the Extranet' },
      { key: 'machineAccountUsername', label: 'Machine account username', secret: false, hint: 'a machine account, not your Extranet login — created by your connectivity provider' },
      { key: 'machineAccountPassword', label: 'Machine account password', secret: true },
    ],
  },
  expedia: {
    name: 'Expedia Group',
    docs: 'https://developers.expediagroup.com/',
    icon: 'ph ph-airplane-tilt',
    fields: [
      { key: 'propertyId', label: 'Property ID', secret: false, hint: 'the Expedia Partner Central property id' },
      { key: 'apiKey', label: 'API key', secret: false },
      { key: 'sharedSecret', label: 'Shared secret', secret: true, hint: 'signs each request alongside the key — issued with it, never shown again' },
    ],
  },
  agoda: {
    name: 'Agoda',
    docs: 'https://ycs.agoda.com/',
    icon: 'ph ph-bed',
    fields: [
      { key: 'hotelId', label: 'Hotel ID', secret: false, hint: 'the property id in YCS' },
      { key: 'apiKey', label: 'API key', secret: true, hint: 'YCS → Connectivity — Agoda issues this per property' },
    ],
  },
  airbnb: {
    name: 'Airbnb',
    docs: 'https://www.airbnb.com/partner',
    icon: 'ph ph-house-line',
    fields: [
      { key: 'clientId', label: 'OAuth client id', secret: false },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
      { key: 'refreshToken', label: 'OAuth refresh token', secret: true, hint: 'from the host authorisation flow — a partner application is required before one can be issued' },
      { key: 'listingIds', label: 'Listing ids, comma separated', secret: false, optional: true, hint: 'leave empty to read every listing the token can see' },
    ],
  },
  makemytrip: {
    name: 'MakeMyTrip',
    docs: 'https://connectivity.ingommt.com/',
    icon: 'ph ph-suitcase-rolling',
    fields: [
      { key: 'hotelCode', label: 'Hotel code', secret: false, hint: 'the MakeMyTrip hotel code from the Ingommt extranet' },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'baseUrl', label: 'API base URL', secret: false, optional: true, hint: 'only if your connectivity contact gave you one other than the Ingommt default' },
    ],
  },
  goibibo: {
    name: 'Goibibo',
    docs: 'https://connectivity.ingommt.com/',
    icon: 'ph ph-compass',
    fields: [
      /* Same platform as MakeMyTrip, separate hotel code — which is why this is
         its own credential and not a checkbox on the one above. */
      { key: 'hotelCode', label: 'Hotel code', secret: false, hint: 'the Goibibo hotel code — the same Ingommt platform as MakeMyTrip, but a different code' },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'baseUrl', label: 'API base URL', secret: false, optional: true },
    ],
  },
};

for (const [id, requirement] of Object.entries(OTA_REQUIREMENTS)) {
  REQUIREMENTS[id] = {
    ...requirement,
    /* Stated once, the same way for all six: what the channel is being asked
       for, in the product's terms. Commission is named because it is the fact
       only the channel has — the PMS folio shows what was banked and cannot say
       what was kept. */
    feeds: `Reservations, room nights and commission from ${requirement.name} — gross against net, per channel`,
  };
}

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
  /* `backend` swaps the medium without touching anything else in this class.
   *
   * `state()` stays synchronous, which is what keeps the fifteen methods below
   * unchanged — making it async would have rippled through every one of them
   * and through every caller. Instead the document is pulled into `_state` by
   * `hydrate()`, which the request edge calls once per request alongside the
   * other document stores, in a single round trip. Per-request rather than
   * per-process because a credential stored on one serverless instance would
   * otherwise be invisible to the next one for its whole lifetime. */
  constructor({ file = FILE, secret = process.env.LEADINTEL_SECRET, backend = null, docKey = 'connections' } = {}) {
    this.file = file;
    this.key = keyFrom(secret);
    this.backend = backend;
    this.docKey = docKey;
    this._pending = null;
    this._state = null;
  }

  state() {
    if (this._state) return this._state;
    /* With a backend, an unhydrated store is empty rather than a file read —
       there is no file to read. `hydrate()` is what fills it. */
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

  async hydrate(value = undefined) {
    if (!this.backend) return this;
    /* The value may be handed in when several stores were fetched together, so
       a shared read does not become one query per store. */
    this._state = (value === undefined ? await this.backend.get(this.docKey) : value) || { workspaces: {} };
    return this;
  }

  /* Writes are issued by synchronous methods (`set`, `remove`, `recordTest`),
     so the promise is parked here and a route that must not answer before the
     credential is durable awaits `flush()`. Without it the redirect could beat
     the write, and the next request — which re-reads from the store — would
     find the credential missing. */
  flush() {
    return this._pending || Promise.resolve();
  }

  _save() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return this._pending;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    /* 0600: the file is useless without the key, but a credential store that
       is world-readable is still a bad habit to leave in a repo. */
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n', { mode: 0o600 });
    return undefined;
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

    /* Refused here rather than stored and left to fail against the vendor a
       quarter of an hour later. Reported all at once: fixing one paste only to
       be told about the next is the same wait twice. */
    const wrong = [];
    for (const field of requirement.fields) {
      const value = String((values || {})[field.key] || '').trim();
      if (!value || !field.check) continue;
      const problem = field.check(value);
      if (problem) wrong.push(`${field.label} ${problem}`);
    }
    if (wrong.length) throw new Error(`${requirement.name}: ${wrong.join('. ')}`);

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

  /* Which sources this workspace has a credential for, by id. Says nothing
     about whether their pulls succeed — only that somebody has connected them,
     which is what decides whether the raw store may still serve that source's
     demo rows. Reads the index, never a secret. */
  configured(workspaceId) {
    return new Set(Object.keys(this.state().workspaces[workspaceId] || {}));
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
      icon: requirement.icon,
      feeds: requirement.feeds,
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
        /* Set or not — for a **secret**, never the value, not even masked. A
           mask still leaks length. */
        set: Boolean(entry && entry.fields[f.key]),
        /* A non-secret field shows what is stored, because hiding it costs
           something real: `deleted_client` means the stored OAuth client id no
           longer exists in the Cloud console, and the one way to see that is to
           compare the two — which a screen that shows neither makes impossible.
           A client id is public by construction (it travels in the consent URL
           in the user's own browser), as are an ad account id and a Razorpay key
           id. `secret: true` fields are unchanged and still never leave the
           module. */
        value: f.secret ? null : ((entry && entry.fields[f.key] && entry.fields[f.key].value) || null),
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

/* ── what a source is actually doing ────────────────────────────────────────
 *
 * The Connections screen used to derive this itself, from webhook deliveries
 * alone. That answered for the two sources that push and was silently wrong for
 * the three that are polled: a stored credential syncing real records every
 * fifteen minutes rendered as "stored, no data yet" forever, because a polled
 * source has no webhook and therefore no delivery count. Meta Ads sat like that
 * in production while it was the one connector carrying live data.
 *
 * The other half is worse. The run log knows a source has failed every attempt
 * for a day and knows why, and none of it reached the screen where somebody
 * would go to fix it — the credential page said "stored" and the reason lived
 * at `/ingest/status`, which is JSON that nobody opens.
 *
 * So both are read here, and the deciding rule is **evidence, not intent**: a
 * credential is not a connection, and a sync that ran is not a sync that
 * carried anything. Lives in this module rather than the template so it can be
 * tested without rendering a page.
 *
 * `sync` is one row of `SyncRunner.status()`, or null where there is none —
 * which is the honest answer for a workspace the sync loop does not serve, and
 * must not be confused with a source that has never run.
 */
function stateOf({ configured = false, readable = null, webhook = null, sync = null } = {}) {
  const minted = Boolean(webhook && webhook.minted);
  const delivered = Boolean(webhook && webhook.records > 0);

  /* Fixtures are excluded deliberately. A fixture transport returns records on
     every run, so counting them would paint every unconnected source green —
     the exact false "connected" this screen exists to avoid. */
  const pulling = Boolean(sync && sync.transport !== 'fixture' && sync.lastPulled > 0);

  /* Rotating LEADINTEL_SECRET orphans a credential, and nothing else about the
     source matters until it is re-entered. */
  if (configured && readable === false) return { state: 'broken', label: 'unreadable' };

  /* Nothing stored. The run log may still show errors against it — the runner
     asks every source on its cadence regardless — but "no credential stored"
     is not a failure of the connection, it is the absence of one. */
  if (!configured && !minted) return { state: 'off', label: 'not connected' };

  if (sync && (sync.recentFailures > 0 || sync.health === 'down')) {
    return { state: 'failing', label: sync.recentFailures > 0 ? 'failing' : 'not syncing' };
  }

  if (delivered || pulling) return { state: 'on', label: 'receiving' };

  return { state: 'idle', label: 'stored, no data yet' };
}

module.exports = { Connections, REQUIREMENTS, OTA_REQUIREMENTS, SOURCES, FILE, encrypt, decrypt, keyFrom, stateOf };
