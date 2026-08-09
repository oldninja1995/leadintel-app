/* The instruction on a creative card.
 *
 * Fatigue was already tested for what it reads; this is tested for what it
 * *tells someone to do*, which is a different thing and a riskier one. A score
 * that is 10 too high is a bad number. A verdict that says "stop" about the
 * cheapest creative on the account is money not spent.
 *
 * So the cases below are mostly about refusing to decide: no benchmark, too few
 * leads, no history. Each of those must reach "not enough data" rather than any
 * of the four confident answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const verdicts = require('../lib/creative-verdict');
const fatigue = require('../lib/creative-fatigue');

/* Cost per lead in paise, as everything on a canonical entity is. */
const row = (cpl, leads, worn = null) => ({ cpl, leads, worn });

/* A fatigue result of a given band, without going through 14 days of series to
   get one — the scorer has its own tests. */
const worn = (band, score, reasons = []) => ({ band, score, reasons, label: fatigue.bandLabel(band) });

/* Five peers with a median of 200000 paise (₹2,000). */
const PEERS = [
  row(100000, 20), row(150000, 20), row(200000, 20), row(300000, 20), row(900000, 20),
];

const only = (subject) => verdicts.decide([subject, ...PEERS])[0];

test('the benchmark is the median of the set, not its mean', () => {
  /* One creative burning four times the going rate drags a mean up until every
     other creative looks efficient beside it. */
  assert.equal(verdicts.benchmarkCpl(PEERS), 200000);
});

/* The subject counts towards the median it is judged against — it is part of
   the account, not an outsider being compared to it — so `only()`'s six-row set
   has a median of ₹2,500 rather than the five peers' ₹2,000. */
test('a creative half again dearer than the median is stopped', () => {
  const v = only(row(600000, 12, worn('healthy', 0)));
  assert.equal(v.action, 'stop');
  assert.match(v.because[0], /140% above/);
});

/* Dear, but not dear enough to be an argument on its own. */
test('a creative just above the median is left alone', () => {
  assert.equal(only(row(320000, 12, worn('healthy', 0))).action, 'keep');
});

test('being unworn does not save an expensive creative', () => {
  /* "It might improve" is what keeps them running — once there is enough
     history to know that it has not. */
  assert.equal(only(row(400000, 10, worn('healthy', 0))).action, 'stop');
});

/* A creative with no fatigue reading has under a fortnight of usable days,
   which puts it at or near Meta's learning phase. An ad that looks dear in week
   one routinely settles by week three, and turning it off is the mistake every
   media buyer is warned about. */
test('an expensive creative too young to score is reviewed, not stopped', () => {
  const v = only(row(600000, 12, null));

  assert.equal(v.action, 'review');
  assert.equal(v.instruction, 'Check it before deciding');
  assert.match(v.because.join(' '), /140% above/, 'it must still say it is expensive');
  assert.match(v.because.join(' '), /too new to judge on cost alone/, 'and why that is not yet a decision');
});

/* The same cost, once there is history behind it, is a decision. */
test('the same creative is stopped once it has history', () => {
  assert.equal(only(row(600000, 12, worn('healthy', 0))).action, 'stop');
  assert.equal(only(row(600000, 12, worn('replace', 90, ['frequency 4.4']))).action, 'stop');
});

/* Review sits between Refresh and Keep: more urgent than nothing to do, less
   settled than a decision already made. */
test('review ranks below refresh and above keep running', () => {
  const order = verdicts.ACTION_ORDER;
  assert.ok(order.indexOf('refresh') < order.indexOf('review'));
  assert.ok(order.indexOf('review') < order.indexOf('keep'));
});

test('a tiring creative that still pays its way is refreshed, not stopped', () => {
  for (const band of ['act', 'replace']) {
    const v = only(row(210000, 15, worn(band, 80, ['frequency 4.1'])));
    assert.equal(v.action, 'refresh', `${band} at the going rate should be replaced, not switched off`);
    assert.match(verdicts.sentence(v), /frequency 4\.1/, 'the reason must survive into the sentence');
  }
});

test('cheap and unworn is the only case that earns more budget', () => {
  assert.equal(only(row(120000, 30, worn('healthy', 0))).action, 'scale');
  /* Cheap but tiring is not a scaling opportunity, it is a deadline. */
  assert.equal(only(row(120000, 30, worn('act', 55, ['frequency 3.4']))).action, 'refresh');
});

test('cheap with no fatigue reading keeps running rather than scaling', () => {
  /* More budget is a claim about tomorrow, and there is no history to make it. */
  assert.equal(only(row(120000, 30, null)).action, 'keep');
});

/* ── the refusals ───────────────────────────────────────────────────────── */

test('too few leads is not a cost per lead', () => {
  const v = only(row(900000, 2, null));
  assert.equal(v.action, 'unknown', 'two leads is two events, not a rate');
  assert.equal(v.label, 'Not enough data');
});

test('no history and no leads is said plainly, not dressed as approval', () => {
  const v = only(row(null, 0, null));
  assert.equal(v.action, 'unknown');
  assert.match(v.because.join(' '), /no leads yet/);
  assert.match(v.because.join(' '), /14 days/);
});

test('a median of two creatives is not a benchmark', () => {
  const [v] = verdicts.decide([row(900000, 20, null), row(100000, 20, null)]);
  assert.equal(v.benchmark, null, `under ${verdicts.MIN_PEERS} peers there is nothing to compare against`);
  assert.equal(v.action, 'unknown');
});

/* With no cost to weigh, fatigue still decides — an exhausted creative is worth
   replacing whether or not anyone can price its leads. */
test('fatigue alone still reaches a verdict when cost cannot be judged', () => {
  const [v] = verdicts.decide([row(null, 0, worn('replace', 90, ['seen 4.4× per person']))]);
  assert.equal(v.action, 'refresh');
});

test('every verdict carries the numbers that produced it', () => {
  for (const v of verdicts.decide([...PEERS, row(300000, 9, worn('watch', 30))])) {
    assert.ok(v.because.length, `${v.label} gave no reason`);
    assert.ok(verdicts.sentence(v).length > v.instruction.length, 'the sentence must say more than the instruction');
  }
});
