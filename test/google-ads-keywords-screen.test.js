/* The Keyword Analytics screen's links.
 *
 *   node --test test/google-ads-keywords-screen.test.js
 *
 * Rendered rather than reasoned about, because everything here is a query
 * string built in a template and both bugs it is written against were bugs of
 * *composition* — a link that was correct in isolation and wrong once the reader
 * had already chosen a campaign, and a "back" link built from the query string
 * it was supposed to be backing out of. Neither is visible in a payload.
 *
 * The screen is `data`-only, so it renders standalone with no shell, no store
 * and no session.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'app', 'google-ads-keywords.ejs'), 'utf8');

const keyword = (name, spend) => ({
  keyword: name,
  matchType: 'EXACT',
  status: 'ENABLED',
  adgroup: 'brand',
  measured: spend !== null,
  spend,
  spendText: spend === null ? null : `₹${spend / 100}`,
  impressions: spend === null ? null : 100,
  clicks: spend === null ? null : 10,
  conversions: 0,
  ctr: null,
  cpcText: null,
});

/* Twelve keywords each, deliberately: the previews on this screen are ten rows
   long, and the links this file is about only appear on a table with more than
   that — which is the shape of every real campaign here. */
const many = (prefix) => Array.from({ length: 11 }, (_, i) => keyword(prefix + ' quiet ' + i, null));

const CAMPAIGNS = [
  { campaignId: '111', campaign: 'competitor search', count: 12, paused: 0, measured: 1, status: 'ENABLED', channelType: 'SEARCH', spendText: '₹9', matchMix: '12 exact', keywords: [...many('a'), keyword('omega', 900)] },
  { campaignId: '222', campaign: 'usp keywords', count: 12, paused: 0, measured: 0, status: 'ENABLED', channelType: 'SEARCH', spendText: null, matchMix: '12 exact', keywords: [...many('b'), keyword('solo', null)] },
];

/* One render, one payload — `sel` is the campaign the reader is looking at and
   `qs` is the query string they arrived with, which is the whole point. */
const render = ({ qs = '', table = '', campaign = '111', sort = 'keyword', reversed = false } = {}) => ejs.render(TEMPLATE, {
  data: {
    connected: true,
    rangeLabel: 'this month',
    qs,
    table,
    /* One sort state per table, keyed by the table's own query parameter — the
       screen draws a header for each and they must not share an order. */
    sorts: { sort: { key: sort, reversed } },
    liveCampaigns: CAMPAIGNS,
    selectedCampaign: CAMPAIGNS.find((c) => c.campaignId === campaign) || null,
    hiddenCampaigns: 7,
    keywords: [], keywordsByCampaign: [], searchTerms: [], words: [], termSummary: {},
  },
});

/* Hrefs come out of the render HTML-escaped — &amp; between parameters — and a
   test that forgets that reads every link as one parameter. */
/* The header row of the account's keyword list — not the first <thead> on the
   page, which belongs to the summary table above the panel. */
const headerOf = (html) => html
  .split('Keywords in the account')[1]
  .split('<thead>')[1]
  .split('</thead>')[0];

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].split('&amp;').join('&'));
const count = (href, name) => (href.split('?')[1] || '').split('&').filter((p) => p.split('=')[0] === name).length;

/* ── links compose, rather than accumulate ──────────────────────────────── */

test('the whole-list link names the chosen campaign once, not twice', () => {
  /* The bug: the query string already carries campaign=222 because the picker
     put it there, and the link appended campaign=222 again. Express reads a
     repeated name as an array, String() of one is "222,222", that matches no
     campaign, and the screen fell back to the first — so asking for the whole
     list of the second campaign showed the whole list of the first. */
  const html = render({ qs: '?range=this-month&campaign=222', campaign: '222' });
  const link = hrefs(html).find((h) => h.includes('table=current'));

  assert.ok(link, 'the whole-list link is not on the page');
  assert.equal(count(link, 'campaign'), 1, `campaign is named more than once: ${link}`);
  assert.match(link, /campaign=222/);
  assert.match(link, /range=this-month/, 'the range the reader chose was dropped');
});

test('back from a single table does not link to that table', () => {
  /* Built from the whole query string, `table` included, "Back to Keyword
     Analytics" was a link to the page it was already on. */
  const html = render({ qs: '?range=this-month&table=terms', table: 'terms' });
  const back = hrefs(html).find((h) => h.startsWith('/google-ads/keywords'));

  assert.ok(back, 'there is no way back');
  assert.doesNotMatch(back, /table=/, `back links to the open table: ${back}`);
  assert.match(back, /range=this-month/, 'backing out reset the range');
});

/* ── the order control ──────────────────────────────────────────────────── */

test('every column of the account list is a sort control', () => {
  /* The first version of this put the order in a line of prose above the table,
     in the panel's footnote style, and the reader could not find it. Somebody
     sorting a table looks at its headers. */
  const html = render({ qs: '?campaign=111&sort=spend', sort: 'spend' });
  const head = headerOf(html);

  for (const column of ['Spend', 'CTR', 'CPC', 'Impressions', 'Clicks', 'Keyword', 'Match']) {
    const cell = head.split('<th').find((c) => c.includes('>' + column));
    assert.ok(cell, `there is no ${column} header`);
    assert.match(cell, /class="li-sort/, `${column} is not a control`);
  }

  const offered = [...head.matchAll(/href="[^"]*[?&]sort=(-?[a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(offered.sort(),
    ['-spend', 'adgroup', 'clicks', 'cpc', 'ctr', 'impressions', 'match', 'status'],
    'the columns on offer are not the columns of this table');

  /* Alphabetical is this table's default, and the default is the absence of the
     parameter rather than a value of it — the URL people land on stays tidy. */
  const keyword = head.split('<th').find((c) => c.includes('>Keyword'));
  assert.doesNotMatch(keyword, /sort=/);

  /* And the column already in use offers the other direction, so a second click
     on it turns the table round rather than doing nothing. */
  const spend = head.split('<th').find((c) => c.includes('>Spend'));
  assert.match(spend, /sort=-spend/);
});

test('the sorted column says so, and the others still offer', () => {
  const html = render({ qs: '?campaign=111&sort=cpc', sort: 'cpc' });
  const head = headerOf(html);

  const cpc = head.split('<th').find((c) => c.includes('>CPC'));
  assert.match(cpc, /aria-sort="descending"/);
  assert.match(cpc, /li-sort--on/);

  const ctr = head.split('<th').find((c) => c.includes('>CTR'));
  assert.doesNotMatch(ctr, /li-sort--on/, 'two columns claim to be the sorted one');
  assert.match(ctr, /sort=ctr/, 'the other columns stopped offering');

  /* And sorting must not move the reader to another campaign. */
  assert.match(ctr, /campaign=111/);
  assert.match(html, /Showing the first 10\s+by CPC/);
});

test('the picker keeps the order and the range when the campaign changes', () => {
  /* A GET form replaces the whole query string; the hidden fields are what stop
     that from resetting everything else the reader has chosen. */
  const html = render({ qs: '?range=this-month&sort=spend&campaign=111', sort: 'spend' });
  const hidden = [...html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]);

  assert.deepEqual(hidden.find(([n]) => n === 'sort'), ['sort', 'spend']);
  assert.deepEqual(hidden.find(([n]) => n === 'range'), ['range', 'this-month']);
  assert.equal(hidden.filter(([n]) => n === 'campaign').length, 0, 'the picker fights its own select');
});

test('a sort link lands on the table it sorts, not at the top of the page', () => {
  /* Sorting is a page load — that is what makes the order a URL — and a page
     load starts at the top, which on this screen is thousands of pixels above
     the table. The anchor is the browser doing that scrolling, with no script. */
  const html = render({ qs: '?campaign=111' });
  const head = headerOf(html);
  const spend = head.split('<th').find((c) => c.includes('>Spend'));

  assert.match(spend, /href="[^"]*#account-keywords"/);
  assert.match(html, /<section class="li-ota-panel" id="account-keywords">/);
});
