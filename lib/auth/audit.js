/* Every gated change, and who made it.
 *
 * Phase 9's exit criterion: *every gated action is enforced server-side and
 * audited*. Enforcement lives in permissions.js; this is the other half.
 *
 * Three properties, all load-bearing:
 *
 * **Refusals are recorded too.** An audit log of successes only answers "what
 * changed" but not "who tried". A Sales Manager repeatedly attempting to change
 * the attribution model is a fact somebody should be able to see, and it is
 * exactly the fact a success-only log discards.
 *
 * **Append-only.** Entries are never rewritten, for the same reason the raw
 * store never is: a log that can be edited answers no question it was kept to
 * answer.
 *
 * **The workspace is on every entry.** Otherwise two tenants' audit trails are
 * one trail, and reading either means trusting a filter that was applied on the
 * way out rather than a fact recorded on the way in.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'var', 'audit.jsonl');

class AuditLog {
  /* See lib/ingest/runner.js — `all()` stays synchronous and `hydrate()` fills
     it, so the reads built on top of it are unchanged. */
  constructor(file = FILE, { backend = null } = {}) {
    this.file = file;
    this.backend = backend;
    this._entries = null;
    this._pending = null;
  }

  all() {
    if (this.backend) return this._entries || [];
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /* `forWorkspace` takes at most 200, so a bounded read is enough here — unlike
     the run log, nothing asks this log a question about an arbitrarily old
     entry. */
  async hydrate({ limit = 1000 } = {}) {
    if (!this.backend) return this;
    this._entries = await this.backend.last(limit);
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

  /* `outcome` is 'allowed' or 'refused'. `detail` carries what actually
     changed — the model applied, the report sent — so the log answers what
     happened and not merely that something did. */
  record({ user, action, outcome, workspace, detail = null, at = new Date().toISOString() }) {
    const entry = {
      at,
      action,
      outcome,
      workspace: workspace || (user && user.workspace) || null,
      user: user ? { id: user.id, name: user.name, role: user.role } : null,
      detail,
    };
    if (this.backend) {
      this._entries = [...(this._entries || []), entry];
      this._pending = this.backend.append(entry, { tag: entry.workspace });
      return entry;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }

  /* Scoped to a workspace by default. Passing none returns nothing rather than
     everything — an audit reader that defaults to "all tenants" is one
     forgotten argument away from a cross-tenant leak. */
  forWorkspace(workspaceId, { action = null, limit = 200 } = {}) {
    if (!workspaceId) return [];
    return this.all()
      .filter((e) => e.workspace === workspaceId)
      .filter((e) => (action ? e.action === action : true))
      .slice(-limit)
      .reverse();
  }

  clear() {
    if (this.backend) {
      this._entries = [];
      this._pending = this.backend.clear();
      return;
    }
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { AuditLog, FILE };
