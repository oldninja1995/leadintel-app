/* What each role may do.
 *
 * Phase 9. The design gates two actions by name — *"attribution changes are
 * Owner and Marketing Director only; custom metric edits are Owner plus
 * Analyst"* — and those are reproduced exactly. The rest of the table follows
 * the roles the design already names on its screens: a Revenue Manager owns
 * ADR and occupancy, a Sales Manager owns lead response, so each can send the
 * reports built on what they own.
 *
 * Two rules make this enforceable rather than decorative.
 *
 * **Deny by default.** An action nobody has been granted is refused, including
 * an action that does not exist. A permission table that returned "allowed"
 * for an unknown string would fail open the first time somebody typo'd a gate.
 *
 * **The check is server-side.** Nothing here is exported to the browser as a
 * decision — the client may use `can` to hide a control, but hiding a control
 * is a courtesy and the gate is the thing that matters. Every gated route
 * calls `require` before acting.
 */

/* Action -> roles that may perform it. Absent from every list means nobody. */
const GRANTS = {
  /* The design's own words. */
  'attribution.change': ['owner', 'marketing-director'],
  'metric.edit': ['owner', 'analyst'],

  /* Derived from what each role owns on the design's screens. */
  'report.send': ['owner', 'marketing-director', 'revenue-manager', 'gm', 'sales-manager'],
  'schedule.run': ['owner', 'marketing-director', 'gm'],
  'rule.judge': ['owner', 'marketing-director', 'revenue-manager', 'sales-manager'],
  'rule.evaluate': ['owner', 'marketing-director', 'revenue-manager', 'sales-manager', 'analyst'],
  'snapshot.record': ['owner', 'analyst'],
  'ingest.webhook': ['owner'],
};

const ACTIONS = Object.keys(GRANTS);

/* Deny by default, including for an action that does not exist. */
function can(user, action) {
  if (!user || !user.role) return false;
  const allowed = GRANTS[action];
  if (!allowed) return false;
  return allowed.includes(user.role);
}

/* Throws rather than returning false, so a route cannot forget to check the
   result. The message names the action and the role, because "forbidden" with
   no subject is the least useful error in software. */
function require_(user, action) {
  if (can(user, action)) return true;
  const who = user ? `${user.roleName || user.role}` : 'an unauthenticated caller';
  const err = new Error(`${who} may not ${action}`);
  err.status = 403;
  err.action = action;
  throw err;
}

/* Everything this user may do — for a client that wants to hide controls it
   would only be refused for anyway. */
function allowed(user) {
  return ACTIONS.filter((action) => can(user, action));
}

module.exports = { GRANTS, ACTIONS, can, require: require_, allowed };
