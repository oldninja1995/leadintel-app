/* Fixture data for the internal ops Accounts panel (/admin/accounts).
 *
 * FIXTURE, not derived — see lib/site-config.js's header for why. There is no
 * billing engine, no Razorpay integration and no plan/tier/MRR concept
 * anywhere else in this codebase (confirmed by exploration before this file
 * was written), so an honest accounts panel has nothing real to read yet.
 * This mirrors the two real seeded workspaces (lib/auth/identity.js) plus a
 * handful of invented ones so the list reads as a list rather than a demo of
 * two rows — every plan/MRR/billing/usage figure below is illustrative.
 */

/* Ported from the design canvas's own `planDefaults` (LeadIntel v2.dc.html) —
   what an account gets before any per-account override in
   var/account-overrides.json. */
const PLAN_DEFAULTS = {
  Starter: { connections: 3, seats: 3, properties: 1, history: 6, api: 0, support: 'Email, 1 day', price: 250000 },
  Growth: { connections: 5, seats: 10, properties: 10, history: 12, api: 750000, support: 'Priority, 4 hours', price: 500000 },
  Enterprise: { connections: 8, seats: 25, properties: 40, history: 24, api: 2000000, support: 'Named CSM + Slack', price: 850000 },
};

const SUPPORT_LEVELS = ['Community', 'Email, 1 day', 'Priority, 4 hours', 'Named CSM + Slack'];

const ENTITLEMENTS = [
  { key: 'connections', label: 'Data source connections', unit: 'sources', step: 1, min: 1, max: 24 },
  { key: 'seats', label: 'Seats', unit: 'users', step: 1, min: 1, max: 250 },
  { key: 'properties', label: 'Properties', unit: 'hotels', step: 1, min: 1, max: 400 },
  { key: 'history', label: 'Historical range', unit: 'months', step: 3, min: 1, max: 60 },
  { key: 'api', label: 'API calls / month', unit: 'calls', step: 250000, min: 0, max: 10000000 },
];

const ACCOUNTS = [
  {
    id: 'parakkat', name: 'Parakkat Hospitality', initials: 'PH',
    sub: '3 properties · Kerala', plan: 'Growth', signup: '2026-02-11', status: 'active',
    billing: [
      { date: '1 Aug 2026', desc: 'Growth — monthly', amount: '₹5,90,000', status: 'Paid' },
      { date: '1 Jul 2026', desc: 'Growth — monthly', amount: '₹5,90,000', status: 'Paid' },
      { date: '1 Jun 2026', desc: 'Growth — monthly', amount: '₹5,90,000', status: 'Paid' },
    ],
    usage: [
      { label: 'Connections', value: '4 of 5', pct: 80 },
      { label: 'Seats', value: '7 of 10', pct: 70 },
      { label: 'API calls', value: '3.1L of 7.5L', pct: 41 },
    ],
    health: 'Signed in this week · all syncs green',
  },
  {
    id: 'kestrel', name: 'Kestrel Resorts', initials: 'KR',
    sub: '1 property · trial', plan: 'Starter', signup: '2026-07-30', status: 'trial',
    billing: [
      { date: '30 Jul 2026', desc: 'Starter — 14-day trial', amount: '₹0', status: 'Trial' },
    ],
    usage: [
      { label: 'Connections', value: '1 of 3', pct: 33 },
      { label: 'Seats', value: '1 of 3', pct: 33 },
      { label: 'API calls', value: '0 of 0', pct: 0 },
    ],
    health: 'No booking source connected yet — every metric stays ADS',
  },
  {
    id: 'tidewater', name: 'Tidewater Collection', initials: 'TC',
    sub: '6 properties · Goa', plan: 'Enterprise', signup: '2025-11-04', status: 'active',
    billing: [
      { date: '1 Aug 2026', desc: 'Enterprise — annual, month 9 of 12', amount: '₹7,22,500', status: 'Paid' },
      { date: '1 Jul 2026', desc: 'Enterprise — annual, month 8 of 12', amount: '₹7,22,500', status: 'Paid' },
    ],
    usage: [
      { label: 'Connections', value: '8 of 8', pct: 100 },
      { label: 'Seats', value: '19 of 25', pct: 76 },
      { label: 'API calls', value: '14.8L of 20L', pct: 74 },
    ],
    health: 'At connection cap — a good upsell conversation',
  },
  {
    id: 'saffron', name: 'Saffron City Hotels', initials: 'SC',
    sub: '2 properties · Jaipur', plan: 'Starter', signup: '2026-05-19', status: 'active',
    billing: [
      { date: '1 Aug 2026', desc: 'Starter — monthly', amount: '₹2,95,000', status: 'Paid' },
      { date: '1 Jul 2026', desc: 'Starter — monthly', amount: '₹2,95,000', status: 'Failed' },
    ],
    usage: [
      { label: 'Connections', value: '3 of 3', pct: 100 },
      { label: 'Seats', value: '2 of 3', pct: 67 },
      { label: 'API calls', value: '0 of 0', pct: 0 },
    ],
    health: 'Last payment failed — card expired',
  },
  {
    id: 'northgate', name: 'Northgate Group', initials: 'NG',
    sub: '11 properties · Delhi NCR', plan: 'Enterprise', signup: '2025-08-22', status: 'active',
    billing: [
      { date: '1 Aug 2026', desc: 'Enterprise — monthly', amount: '₹10,03,000', status: 'Paid' },
      { date: '1 Jul 2026', desc: 'Enterprise — monthly', amount: '₹10,03,000', status: 'Paid' },
    ],
    usage: [
      { label: 'Connections', value: '6 of 8', pct: 75 },
      { label: 'Seats', value: '25 of 25', pct: 100 },
      { label: 'API calls', value: '18.9L of 20L', pct: 95 },
    ],
    health: 'Seats and API calls both near cap',
  },
  {
    id: 'palmgrove', name: 'Palm Grove Beach Resort', initials: 'PG',
    sub: '1 property · Kovalam', plan: 'Starter', signup: '2026-08-02', status: 'trial',
    billing: [
      { date: '2 Aug 2026', desc: 'Starter — 14-day trial', amount: '₹0', status: 'Trial' },
    ],
    usage: [
      { label: 'Connections', value: '2 of 3', pct: 67 },
      { label: 'Seats', value: '1 of 3', pct: 33 },
      { label: 'API calls', value: '0 of 0', pct: 0 },
    ],
    health: 'Trial ends in 6 days — no payment method on file',
  },
  {
    id: 'meridian', name: 'Meridian Hospitality Partners', initials: 'MH',
    sub: '4 properties · Mumbai', plan: 'Growth', signup: '2025-12-30', status: 'churned',
    billing: [
      { date: '1 May 2026', desc: 'Growth — monthly', amount: '₹5,90,000', status: 'Refunded' },
    ],
    usage: [
      { label: 'Connections', value: '0 of 5', pct: 0 },
      { label: 'Seats', value: '0 of 10', pct: 0 },
      { label: 'API calls', value: '0 of 7.5L', pct: 0 },
    ],
    health: 'Cancelled 1 May 2026 — switched to an in-house dashboard',
  },
];

function list() {
  return ACCOUNTS.map((a) => ({ ...a }));
}

function get(id) {
  const found = ACCOUNTS.find((a) => a.id === id);
  return found ? { ...found } : null;
}

module.exports = { ACCOUNTS, PLAN_DEFAULTS, SUPPORT_LEVELS, ENTITLEMENTS, list, get };
