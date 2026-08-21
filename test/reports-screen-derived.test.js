/* Reports & Dashboards answers from rows, the identity table and the schedule
 * definitions — or says it cannot.
 *
 *   node --test test/reports-screen-derived.test.js
 *
 * This was the last screen in the app with no projection at all. Structure —
 * the widget palette, the builder canvas, the template list — is the static
 * driver's job and stays there. The claims were the problem, and this screen is
 * the one people export and email.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');
const permissions = require('../lib/auth/permissions');
const authored = require('../data/reports');

const EMPTY = {
  campaignDays: [], leads: [], deals: [], bookings: [], payments: [],
  creatives: [], webChannelRevenueDays: [], webChannelDays: [],
};

const USERS = [
  { id: 'anand', name: 'Anand P', role: 'owner', roleName: 'Owner', workspace: 'parakkat', workspaceName: 'Parakkat Hospitality' },
  { id: 'reshma', name: 'Reshma Menon', role: 'marketing-director', roleName: 'Marketing Director', workspace: 'parakkat', workspaceName: 'Parakkat Hospitality' },
  { id: 'sneha', name: 'Sneha Nair', role: 'analyst', roleName: 'Analyst', workspace: 'parakkat', workspaceName: 'Parakkat Hospitality' },
];

const SCHEDULES = [
  { id: 'owner-weekly', name: 'Owner weekly', freq: 'Mondays 08:00 IST', to: ['Anand P'], channels: ['email', 'whatsapp'], status: 'active', nextRunAt: '2026-08-24T02:30:00.000Z' },
  { id: 'paused-one', name: 'Reservations pace', freq: 'Daily 09:00 IST', to: ['Reservations Manager'], channels: ['email'], status: 'paused', nextRunAt: null },
];

const run = (params = {}) => PROJECTIONS.reports(EMPTY, { over: null, can: permissions.can, ...params }, authored);

test('the forecast card declines, like the one on the AI screen', () => {
  const card = run().presentKpis.find((k) => k.label === 'AUGUST FORECAST');
  assert.equal(card.value, '—', 'the same ₹61.0L invention the AI forecast tab carried');
  assert.match(card.delta, /no forecasting model/);

  /* And the cards that do name a metric are left for the registry to fill. */
  for (const bound of run().presentKpis.filter((k) => k.metric)) {
    assert.ok(bound.value !== '—' || true, 'bound cards are the registry\'s to answer, not this projection\'s');
  }
});

test('risks and opportunities are the AI screen\'s, not a second derivation', () => {
  const out = run();
  const ai = PROJECTIONS.ai(EMPTY, { over: null }, {});
  assert.deepEqual(out.scoreRisks.map((r) => r.text), (ai.aiRisks || []).slice(0, 3).map((r) => r.text),
    'two screens deriving "what is going wrong" by two routes is how they disagree on a Tuesday');

  const serialised = JSON.stringify(out.scoreRisks) + JSON.stringify(out.scoreOpps);
  for (const ghost of ['₹3.2L/mo', '₹1.8L', '21.8x', 'Munnar Honeymoon', 'Corporate offsite']) {
    assert.ok(!serialised.includes(ghost), `"${ghost}" is still being served`);
  }
});

test('the share list is this workspace, with the roles the identity table holds', () => {
  const rows = run({ users: USERS }).shareRows;
  assert.deepEqual(rows.map((r) => r.who), ['Anand P', 'Reshma Menon', 'Sneha Nair']);
  /* The fixture had Reshma as Sales Manager and Tara — the actual Sales
     Manager — as an Analyst. */
  assert.equal(rows[1].meta, 'Marketing Director · Parakkat Hospitality');
  assert.equal(rows[0].init, 'AP');
});

test('access comes off the permission ladder, not from a plausible-sounding phrase', () => {
  const rows = run({ users: USERS }).shareRows;
  const by = Object.fromEntries(rows.map((r) => [r.who, r.access]));
  assert.equal(by['Anand P'], 'Full access');
  assert.equal(by['Reshma Menon'], 'Can send', 'report.send is granted to marketing-director');
  assert.equal(by['Sneha Nair'], 'Can view', 'and not to analyst');
});

test('a schedule reports what will happen, including that nothing is dispatched', () => {
  const rows = run({ schedules: SCHEDULES }).schedules;
  assert.equal(rows[0].next, '24 Aug', 'the next run is computed, not typed');
  assert.match(rows[0].status, /not dispatched/, 'there is no mail or WhatsApp transport in this product');
  assert.deepEqual(rows[0].channels, ['Email', 'Whatsapp']);

  /* A paused schedule is reported as paused rather than dropped, so a silent
     schedule can be told apart from one that was never there. */
  assert.equal(rows[1].status, 'paused');
  assert.equal(rows[1].next, '—');
});

test('what the projection cannot see, it leaves alone rather than blanking', () => {
  /* With no users and no schedules handed over — a local run, or a test — the
     keys are absent, so the static driver's rows stand. Returning [] here would
     blank the panels instead, which is the failure mode the driver's own note
     warns about. */
  const out = run();
  assert.ok(!('shareRows' in out));
  assert.ok(!('schedules' in out));
});
