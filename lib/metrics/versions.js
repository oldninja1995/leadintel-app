/* Versioned results, so a past number reproduces exactly.
 *
 * Sub-phase 6.2, against stage 5's own words: "Results versioned with the
 * input snapshot." The exit criterion Phase 6 states is blunter — *a number
 * from three months ago reproduces exactly* — and the only way to satisfy that
 * honestly is to keep what the number was computed **from**, not just what it
 * came out as. A stored figure with no inputs is a claim; a stored figure with
 * its inputs is a receipt.
 *
 * Three things go in every record, and the second is the one people forget:
 *
 *   inputs      the canonical entities the evaluation read
 *   registry    a fingerprint of every definition in force at the time
 *   values      what came out
 *
 * Without the fingerprint, a figure that moves between then and now is
 * ambiguous: the data may have been restated, or somebody may have edited the
 * formula. Those need different responses, and telling them apart is exactly
 * what 6.3's restatement rule will need.
 *
 * Reproduction re-runs the evaluator over the stored inputs and compares. That
 * is only meaningful because `evaluate` is a pure function of a snapshot — no
 * clock, no ambient state, no ordering luck. The tests below would catch it
 * the day that stops being true.
 *
 * **On storage.** Whole entity sets are written inline, which is right at
 * fixture scale and wrong at production scale — there it would reference the
 * append-only raw store by window instead. The record shape does not change;
 * only where `inputs` points does.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const registry = require('./registry');

const DIR = path.join(__dirname, '..', '..', 'var', 'evaluations');

/* Order-insensitive, like the raw store's — two snapshots differing only in
   key order are the same snapshot, and a checksum that disagreed would make
   every re-record look like new data. */
function checksum(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}

/* What a definition is, for the purpose of "did this change?". Deliberately
   includes thresholds, format and favourability: a metric whose good/warning
   bands moved reports differently even when the number is identical, and
   anyone comparing two records needs to see that. `description` and
   `aiContext` are prose and excluded — rewording a sentence is not a
   restatement. */
function definitionOf(metric) {
  return {
    id: metric.id,
    formula: metric.formula || null,
    base: typeof metric.source === 'function',
    dependencies: [...metric.dependencies].sort(),
    thresholds: metric.thresholds,
    benchmark: metric.benchmark,
    favourability: metric.favourability,
    format: metric.format,
    refresh: metric.refresh,
    owner: metric.owner,
  };
}

const definitions = () => registry.list().map(definitionOf).sort((a, b) => a.id.localeCompare(b.id));
const fingerprint = () => checksum(definitions());

/* Which definitions differ between two fingerprinted sets. Answering "which
   metric changed" rather than "something changed" is the difference between a
   usable restatement notice and an alarm. */
function definitionDrift(before = [], after = definitions()) {
  const beforeById = Object.fromEntries(before.map((d) => [d.id, d]));
  const afterById = Object.fromEntries(after.map((d) => [d.id, d]));
  const drift = [];

  for (const id of new Set([...Object.keys(beforeById), ...Object.keys(afterById)])) {
    if (!beforeById[id]) { drift.push({ metric: id, change: 'added' }); continue; }
    if (!afterById[id]) { drift.push({ metric: id, change: 'removed' }); continue; }
    if (checksum(beforeById[id]) !== checksum(afterById[id])) drift.push({ metric: id, change: 'redefined' });
  }
  return drift;
}

class Evaluations {
  constructor(dir = DIR) {
    this.dir = dir;
  }

  _file(id) {
    /* Ids are generated below and never taken from a caller, but a path that
       could escape its directory is not worth leaving to convention. */
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`bad evaluation id "${id}"`);
    return path.join(this.dir, `${id}.json`);
  }

  /* `evaluate` is injected rather than required, because requiring it here
     would close a cycle: index.js -> versions.js -> index.js. */
  record(entities, { evaluate, at = null, recordedAt = new Date().toISOString(), note = null } = {}) {
    if (typeof evaluate !== 'function') throw new Error('record needs an evaluate function');

    const { values, problems, notApplicable } = evaluate(entities, { at });
    const inputChecksum = checksum(entities);
    const id = `${recordedAt.replace(/[:.]/g, '-')}-${inputChecksum.slice(0, 8)}`;

    const record = {
      id,
      recordedAt,
      note,
      at,
      registryFingerprint: fingerprint(),
      definitions: definitions(),
      inputChecksum,
      inputs: entities,
      values,
      problems,
      notApplicable,
    };

    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._file(id), JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  get(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /* Newest first. The metadata only — a listing that carried every stored
     entity set would be unusable by the tenth record. */
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        return {
          id: r.id, recordedAt: r.recordedAt, note: r.note, at: r.at,
          registryFingerprint: r.registryFingerprint, inputChecksum: r.inputChecksum,
          metrics: Object.keys(r.values).length,
        };
      })
      .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
  }

  /* Re-run the stored inputs through the current evaluator and say whether the
     answer still holds — and if not, whether the definitions moved under it. */
  reproduce(id, { evaluate } = {}) {
    const stored = this.get(id);
    if (!stored) return null;

    const { values } = evaluate(stored.inputs, { at: stored.at });
    const changed = [];
    for (const metric of new Set([...Object.keys(stored.values), ...Object.keys(values)])) {
      const before = stored.values[metric];
      const after = values[metric];
      if (before !== after) changed.push({ metric, then: before, now: after });
    }

    const drift = definitionDrift(stored.definitions);
    return {
      id,
      recordedAt: stored.recordedAt,
      reproduced: changed.length === 0,
      /* Stated separately because they demand different responses: the same
         inputs giving different answers under unchanged definitions is a bug,
         while the same inputs giving different answers after a definition
         changed is a restatement. */
      registryChanged: stored.registryFingerprint !== fingerprint(),
      definitionDrift: drift,
      changed,
      values,
    };
  }
}

module.exports = { Evaluations, DIR, checksum, fingerprint, definitions, definitionOf, definitionDrift };
