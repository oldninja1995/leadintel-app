/* Creative Intelligence, from Meta's ads.
 *
 * The screen shows nineteen fields per row and Meta supports seven of them. So
 * most of what is worth testing here is the *declining*: a projection that
 * quietly filled the other twelve would produce a screen that looks complete
 * and is partly invented, which is the one outcome this driver exists to avoid.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');
const canonical = require('../lib/ingest/canonical');

const project = PROJECTIONS.creatives;
/* The driver spreads a projection over the payload, so it returns an object
   keyed by collection name. Unwrapped here to keep the assertions readable. */
const creatives = (entities) => project(entities).creatives;

const entitiesWith = (rows) => ({ creatives: rows });

const CREATIVE = {
  entity: 'creative', id: '99201', adId: '99201', title: 'UGC video 03',
  platform: 'meta', spend: 126000, impressions: 1000, clicks: 34, days: 7,
};

test('a measured creative reports its real spend and click-through rate', () => {
  const [row] = creatives(entitiesWith([CREATIVE]));

  assert.equal(row.title, 'UGC video 03');
  assert.equal(row.platform, 'Meta');
  assert.equal(row.spend, '₹1,260');
  assert.equal(row.ctr, '3.40%');
});

/* The distinction the whole driver turns on. */
test('a creative nothing measured declines rather than reporting zero', () => {
  const [row] = creatives(entitiesWith([
    { ...CREATIVE, spend: null, impressions: null, clicks: null, days: 0 },
  ]));

  assert.equal(row.spend, '—', 'an unmeasured ad did not spend nothing');
  assert.equal(row.ctr, '—');
});

test('the fields Meta cannot support are declined, never filled', () => {
  const [row] = creatives(entitiesWith([CREATIVE]));

  /* What is left after the re-labelled cells took the ones Meta can answer:
     format needs the creative object, hook and hold need video milestones, and
     fatigue needs history. */
  for (const field of ['type', 'dur', 'hook', 'hookRate', 'fatigue']) {
    assert.equal(row[field], '—', `${field} must be declined, not invented`);
  }
});

/* The three cells that used to be permanently dead now carry Meta metrics, and
   their labels were re-bound to match — see tools/literal-bindings.js. */
test('the re-labelled cells carry the metric their label now names', () => {
  const [row] = creatives(entitiesWith([
    { ...CREATIVE, cpm: 210.5, frequency: 1.84, spend: 126000, clicks: 34 },
  ]));

  assert.equal(row.bookings, '₹211', 'CPM');
  assert.equal(row.rev, '1.8×', 'frequency');
  assert.equal(row.roas, '₹37', 'CPC — ₹1,260 over 34 clicks');
});

test('a re-labelled cell still declines when its metric is missing', () => {
  const [row] = creatives(entitiesWith([
    { ...CREATIVE, cpm: null, frequency: null, clicks: 0 },
  ]));

  assert.equal(row.bookings, '—');
  assert.equal(row.rev, '—');
  assert.equal(row.roas, '—', 'no clicks is not a cost per click of zero');
});

/* Revenue per creative needs ad-level identity resolution joined to PMS
   bookings, and the PMS is still on fixtures — crediting real ads with fixture
   revenue would invent a return nobody earned. */
/* Revenue-based judgement is still declined — it is simply no longer occupying
   those cells. The detail panel is where bookings and ROAS now live, and both
   stay dashed until the PMS and CRM are real. */
test('revenue and bookings stay declined in the detail panel', () => {
  const panel = PROJECTIONS['overlay-creative-detail'](entitiesWith([CREATIVE]), { cr: '1' }).selCr;
  assert.equal(panel.roas, '—');
  assert.equal(panel.bookings, '—');
});

test('rows are ranked by spend', () => {
  const rows = creatives(entitiesWith([
    { ...CREATIVE, adId: 'a', title: 'small', spend: 100 },
    { ...CREATIVE, adId: 'c', title: 'big', spend: 900 },
  ]));

  assert.deepEqual(rows.map((r) => r.title), ['big', 'small']);
});

/* The ads edge answers with every ad the account ever created, while insights
   cover only the window pulled — 1,175 against 47 on the real account. Showing
   all of them buries the ones that matter under rows of `—`. */
test('creatives nothing measured are kept out of the ranking', () => {
  const rows = creatives(entitiesWith([
    { ...CREATIVE, adId: 'a', title: 'ran', spend: 100 },
    { ...CREATIVE, adId: 'b', title: 'never ran', spend: null },
    { ...CREATIVE, adId: 'c', title: 'also never', spend: undefined },
  ]));

  assert.deepEqual(rows.map((r) => r.title), ['ran']);
});

/* An empty screen would read as a broken connection rather than a quiet spell. */
test('when nothing at all was measured, the unmeasured set is shown instead', () => {
  const rows = creatives(entitiesWith([
    { ...CREATIVE, adId: 'a', title: 'one', spend: null },
    { ...CREATIVE, adId: 'b', title: 'two', spend: null },
  ]));

  assert.equal(rows.length, 2, 'better a screen of dashes than a screen of nothing');
});

/* ── the creative itself ────────────────────────────────────────────────── */

test('a thumbnail is delivered through the proxy, not from Meta directly', () => {
  const [row] = creatives(entitiesWith([
    { ...CREATIVE, thumbnailUrl: 'https://scontent.xx.fbcdn.net/v/t45.png?_nc_cat=1' },
  ]));

  assert.match(row.grad, /url\('\/creatives\/99201\/thumbnail'\)/);
  assert.ok(!row.grad.includes('fbcdn.net'), 'the CDN address must not reach the browser');
});

/* An expired signature should look like it did before, not like a broken page. */
test('the gradient stays underneath as the fallback', () => {
  const [withImage] = creatives(entitiesWith([{ ...CREATIVE, thumbnailUrl: 'https://x.fbcdn.net/a.png' }]));
  const [without] = creatives(entitiesWith([{ ...CREATIVE, thumbnailUrl: null }]));

  assert.match(withImage.grad, /linear-gradient/);
  assert.equal(without.grad, 'linear-gradient(135deg,#2b2741,#5d5294)');
});

test('Meta\'s object type becomes the format column', () => {
  const video = creatives(entitiesWith([{ ...CREATIVE, objectType: 'VIDEO' }]))[0];
  const image = creatives(entitiesWith([{ ...CREATIVE, objectType: 'SHARE' }]))[0];
  const unknown = creatives(entitiesWith([{ ...CREATIVE, objectType: null }]))[0];

  assert.equal(video.type, 'Video');
  assert.equal(video.icon, 'ph-fill ph-play-circle');
  assert.equal(image.type, 'Image');
  assert.equal(unknown.type, '—', 'an unreported format is declined, not guessed');
});

test('a creative with no name falls back to its ad id rather than blank', () => {
  const [row] = creatives(entitiesWith([{ ...CREATIVE, title: null }]));
  assert.equal(row.title, '99201');
});

test('no creatives at all is an empty screen, not a crash', () => {
  assert.deepEqual(creatives({}), []);
  assert.deepEqual(creatives({ creatives: [] }), []);
});

/* ── the canonical join ─────────────────────────────────────────────────── */

/* Identity comes from the ads edge and measurement from ad-level insights, as
   two kinds describing one thing. If the join breaks, every creative silently
   reports no spend — which looks like a quiet account rather than a bug. */
test('canonical joins a creative to the ad-level insights that measure it', () => {
  const entities = canonical.build([
    {
      source: 'meta_ads',
      kind: 'creative',
      externalId: '99201',
      body: { id: '99201', name: 'UGC video 03', status: 'ACTIVE', creative: { id: 'CR-9021' } },
    },
    {
      source: 'meta_ads',
      kind: 'ad_day',
      externalId: '99201:2026-07-14',
      body: {
        ad_id: '99201', ad_name: 'UGC video 03', date_start: '2026-07-14',
        account_currency: 'INR', spend: '700', impressions: '1000', clicks: '34',
      },
    },
    {
      source: 'meta_ads',
      kind: 'ad_day',
      externalId: '99201:2026-07-15',
      body: {
        ad_id: '99201', ad_name: 'UGC video 03', date_start: '2026-07-15',
        account_currency: 'INR', spend: '300', impressions: '500', clicks: '16',
      },
    },
  ]);

  assert.equal(entities.creatives.length, 1);
  const [c] = entities.creatives;

  assert.equal(c.adId, '99201');
  assert.equal(c.creativeId, 'CR-9021', 'the creative link must survive');
  /* ₹700 + ₹300 = ₹1,000 = 100000 paise, summed across both days. */
  assert.equal(c.spend, 100000);
  assert.equal(c.impressions, 1500);
  assert.equal(c.days, 2);
});

test('a creative with no insight rows keeps its identity and reports null spend', () => {
  const entities = canonical.build([
    {
      source: 'meta_ads',
      kind: 'creative',
      externalId: '99999',
      body: { id: '99999', name: 'never ran', status: 'PAUSED', creative: { id: 'CR-1' } },
    },
  ]);

  const [c] = entities.creatives;
  assert.equal(c.title, 'Never Ran');
  assert.equal(c.spend, null, 'no measurement is not a measurement of zero');
  assert.equal(c.days, 0);
});

/* The fixtures must stay clean — a field the request never asked for is absent,
   not malformed, and must not consume the problem channel. */
test('a creative missing optional fields raises no normalisation problem', () => {
  const entities = canonical.build([
    {
      source: 'meta_ads',
      kind: 'creative',
      externalId: 'CR-9021',
      body: { creative_id: 'CR-9021', ad_id: '99201', title: 'x', type: 'video', updated_at: '2026-07-14T09:12:00+00:00' },
    },
  ]);

  assert.deepEqual(entities.problems, []);
});

/* ── the detail panel ───────────────────────────────────────────────────── */

const overlay = PROJECTIONS['overlay-creative-detail'];

const THREE = {
  creatives: ['first', 'second', 'third'].map((t, i) => ({
    ...CREATIVE, adId: `ad-${i}`, title: t, spend: 900 - i * 100,
  })),
};

/* The bug this exists to prevent: every card was hardcoded to cr=1, so
   whichever creative you clicked, you got the first one's numbers. */
test('each card links to its own detail', () => {
  const rows = creatives(THREE);
  /* The ranking *and the view* ride along, so a card opens what was clicked
     whichever ordering the screen was showing. */
  assert.deepEqual(rows.map((r) => r.go), [
    '/creatives?view=leaderboard&sort=best&cr=1',
    '/creatives?view=leaderboard&sort=best&cr=2',
    '/creatives?view=leaderboard&sort=best&cr=3',
  ]);
});

test('the panel shows the creative that was clicked', () => {
  assert.equal(overlay(THREE, { cr: '2' }).selCr.title, 'second');
  assert.equal(overlay(THREE, { cr: '3' }).selCr.title, 'third');
});

/* A panel that disagreed with the card it opened from would be worse than
   either being wrong alone. */
test('the panel agrees with its card', () => {
  const card = creatives(THREE)[1];
  const panel = overlay(THREE, { cr: '2' }).selCr;

  assert.equal(panel.title, card.title);
  assert.equal(panel.spend, card.spend);
  assert.equal(panel.ctr, card.ctr);
  assert.equal(panel.fatigue, card.fatigue);
});

test('an out-of-range or missing selection falls back rather than emptying', () => {
  assert.equal(overlay(THREE, { cr: '99' }).selCr.title, 'first');
  assert.equal(overlay(THREE, {}).selCr.title, 'first');
  assert.deepEqual(overlay({ creatives: [] }, { cr: '1' }), {});
});

test('the panel declines what Meta does not report', () => {
  const panel = overlay(THREE, { cr: '1' }).selCr;
  for (const field of ['thumbStop', 'watch', 'quality', 'bookings', 'roas']) {
    assert.equal(panel[field], '—', `${field} must be declined`);
  }
});

/* ── sorting ────────────────────────────────────────────────────────────── */

const RANKABLE = {
  creatives: [
    { ...CREATIVE, adId: 'a', title: 'big-spend', spend: 900, clicks: 10, impressions: 10000, cpm: 300, frequency: 3.1 },
    { ...CREATIVE, adId: 'b', title: 'efficient', spend: 500, clicks: 50, impressions: 10000, cpm: 100, frequency: 1.2 },
    { ...CREATIVE, adId: 'c', title: 'unmeasured', spend: 100, clicks: 0, impressions: 10000, cpm: null, frequency: null },
  ],
};

/* The screen opens on the ranking that answers "what do I do first", not on a
   column. Nothing in RANKABLE has leads, so every verdict is "not enough data"
   and Best falls through to its spend tiebreak — what is asserted here is the
   default, not the tiebreak. */
test('the screen opens ranked by what to act on first', () => {
  const out = project(RANKABLE);
  assert.equal(out.sortLabel, 'Best');
  assert.deepEqual(out.creatives.map((r) => r.title), ['big-spend', 'efficient', 'unmeasured']);
});

test('an explicit column still ranks by that column', () => {
  const out = project(RANKABLE, { sort: 'spend' });
  assert.equal(out.sortLabel, 'Spend');
  assert.deepEqual(out.creatives.map((r) => r.title), ['big-spend', 'efficient', 'unmeasured']);
});

test('a cost metric ranks cheapest first, a performance metric ranks best first', () => {
  assert.equal(project(RANKABLE, { sort: 'cpm' }).creatives[0].title, 'efficient');
  assert.equal(project(RANKABLE, { sort: 'ctr' }).creatives[0].title, 'efficient');
  assert.equal(project(RANKABLE, { sort: 'frequency' }).creatives[0].title, 'big-spend');
});

/* A creative with no CPM is not the cheapest one on the screen. */
test('unknown sinks whichever way the column sorts', () => {
  for (const sort of ['cpm', 'frequency', 'cpc']) {
    const last = project(RANKABLE, { sort }).creatives.at(-1);
    assert.equal(last.title, 'unmeasured', `${sort} must not float an unknown to the top`);
  }
});

test('an unknown sort falls back rather than emptying the screen', () => {
  const out = project(RANKABLE, { sort: 'nonsense' });
  assert.equal(out.sortLabel, 'Best');
  assert.equal(out.creatives.length, 3);
});

test('the control offers a next ranking to move to', () => {
  assert.match(project(RANKABLE).sortNext, /^\/creatives\?view=\w+&sort=\w+$/);
});

/* Switching view must not silently reset the ranking, and switching ranking
   must not throw the reader back to Gallery. */
test('the sort control and the view tabs each hold the other', () => {
  const out = project(RANKABLE, { view: 'leaderboard', sort: 'cpm' });

  assert.match(out.sortNext, /view=leaderboard/, 'the next sort stays in the view');
  for (const tab of out.viewTabs) assert.match(tab.go, /sort=cpm/, `${tab.label} dropped the ranking`);
});

/* ── the three views ────────────────────────────────────────────────────── */

/* The design draws Gallery, Leaderboard and Timeline as three inert spans and
   gives none of them any markup of its own, so each is an *ordering* over the
   same cards rather than a second layout — see the VIEWS comment in
   lib/repository/projections.js. What is testable is that they differ, that the
   tabs point somewhere, and that neither control forgets the other. */
/* One ranking control, not two. The leaderboard used to rank by its own fixed
   rule, so choosing a ranking did nothing in the view the screen opens on — a
   control that appears broken. Gallery and Leaderboard now honour the same
   sort; the leaderboard's contribution is the numbering. */
test('the sort control drives every view except the timeline', () => {
  const order = (view) => project(FLEET, { view, sort: 'cpl' }).creatives.map((r) => r.title);

  assert.deepEqual(order('gallery'), order('leaderboard'), 'the leaderboard must honour the chosen ranking');
  assert.notDeepEqual(order('timeline'), order('gallery'), 'a timeline is chronological, not ranked');
});

test('the leaderboard numbers its rows and the other views do not', () => {
  assert.deepEqual(project(RANKABLE, { view: 'leaderboard' }).creatives.map((r) => r.rank), ['1', '2', '3']);
  assert.deepEqual(project(RANKABLE, { view: 'gallery' }).creatives.map((r) => r.rank), ['', '', '']);
});

/* The rank is a field of its own, not a prefix on the name — a title carrying
   "3. " is a title every reader of it has to strip again. */
test('the position never leaks into the creative name', () => {
  for (const row of project(RANKABLE, { view: 'leaderboard' }).creatives) {
    assert.doesNotMatch(row.title, /^\d+\.\s/);
  }
});

test('an unknown view falls back to the leaderboard rather than emptying the screen', () => {
  const out = project(RANKABLE, { view: 'nonsense' });
  assert.match(out.creativeSummary, /Leaderboard/);
  assert.equal(out.creatives.length, 3);
});

test('the heading line describes what is actually on the screen', () => {
  assert.match(project(RANKABLE, { view: 'gallery', sort: 'cpm' }).creativeSummary, /^3 creatives · Gallery, ranked by cpm$/);
  assert.match(project(RANKABLE).creativeSummary, /Leaderboard, ranked by best — what to act on first/);
  assert.match(project(RANKABLE, { view: 'timeline' }).creativeSummary, /most recently started first/);
});

/* A menu of rankings the screen can actually perform — the design draws a caret
   and no menu, so the options travel to the browser and it builds one. */
test('every ranking is offered, with the current one marked', () => {
  const options = project(RANKABLE, { sort: 'cpm' }).sortOptions;

  assert.equal(options[0].label, 'Best', 'the default leads the menu');
  assert.equal(options.filter((o) => o.active).length, 1);
  assert.equal(options.find((o) => o.active).key, 'cpm');
  for (const o of options) assert.match(o.go, /^\/creatives\?view=\w+&sort=\w+$/);
});

/* ── the scores, and what they tell someone to do ───────────────────────── */

/* Thirty days of a creative wearing out: frequency over 4, click-through
   falling and CPM rising together, which is what all three sources describe. */
const worn30 = Array.from({ length: 30 }, (_, i) => {
  const late = i >= 23;
  return {
    date: `2026-07-${String(i + 8).padStart(2, '0')}`,
    impressions: 9000,
    clicks: Math.round(9000 * (late ? 0.0139 : 0.0188)),
    spend: 300000,
    frequency: late ? 4.3 : 3.4,
    cpm: late ? 327 : 268,
  };
});

/* The same thirty days without the wear: nothing crosses a threshold, so it
   scores zero *and has the history to mean it* — which is the difference
   between "healthy" and "no reading". */
const steady30 = worn30.map((d) => ({ ...d, clicks: 169, frequency: 1.6, cpm: 268 }));

const FLEET = {
  creatives: [
    { ...CREATIVE, adId: 'w', title: 'worn out', objective: 'OUTCOME_LEADS', spend: 900000, leads: 9, impressions: 270000, clicks: 4900, series: worn30 },
    { ...CREATIVE, adId: 'a', title: 'ordinary a', objective: 'OUTCOME_TRAFFIC', spend: 300000, leads: 12, impressions: 90000, clicks: 2600 },
    { ...CREATIVE, adId: 'b', title: 'ordinary b', objective: 'OUTCOME_SALES', spend: 280000, leads: 11, impressions: 88000, clicks: 2400 },
    { ...CREATIVE, adId: 'c', title: 'cheap', objective: 'OUTCOME_AWARENESS', spend: 200000, leads: 22, impressions: 80000, clicks: 2200, series: steady30 },
  ],
};

const byTitle = (view) => Object.fromEntries(
  project(FLEET, view).creatives.map((r) => [r.title.replace(/^\d+\.\s/, ''), r]),
);

/* The complaint this answers: a badge reading "42" that nothing on the page
   defines. */
test('the fatigue badge names its band and carries its own definition', () => {
  const rows = byTitle();

  assert.equal(rows['worn out'].fatigueBand, 'Replace');
  assert.match(rows['worn out'].fatigueWhy, /100\/100 — Replace/);
  assert.match(rows['worn out'].fatigueWhy, /frequency/i, 'the tooltip must say what the score reads');
  assert.match(rows['worn out'].fatigueWhy, /Last 7 days against the 23 before them/);
});

/* Unknown is never healthy — and it is never "Healthy" in words either. */
test('a creative with too little history says so rather than scoring zero', () => {
  const row = byTitle()['ordinary a'];
  assert.equal(row.fatigue, '—');
  assert.equal(row.fatigueBand, 'No reading');
  assert.doesNotMatch(row.fatigueWhy, /Healthy/);
});

test('the screen defines both of its own scores', () => {
  const out = project(FLEET);
  assert.match(out.fatigueLegend, /0–19 healthy · 20–39 watch · 40–69 act soon · 70\+ replace/);
  assert.match(out.verdictLegend, /cost per lead against the account median/);
});

/* Ranking by stage name would sort Bottom before Top — the funnel upside
   down. */
test('the screen can be ranked by funnel stage, top first', () => {
  const out = project(FLEET, { sort: 'funnel' });

  assert.equal(out.sortLabel, 'Funnel');
  assert.deepEqual(out.creatives.map((r) => r.dur), [
    'Top of funnel', 'Middle of funnel', 'Bottom of funnel', 'Bottom of funnel',
  ]);
});

test('creatives sharing a funnel stage fall back to spend', () => {
  const bottom = project(FLEET, { sort: 'funnel' }).creatives.filter((r) => r.dur === 'Bottom of funnel');
  assert.deepEqual(bottom.map((r) => r.title), ['worn out', 'ordinary b'], 'the bigger spender leads its stage');
});

test('a creative with no funnel stage sinks rather than filing under Bottom', () => {
  const out = project({ creatives: [...FLEET.creatives, { ...CREATIVE, adId: 'x', title: 'no objective', objective: null, spend: 99999999 }] }, { sort: 'funnel' });
  assert.equal(out.creatives.at(-1).title, 'no objective', 'unknown is not the bottom of the funnel, however much it spent');
});

test('each creative says which part of the funnel it is working in', () => {
  const rows = byTitle();

  assert.equal(rows['worn out'].dur, 'Bottom of funnel');
  assert.equal(rows['ordinary a'].dur, 'Middle of funnel');
  assert.equal(rows.cheap.dur, 'Top of funnel');
  assert.match(rows.cheap.durWhy, /bought for reach/, 'the badge has to say why that changes how it is judged');
});

/* Read from the objective rather than inferred, so an objective outside Meta's
   two taxonomies is declined instead of filed under a guess. */
test('an unmapped objective declines a funnel stage rather than guessing one', () => {
  const [row] = creatives(entitiesWith([{ ...CREATIVE, objective: 'SOMETHING_NEW' }]));
  assert.equal(row.dur, '—');
  assert.match(row.durWhy, /declined rather than guessed/);
});

/* The half that was missing: a score told the reader something was wrong and
   left them to work out what to do about it. */
test('every card carries an instruction, and the instruction carries its reasons', () => {
  for (const row of project(FLEET).creatives) {
    assert.ok(row.verdict, `${row.title} has no verdict`);
    assert.ok(row.verdictBecause, `${row.title} gives no reason`);
    assert.ok(row.verdictColor && row.verdictBg);
  }
});

test('the worn-out creative burning three times the going rate is told to stop', () => {
  const rows = byTitle();

  assert.equal(rows['worn out'].verdict, 'Stop');
  assert.match(rows['worn out'].verdictWhy, /Turn it off/);
  assert.equal(rows.cheap.verdict, 'Scale');
  assert.equal(rows['ordinary b'].verdict, 'Keep running');
});

/* ── the panel agrees with the card, on the new fields too ─────────────── */

test('the drawer carries the same verdict and funnel stage as the card', () => {
  const card = project(FLEET, { cr: '1' }).creatives[0];
  const panel = PROJECTIONS['overlay-creative-detail'](FLEET, { cr: '1' }).selCr;

  assert.equal(panel.verdict, card.verdict);
  assert.equal(panel.fatigueBand, card.fatigueBand);
  assert.equal(panel.funnel, card.dur);
  assert.equal(panel.winning, card.winning);
});

/* The drawer opens the card that was clicked, in whichever view it was clicked
   from — the ranking changes which creative sits at position one. */
test('the drawer follows the view it was opened from', () => {
  for (const view of ['gallery', 'leaderboard', 'timeline']) {
    const card = project(FLEET, { view, cr: '1' }).creatives[0];
    const panel = PROJECTIONS['overlay-creative-detail'](FLEET, { view, cr: '1' }).selCr;

    assert.equal(panel.title, card.title, `${view} opened the wrong creative`);
    assert.equal(panel.fatigue, card.fatigue);
  }
});

/* Clicking a card under one ranking must not open whatever sat at that
   position under another. */
test('a card carries the ranking it was clicked under', () => {
  const rows = project(RANKABLE, { sort: 'cpm' }).creatives;
  assert.match(rows[0].go, /sort=cpm/);

  const panel = PROJECTIONS['overlay-creative-detail'](RANKABLE, { sort: 'cpm', cr: '1' }).selCr;
  assert.equal(panel.title, 'efficient', 'the panel must rank the same way the screen did');
});
