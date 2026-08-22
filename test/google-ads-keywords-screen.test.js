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
const render = ({ qs = '', table = '', campaign = '111', keywordSort = 'name' } = {}) => ejs.render(TEMPLATE, {
  data: {
    connected: true,
    rangeLabel: 'this month',
    qs,
    table,
    keywordSort,
    liveCampaigns: CAMPAIGNS,
    selectedCampaign: CAMPAIGNS.find((c) => c.campaignId === campaign) || null,
    hiddenCampaigns: 7,
    keywords: [], keywordsByCampaign: [], searchTerms: [], words: [], termSummary: {},
  },
});

/* Hrefs come out of the render HTML-escaped — &amp; between parameters — and a
   test that forgets that reads every link as one parameter. */
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

test('the account list can be ranked by spend and put back', () => {
  const alpha = render({ qs: '?campaign=111' });
  const toSpend = hrefs(alpha).find((h) => h.includes('sort=spend'));
  assert.ok(toSpend, 'there is no way to rank the list by spend');
  assert.match(toSpend, /campaign=111/, 'ranking by spend would move the reader to another campaign');

  const ranked = render({ qs: '?campaign=111&sort=spend', keywordSort: 'spend' });
  const back = hrefs(ranked).filter((h) => h.includes('campaign=111') && !h.includes('sort='));
  assert.ok(back.length, 'there is no way back to the alphabetical order');
  /* And the page says which order it is in, because a table of 220 rows that
     silently changed order is worse than one that never moved. */
  assert.match(ranked, /Showing the first 10\s+by spend/);
  assert.match(alpha, /Showing the first 10\s+alphabetically/);
});

test('the picker keeps the order and the range when the campaign changes', () => {
  /* A GET form replaces the whole query string; the hidden fields are what stop
     that from resetting everything else the reader has chosen. */
  const html = render({ qs: '?range=this-month&sort=spend&campaign=111', keywordSort: 'spend' });
  const hidden = [...html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]);

  assert.deepEqual(hidden.find(([n]) => n === 'sort'), ['sort', 'spend']);
  assert.deepEqual(hidden.find(([n]) => n === 'range'), ['range', 'this-month']);
  assert.equal(hidden.filter(([n]) => n === 'campaign').length, 0, 'the picker fights its own select');
});
