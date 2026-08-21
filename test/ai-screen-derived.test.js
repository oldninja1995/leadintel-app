/* The AI Command Center answers from rows, or says it cannot.
 *
 *   node --test test/ai-screen-derived.test.js
 *
 * This screen was the worst offender in the app for a specific reason: it is
 * the one that speaks in sentences. A KPI card that is wrong is a wrong number;
 * a paragraph that is wrong reads as analysis. It carried a health score of 84
 * with the reason "CPL fell 22% while lead volume rose 18%", a forecast of
 * ₹61.0L at "89% confidence" from a model "retrained nightly", a five-step
 * causal chain citing an audit-log entry nobody wrote, a chat transcript with a
 * campaign name and "94 confirmed bookings", and a recommendation naming two
 * employees and their response times. None of it came from a row.
 *
 * The rule for this driver is derive or decline, never borrow. These tests hold
 * the AI screen to it, and they are written so that adding a new authored
 * collection to data/ai.js fails until the projection either derives it or
 * declines it deliberately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PROJECTIONS } = require('../lib/repository/projections');
const authored = require('../data/ai');

/* Not business claims: two are colour tokens the design carries, and `aiCaps`
   is the "what this can be asked" list — a statement about the product, not
   about the account. Anything else added to data/ai.js has to be handled. */
const NOT_A_CLAIM = new Set(['up', 'down', 'warn', 'aiCaps', 'select']);

const EMPTY = {
  campaignDays: [], leads: [], deals: [], bookings: [], payments: [], creatives: [],
  webChannelRevenueDays: [], webChannelDays: [], sessionDays: [],
};

const run = (entities = EMPTY, params = {}) => PROJECTIONS.ai(entities, { over: null, ...params }, authored);

test('every authored collection on this screen is either derived or declined', () => {
  const covered = Object.keys(run());
  const missing = Object.keys(authored).filter((k) => !NOT_A_CLAIM.has(k) && !covered.includes(k));

  assert.deepEqual(missing, [], [
    'these are still served straight from data/ai.js, which means the screen is',
    'showing a figure nobody measured:',
    ...missing.map((m) => `  ${m}`),
  ].join('\n'));
});

test('nothing from the fixture reaches the screen through the projection', () => {
  const out = JSON.stringify(run());
  /* The specific inventions, each of which was on the live site. */
  for (const ghost of [
    'Munnar Honeymoon', 'Kumarakom', '₹61.0L', '89%', 'Root cause found',
    'retrained nightly', 'CPL fell 22%', 'Vishnu', '94 confirmed', '₹1.1L',
  ]) {
    assert.ok(!out.includes(ghost), `"${ghost}" is still being served`);
  }
});

test('the health cards decline for the same reason the minis beside them do', () => {
  const { healthCards, healthMinis } = run();
  assert.ok(healthCards.length, 'the cards should still be drawn, so the reader sees the question is unanswered');
  for (const card of healthCards) {
    assert.equal(card.score, '—');
    assert.match(card.reason, /no scoring model/i);
    assert.equal(card.rec, '—', 'a recommendation from a model that does not exist is the same invention as the score');
  }
  /* The pair used to disagree: four honest minis beside six confident cards. */
  assert.ok(healthMinis.every((m) => m.score === '—'));
});

test('the forecast declines rather than projecting', () => {
  const { fcKpis, fcConf, fcNote } = run();
  assert.equal(fcConf, '—', 'a confidence figure is itself a model output');
  assert.match(fcNote, /no forecasting model/i);
  for (const k of fcKpis) {
    assert.equal(k.value, '—');
    assert.equal(k.range, '—', 'a range implies a distribution, which implies a model');
  }
});

test('no causal chain is offered, because the screen says it infers no cause', () => {
  assert.deepEqual(run().rootChain, []);
});

/* ── the derived half ─────────────────────────────────────────────────────── */

const day = (date, spend) => ({ date, campaign: 'brand', platform: 'google_ads', spend, impressions: 10, clicks: 1, leads: 0 });

test('an anomaly is reported only when a day really is far from the mean', () => {
  /* Fourteen flat days: nothing to report, and a table that fired here would be
     a table nobody trusts. */
  const flat = Array.from({ length: 14 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, 1000));
  assert.deepEqual(run({ ...EMPTY, campaignDays: flat }).anomalies, []);

  /* Same fortnight with one day ten times the rest. */
  const spike = flat.map((d, i) => (i === 6 ? { ...d, spend: 10000 } : d));
  const found = run({ ...EMPTY, campaignDays: spike }).anomalies;
  assert.ok(found.length, 'a tenfold day should be reported');
  assert.equal(found[0].when.length > 0, true);
  assert.match(found[0].status, /σ over 14 days/, 'the status says what the figure is measured against, not what caused it');
  assert.ok(!/root cause|investigating|resolved/i.test(found[0].status), 'a status this screen cannot know');
});

test('a window too short to have a normal reports nothing', () => {
  const threeDays = [day('2026-08-01', 100), day('2026-08-02', 100), day('2026-08-03', 9000)];
  assert.deepEqual(run({ ...EMPTY, campaignDays: threeDays }).anomalies, []);
});

test('goals come from the registry target, read in the direction favourability says', () => {
  const registry = {
    list: () => [
      { id: 'good.high', name: 'Revenue', favourability: 'higher', benchmark: { target: 100 }, format: { kind: 'count' } },
      { id: 'good.low', name: 'Cancellation rate', favourability: 'lower', benchmark: { target: 2 }, format: { kind: 'count' } },
      { id: 'no.target', name: 'Untargeted', favourability: 'higher', benchmark: null, format: { kind: 'count' } },
    ],
  };
  const format = (metric, v) => String(v);
  const values = { 'good.high': 50, 'good.low': 4, 'no.target': 999 };
  const { goals } = run(EMPTY, { values, registry, format });

  const by = Object.fromEntries(goals.map((g) => [g.name, g]));
  assert.ok(!by.Untargeted, 'a metric declaring no target is not a goal');
  assert.equal(by.Revenue.pace, '50% · short of target', '50 against 100 is half way');
  /* The one that would be backwards if favourability were ignored: 4% against a
     2% target is 50% of the way there, not 200%. */
  assert.equal(by['Cancellation rate'].pace, '50% · short of target');
});

test('goals and benchmarks are empty rather than invented when the registry is absent', () => {
  const out = run();
  assert.deepEqual(out.goals, []);
  assert.deepEqual(out.benchRows, []);
  assert.deepEqual(out.benchModes, [], 'a mode control offering a comparison nothing can answer is the fixture again');
});

test('only the comparison the store can answer is offered', () => {
  const registry = { list: () => [{ id: 'm', name: 'ROAS', favourability: 'higher', benchmark: null, format: { kind: 'count' } }] };
  const format = (metric, v) => String(v);
  const out = run(EMPTY, { registry, format, values: { m: 6 }, previous: { m: 4 } });

  assert.equal(out.benchRows.length, 1);
  assert.equal(out.benchRows[0].delta, '+50.0%');
  assert.equal(out.benchModes.length, 1, 'last year and category were offered and answered with the same rows');
  assert.equal(out.benchCol2, 'Previous period');
});

test('the simulator declines when there is no measured baseline to move', () => {
  const { simOut, simNote } = run();
  assert.match(simNote, /Nothing to simulate from/);
  for (const o of simOut) assert.equal(o.value, '—');
  assert.ok(!simOut.some((o) => o.label === 'CONFIDENCE'), 'a confidence with no model behind it was the thing being removed');
});

/* ── the template ─────────────────────────────────────────────────────────── */

test('the view carries no invented figure of its own', () => {
  const markup = fs.readFileSync(path.join(__dirname, '..', 'views/screens/ai.ejs'), 'utf8')
    /* EJS comments describe what was removed and quote it, on purpose. */
    .replace(/<%#[\s\S]*?%>/g, ' ');

  for (const ghost of [
    'Munnar Honeymoon', 'Kumarakom', '₹61.0L', '94 confirmed', 'retrained nightly',
    'model fitted on 12 months', 'This week&#39;s action plan',
  ]) {
    assert.ok(!markup.includes(ghost), `views/screens/ai.ejs still hardcodes "${ghost}"`);
  }
  /* The forecast chart was the most persuasive of the lot: hand-typed path
     coordinates drawing a rising curve and a widening confidence band. */
  assert.ok(!/stroke-dasharray="5 5"/.test(markup), 'the hand-drawn forecast curve is back');
});

/* The levers used to be described in one place and applied in another.
   `select()` in data/ai.js defaulted them to "+20%" and "48h + reminder" and
   wrote that into the heading and the selected chips, while the arithmetic
   started from unmoved — so the tab opened claiming a scenario the reader had
   not chosen, above six figures that were the untouched baseline. */
test('the simulator label, its chips and its arithmetic agree', () => {
  const out = run();
  assert.equal(out.simScenario, 'Meta budget Hold · ADR Hold · payment window 72h window');

  const selected = (opts) => opts.find((o) => o.bg && o.bg !== 'transparent') || opts[0];
  assert.equal(selected(out.simMetaOpts).label, 'Hold', 'the chip shown as selected is the one being calculated with');
  assert.equal(selected(out.simCancelOpts).label, '72h window');

  /* And a lever the reader does move is honoured. */
  const moved = run(EMPTY, { simMeta: '+40%', simCancel: '48h + reminder' });
  assert.match(moved.simScenario, /Meta budget \+40%/);
  assert.match(moved.simScenario, /payment window 48h \+ reminder/);
  assert.equal(moved.simMetaOpts.find((o) => o.label === '+40%').bg !== undefined, true);
});

test('an unknown lever value falls back rather than throwing', () => {
  const out = run(EMPTY, { simMeta: '../../etc/passwd', simAdr: '999%' });
  assert.equal(out.simScenario, 'Meta budget Hold · ADR Hold · payment window 72h window');
});
