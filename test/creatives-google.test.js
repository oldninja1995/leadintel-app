/* Creative Intelligence, Google's half.
 *
 *   node --test test/creatives-google.test.js
 *
 * Meta's ad object is a creative — a thumbnail, a video, a frequency, a
 * retention curve — and the screen's nineteen fields were designed around it.
 * Google's is not. So most of what is worth testing here is the same thing
 * test/creatives.test.js tests for Meta: the *declining*. A channel that quietly
 * filled hook, hold, fatigue and ROAS from something adjacent would produce a
 * screen that looks complete and is partly invented.
 *
 * Two rules this file exists to hold:
 *
 *   1. The channel is the app's own Channel chip — `f_channel=google` — so the
 *      filter bar and the tab are one act, and the cards survive the selection
 *      that asked for them.
 *   2. A search ad is not a creative. It is a pool of headlines Google
 *      recombines per auction; there is nothing to look at, and judging one
 *      beside a video compares campaigns rather than creative.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');
const filters = require('../lib/filters');

const project = (entities, params = {}) => PROJECTIONS.creatives(entities, { f_channel: 'google', ...params });

const day = (over = {}) => ({
  entity: 'googleAd', adId: '11', ad: null, adType: 'RESPONSIVE_SEARCH_AD', status: 'ENABLED',
  adgroupId: '7', campaignId: '1', date: '2026-08-20',
  spend: 2000000, impressions: 6520, clicks: 900, leads: 12, ...over,
});

const video = (over = {}) => day({
  adId: '22', ad: 'WalkAround #4', adType: 'DEMAND_GEN_VIDEO_RESPONSIVE_AD', campaignId: '2',
  date: '2026-08-21', spend: 137000, impressions: 9267, clicks: 90, leads: 0, ...over,
});

const CAMPAIGNS = [
  { platform: 'google_ads', campaignId: '1', campaign: 'usp keywords campaign', channelType: 'SEARCH', date: '2026-08-21' },
  { platform: 'google_ads', campaignId: '2', campaign: 'mofu', channelType: 'DEMAND_GEN', date: '2026-08-21' },
  /* Meta's rows share this collection and must not become Google creatives. */
  { platform: 'meta_ads', campaignId: '9', campaign: 'meta prospecting', date: '2026-08-21' },
];

/* One search ad over two days, one video. The search ad is the one that must
   not appear. */
const ENTITIES = {
  googleAds: [
    day(),
    day({ date: '2026-08-21', spend: 605000, impressions: 1000, clicks: 120, leads: 3 }),
    video(),
  ],
  campaignDays: CAMPAIGNS,
};

/* ── what is on the screen, and what is deliberately not ─────────────────── */

test('search ads are not creative, and are counted rather than dropped in silence', () => {
  const out = project(ENTITIES);

  assert.deepEqual(out.creatives.map((c) => c.title), ['WalkAround #4']);
  assert.match(out.creativeSummary, /1 search ad not shown/);

  const note = out.creativeNotes.find((n) => /Search ads are not here/.test(n.heading));
  assert.ok(note, 'the screen does not say what it left off');
  assert.match(note.text, /Ad Analytics/);
  /* The money left off is named, so nobody reads the total as the account's. */
  assert.match(note.text, /₹26,050/);
});

test('a Google creative reports what Google measured, summed over its days', () => {
  const entities = {
    googleAds: [video(), video({ date: '2026-08-20', spend: 63000, impressions: 4000, clicks: 30, leads: 1 })],
    campaignDays: CAMPAIGNS,
  };
  const [row] = project(entities).creatives;

  assert.equal(row.title, 'WalkAround #4');
  assert.equal(row.spendTotal, '₹2,000', 'the two days did not sum');
  assert.equal(row.dur, '2 days');
  assert.match(row.headline, /mofu/);
  assert.match(row.headline, /13,267 impressions/);
  assert.equal(row.ctr, '0.90%');
});

test('an unnamed creative is shown by its id rather than as a blank', () => {
  const entities = {
    googleAds: [video({ adId: '77', ad: null, adType: 'DEMAND_GEN_IMAGE_AD' })],
    campaignDays: CAMPAIGNS,
  };
  assert.equal(project(entities).creatives[0].title, '#77');
});

test('everything Google does not report about a creative is dashed, not filled', () => {
  /* The tiles are labelled by the design: COST / INT. LEAD, CPL, HOOK, HOLD,
     INT. LEADS, RESERVATIONS, RES. VALUE, ROAS. Not one is a thing Google
     reports about an ad, and the nearest available number is not the same
     number. */
  const [row] = project(ENTITIES).creatives;

  for (const field of ['spend', 'cpl', 'hookPct', 'holdPct', 'intLeads', 'reservations', 'resValue', 'roas']) {
    assert.equal(row[field], '—', `${field} was filled from something Google does not measure`);
  }
  assert.equal(row.fatigue, '—');
  assert.match(row.fatigueWhy, /frequency/);
  assert.match(row.intLeadsWhy, /tags a lead to a campaign, not to an ad/);
});

test('Google conversions are named as Google conversions, never as leads', () => {
  const quiet = project(ENTITIES).creatives[0];
  assert.equal(quiet.verdictInstruction, 'No Google conversions in this range');
  assert.equal(quiet.cpl, '—');

  const converting = project({
    googleAds: [video({ adId: '33', ad: 'Reel 2', spend: 200000, impressions: 100, clicks: 10, leads: 4 })],
    campaignDays: CAMPAIGNS,
  }).creatives[0];

  assert.match(converting.verdictInstruction, /4 Google conversions at ₹500/);
  assert.match(converting.verdictBecause, /not a lead count/);
  assert.doesNotMatch(converting.verdictInstruction, /lead/i);
});

test('the card carries no image, and does not pretend to', () => {
  /* Meta cards fetch a thumbnail through the gradient binding. Google's ads
     report has no asset to fetch, so the card must not point at a proxy route
     that can only 404. */
  const [row] = project(ENTITIES).creatives;

  assert.doesNotMatch(row.grad, /url\(/);
  assert.equal(row.video, '');
  assert.equal(row.poster, '');
});

test('nothing on this channel is scored, and the bar says nothing rather than something', () => {
  const [row] = project(ENTITIES).creatives;
  assert.equal(row.bestScore, '—');
  assert.equal(row.winning, '0%');
  assert.match(project(ENTITIES).verdictLegend, /not a recommendation/);
});

/* ── the channel is the Channel chip ─────────────────────────────────────── */

test('the card carries the channel token the filter compares against', () => {
  /* applyFilters keeps a row when String(row[field]) === the selection,
     exactly. A card reading "Google Ads · demand gen" would be dropped by the
     very chip that asked for it, and the screen would select Google and show
     nothing. */
  const out = project(ENTITIES);
  assert.equal(out.creatives[0].platform, 'google');

  const kept = filters.applyFilters({ creatives: out.creatives }, { f_channel: 'google' });
  assert.equal(kept.payload.creatives.length, out.creatives.length, 'the Channel chip filtered away its own screen');
});

test('the surface is on the card, and a video creative stays where Google put it', () => {
  const [row] = project(ENTITIES).creatives;
  assert.match(row.hook, /demand gen$/);
  assert.match(row.type, /video/);
  assert.doesNotMatch(row.hook, /· video$/, 'a video creative was filed as a Video campaign');
  assert.equal(row.lifecycle, 'demand gen campaign');
});

test('the two channels are a switch, and each names the other through the chip', () => {
  const google = project(ENTITIES);
  assert.deepEqual(google.viewTabs.map((t) => t.label), ['Meta ads', 'Google Ads']);
  assert.match(google.viewTabs[1].go, /f_channel=google/);
  /* Back to Meta by clearing the chip: the Meta cards carry the label 'Meta'
     where the chip's token is lowercase, so f_channel=meta would filter away the
     screen it just asked for. */
  assert.doesNotMatch(google.viewTabs[0].go, /f_channel/);

  const meta = PROJECTIONS.creatives({ creatives: [] }, {});
  assert.deepEqual(meta.viewTabs.map((t) => t.label), ['Gallery', 'Leaderboard', 'Timeline', 'Google Ads']);
  assert.match(meta.viewTabs[3].go, /f_channel=google/);
});

test('ranking can be changed, and every order is one Google reports', () => {
  const entities = {
    googleAds: [
      video({ adId: '33', ad: 'Reel 2', spend: 200000, impressions: 100, clicks: 10, leads: 4 }),
      video(),
    ],
    campaignDays: CAMPAIGNS,
  };

  assert.deepEqual(project(entities).creatives.map((c) => c.title), ['Reel 2', 'WalkAround #4']);
  assert.deepEqual(project(entities, { sort: 'ctr' }).creatives.map((c) => c.title), ['Reel 2', 'WalkAround #4']);

  const cheapest = project(entities, { sort: 'cpa' });
  assert.equal(cheapest.sortLabel, 'Cost per conversion');
  /* The creative with no conversions has no cost per one, and sorts last in
     either direction rather than winning "cheapest". */
  assert.equal(cheapest.creatives[cheapest.creatives.length - 1].title, 'WalkAround #4');
});

test('the census counts surfaces and opens Ad Analytics at one', () => {
  const { creativeCensus } = project(ENTITIES);
  assert.deepEqual(creativeCensus.map((c) => `${c.count} ${c.label}`), ['1 demand gen']);
  assert.match(creativeCensus[0].go, /segment=DEMAND_GEN/);
});

test('Meta rows in the shared collections do not become Google creatives', () => {
  const rows = project(ENTITIES).creatives;
  assert.equal(rows.length, 1);
  assert.ok(!rows.some((r) => /meta prospecting/.test(r.headline)));
});

test('the range travels with every link out of the channel', () => {
  const out = project(ENTITIES, { period: '90d' });
  for (const href of [out.sortNext, out.goalNext, ...out.viewTabs.map((t) => t.go), out.creatives[0].go]) {
    assert.match(href, /period=90d/, `a link dropped the range: ${href}`);
  }
});
