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
  constructor(file = FILE) {
    this.file = file;
  }

  all() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { AuditLog, FILE };
