/* Phase 6 sub-phase 6.3 — per-metric definition versions.
 *
 *   node --test        or        npm test
 *
 * Definitions live in code, so the log works by reconciling against what is in
 * force rather than by being told about an edit. The tests that matter are the
 * ones where an edit happens between two reconciles.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DefinitionLog, changedFields } = require('../lib/metrics/definition-log');
const registry = require('../lib/metrics/registry');

const log = () => new DefinitionLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-def-')), 'definitions.json'));
const T1 = '2026-08-01T09:00:00.000Z';
const T2 = '2026-08-06T09:00:00.000Z';

/* Edit a definition, run the body, then put it back however it ends. */
function withEdit(id, changes, body) {
  const metric = registry.get(id);
  const original = {};
  for (const key of Object.keys(changes)) original[key] = metric[key];
  Object.assign(metric, changes);
  try { return body(); } finally { Object.assign(metric, original); }
}

/* ── first sighting ─────────────────────────────────────────────────────── */

test('every metric starts at v1', () => {
  const l = log();
  const minted = l.reconcile({ at: T1 });

  assert.equal(minted.length, registry.list().length);
  assert.ok(minted.every((m) => m.change === 'added' && m.version === 1));
  assert.equal(l.versionOf('roas.net'), 1);
});

test('a first sighting is recorded as added, not as an edit', () => {
  /* v1 is where a metric starts. Reading it as a change would make the very
     first boot look like somebody rewrote the whole registry. */
  const l = log();
  l.reconcile({ at: T1 });
  assert.equal(l.governance('roas.net').edits, 0);
  assert.equal(l.historyOf('roas.net')[0].change, 'added');
});

test('reconciling twice mints nothing the second time', () => {
  const l = log();
  l.reconcile({ at: T1 });
  assert.deepEqual(l.reconcile({ at: T2 }), []);
});

/* ── an edit ────────────────────────────────────────────────────────────── */

test('changing a definition mints a new version for that metric only', () => {
  const l = log();
  l.reconcile({ at: T1 });

  const minted = withEdit('roas.net', { thresholds: { good: 9, warning: 5 } }, () => l.reconcile({ at: T2, author: 'Reshma K' }));

  assert.equal(minted.length, 1, 'editing one metric versioned more than one');
  assert.deepEqual(minted[0].metric, 'roas.net');
  assert.equal(minted[0].change, 'redefined');
  assert.equal(minted[0].from, 1);
  assert.equal(minted[0].version, 2);
  assert.equal(l.versionOf('cost.per_lead'), 1, 'an untouched metric was advanced');
});

test('the history says which fields moved, not merely that something did', () => {
  const l = log();
  l.reconcile({ at: T1 });
  const [change] = withEdit('roas.net', { thresholds: { good: 9, warning: 5 }, owner: 'Revenue Manager' },
    () => l.reconcile({ at: T2 }));

  assert.deepEqual(change.fields, ['owner', 'thresholds']);
});

test('an author is recorded when given and never invented', () => {
  /* The app cannot see who edited a source file. A governance record naming
     the wrong person is worse than one naming nobody. */
  const l = log();
  l.reconcile({ at: T1 });

  withEdit('roas.net', { owner: 'Revenue Manager' }, () => l.reconcile({ at: T2, author: 'Reshma K' }));
  assert.equal(l.governance('roas.net').author, 'Reshma K');

  withEdit('cost.per_lead', { owner: 'Revenue Manager' }, () => l.reconcile({ at: T2 }));
  assert.equal(l.governance('cost.per_lead').author, 'unattributed');
});

test('versions survive a reload', () => {
  const l = log();
  l.reconcile({ at: T1 });
  withEdit('roas.net', { thresholds: { good: 9, warning: 5 } }, () => l.reconcile({ at: T2 }));

  assert.equal(new DefinitionLog(l.file).versionOf('roas.net'), 2);
});

test('rewording prose does not mint a version', () => {
  /* `description` and `aiContext` are outside the fingerprint — a clearer
     sentence is not a redefinition. */
  const l = log();
  l.reconcile({ at: T1 });
  const minted = withEdit('roas.net', { description: 'Reworded, same arithmetic.' }, () => l.reconcile({ at: T2 }));
  assert.deepEqual(minted, []);
});

test('an edit and its reversal leave the version advanced, not restored', () => {
  /* Versions count edits, not distinct states — a metric that went out at v2
     was still a different definition from v1 at the time. */
  const l = log();
  l.reconcile({ at: T1 });
  withEdit('roas.net', { thresholds: { good: 9, warning: 5 } }, () => l.reconcile({ at: T2 }));
  const back = l.reconcile({ at: T2 });

  assert.equal(back.length, 1);
  assert.equal(l.versionOf('roas.net'), 3);
});

/* ── governance line ────────────────────────────────────────────────────── */

test('governance reads like the design panel', () => {
  const l = log();
  l.reconcile({ at: T1 });
  withEdit('roas.net', { thresholds: { good: 9, warning: 5 } }, () => l.reconcile({ at: T2, author: 'Reshma K' }));

  const g = l.governance('roas.net');
  assert.equal(g.version, 'v2');
  assert.equal(g.since, T2);
  assert.equal(g.author, 'Reshma K');
  assert.equal(g.edits, 1);
});

test('a metric with no history has no governance to report', () => {
  assert.equal(log().governance('roas.net'), null);
});

/* ── retirement ─────────────────────────────────────────────────────────── */

test('a metric that leaves the registry keeps its history', () => {
  /* A report sent under it still needs explaining. */
  const l = log();
  l.reconcile({ at: T1 });

  const original = registry.BY_ID['leads.lost'];
  delete registry.BY_ID['leads.lost'];
  const index = registry.METRICS.indexOf(original);
  registry.METRICS.splice(index, 1);
  try {
    const minted = l.reconcile({ at: T2 });
    assert.deepEqual(minted.map((m) => [m.metric, m.change]), [['leads.lost', 'retired']]);
    assert.ok(l.governance('leads.lost').retired, 'a retired metric lost its record');
  } finally {
    registry.METRICS.splice(index, 0, original);
    registry.BY_ID['leads.lost'] = original;
  }
});

/* ── field comparison ───────────────────────────────────────────────────── */

test('changed fields ignore key order and notice real differences', () => {
  assert.deepEqual(changedFields({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), []);
  assert.deepEqual(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 }), ['b']);
  assert.deepEqual(changedFields({ id: 'x', a: 1 }, { id: 'y', a: 1 }), [], 'the id was reported as a changed field');
});
