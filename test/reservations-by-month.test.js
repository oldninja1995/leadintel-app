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

test('the channel switch picks the platform for bookings and spend alike', () => {
  const deals = [
    { outcome: 'won', channel: 'meta', closedAt: '2026-09-10', revenue: 500000 },
    { outcome: 'won', channel: 'google', closedAt: '2026-09-11', revenue: 300000 },
  ];
  const spend = [
    { platform: 'meta_ads', date: '2026-09-02', spend: 100000 },
    { platform: 'google_ads', date: '2026-09-02', spend: 200000 },
  ];
  const all = reservationsByMonth(deals, NOW, [], spend);
  assert.deepStrictEqual([all.total, all.spend, all.channelText], ['₹8,000', '₹3,000', 'Meta + Google']);
  const meta = reservationsByMonth(deals, NOW, [], spend, ['meta']);
  assert.deepStrictEqual([meta.total, meta.spend, meta.channelText], ['₹5,000', '₹1,000', 'Meta']);
  const google = reservationsByMonth(deals, NOW, [], spend, ['google']);
  assert.deepStrictEqual([google.total, google.spend], ['₹3,000', '₹2,000']);
  assert.ok(reservationsByMonth(deals, NOW, [], spend, []).empty);
});

test('repeat-customer value: a re-enquiry, or a second won booking on one lead', () => {
  const out = reservationsByMonth([
    { id: 'L1#A', leadId: 'L1', outcome: 'won', channel: 'meta', closedAt: '2026-03-05', revenue: 100000 },
    { id: 'L1', leadId: 'L1', outcome: 'won', channel: 'meta', closedAt: '2026-09-05', revenue: 200000 },
    { id: 'L2', leadId: 'L2', outcome: 'won', channel: 'meta', closedAt: '2026-09-06', revenue: 300000, reEnquiry: true },
    { id: 'L3', leadId: 'L3', outcome: 'won', channel: 'google', closedAt: '2026-09-07', revenue: 400000, repeat: false },
  ], NOW);
  assert.deepStrictEqual([out.repeat, out.repeatN, out.repeatShare], ['₹5,000', '2', '50%']);
  const sept = out.bars[10];
  assert.ok(sept.rh > 0 && sept.rh < sept.h);
  assert.match(sept.tip, /₹5,000 from 2 repeat/);
  assert.strictEqual(out.bars[4].rh, 0);
});
