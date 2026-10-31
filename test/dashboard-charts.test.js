const test = require('node:test');
const assert = require('node:assert');
const charts = require('../lib/dashboard-charts');

const day = (campaign, leads) => ({ date: '2026-10-01', platform: 'google_ads', campaign, label: campaign, spend: 100000, impressions: 10, clicks: 1, leads });

test('Google bookings with no campaign are shared by conversion split and marked estimated', () => {
  const leads = [{ id: 'a', createdAt: '2026-10-01T05:00:00Z', channel: 'google', stage: 'Won' }];
  const deals = [{ id: 'd', leadId: 'a', outcome: 'won', revenue: 1000000, closedAt: '2026-10-02T00:00:00Z', channel: 'google' }];
  const out = charts.marketing({ leads, deals, campaignDays: [day('B', 3), day('C', 1)] }).roasByCampaign;
  assert.deepStrictEqual(out.rows.map((r) => r.roas), ['7.50x est.', '2.50x est.']);
  assert.match(out.orphans[0], /no campaign name/);
});

test('the funnel reads Booked as a share of CRM leads, never over 100% of the stage above', () => {
  const leads = [{ id: 'a', createdAt: '2026-10-01T05:00:00Z', channel: 'google', stage: 'Fresh' }];
  const deals = [1, 2].map((i) => ({ id: `d${i}`, leadId: `old${i}`, outcome: 'won', revenue: 100, closedAt: '2026-10-02T00:00:00Z', channel: 'google' }));
  const col = charts.marketing({ leads, deals, campaignDays: [day('B', 1)] }).platformFunnel.cols.find((c) => c.key === 'google');
  assert.match(col.stages.find((s) => s.label === 'Booked').step, /of leads$/);
});

test('arrival heatmap buckets by India time', () => {
  /* 23:30 UTC Sunday is 05:00 Monday in India. */
  const out = charts.executive({ leads: [{ id: 'a', createdAt: '2026-10-04T23:30:00Z', stage: 'Fresh' }], deals: [], campaignDays: [] }).arrivals;
  assert.strictEqual(out.peak, 'Mon 5am–6am');
});

test('charts are computed once per snapshot and range, and again when the data changes', () => {
  const whole = { leads: [{ id: 'a', createdAt: '2026-10-01T05:00:00Z', stage: 'Fresh' }], deals: [], campaignDays: [] };
  const over = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', label: '2026-10-01..2026-10-01' };
  const first = charts.executive(whole, { whole, over });
  assert.strictEqual(charts.executive(whole, { whole, over }), first);
  assert.notStrictEqual(charts.executive(whole, { whole, over, channel: 'meta' }), first);
  const rebuilt = { ...whole };
  assert.notStrictEqual(charts.executive(rebuilt, { whole: rebuilt, over }), first);
});

test('marketing insights split repeat customers and find lifetime repeaters', () => {
  const leads = [
    { id: 'a', name: 'Asha', customer: 'phone:1#0', createdAt: '2026-10-01T05:00:00Z', channel: 'meta', stage: 'Won', adName: 'Ad 1', owner: 'ravi@x.com' },
    { id: 'b', name: 'Bala', customer: 'phone:2#0', createdAt: '2026-10-02T05:00:00Z', channel: 'google', stage: 'Won', repeat: true },
  ];
  const deals = [
    { id: 'd1', leadId: 'a', outcome: 'won', revenue: 1000000, closedAt: '2026-10-03T06:00:00Z', channel: 'meta' },
    { id: 'a#b1', leadId: 'a', outcome: 'won', revenue: 3000000, closedAt: '2026-10-10T06:00:00Z', channel: 'meta' },
    { id: 'd3', leadId: 'b', outcome: 'won', revenue: 2000000, closedAt: '2026-10-05T06:00:00Z', channel: 'google', repeat: true },
    { id: 'd4', leadId: 'b', outcome: 'won', revenue: 9999999, closedAt: '2026-10-06T06:00:00Z', channel: 'google', bookingStatus: 'Cancelled' },
  ];
  const ins = charts.marketing({ leads, deals, campaignDays: [] }).insights;
  assert.strictEqual(ins.repeatSplit.total, '3');
  assert.strictEqual(ins.repeatSplit.repeatShare, '67%');
  assert.strictEqual(ins.topRepeatCustomers.rows[0].label, 'Asha');
  assert.strictEqual(ins.topRepeatCustomers.rows[0].badge, '2×');
  assert.strictEqual(ins.rebookGap.median, '7 days');
  assert.strictEqual(ins.returningLeads.rate, '50%');
  assert.strictEqual(ins.topAds.rows[0].label, 'Ad 1');
  assert.strictEqual(ins.owners.rows[0].label, 'Ravi');
  assert.strictEqual(ins.valueBands.rows.find((r) => r.label === '₹10k–25k').value, '2');
  const meta = charts.marketing({ leads, deals, campaignDays: [] }, { f_channel: 'meta' }).insights;
  assert.strictEqual(meta.repeatByChannel.rows.length, 1);
});
