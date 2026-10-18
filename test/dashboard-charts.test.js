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
