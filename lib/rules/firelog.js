/* Every time a rule fired, and whether it should have.
 *
 * Phase 8's second exit criterion: *every rule reports its 90-day fire count
 * and false-positive rate*. The design puts a fire count on each rule and
 * colours the noisy ones — nine fires for the sales-response rule against one
 * for high cancellations, with the nine shown in red.
 *
 * A false positive cannot be computed. Whether a fire was worth having is a
 * judgement somebody makes afterwards, so it is **recorded when a human says
 * so** and never inferred. A rule with no marked false positives has a rate of
 * 0% only once at least one fire has been reviewed; before that it is unknown,
 * and saying "0% false positives" about an unreviewed rule would be the most
 * flattering possible lie about a noisy threshold.
 *
 * Append-only, like the raw store: a fire that was later judged a false
 * positive is annotated, not deleted, because the count of times a threshold
 * shouted is the thing the design wants visible.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'var', 'fires.jsonl');
const NINETY_DAYS = 90 * 24 * 3600 * 1000;

class FireLog {
  constructor(file = FILE) {
    this.file = file;
  }

  all() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  append(fire) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(fire) + '\n');
    return fire;
  }

  /* Annotated, not rewritten — the original line stays and a judgement is
     appended beside it. */
  judge(fireId, { falsePositive, by = null, at = new Date().toISOString(), note = null }) {
    const fires = this.all();
    if (!fires.some((f) => f.id === fireId)) return null;
    const judgement = { id: fireId, kind: 'judgement', falsePositive: Boolean(falsePositive), by, at, note };
    this.append(judgement);
    return judgement;
  }

  /* Fires and judgements resolved together. A fire judged twice takes the
     latest judgement — somebody changing their mind is allowed. */
  resolved() {
    const fires = [];
    const judgements = new Map();
    for (const row of this.all()) {
      if (row.kind === 'judgement') judgements.set(row.id, row);
      else fires.push(row);
    }
    return fires.map((f) => {
      const judgement = judgements.get(f.id);
      return { ...f, judged: Boolean(judgement), falsePositive: judgement ? judgement.falsePositive : null };
    });
  }

  /* What the design's rule table shows. `since` is injected rather than read
     from the clock so the window is reproducible. */
  stats(ruleId, since) {
    const cutoff = since || new Date(Date.now() - NINETY_DAYS).toISOString();
    const fires = this.resolved().filter((f) => f.rule === ruleId && f.at >= cutoff);
    const judged = fires.filter((f) => f.judged);
    const false_ = judged.filter((f) => f.falsePositive);

    return {
      rule: ruleId,
      since: cutoff,
      fired: fires.length,
      judged: judged.length,
      falsePositives: false_.length,
      /* Unknown until somebody has reviewed a fire. Reporting 0% for an
         unreviewed rule would flatter exactly the thresholds that need
         watching. */
      falsePositiveRate: judged.length ? `${Math.round((false_.length / judged.length) * 100)}%` : null,
      unreviewed: fires.length - judged.length,
      lastFired: fires.length ? fires[fires.length - 1].at : null,
    };
  }

  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { FireLog, FILE, NINETY_DAYS };
