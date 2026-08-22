/* Creative Intelligence, Google's half.
 *
 *   node --test test/creatives-google.test.js
 *
 * Meta's ad object is a creative — a thumbnail, a video, a frequency, a
 * retention curve — and the screen's nineteen fields were designed around it.
 * Google's is not: a responsive search ad is a set of headlines Google
 * assembles per auction. So most of what is worth testing here is the same
 * thing test/creatives.test.js tests for Meta — the *declining*. A channel that
 * quietly filled hook, hold, fatigue and ROAS from something adjacent would
 * produce a screen that looks complete and is partly invented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');

const project = (entities, params = {}) => PROJECTIONS.creatives(entities, { channel: 'google', ...params });

const day = (over = {}) => ({
  entity: 'googleAd', adId: '11', ad: null, adType: 'RESPONSIVE_SEARCH_AD', status: 'ENABLED',
  adgroupId: '7', campaignId: '1', date: '2026-08-20',
  spend: 2000000, impressions: 6520, clicks: 900, leads: 12, ...over,
});

const ENTITIES = {
  googleAds: [
    day(),
    day({ date: '2026-08-21', spend: 605000, impressions: 1000, clicks: 120, leads: 3 }),
    day({ adId: '22', ad: 'WalkAround #4', adType: 'DEMAND_GEN_VIDEO_RESPONSIVE_AD', campaignId: '2', date: '2026-08-21', spend: 137000, impressions: 9267, clicks: 90, leads: 0 }),
  ],
  campaignDays: [
    { platform: 'google_ads', campaignId: '1', campaign: 'usp keywords campaign', channelType: 'SEARCH', date: '2026-08-21' },
    { platform: 'google_ads', campaignId: '2', campaign: 'mofu', channelType: 'DEMAND_GEN', date: '2026-08-21' },
    /* Meta's rows share this collection and must not become Google creatives. */
    { platform: 'meta_ads', campaignId: '9', campaign: 'meta prospecting', date: '2026-08-21' },
  ],
};

test('a Google ad reports what Google measured, summed over its days', () => {
  const [row] = project(ENTITIES).creatives;

  assert.equal(row.title, '#11', 'an unnamed ad must be shown by its id, not as a blank');
  assert.equal(row.spendTotal, '₹26,050', 'the two days did not sum');
  assert.equal(row.ctr, '13.56%');
  assert.match(row.headline, /usp keywords campaign/);
  assert.match(row.headline, /7,520 impressions/);
  assert.equal(row.dur, '2 days');
});

test('everything Google does not report about an ad is dashed, not filled', () => {
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
  /* The count sums every action the account defines — an enquiry and a phone
     click alike — so calling it a lead count would be the same mislabelling the
     keyword screen refuses to make. */
  const [row] = project(ENTITIES).creatives;

  assert.match(row.verdictInstruction, /15 Google conversions at ₹1,737/);
  assert.match(row.verdictBecause, /not a lead count/);
  assert.doesNotMatch(row.verdictInstruction, /lead/i);
});

test('an ad with no conversions says so rather than showing a zero cost', () => {
  const row = project(ENTITIES).creatives.find((c) => c.title === 'WalkAround #4');
  assert.equal(row.verdictInstruction, 'No Google conversions in this range');
  assert.equal(row.cpl, '—');
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

test('the surface comes from the campaign, and a video creative stays where Google put it', () => {
  const row = project(ENTITIES).creatives.find((c) => c.title === 'WalkAround #4');
  assert.equal(row.platform, 'Google Ads · demand gen');
  assert.match(row.type, /video/);
  assert.doesNotMatch(row.platform, /· video$/, 'a video creative was filed as a Video campaign');
});

test('ranking can be changed, and every order is one Google reports', () => {
  const bySpend = project(ENTITIES).creatives.map((c) => c.title);
  assert.deepEqual(bySpend, ['#11', 'WalkAround #4']);

  const byCtr = project(ENTITIES, { sort: 'ctr' }).creatives.map((c) => c.title);
  assert.deepEqual(byCtr, ['#11', 'WalkAround #4']);

  const cheapest = project(ENTITIES, { sort: 'cpa' });
  assert.equal(cheapest.sortLabel, 'Cost per conversion');
  /* The ad with no conversions has no cost per one, and sorts last in either
     direction rather than winning "cheapest". */
  assert.equal(cheapest.creatives[cheapest.creatives.length - 1].title, 'WalkAround #4');
});

test('the two channels are a switch, and each names the other', () => {
  const google = project(ENTITIES);
  assert.deepEqual(google.viewTabs.map((t) => t.label), ['Meta ads', 'Google Ads']);

  const meta = PROJECTIONS.creatives({ creatives: [] }, {});
  assert.deepEqual(meta.viewTabs.map((t) => t.label), ['Gallery', 'Leaderboard', 'Timeline', 'Google Ads']);
  assert.match(meta.viewTabs[3].go, /channel=google/);
});

test('the census counts surfaces and opens Ad Analytics at one', () => {
  const { creativeCensus } = project(ENTITIES);
  assert.deepEqual(creativeCensus.map((c) => `${c.count} ${c.label}`), ['1 search', '1 demand gen']);
  assert.match(creativeCensus[0].go, /segment=SEARCH/);
});

test('Meta rows in the shared collections do not become Google creatives', () => {
  const rows = project(ENTITIES).creatives;
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => /meta prospecting/.test(r.headline)));
});

test('the range travels with every link out of the channel', () => {
  const out = project(ENTITIES, { period: '90d' });
  for (const href of [out.sortNext, out.goalNext, ...out.viewTabs.map((t) => t.go), out.creatives[0].go]) {
    assert.match(href, /period=90d/, `a link dropped the range: ${href}`);
  }
});
