/* Creative Intelligence summary: built from the rows on screen, never a made-up zero. */

const test = require('node:test');
const assert = require('node:assert');
const { metaDigest, googleDigest } = require('../lib/creative-digest');

const fmt = {
  money: (p) => `₹${Math.round(p / 100)}`,
  count: (n) => String(Math.round(n)),
  pct: (r) => `${(r * 100).toFixed(1)}%`,
  x: (r) => `${r.toFixed(2)}x`,
};
const R = (rupees) => rupees * 100;
const ad = (name, over = {}) => ({ name, spend: R(1000), impressions: 10000, clicks: 100, leads: 10, interested: 2, bookings: 0, revenue: 0, action: 'continue', fatiguing: false, ...over });

test('meta: headline totals, cheapest interested lead, best return, idle spend, recommendations', () => {
  const out = metaDigest([
    ad('Pool reel', { interested: 5, bookings: 1, revenue: R(20000), action: 'scale' }),
    ad('Room carousel', { interested: 1 }),
    ad('Old banner', { spend: R(800), interested: 0, action: 'pause', fatiguing: true }),
  ], fmt);
  assert.match(out.headline, /^3 creatives spent ₹2800 → 30000 impressions \(1\.0% CTR\) → 30 leads at ₹93 → 6 interested at ₹467 each → 1 reservation worth ₹20000/);
  const text = out.points.map((p) => p.text).join('\n');
  assert.match(text, /Cheapest interested leads: “Pool reel” at ₹200/);
  assert.match(text, /Best return: “Pool reel”/);
  assert.match(text, /₹800 .* no interested lead yet — the largest is “Old banner”/);
  assert.match(text, /Recommendations: 1 to scale, 1 to keep running, 1 to pause/);
  assert.match(text, /1 creative is declining or fatiguing/);
  assert.doesNotMatch(text + out.headline, /NaN|undefined|null|Infinity/);
});

test('meta: unknown CRM figures are left out, not shown as zero', () => {
  const out = metaDigest([ad('A', { interested: null, bookings: null, revenue: null }), ad('B', { interested: null, bookings: null, revenue: null })], fmt);
  assert.doesNotMatch(out.headline, /interested|reservation/);
  assert.ok(!out.points.some((p) => /no interested lead/.test(p.text)));
});

test('meta and google: nothing delivered reads as such', () => {
  assert.match(metaDigest([], fmt).headline, /No Meta creative delivered/);
  assert.match(googleDigest([{ name: 'x', spend: 0, impressions: 0 }], fmt).headline, /No Google creative delivered/);
});

test('google: conversions, cheapest, idle and thin', () => {
  const out = googleDigest([
    { name: 'V1', spend: R(1000), impressions: 5000, clicks: 50, conversions: 10, thin: false },
    { name: 'V2', spend: R(1000), impressions: 5000, clicks: 50, conversions: 5, thin: false },
    { name: 'D1', spend: R(500), impressions: 400, clicks: 2, conversions: 0, thin: true },
  ], fmt);
  assert.match(out.headline, /15 Google conversions at ₹167/);
  const text = out.points.map((p) => p.text).join('\n');
  assert.match(text, /Cheapest conversions: “V1” at ₹100/);
  assert.match(text, /no Google conversion — the largest is “D1”/);
  assert.match(text, /1 of 3 have under 1,000 impressions/);
});
