/* Sent reports, and what happens when their numbers move.
 *
 * Sub-phase 5.3. Its exit criterion is the sharpest sentence in the plan:
 * *already-sent reports are flagged on restatement rather than silently
 * altered*. Both halves matter. A report that quietly updates itself makes a
 * liar of whoever quoted it in a meeting; a report that never updates leaves
 * people acting on a figure that has since been corrected. The only honest
 * answer is that the sent copy is immutable **and** the drift is announced.
 *
 * So a dispatch keeps the values it carried, copied out of the evaluation
 * snapshot at send time rather than referenced — a recipient's PDF does not
 * change because a store was replayed. `restatement()` then compares those
 * frozen figures against the present, and answers three questions separately
 * because they need different responses:
 *
 *   data moved          the same definitions now give a different number, so
 *                       the source restated — reissue the report
 *   definitions moved   somebody changed what the metric means, so the old
 *                       report is not wrong, it is answering a different
 *                       question — say so rather than reissuing
 *   nothing moved       the report still holds; leave it alone
 *
 * Nothing here sends anything. There is no mail transport, no PDF renderer and
 * no scheduler — those are Phase 8. `send` records that a dispatch happened,
 * which is the fact 5.3 and 6.3 both needed and neither had.
 */

const fs = require('fs');
const path = require('path');

const { definitionDrift, checksum } = require('./metrics/versions');

const DIR = path.join(__dirname, '..', 'var', 'dispatches');

class Dispatches {
  /* See lib/connections.js — the file path is untouched and still the default;
     a backend swaps the medium and `hydrate()` pulls the directory into memory
     so the synchronous reads below are unchanged. */
  constructor(dir = DIR, { backend = null, prefix = 'dispatches/' } = {}) {
    this.dir = dir;
    this.backend = backend;
    this.prefix = prefix;
    this._docs = null;
    this._pending = null;
  }

  _id(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`bad dispatch id "${id}"`);
    return id;
  }

  _file(id) {
    return path.join(this.dir, `${this._id(id)}.json`);
  }

  async hydrate() {
    if (!this.backend) return this;
    const rows = await this.backend.list(this.prefix);
    this._docs = new Map(rows.map((r) => [r.key.slice(this.prefix.length), r.value]));
    return this;
  }

  flush() {
    return this._pending || Promise.resolve();
  }

  _put(id, value) {
    if (this.backend) {
      this._docs = this._docs || new Map();
      this._docs.set(this._id(id), value);
      this._pending = this.backend.put(this.prefix + this._id(id), value);
      return value;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._file(id), JSON.stringify(value, null, 2) + '\n');
    return value;
  }

  /* `evaluation` is a record from lib/metrics/versions — it carries the values,
     the definitions in force and the inputs they came from. The dispatch takes
     a copy of the parts the recipient saw, so it stands alone even if the
     evaluation is later pruned. */
  send(report, { evaluation, metrics = null, recipients = [], channels = [], sentAt = new Date().toISOString() } = {}) {
    if (!report) throw new Error('a dispatch needs a report name');
    if (!evaluation || !evaluation.values) throw new Error('a dispatch needs the evaluation it carried');

    /* A report shows some metrics, not all of them. Recording which ones keeps
       a later restatement from flagging a figure the recipient never saw. */
    const shown = metrics && metrics.length ? metrics : Object.keys(evaluation.values);
    const missing = shown.filter((m) => !(m in evaluation.values));
    if (missing.length) throw new Error(`the evaluation does not carry ${missing.join(', ')}`);

    const carried = Object.fromEntries(shown.map((m) => [m, evaluation.values[m]]));
    const id = `${sentAt.replace(/[:.]/g, '-')}-${checksum({ report, carried }).slice(0, 8)}`;

    const dispatch = {
      id,
      report,
      sentAt,
      recipients,
      channels,
      evaluationId: evaluation.id,
      at: evaluation.at || null,
      registryFingerprint: evaluation.registryFingerprint,
      /* Frozen. This is what the recipient has in their hand. */
      definitions: evaluation.definitions,
      carried,
    };

    return this._put(id, dispatch);
  }

  get(id) {
    if (this.backend) return (this._docs || new Map()).get(this._id(id)) || null;
    const file = this._file(id);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  /* Rewrites a dispatch that has just been created — used to attach delivery
     results and the schedule that produced it. Deliberately not a general
     update: `carried` is what the recipient saw and must never be edited, so
     it is restored from the stored copy whatever the caller passes. */
  update(dispatch) {
    const stored = this.get(dispatch.id);
    if (!stored) throw new Error(`no dispatch "${dispatch.id}"`);
    const merged = { ...stored, ...dispatch, carried: stored.carried, definitions: stored.definitions };
    return this._put(dispatch.id, merged);
  }

  list() {
    const all = this.backend
      ? [...(this._docs || new Map()).values()]
      : (fs.existsSync(this.dir)
        ? fs.readdirSync(this.dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')))
        : []);
    return all.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  }
}

/* What has moved under a sent report since it went out.
 *
 * `currentValues` is a fresh evaluation at the dispatch's own grain — comparing
 * a campaign report against workspace figures would invent a restatement that
 * never happened. */
function restatement(dispatch, currentValues = {}) {
  const drift = definitionDrift(dispatch.definitions);
  const redefined = new Set(drift.filter((d) => d.change === 'redefined').map((d) => d.metric));

  const moved = [];
  for (const [metric, sent] of Object.entries(dispatch.carried)) {
    const now = Object.prototype.hasOwnProperty.call(currentValues, metric) ? currentValues[metric] : undefined;
    if (now === undefined) {
      /* A metric the report showed and the registry no longer defines is not a
         restatement — it is a report that can no longer be reproduced at all. */
      moved.push({ metric, sent, now: null, reason: 'no longer in the registry' });
      continue;
    }
    if (now === sent) continue;
    moved.push({
      metric,
      sent,
      now,
      reason: redefined.has(metric) ? 'definition changed' : 'source data restated',
    });
  }

  const dataMoved = moved.filter((m) => m.reason === 'source data restated');
  const definitionMoved = moved.filter((m) => m.reason === 'definition changed');

  return {
    dispatch: dispatch.id,
    report: dispatch.report,
    sentAt: dispatch.sentAt,
    stale: moved.length > 0,
    /* Kept apart on purpose — one calls for a reissue, the other for an
       explanation. See the note at the top of this file. */
    dataMoved,
    definitionMoved,
    unreproducible: moved.filter((m) => m.reason === 'no longer in the registry'),
    moved,
  };
}

/* Every sent report that no longer matches the present. `evaluateAt` is handed
   in so this module never decides how to evaluate — it only compares. */
function stale(dispatches, evaluateAt) {
  const byGrain = new Map();
  const out = [];

  for (const dispatch of dispatches) {
    const key = dispatch.at ? `${dispatch.at.dimension}:${dispatch.at.value}` : '';
    if (!byGrain.has(key)) byGrain.set(key, evaluateAt(dispatch.at));
    const result = restatement(dispatch, byGrain.get(key));
    if (result.stale) out.push(result);
  }
  return out;
}

module.exports = { Dispatches, DIR, restatement, stale };
