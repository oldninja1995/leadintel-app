/* Who is asking, and which workspace they belong to.
 *
 * Phase 9. The design names seven roles across its screens — Owner, Marketing
 * Director, Revenue Manager, GM, Reservations Manager, Sales Manager, Analyst
 * — and puts a workspace switcher in the chrome, which is what makes tenancy a
 * requirement rather than a nicety.
 *
 * **These accounts are seeded and not real people.** Nobody has signed up;
 * there is no registration, no password reset and no email. They exist so that
 * permissions and tenancy can be enforced and tested against something. Every
 * seeded password is the same well-known string, stated in the open below,
 * because a fixture credential that looked secret would be the worst of both
 * worlds — see the note in `lib/ingest/fixtures` for the same reasoning about
 * synthetic data.
 *
 * Passwords are nonetheless hashed with scrypt and compared in constant time.
 * Not because these accounts matter, but because the first real account will
 * arrive through this same door, and a codebase that stored fixture passwords
 * in plain text would teach the wrong lesson to whoever adds it.
 */

const crypto = require('crypto');

/* Stated in the open on purpose — see the note above. */
const SEED_PASSWORD = 'leadintel';

const ROLES = [
  'owner',
  'marketing-director',
  'revenue-manager',
  'gm',
  'reservations-manager',
  'sales-manager',
  'analyst',
];

const ROLE_NAMES = {
  owner: 'Owner',
  'marketing-director': 'Marketing Director',
  'revenue-manager': 'Revenue Manager',
  gm: 'GM',
  'reservations-manager': 'Reservations Manager',
  'sales-manager': 'Sales Manager',
  analyst: 'Analyst',
};

/* Two workspaces, because one workspace cannot demonstrate isolation. The
   second is deliberately empty — proving that a member of it sees none of the
   first's data is the whole point of the exit criterion. */
const WORKSPACES = [
  { id: 'parakkat', name: 'Parakkat Hospitality', initials: 'PH' },
  { id: 'kestrel', name: 'Kestrel Resorts', initials: 'KR' },
];

const USERS = [
  { id: 'anand', name: 'Anand P', role: 'owner', workspace: 'parakkat' },
  { id: 'reshma', name: 'Reshma Menon', role: 'marketing-director', workspace: 'parakkat' },
  { id: 'vivek', name: 'Vivek S', role: 'revenue-manager', workspace: 'parakkat' },
  { id: 'tara', name: 'Tara George', role: 'sales-manager', workspace: 'parakkat' },
  { id: 'sneha', name: 'Sneha Nair', role: 'analyst', workspace: 'parakkat' },
  /* The other workspace's owner. Used to prove isolation. */
  { id: 'imran', name: 'Imran Q', role: 'owner', workspace: 'kestrel' },
];

/* scrypt with a per-user salt. Deterministic across runs so the seeded users
   survive a restart without a database. */
function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

const saltFor = (userId) => `leadintel:${userId}`;

/* Constant-time, so a caller cannot learn a password by timing the comparison.
   Length is checked first because `timingSafeEqual` throws on a mismatch. */
function verify(password, userId, expected) {
  const candidate = Buffer.from(hash(password, saltFor(userId)));
  const known = Buffer.from(expected);
  if (candidate.length !== known.length) return false;
  return crypto.timingSafeEqual(candidate, known);
}

const CREDENTIALS = Object.fromEntries(USERS.map((u) => [u.id, hash(SEED_PASSWORD, saltFor(u.id))]));

const byId = Object.fromEntries(USERS.map((u) => [u.id, u]));
const workspaceById = Object.fromEntries(WORKSPACES.map((w) => [w.id, w]));

function authenticate(userId, password) {
  const user = byId[userId];
  /* A wrong username and a wrong password are the same answer to the caller.
     Telling them apart is how an attacker enumerates accounts. */
  if (!user || !verify(password, userId, CREDENTIALS[userId])) return null;
  return describe(user);
}

function describe(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    roleName: ROLE_NAMES[user.role],
    workspace: user.workspace,
    workspaceName: workspaceById[user.workspace].name,
  };
}

const get = (id) => (byId[id] ? describe(byId[id]) : null);
const list = () => USERS.map(describe);
const workspaces = () => WORKSPACES.slice();
const workspace = (id) => workspaceById[id] || null;

module.exports = {
  ROLES, ROLE_NAMES, WORKSPACES, USERS, SEED_PASSWORD,
  authenticate, get, list, workspaces, workspace, describe, hash, verify,
};
