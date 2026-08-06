/* Phase 5 sub-phase 5.3 — restatement and report flagging.
 *
 *   node --test        or        npm test
 *
 * The exit criterion has two halves and both are load-bearing: already-sent
 * reports are **flagged** on restatement, and **not silently altered**. A
 * report that quietly updates itself makes a liar of whoever quoted it; one
 * that never updates leaves people acting on a corrected figure. So most of
 * what follows checks that the sent copy is immutable *and* that the drift is
 * announced beside it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reports = require('../lib/reports');
const alerts = require('../lib/alerts');
const registry = require('../lib/metrics/registry');
const { definitions } = require('../lib/metrics/versions');

const { Dispatches, restatement, stale } = reports;

const store = () => new Dispatches(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-disp-')));
const SENT = '2026-08-01T08:00:00.000Z';

/* An evaluation record as lib/metrics/versions produces one. */
const evaluation = (values, over = {}) => ({
  id: '2026-08-01T08-00-00-000Z-abcdef12',
  values,
  definitions: definitions(),
  registryFingerprint: 'fingerprint-at-send',
  at: null,
  ...over,
});

const sentValues = { 'revenue.net': 4280000, 'roas.net': 4.8, 'leads.count': 604 };

/* ── recording that a report went out ───────────────────────────────────── */

test('a dispatch keeps the figures the recipient actually saw', () => {
  const dispatch = store().send('Owner weekly', {
    evaluation: evaluation(sentValues), sentAt: SENT, recipients: ['Anand P'], channels: ['Email'],
  });

  assert.equal(dispatch.report, 'Owner weekly');
  assert.deepEqual(dispatch.carried, sentValues);
  assert.deepEqual(dispatch.recipients, ['Anand P']);
  assert.equal(dispatch.evaluationId, '2026-08-01T08-00-00-000Z-abcdef12');
});

test('a report records only the metrics it showed', () => {
  /* Flagging a figure the recipient never saw would be noise. */
  const dispatch = store().send('GM daily digest', {
    evaluation: evaluation(sentValues), metrics: ['revenue.net'], sentAt: SENT,
  });
  assert.deepEqual(Object.keys(dispatch.carried), ['revenue.net']);
});

test('a report cannot claim a metric its evaluation never carried', () => {
  assert.throws(
    () => store().send('Owner weekly', { evaluation: evaluation(sentValues), metrics: ['revenue.net', 'ghost.metric'] }),
    /does not carry ghost.metric/
  );
});

test('a dispatch needs a report and an evaluation', () => {
  assert.throws(() => store().send('', { evaluation: evaluation(sentValues) }), /needs a report name/);
  assert.throws(() => store().send('Owner weekly', {}), /needs the evaluation it carried/);
});

test('a dispatch survives a reload, and lists newest first', () => {
  const dispatches = store();
  dispatches.send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: '2026-08-01T08:00:00.000Z' });
  dispatches.send('Month-end board pack', { evaluation: evaluation(sentValues), sentAt: '2026-08-31T18:00:00.000Z' });

  const list = new Dispatches(dispatches.dir).list();
  assert.equal(list.length, 2);
  assert.equal(list[0].report, 'Month-end board pack');
});

test('a bad dispatch id cannot escape the directory', () => {
  assert.throws(() => store().get('../../server'), /bad dispatch id/);
});

/* ── the sent copy is never altered ─────────────────────────────────────── */

test('a restatement does not rewrite what was sent', () => {
  const dispatches = store();
  const dispatch = dispatches.send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: SENT });

  restatement(dispatch, { ...sentValues, 'roas.net': 3.1 });

  const reread = dispatches.get(dispatch.id);
  assert.equal(reread.carried['roas.net'], 4.8, 'the sent copy was corrected in place');
});

/* ── flagging ───────────────────────────────────────────────────────────── */

test('a figure that moved at source is flagged as a restatement', () => {
  const dispatch = store().send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: SENT });
  const result = restatement(dispatch, { ...sentValues, 'roas.net': 3.1 });

  assert.equal(result.stale, true);
  assert.deepEqual(result.dataMoved, [{ metric: 'roas.net', sent: 4.8, now: 3.1, reason: 'source data restated' }]);
  assert.deepEqual(result.definitionMoved, []);
});

test('a report whose figures still hold is not flagged', () => {
  const dispatch = store().send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: SENT });
  const result = restatement(dispatch, { ...sentValues });

  assert.equal(result.stale, false);
  assert.deepEqual(result.moved, []);
});

test('a changed definition is reported as such, not as a restated figure', () => {
  /* One calls for a reissue; the other for an explanation. The old report is
     not wrong — it is answering a different question. */
  const dispatch = store().send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: SENT });

  const metric = registry.get('roas.net');
  const original = metric.thresholds;
  metric.thresholds = { good: 99, warning: 50 };
  try {
    const result = restatement(dispatch, { ...sentValues, 'roas.net': 3.1 });
    assert.deepEqual(result.definitionMoved.map((m) => m.metric), ['roas.net']);
    assert.deepEqual(result.dataMoved, [], 'a definition change was reported as a source restatement');
  } finally {
    metric.thresholds = original;
  }
});

test('a metric the registry no longer defines makes a report unreproducible', () => {
  const dispatch = store().send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: SENT });
  const { 'leads.count': _dropped, ...current } = sentValues;

  const result = restatement(dispatch, current);
  assert.deepEqual(result.unreproducible.map((m) => m.metric), ['leads.count']);
  assert.equal(result.stale, true);
});

test('null and zero are not the same figure', () => {
  const dispatch = store().send('Owner weekly', { evaluation: evaluation({ 'roas.net': null }), sentAt: SENT });
  const result = restatement(dispatch, { 'roas.net': 0 });
  assert.equal(result.stale, true, 'an unknown becoming zero went unnoticed');
});

/* ── across every sent report ───────────────────────────────────────────── */

test('stale reports are found, and current ones left out', () => {
  const dispatches = store();
  dispatches.send('Owner weekly', { evaluation: evaluation(sentValues), sentAt: '2026-08-01T08:00:00.000Z' });
  dispatches.send('GM daily digest', { evaluation: evaluation(sentValues), metrics: ['leads.count'], sentAt: '2026-08-02T07:30:00.000Z' });

  const found = stale(dispatches.list(), () => ({ ...sentValues, 'roas.net': 3.1 }));
  assert.equal(found.length, 1, 'the digest showed only leads.count and should not be flagged');
  assert.equal(found[0].report, 'Owner weekly');
});

test('each report is compared at its own grain', () => {
  /* Comparing a campaign report against workspace figures would invent a
     restatement that never happened. */
  const dispatches = store();
  const at = { dimension: 'campaign', value: 'munnar honeymoon jul' };
  dispatches.send('Marketing performance', { evaluation: evaluation({ 'ads.spend': 13821 }, { at }), sentAt: SENT });

  const grains = [];
  stale(dispatches.list(), (grain) => { grains.push(grain); return { 'ads.spend': 13821 }; });
  assert.deepEqual(grains, [at], 'the dispatch was evaluated at the wrong grain');
});

/* ── what the panel says ────────────────────────────────────────────────── */

test('a restated report is critical; a redefined one is a warning', () => {
  const dataMoved = {
    dispatch: 'd1', report: 'Owner weekly', sentAt: SENT,
    dataMoved: [{ metric: 'roas.net', sent: 4.8, now: 3.1 }], definitionMoved: [], unreproducible: [],
    moved: [{ metric: 'roas.net', sent: 4.8, now: 3.1 }],
  };
  const [critical] = alerts.restatementAlerts([dataMoved]);
  assert.equal(critical.severity, 'critical');
  assert.match(critical.title, /“Owner weekly” was sent with figures that have changed/);
  assert.match(critical.meta, /1 figure restated at source/);

  const defsOnly = { ...dataMoved, dataMoved: [], definitionMoved: [{ metric: 'roas.net' }] };
  const [warning] = alerts.restatementAlerts([defsOnly]);
  assert.equal(warning.severity, 'warning');
  assert.match(warning.meta, /1 definition changed since/);
});

test('nothing sent means nothing to say', () => {
  assert.deepEqual(alerts.restatementAlerts([]), []);
  assert.equal(alerts.build({ restatements: [] }).empty, true);
});

test('a restatement reaches the notification panel', () => {
  const built = alerts.build({
    restatements: [{
      dispatch: 'd1', report: 'Owner weekly', sentAt: SENT,
      dataMoved: [{ metric: 'roas.net', sent: 4.8, now: 3.1 }], definitionMoved: [], unreproducible: [],
      moved: [{ metric: 'roas.net', sent: 4.8, now: 3.1 }],
    }],
  });
  assert.equal(built.count, 1);
  assert.equal(built.critical, 1);
});
