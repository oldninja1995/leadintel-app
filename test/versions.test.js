/* Phase 6 sub-phase 6.2 — versioned results with input snapshots.
 *
 *   node --test        or        npm test
 *
 * The exit criterion is "a number from three months ago reproduces exactly",
 * and the only honest way to check that is to store the inputs, re-run them,
 * and compare. Everything below writes to a temporary directory: a test that
 * left records in `var/evaluations/` would make the app's own history a
 * fiction.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const metrics = require('../lib/metrics');
const registry = require('../lib/metrics/registry');
const versions = require('../lib/metrics/versions');
const ingest = require('../lib/ingest');

const { Evaluations, checksum, definitionDrift, definitions } = versions;

const store = () => new Evaluations(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-eval-')));
const evaluate = metrics.evaluate;
const THEN = '2026-05-06T09:00:00.000Z';

const entities = () => ({
  campaignDays: [{ campaign: 'munnar', label: 'Munnar', platform: 'meta_ads', spend: 700000, impressions: 100000, clicks: 2000, leads: 20 }],
  leads: [{ id: 'L-1', campaign: 'munnar', property: 'Munnar Hillside', createdAt: '2026-07-14T00:00:00.000Z' }],
  bookings: [{ id: 'B-1', leadId: 'L-1', property: 'Munnar Hillside', nights: 3, revenue: { value: 4280000 }, bookingStatus: 'Checked_in' }],
  inventoryDays: [{ id: 'P-MUN:2026-07-14', propertyId: 'P-MUN', property: 'Munnar Hillside', available: 42, sold: 33 }],
  leadEvents: [],
  payments: [],
  problems: [],
});

/* ── recording ──────────────────────────────────────────────────────────── */

test('a record keeps what the number was computed from, not just the number', () => {
  const record = store().record(entities(), { evaluate, recordedAt: THEN });

  assert.ok(record.values['revenue.net'], 'no values were recorded');
  assert.ok(record.inputs, 'the inputs were not kept — the figure is a claim, not a receipt');
  assert.deepEqual(record.inputs.bookings.map((b) => b.id), ['B-1']);
  assert.ok(record.registryFingerprint, 'no record of which definitions were in force');
});

test('a record survives a reload', () => {
  const evaluations = store();
  const written = evaluations.record(entities(), { evaluate, recordedAt: THEN, note: 'month end' });
  const read = new Evaluations(evaluations.dir).get(written.id);

  assert.equal(read.note, 'month end');
  assert.equal(read.values['revenue.net'], written.values['revenue.net']);
});

test('the listing is metadata only, newest first', () => {
  const evaluations = store();
  evaluations.record(entities(), { evaluate, recordedAt: '2026-05-06T09:00:00.000Z' });
  evaluations.record(entities(), { evaluate, recordedAt: '2026-06-06T09:00:00.000Z' });

  const list = evaluations.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].recordedAt, '2026-06-06T09:00:00.000Z', 'the oldest record was listed first');
  assert.equal(list[0].inputs, undefined, 'the listing carried every stored entity set');
});

test('an id is derived from the moment and the inputs', () => {
  const record = store().record(entities(), { evaluate, recordedAt: THEN });
  assert.match(record.id, /^2026-05-06T09-00-00-000Z-[0-9a-f]{8}$/);
});

test('a bad id cannot escape the evaluations directory', () => {
  assert.throws(() => store().get('../../server'), /bad evaluation id/);
});

test('an evaluation that was never recorded is absent, not an error', () => {
  assert.equal(store().get('2026-01-01T00-00-00-000Z-deadbeef'), null);
});

/* ── reproduction ───────────────────────────────────────────────────────── */

test('a recorded number reproduces exactly', () => {
  const evaluations = store();
  const record = evaluations.record(entities(), { evaluate, recordedAt: THEN });
  const again = evaluations.reproduce(record.id, { evaluate });

  assert.equal(again.reproduced, true, `values drifted: ${JSON.stringify(again.changed)}`);
  assert.deepEqual(again.changed, []);
  assert.equal(again.registryChanged, false);
});

test('reproduction re-runs the evaluator rather than reading the stored values back', () => {
  /* If it simply echoed what was stored, a corrupted value would still
     "reproduce". Overwriting one and re-running must be caught. */
  const evaluations = store();
  const record = evaluations.record(entities(), { evaluate, recordedAt: THEN });

  const file = path.join(evaluations.dir, `${record.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.values['revenue.net'] = 999;
  fs.writeFileSync(file, JSON.stringify(stored));

  const again = evaluations.reproduce(record.id, { evaluate });
  assert.equal(again.reproduced, false);
  assert.deepEqual(again.changed, [{ metric: 'revenue.net', then: 999, now: 4280000 }]);
});

test('a scoped evaluation reproduces at its own grain', () => {
  const evaluations = store();
  const at = { dimension: 'campaign', value: 'munnar' };
  const record = evaluations.record(entities(), { evaluate, at, recordedAt: THEN });

  assert.deepEqual(record.at, at);
  assert.ok(record.notApplicable.includes('occupancy.rate'), 'the grain was not applied when recording');
  assert.equal(evaluations.reproduce(record.id, { evaluate }).reproduced, true);
});

test('an evaluation that never happened cannot be reproduced', () => {
  assert.equal(store().reproduce('2026-01-01T00-00-00-000Z-deadbeef', { evaluate }), null);
});

/* ── telling a restatement from a bug ───────────────────────────────────── */

test('a changed definition is reported separately from a changed number', () => {
  /* The same inputs giving a different answer under unchanged definitions is a
     bug. The same inputs giving a different answer after a definition changed
     is a restatement. Conflating them makes both unactionable. */
  const evaluations = store();
  const record = evaluations.record(entities(), { evaluate, recordedAt: THEN });

  const roas = registry.get('roas.net');
  const original = roas.thresholds;
  roas.thresholds = { good: 99, warning: 50 };
  try {
    const again = evaluations.reproduce(record.id, { evaluate });
    assert.equal(again.registryChanged, true);
    assert.deepEqual(again.definitionDrift, [{ metric: 'roas.net', change: 'redefined' }]);
    /* A threshold moves how a number is judged, not what it is. */
    assert.equal(again.reproduced, true);
  } finally {
    roas.thresholds = original;
  }
});

test('drift names added and removed metrics, not just changed ones', () => {
  const before = definitions().filter((d) => d.id !== 'roas.net');
  const drift = definitionDrift(before);
  assert.deepEqual(drift, [{ metric: 'roas.net', change: 'added' }]);

  const withGhost = [...definitions(), { id: 'ghost.metric' }];
  assert.deepEqual(definitionDrift(withGhost), [{ metric: 'ghost.metric', change: 'removed' }]);
});

test('rewording prose is not a redefinition', () => {
  /* `description` and `aiContext` are excluded from the fingerprint on
     purpose — a clearer sentence must not read as a restatement. */
  const metric = registry.get('roas.net');
  const original = metric.description;
  const before = definitions();

  metric.description = 'Something else entirely, but the same arithmetic.';
  try {
    assert.deepEqual(definitionDrift(before), []);
  } finally {
    metric.description = original;
  }
});

test('a moved threshold is a redefinition, because it changes how the number reads', () => {
  const metric = registry.get('cost.per_lead');
  const original = metric.thresholds;
  /* Captured before the edit — comparing the current definitions against
     themselves would show no drift however much had changed. */
  const before = definitions();

  metric.thresholds = { good: 1, warning: 2 };
  try {
    assert.deepEqual(definitionDrift(before), [{ metric: 'cost.per_lead', change: 'redefined' }]);
  } finally {
    metric.thresholds = original;
  }
});

/* ── checksums ──────────────────────────────────────────────────────────── */

test('a checksum ignores key order', () => {
  assert.equal(checksum({ a: 1, b: { c: 2, d: 3 } }), checksum({ b: { d: 3, c: 2 }, a: 1 }));
});

test('a checksum notices a changed value', () => {
  assert.notEqual(checksum({ spend: 700000 }), checksum({ spend: 700001 }));
});

test('two records of the same entities share an input checksum', () => {
  const evaluations = store();
  const a = evaluations.record(entities(), { evaluate, recordedAt: '2026-05-06T09:00:00.000Z' });
  const b = evaluations.record(entities(), { evaluate, recordedAt: '2026-06-06T09:00:00.000Z' });
  assert.equal(a.inputChecksum, b.inputChecksum, 'identical inputs hashed differently');
  assert.notEqual(a.id, b.id, 'two records collided on one id');
});

/* ── against the real store ─────────────────────────────────────────────── */

test('a real evaluation records and reproduces', () => {
  const evaluations = store();
  const record = evaluations.record(ingest.snapshot({ store: ingest.storeFor('parakkat') }), { evaluate, recordedAt: THEN, note: 'fixtures' });

  assert.equal(record.values['revenue.net'], 4280000);
  const again = evaluations.reproduce(record.id, { evaluate });
  assert.equal(again.reproduced, true, `drift: ${JSON.stringify(again.changed)}`);
});

test('the evaluator has no hidden clock', () => {
  /* Reproduction is only meaningful because evaluation is pure. Evaluating the
     same entities twice, minutes apart in principle, must agree exactly. */
  const e = ingest.snapshot({ store: ingest.storeFor('parakkat') });
  assert.deepEqual(evaluate(e).values, evaluate(e).values);
});
