/* Letting a source call in.
 *
 * `server.js` stated this gap plainly and left it open: "a webhook needs its
 * own credential, a signature from the sending system, not a browser session.
 * That is not built." This is that credential.
 *
 * **Why it cannot reuse anything already here.** Every other route takes its
 * workspace from the session, deliberately — so there is no `?workspace=` a
 * caller could forge or a maintainer could forget to check. A webhook has no
 * session and never will; TeleCRM is not going to hold a cookie. So the
 * workspace has to come from somewhere, and the only safe answer is *the
 * credential itself*. A token names one workspace and one source, and a request
 * carrying it can reach neither another tenant's intake nor another source's.
 * The invariant is kept rather than weakened: the workspace still never comes
 * from the request body, path or query.
 *
 * **Tokens are hashed, not encrypted.** `lib/connections.js` must encrypt,
 * because it has to hand a vendor credential back to the transport in
 * plaintext. This one is only ever *checked*, so the store keeps a SHA-256 and
 * the token itself exists exactly once — in the response that mints it. A
 * leaked store yields nothing usable. It also means rotating `LEADINTEL_SECRET`
 * does not orphan these the way it orphans stored credentials.
 *
 * **Deliveries are counted here** rather than inferred elsewhere, because the
 * Connections screen needs to tell two states apart that looked identical
 * before: a credential that is stored, and a source that is actually sending.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '..', 'var', 'webhooks.json');

/* Long enough that guessing is not a strategy, and prefixed so one found in a
   log is identifiable as this app's rather than mistaken for a vendor key. */
const PREFIX = 'lihook';

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

class Webhooks {
  /* See lib/connections.js for why `state()` stays synchronous and hydration
     happens at the request edge instead. */
  constructor({ file = FILE, backend = null, docKey = 'webhooks' } = {}) {
    this.file = file;
    this.backend = backend;
    this.docKey = docKey;
    this._pending = null;
    this._state = null;
  }

  state() {
    if (this._state) return this._state;
    if (this.backend) {
      this._state = { tokens: {} };
      return this._state;
    }
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this._state = { tokens: {} };
    }
    return this._state;
  }

  async hydrate(value = undefined) {
    if (!this.backend) return this;
    this._state = (value === undefined ? await this.backend.get(this.docKey) : value) || { tokens: {} };
    return this;
  }

  /* Undefined when nothing is pending, rather than a resolved promise. A
     caller that awaits is unaffected, but a caller that branches on whether it
     got one stays synchronous on the file path — which is what keeps the
     middleware that settles these writes from deferring when there was nothing
     to settle. */
  flush() {
    return this._pending;
  }

  _save() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return this;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    /* 0600 for the same reason as the credential store: the contents are not
       usable, but a bearer-credential file that is world-readable is still a
       bad habit to leave in a repo. */
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n', { mode: 0o600 });
    return this;
  }

  /* One live token per workspace + source. Minting again **replaces** the old
     one rather than adding a second: two valid tokens for one intake means
     revoking the leaked one requires knowing which it was, and a screen that
     never shows a token back cannot tell you. The caller is told it replaced. */
  mint(workspaceId, source, { by = null, at = new Date().toISOString() } = {}) {
    if (!workspaceId) throw new Error('a webhook token must belong to a workspace');
    if (!source) throw new Error('a webhook token must name a source');

    const previous = this.find(workspaceId, source);
    if (previous) delete this.state().tokens[previous.id];

    const id = crypto.randomBytes(9).toString('hex');
    const secret = crypto.randomBytes(24).toString('hex');
    const token = `${PREFIX}_${id}_${secret}`;

    this.state().tokens[id] = {
      id,
      workspace: workspaceId,
      source,
      /* The token is never stored. Only proof that a given one matches. */
      secretHash: hash(secret),
      createdAt: at,
      createdBy: by,
      lastDeliveryAt: null,
      deliveries: 0,
      records: 0,
    };
    this._save();

    /* `token` is returned exactly once, here. Nothing reads it back. */
    return { id, token, createdAt: at, replaced: Boolean(previous) };
  }

  find(workspaceId, source) {
    return Object.values(this.state().tokens)
      .find((t) => t.workspace === workspaceId && t.source === source) || null;
  }

  /* Returns the token's workspace and source, or null. One answer for every
     failure — malformed, unknown, wrong secret — because distinguishing them
     for the caller would say which ids exist. */
  verify(presented) {
    if (typeof presented !== 'string') return null;
    const parts = presented.trim().split('_');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;

    const [, id, secret] = parts;
    const entry = this.state().tokens[id];
    if (!entry) return null;

    const expected = Buffer.from(entry.secretHash);
    const given = Buffer.from(hash(secret));
    if (expected.length !== given.length) return null;
    if (!crypto.timingSafeEqual(expected, given)) return null;

    return { id: entry.id, workspace: entry.workspace, source: entry.source };
  }

  /* Called after a delivery is accepted, so the screen can say "receiving"
     rather than merely "configured". Counts records as well as deliveries: a
     source posting empty bodies on a timer is connected and useless, and those
     two numbers are what tell them apart. */
  recordDelivery(id, { records = 0, at = new Date().toISOString() } = {}) {
    const entry = this.state().tokens[id];
    if (!entry) return null;
    entry.lastDeliveryAt = at;
    entry.deliveries += 1;
    entry.records += Number(records) || 0;
    this._save();
    return { lastDeliveryAt: entry.lastDeliveryAt, deliveries: entry.deliveries, records: entry.records };
  }

  revoke(workspaceId, source) {
    const entry = this.find(workspaceId, source);
    if (!entry) return false;
    delete this.state().tokens[entry.id];
    this._save();
    return true;
  }

  /* Safe to render — says a token exists and what it has received, never the
     token. */
  describe(workspaceId, source) {
    const entry = this.find(workspaceId, source);
    if (!entry) {
      return { source, minted: false, createdAt: null, createdBy: null, lastDeliveryAt: null, deliveries: 0, records: 0 };
    }
    return {
      source,
      minted: true,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      lastDeliveryAt: entry.lastDeliveryAt,
      deliveries: entry.deliveries,
      records: entry.records,
    };
  }

  reload() { this._state = null; return this; }
}

module.exports = { Webhooks, PREFIX, FILE };
