/* Which part of the funnel a creative is working in.
 *
 * The case that forced this file into existence: a lead-gen account running its
 * whole funnel — broad prospecting, 60-day engagers, 30-day video watchers —
 * under one `OUTCOME_LEADS` objective. Reading the objective filed all
 * twenty-five creatives under "Bottom of funnel" and the badge said nothing.
 *
 * The ad set names below are the real ones from that account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const funnel = require('../lib/creative-funnel');

/* The account's own audiences, as canonical resolves them: id -> retention. */
const AUDIENCES = {
  '900060': { name: 'All 60 Days KL', retentionDays: 60 },
  '900030': { name: '30 Days 75% Watchers', retentionDays: 30 },
  '900007': { name: '7 Day Site Visitors', retentionDays: 7 },
  '900365': { name: 'All 365 Days', retentionDays: 365 },
};

const on = (creative) => funnel.stageFor(creative, AUDIENCES);

/* ── targeting, the signal that should answer ───────────────────────────── */

test('no custom audience is cold traffic, whatever the objective says', () => {
  const r = on({ targeting: { customAudienceIds: [] }, objective: 'OUTCOME_LEADS' });

  assert.equal(r.stage, 'Top');
  assert.equal(r.signal, 'targeting');
  assert.match(r.because, /no custom audience/);
});

/* A Bangalore holidaymaker who has never heard of the resort is at the top of
   the funnel whether or not the city was named. */
test('narrowing by geography or interest is still cold', () => {
  assert.equal(on({ targeting: { customAudienceIds: [], geo: ['Bangalore'] } }).stage, 'Top');
});

test('a recent audience is the bottom of the funnel', () => {
  const r = on({ targeting: { customAudienceIds: ['900030'] }, objective: 'OUTCOME_LEADS' });

  assert.equal(r.stage, 'Bottom');
  assert.match(r.because, /30-day audience/);
});

test('an audience older than the hot window is warm, not hot', () => {
  const r = on({ targeting: { customAudienceIds: ['900060'] } });

  assert.equal(r.stage, 'Middle');
  assert.match(r.because, /60-day/);
});

/* The hottest audience in the mix decides how the ad set behaves; averaging two
   windows would describe neither. */
test('an ad set on several audiences takes the shortest window', () => {
  assert.equal(on({ targeting: { customAudienceIds: ['900365', '900060', '900007'] } }).stage, 'Bottom');
  assert.equal(on({ targeting: { customAudienceIds: ['900365', '900060'] } }).stage, 'Middle');
});

/* Thirty days is the boundary, and boundaries are where this gets argued. */
test('the hot window is inclusive at its edge', () => {
  assert.equal(on({ targeting: { customAudienceIds: ['900030'] } }).stage, 'Bottom', '30 days is hot');
  assert.equal(on({ targeting: { customAudienceIds: ['900060'] } }).stage, 'Middle', '60 days is not');
});

/* Having an audience it cannot price is not the same as having none. */
test('an unknown audience is never read as broad', () => {
  const r = funnel.stageFor(
    { targeting: { customAudienceIds: ['999999'] }, adsetName: 'Mystery', objective: 'OUTCOME_LEADS' },
    AUDIENCES,
  );

  assert.notEqual(r.stage, 'Top', 'an ad set with a custom audience is certainly not cold');
  assert.equal(r.signal, 'objective', 'with no retention to read it falls through rather than guessing');
});

/* ── the name, when targeting cannot answer ─────────────────────────────── */

test('the account\'s own ad set names resolve the stage', () => {
  const named = (adsetName) => funnel.stageFor({ adsetName, objective: 'OUTCOME_LEADS' }, AUDIENCES);

  assert.equal(named('Broad | Kerala').stage, 'Top');
  assert.equal(named('Broad | TN').stage, 'Top');
  assert.equal(named('All 60 Days KL').stage, 'Middle');
  assert.equal(named('All 60 Days Mumbai').stage, 'Middle');
  assert.equal(named('30 Days 75% Watchers').stage, 'Bottom');
});

test('a name-read stage says it was read from a name', () => {
  const r = funnel.stageFor({ adsetName: 'All 60 Days KL' }, AUDIENCES);

  assert.equal(r.signal, 'name');
  assert.match(funnel.meaning(r), /Read from the ad set's name/);
});

/* An ad set named for both should read as the pool it retargets. */
test('a day count beats the word broad', () => {
  assert.equal(funnel.fromName('Broad | 30 Days Watchers').stage, 'Bottom');
});

test('a named audience with no window given is warm, not hot', () => {
  /* The name says there is an audience but not how recent it is; calling it hot
     would claim the thing that was not said. */
  assert.equal(funnel.fromName('Lookalike 1% — past bookers').stage, 'Middle');
  assert.equal(funnel.fromName('IG Engagers').stage, 'Middle');
});

/* "Cities | TN" names a place, not an audience. */
test('a name that says nothing about an audience does not answer', () => {
  assert.equal(funnel.fromName('Cities | TN'), null);
  assert.equal(funnel.fromName('Ad set 4'), null);
  assert.equal(funnel.fromName(''), null);
});

/* ── the objective, last ────────────────────────────────────────────────── */

test('the objective still answers when nothing better can', () => {
  const r = funnel.stageFor({ objective: 'OUTCOME_AWARENESS' }, AUDIENCES);

  assert.equal(r.stage, 'Top');
  assert.equal(r.signal, 'objective');
});

test('targeting outranks the name, and the name outranks the objective', () => {
  /* All three disagree on purpose. */
  const creative = {
    targeting: { customAudienceIds: ['900007'] },
    adsetName: 'Broad | Kerala',
    objective: 'OUTCOME_AWARENESS',
  };

  assert.equal(on(creative).stage, 'Bottom', 'targeting wins');
  assert.equal(funnel.stageFor({ adsetName: 'Broad | Kerala', objective: 'OUTCOME_LEADS' }, AUDIENCES).stage, 'Top', 'the name beats the objective');
});

/* ── declining ──────────────────────────────────────────────────────────── */

test('nothing readable is declined, never defaulted', () => {
  assert.equal(funnel.stageFor({}, AUDIENCES), null);
  assert.equal(funnel.stageFor({ adsetName: 'Ad set 9', objective: 'SOMETHING_NEW' }, AUDIENCES), null);
  assert.equal(funnel.label(null), null);
  assert.equal(funnel.rank(null), null);
  assert.match(funnel.meaning(null), /Declined rather than guessed/);
});

/* Top, then Middle, then Bottom — the order the funnel is drawn in. Ranking by
   the stage's name would put Bottom first, which is the funnel upside down. */
test('the stages rank in funnel order', () => {
  const rankOf = (stage) => funnel.rank({ stage });
  assert.ok(rankOf('Top') < rankOf('Middle'));
  assert.ok(rankOf('Middle') < rankOf('Bottom'));
});

/* The reader is entitled to know how strong the claim is: a stage read from a
   retention window and one read from a name are not the same claim. */
test('the tooltip names the signal that answered and what the stage is for', () => {
  const byTargeting = on({ targeting: { customAudienceIds: ['900007'] } });

  assert.match(funnel.meaning(byTargeting), /Read from the ad set's targeting/);
  assert.match(funnel.meaning(byTargeting), /judge it on cost per lead/);
  assert.match(funnel.meaning(on({ targeting: { customAudienceIds: [] } })), /judge it on reach and hook rate/);
});

/* ── the single-objective account ───────────────────────────────────────── */

/* The failure this whole file was rewritten to avoid, in its last hiding
   place: an account that runs its entire funnel under one OUTCOME_LEADS. The
   objective then does not classify anything, it labels everything — and a
   constant wearing the appearance of a measurement is worse than a dash. */
test('an objective every creative shares stops being a signal', () => {
  const uniform = [
    { objective: 'OUTCOME_LEADS' }, { objective: 'OUTCOME_LEADS' }, { objective: 'OUTCOME_LEADS' },
  ];
  assert.equal(funnel.objectiveVaries(uniform), false);

  const declined = funnel.stageFor({ adsetName: 'Cities | TN', objective: 'OUTCOME_LEADS' }, {}, { objectiveVaries: false });
  assert.equal(declined, null, 'cold city traffic must not be filed under Bottom');
});

test('an account running several objectives still reads them', () => {
  const varied = [{ objective: 'OUTCOME_LEADS' }, { objective: 'OUTCOME_AWARENESS' }];
  assert.equal(funnel.objectiveVaries(varied), true);

  const read = funnel.stageFor({ objective: 'OUTCOME_AWARENESS' }, {}, { objectiveVaries: true });
  assert.equal(read.stage, 'Top');
});

/* The stronger signals are unaffected — they never needed the objective. */
test('targeting and the name still answer on a single-objective account', () => {
  const opts = { objectiveVaries: false };

  assert.equal(funnel.stageFor({ adsetName: 'Broad | Kerala', objective: 'OUTCOME_LEADS' }, {}, opts).stage, 'Top');
  assert.equal(funnel.stageFor({ adsetName: 'All 60 Days KL', objective: 'OUTCOME_LEADS' }, {}, opts).stage, 'Middle');
  assert.equal(funnel.stageFor({ adsetName: '30 Days 75% Watchers', objective: 'OUTCOME_LEADS' }, {}, opts).stage, 'Bottom');
  /* And with the targeting fetched, the city ad sets resolve properly. */
  assert.equal(funnel.stageFor({ adsetName: 'Cities | TN', targeting: { customAudienceIds: [] } }, {}, opts).stage, 'Top');
});

/* ── stacked audiences ──────────────────────────────────────────────────── */

/* The real account's shape, and the reason MOFU was unreachable on it.
 *
 * Every retargeting ad set stacks a small 30-day pool beside a much larger
 * 60-day one. Picking the shortest window described the part of the ad set that
 * barely runs: 28 creatives read BOFU and not one read MOFU, which described
 * the rule rather than the account. */
const STACKED = {
  hot: { name: '75% Video Watchers 30 Days', retentionDays: 30, size: 3900 },
  warm: { name: '50% Watchers 60 days', retentionDays: 60, size: 53400 },
  old: { name: 'IG Messaged Customers 180 Days', retentionDays: 180, size: 2400 },
  unsized: { name: 'Wishlist 30 Days', retentionDays: 30, size: null },
  unsizedWarm: { name: 'Website Leads 60 Days', retentionDays: 60, size: null },
};

const stacked = (...ids) => funnel.stageFor({ targeting: { customAudienceIds: ids } }, STACKED, { objectiveVaries: false });

test('the audience that receives the delivery decides the stage', () => {
  /* 53,400 people at 60 days beside 3,900 at 30: roughly ninety-three percent
     of the impressions go to the warm pool, so the ad set is warm. */
  const mixed = stacked('hot', 'warm');
  assert.equal(mixed.stage, 'Middle');
  assert.match(mixed.because, /largest audience is a 60-day pool/);
  assert.match(mixed.because, /50% Watchers 60 days/, 'and names which pool decided it');
});

test('a genuinely hot ad set is still hot', () => {
  assert.equal(stacked('hot').stage, 'Bottom');
  assert.equal(stacked('hot', 'old').stage, 'Bottom', '3,900 beats 2,400');
});

test('a stack of warm pools is warm', () => {
  assert.equal(stacked('warm', 'old').stage, 'Middle');
});

/* Meta withholds sizes on very small audiences. With nothing to weigh by, the
   hottest audience is the safer assumption. */
test('with no sizes reported it falls back to the shortest window', () => {
  const r = stacked('unsized', 'unsizedWarm');
  assert.equal(r.stage, 'Bottom');
  assert.match(r.because, /retargeting a 30-day audience/);
});

test('one sized pool among unsized ones still decides', () => {
  assert.equal(stacked('unsized', 'warm').stage, 'Middle', 'the only pool with a size is the one that can be weighed');
});
