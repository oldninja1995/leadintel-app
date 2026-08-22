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
  /* The score took the headline once the quartile rates arrived; the conversion
     count moved to the line beneath it, where it still has to be named for what
     it is — every action the account defines, not leads. */
  const quiet = project(ENTITIES).creatives[0];
  assert.match(quiet.verdictBecause, /No Google conversions in this range/);
  assert.equal(quiet.cpl, '—');

  const converting = project({
    googleAds: [video({ adId: '33', ad: 'Reel 2', spend: 200000, impressions: 100, clicks: 10, leads: 4 })],
    campaignDays: CAMPAIGNS,
  }).creatives[0];

  assert.match(converting.verdictBecause, /4 Google conversions at ₹500/);
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

test('a creative Google measured nothing about keeps an empty bar', () => {
  /* The score exists only where a measure does. An ad with no impressions, no
     clicks and no conversions has nothing to be placed against the median on,
     and drawing a bar for it would be a width with no measurement behind it. */
  const entities = {
    googleAds: [video({ spend: 0, impressions: 0, clicks: 0, leads: 0, p25: null, p100: null })],
    campaignDays: CAMPAIGNS,
  };
  const [row] = project(entities).creatives;

  assert.equal(row.bestScore, '—');
  assert.equal(row.winning, '0%');
  assert.equal(row.confidence, '');
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

test('the channel is chosen by the chip, and nothing else offers to choose it', () => {
  /* There were two switches for one selection — the Channel chip in the filter
     bar and a Meta ads · Google Ads strip on the screen — which is how a reader
     ends up wondering which of them is authoritative. */
  assert.deepEqual(project(ENTITIES).viewTabs, []);

  const meta = PROJECTIONS.creatives({ creatives: [] }, {});
  assert.deepEqual(meta.viewTabs.map((t) => t.label), ['Gallery', 'Leaderboard', 'Timeline']);
  assert.ok(!meta.viewTabs.some((t) => /f_channel/.test(t.go)), 'the Meta strip still offers to change channel');
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
  for (const href of [out.sortNext, out.goalNext, out.creatives[0].go]) {
    assert.match(href, /period=90d/, `a link dropped the range: ${href}`);
  }
});

/* ── judged on Google's own measures ──────────────────────────────────────
 *
 * The cards were unscored and said so, which was right while the only measures
 * pulled were spend and clicks. The ads report carries the video quartile rates
 * once it is asked for them, and a quarter watched is a hook rate on Google's
 * own definition rather than by analogy with Meta's.
 */

const withVideo = (over = {}) => video({ p25: 0.4, p100: 0.1, videoViewRate: 0.3, ...over });

test('hook and hold are Google\'s quartile rates, not an analogy', () => {
  const [row] = project({ googleAds: [withVideo()], campaignDays: CAMPAIGNS }).creatives;
  assert.equal(row.hookPct, '40.0%');
  assert.equal(row.holdPct, '10.0%');
});

test('a creative that is not a video has no hook and no hold, and reads a dash', () => {
  /* Nobody failed to watch a search ad. A zero would say they did. */
  const entities = {
    googleAds: [video({ adType: 'DEMAND_GEN_IMAGE_AD', p25: null, p100: null })],
    campaignDays: CAMPAIGNS,
  };
  const [row] = project(entities).creatives;
  assert.equal(row.hookPct, '—');
  assert.equal(row.holdPct, '—');
});

test('100 is the channel median, and a creative is placed against it', () => {
  const entities = {
    googleAds: [
      withVideo({ adId: '1', ad: 'A', p100: 0.20, impressions: 10000, clicks: 100, spend: 100000, leads: 2 }),
      withVideo({ adId: '2', ad: 'B', p100: 0.10, impressions: 10000, clicks: 100, spend: 100000, leads: 2 }),
      withVideo({ adId: '3', ad: 'C', p100: 0.05, impressions: 10000, clicks: 100, spend: 100000, leads: 2 }),
    ],
    campaignDays: CAMPAIGNS,
  };
  const scored = Object.fromEntries(project(entities).creatives.map((c) => [c.title, Number(c.bestScore)]));

  assert.equal(scored.B, 100, 'the median creative is not the median score');
  assert.ok(scored.A > scored.B, 'holding twice as long scored no better');
  assert.ok(scored.C < scored.B);
});

test('a thin sample is marked rather than trusted', () => {
  /* Under a thousand impressions the measure is real and the sample is not,
     and saying which is which is the difference between a score and a claim. */
  const entities = {
    googleAds: [withVideo({ impressions: 400 }), withVideo({ adId: '9', ad: 'Other', impressions: 40000 })],
    campaignDays: CAMPAIGNS,
  };
  const thin = project(entities).creatives.find((c) => c.title === 'WalkAround #4');
  assert.equal(thin.confidence, 'thin');
});

test('a missing measure costs nothing rather than counting as zero', () => {
  /* One creative with no conversions and one with them must not make the first
     look worthless: it is scored on the three measures it has. */
  const entities = {
    googleAds: [
      withVideo({ adId: '1', ad: 'A', leads: 0, impressions: 10000, clicks: 100 }),
      withVideo({ adId: '2', ad: 'B', leads: 4, impressions: 10000, clicks: 100 }),
    ],
    campaignDays: CAMPAIGNS,
  };
  const a = project(entities).creatives.find((c) => c.title === 'A');
  assert.ok(Number(a.bestScore) >= 90, `a creative with no conversions scored ${a.bestScore}`);
  assert.match(a.confidence, /3 measures/);
});

test('the score says what carried it and what dragged it', () => {
  const entities = {
    googleAds: [
      withVideo({ adId: '1', ad: 'A', p100: 0.3, clicks: 10, impressions: 10000 }),
      withVideo({ adId: '2', ad: 'B', p100: 0.05, clicks: 900, impressions: 10000 }),
    ],
    campaignDays: CAMPAIGNS,
  };
  const a = project(entities).creatives.find((c) => c.title === 'A');
  assert.match(a.verdictInstruction, /best on hold/);
  assert.match(a.verdictInstruction, /worst on click-through/);
  assert.match(a.verdictWhy, /100 is this channel's median/);
});
