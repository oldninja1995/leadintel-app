const test = require('node:test');
const assert = require('node:assert/strict');
const { PROJECTIONS } = require('../lib/repository/projections');

const lead = (id, stage, owner, extra = {}) => ({ id, name: `Guest ${id}`, phone: `+91 98470 0000${id}`, stage, owner, createdAt: `2026-10-0${id}T10:00:00Z`, ...extra });
const entities = {
  leads: [
    lead('1', 'Fresh', 'a@x.com'),
    lead('2', 'Interested', 'a@x.com'),
    lead('3', 'Not interested', 'b@x.com'),
    lead('4', 'Won/Converted', 'b@x.com'),
  ],
  deals: [{ id: 'd4', leadId: '4', outcome: 'won', revenue: 100, closedAt: '2026-10-05T00:00:00Z' }],
  bookings: [],
  campaignDays: [],
};
const rows = (params) => PROJECTIONS.leads(entities, params).leadRows.map((r) => r.name);

test('lead filters narrow the list on the server, by owner, stage, search and progress', () => {
  assert.deepEqual(rows({}), ['Guest 4', 'Guest 3', 'Guest 2', 'Guest 1']);
  assert.deepEqual(rows({ owner: 'a@x.com' }), ['Guest 2', 'Guest 1']);
  assert.deepEqual(rows({ stage: 'interested' }), ['Guest 2']);
  assert.deepEqual(rows({ q: '00003' }), ['Guest 3']);
  /* "Not interested" never counts as interested — the funnel's own rule. */
  assert.deepEqual(rows({ progress: 'interested' }), ['Guest 4', 'Guest 2']);
  assert.deepEqual(rows({ progress: 'booked' }), ['Guest 4']);
});

test('the note says how many match, and the form keeps the date range', () => {
  const out = PROJECTIONS.leads(entities, { owner: 'b@x.com', period: '30d', model: 'x' });
  assert.match(out.leadNote, /^2 of 4 leads match/);
  assert.deepEqual(out.leadFilter.hidden, [{ name: 'period', value: '30d' }]);
});
