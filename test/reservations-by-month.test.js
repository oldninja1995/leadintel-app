const test = require('node:test');
const assert = require('node:assert');
const { reservationsByMonth } = require('../lib/dashboard-charts');

const NOW = new Date('2026-10-19T10:00:00Z');

test('twelve calendar months ending with the current one', () => {
  const out = reservationsByMonth([{ outcome: 'won', channel: 'meta', closedAt: '2026-10-02', revenue: 100000 }], NOW);
  assert.strictEqual(out.bars.length, 12);
  assert.strictEqual(out.bars[0].label, 'Nov 25');
  assert.strictEqual(out.bars[11].label, 'Oct 26');
  assert.ok(out.bars[11].current);
});

test('the tile\'s rule: won only, cancellations excluded, by close date', () => {
  const out = reservationsByMonth([
    { outcome: 'won', channel: 'meta', closedAt: '2026-09-10', revenue: 500000 },
    { outcome: 'won', channel: 'meta', closedAt: '2026-09-11', revenue: 300000, bookingStatus: 'Cancelled' },
    { outcome: 'won', channel: 'organic', closedAt: '2026-09-13', revenue: 400000 },
    { outcome: 'won', channel: null, closedAt: '2026-09-14', revenue: 400000 },
    { outcome: 'lost', closedAt: '2026-09-12', revenue: 900000 },
    { outcome: 'won', channel: 'meta', closedAt: '2025-01-01', revenue: 700000 },
  ], NOW);
  assert.strictEqual(out.total, '₹5,000');
  assert.match(out.bars[10].tip, /₹5,000 · 1 reservations/);
});

test('nothing won reads as empty, not a row of zero bars', () => {
  assert.ok(reservationsByMonth([], NOW).empty);
});
