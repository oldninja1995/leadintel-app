/* Ad Analytics — the ads, segmented by the surface they ran on.
 *
 *   node --test test/google-ads-ads-screen.test.js
 *
 * Rendered rather than reasoned about, for the reason the keyword screen's test
 * gives: everything here is a link built in a template, and a segment chip that
 * leaves two segments in the URL is invisible in a payload.
 *
 * What this screen must not do is guess. Google reports an advertising channel
 * on the campaign and an ad *type* on the ad, and those are different facts: a
 * Demand Gen campaign serving a video creative is not a Video campaign. Filing
 * it under Video would be the kind of invention this codebase is written
 * against, so the segment stays Google's own classification and the ad type
 * gets a column.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'app', 'google-ads-ads.ejs'), 'utf8');

const ad = (adId, channel, adType, spend) => ({
  ad: null, adId, adType, status: 'ENABLED',
  campaign: 'brand search campaign', campaignId: '1', adgroup: 'Ad group 1', channel,
  measured: true, spend, impressions: 100, clicks: 10, conversions: 1,
  spendText: `₹${spend}`, ctr: '10.00%', cpcText: '₹5', cplText: '₹50',
});

const SEGMENTS = [
  { key: 'SEARCH', label: 'Search', count: 1, spendText: '₹900', impressions: 100, clicks: 10, conversions: 1 },
  { key: 'VIDEO', label: 'Video', count: 0, spendText: null, impressions: 0, clicks: 0, conversions: 0 },
  { key: 'DISPLAY', label: 'Display', count: 0, spendText: null, impressions: 0, clicks: 0, conversions: 0 },
  { key: 'DEMAND_GEN', label: 'Demand Gen', count: 1, spendText: '₹400', impressions: 100, clicks: 10, conversions: 1 },
];

const ROWS = [ad('11', 'SEARCH', 'RESPONSIVE_SEARCH_AD', 900), ad('22', 'DEMAND_GEN', 'VIDEO_RESPONSIVE_AD', 400)];

const render = ({ qs = '?period=30d', segment = null, rows = ROWS, unplaced = 0, sort = 'spend' } = {}) =>
  ejs.render(TEMPLATE, {
    data: {
      connected: true, rangeLabel: '30d', qs,
      adRows: segment ? rows.filter((r) => r.channel === segment) : rows,
      adTotal: rows.length,
      segments: SEGMENTS, segment, unplaced,
      sorts: { sortAds: { key: sort, reversed: false } },
    },
  });

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].split('&amp;').join('&'));

test('the three named surfaces are drawn whether or not they ran', () => {
  /* A chip that disappears when nothing ran leaves the reader wondering whether
     the screen forgot Video. Zero is an answer; absence is not. */
  const html = render();

  for (const label of ['Search', 'Video', 'Display']) {
    assert.match(html, new RegExp(`>\\s*${label}\\s*</a>`), `${label} is not on the screen`);
  }
  assert.match(html, /Nothing ran on <strong>Video or Display<\/strong>/);
});

test('a surface the account does run is offered beside the three', () => {
  /* Demand Gen is not one of the three asked for by name, and dropping it would
     hide two-fifths of the account's spend. */
  assert.match(render(), />\s*Demand Gen\s*<\/a>/);
});

test('choosing a segment names it once, and offers the way back', () => {
  const html = render({ qs: '?period=30d&segment=SEARCH', segment: 'SEARCH' });
  const segmented = hrefs(html).filter((h) => h.includes('segment='));

  for (const href of segmented) {
    const named = (href.split('?')[1] || '').split('&').filter((p) => p.startsWith('segment=')).length;
    assert.equal(named, 1, `a link names the segment twice: ${href}`);
    assert.match(href, /period=30d/, 'choosing a surface dropped the range');
  }
  /* The chosen chip turns into the way out, rather than a link to itself. */
  assert.ok(hrefs(html).some((h) => h.endsWith('/google-ads/ads?period=30d#ads')), 'there is no way back to every ad');
  assert.match(html, /Show every ad/);
});

test('a video creative in a Demand Gen campaign is not filed under Video', () => {
  /* The whole point of the segment being the campaign's channel. The ad's type
     is shown instead, so the reader can see what the creative is without the
     screen inventing a surface for it. */
  const html = render();
  const body = html.split('<tbody>')[2].split('</tbody>')[0];
  const videoRow = body.split('<tr>').find((r) => r.includes('video responsive ad'));

  assert.ok(videoRow, 'the video ad is missing');
  assert.match(videoRow, /demand gen/, 'the video ad lost the surface Google reported');
  assert.doesNotMatch(videoRow, />\s*video\s*</, 'a video creative was filed as a Video campaign');
});

test('an unnamed ad is shown by its id rather than as a blank', () => {
  const html = render();
  assert.match(html, /#11/);
});

test('every column of the ad table sorts, and sorting comes back to the table', () => {
  const html = render();
  const head = html.split('id="ads"')[1].split('<thead>')[1].split('</thead>')[0];

  const columns = [...head.matchAll(/>([A-Za-z./ ]+)<span class="li-sort-caret/g)].map((m) => m[1]);
  assert.deepEqual(columns, ['Ad', 'Type', 'Status', 'Surface', 'Campaign', 'Ad group',
    'Spend', 'Impressions', 'Clicks', 'CTR', 'CPC', 'Conv.', 'Cost/conv.']);

  for (const href of hrefs(html).filter((h) => h.includes('sortAds='))) {
    assert.match(href, /#ads$/, `a sort link lands at the top of the page: ${href}`);
  }
  /* Spend is this table's default, so it is the absence of the parameter. */
  const spend = head.split('<th').find((c) => c.includes('>Spend'));
  assert.match(spend, /sortAds=-spend/, 'the column in use does not offer the other direction');
});

test('an ad whose campaign did not report is unknown, not assumed', () => {
  const html = render({ unplaced: 3 });
  assert.match(html, /3 ads could not be placed/);
});

test('the sort keys this screen draws are keys the sort knows', () => {
  const { SORT_KEYS } = require('../lib/google-ads-rollup');
  for (const key of ['ad', 'adtype', 'status', 'channel', 'campaign', 'adgroup',
    'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'cpl']) {
    assert.ok(SORT_KEYS.includes(key), `the ad table offers ${key} and the sort does not know it`);
  }
});
