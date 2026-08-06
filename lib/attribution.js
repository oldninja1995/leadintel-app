/* Stage 4 — attribution, as a workspace parameter.
 *
 * Sub-phase 5.2. The Analytics Engine page is specific about the shape of this,
 * and the shape is the point: attribution is "a workspace attribution model"
 * applied on every revenue read — not a control that sits on one report and
 * lets two screens disagree about what a booking was worth. Phase 2 wired the
 * seven models as a per-screen URL toggle, which was the right thing to build
 * then and the wrong thing to keep.
 *
 * So the model lives here, in one place, persisted, and every read is handed it.
 * Three consequences the page asks for follow from that:
 *
 *   preview      changing it shows the impact before it applies, because the
 *                spread between first and last click is the whole argument and
 *                nobody should discover it after the fact
 *   justification a change is a claim about how the business credits revenue;
 *                it is recorded with a reason, and `custom` cannot be applied
 *                without one ("Your weights; requires justification")
 *   history      every change is kept, so a number that moved can be explained
 *                by the decision that moved it
 *
 * The credit table is **reviewed design content**, not authored — it is the
 * impact-preview table from the Analytics Engine page, verbatim. See the note
 * in data/attribution.js.
 *
 * **What this cannot do yet, stated plainly.** Multi-touch weighting needs a
 * touchpoint chain per booking. The fixtures carry two `lead_event` rows in
 * total, so Shapley or time-decay weighting over *ingested* touchpoints is not
 * computable at this scale — with one touchpoint every model credits it fully
 * and they all agree. The mechanism below is real; the per-channel weights stay
 * the design's reviewed figures until there is touchpoint data to compute from.
 */

const fs = require('fs');
const path = require('path');

const { UP, DOWN, NA } = require('../data/_tokens');

const STORE = path.join(__dirname, '..', 'var', 'workspace.json');

/* Meta / Google / Direct / Organic / Email·WA in ₹ lakh, and the resulting Meta
   ROAS. Verbatim from the Analytics Engine impact preview — design content. */
const MODELS = {
  first: { name: 'First click', meta: 24.1, google: 13.6, direct: 6.8, organic: 5.2, email: 2.6, roas: '4.9x', roasColor: UP, character: 'Credits discovery; flatters top-of-funnel' },
  last: { name: 'Last click', meta: 14.1, google: 12.0, direct: 19.9, organic: 2.1, email: 4.2, roas: '2.9x', roasColor: DOWN, character: 'Credits the closer; over-rewards direct' },
  linear: { name: 'Linear', meta: 18.3, google: 13.1, direct: 10.5, organic: 6.3, email: 4.1, roas: '3.7x', roasColor: NA, character: 'Neutral; ignores position entirely' },
  position: { name: 'Position based', meta: 19.4, google: 12.6, direct: 11.5, organic: 5.2, email: 3.6, roas: '4.0x', roasColor: NA, character: '40/20/40 — the pragmatic default' },
  decay: { name: 'Time decay', meta: 16.2, google: 12.6, direct: 15.2, organic: 3.7, email: 4.7, roas: '3.3x', roasColor: NA, character: 'Suits short booking windows' },
  datadriven: { name: 'Data driven', meta: 18.9, google: 13.6, direct: 10.5, organic: 5.2, email: 4.2, roas: '4.8x', roasColor: UP, character: 'Shapley on your own history — active' },
  custom: { name: 'Custom weighted', meta: 17.5, google: 12.9, direct: 12.4, organic: 5.0, email: 4.5, roas: '4.3x', roasColor: NA, character: 'Your weights; requires justification' },
};

const ORDER = ['first', 'last', 'linear', 'position', 'decay', 'datadriven', 'custom'];
const CHANNELS = ['meta', 'google', 'direct', 'organic', 'email'];
const DEFAULT = 'datadriven';

/* The page's own words for the custom model. A weighting somebody invented is
   exactly the one that needs a reason attached. */
const REQUIRES_JUSTIFICATION = new Set(['custom']);

const isModel = (key) => Object.prototype.hasOwnProperty.call(MODELS, key);
const total = (m) => CHANNELS.reduce((t, c) => t + m[c], 0);

/* ── the workspace setting ──────────────────────────────────────────────── */

class Workspace {
  constructor(file = STORE) {
    this.file = file;
    this._state = null;
  }

  state() {
    if (this._state) return this._state;
    try {
      const onDisk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._state = isModel(onDisk.model) ? onDisk : this._fresh();
    } catch (err) {
      /* No file yet is the ordinary case on a new install, and a corrupt one
         must not stop the product from rendering — but it must not silently
         become "the default was always what you chose" either, so the reset is
         recorded in history like any other change. */
      this._state = this._fresh(err.code === 'ENOENT' ? null : `unreadable workspace file: ${err.message}`);
    }
    return this._state;
  }

  _fresh(problem = null) {
    return {
      model: DEFAULT,
      changedAt: null,
      justification: null,
      history: problem ? [{ to: DEFAULT, at: null, justification: problem, reset: true }] : [],
    };
  }

  model() { return this.state().model; }

  /* Applied, with the reason it was applied. Returns the change record rather
     than a bare ok, so a caller can show what actually moved. */
  apply(model, { justification = '', at = new Date().toISOString() } = {}) {
    if (!isModel(model)) throw new Error(`unknown attribution model "${model}"`);

    const reason = String(justification || '').trim();
    if (REQUIRES_JUSTIFICATION.has(model) && !reason) {
      throw new Error(`the ${MODELS[model].name} model cannot be applied without a written justification`);
    }

    const state = this.state();
    const from = state.model;
    const change = { from, to: model, at, justification: reason || null, impact: impact(from, model) };

    this._state = {
      model,
      changedAt: at,
      justification: reason || null,
      /* Newest first — the question anyone asks of this list is "what changed
         most recently", not "what changed first". */
      history: [change, ...state.history].slice(0, 50),
    };

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n');
    return change;
  }

  reload() { this._state = null; return this; }
}

/* ── impact preview ─────────────────────────────────────────────────────── */

const lakh = (n) => `₹${n.toFixed(1)}L`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}L`;

/* What changing the model would do, before it does it. Per channel, because
   "revenue moved" is not actionable and "Meta loses ₹4.8L to Direct" is. */
function impact(from, to) {
  if (!isModel(from) || !isModel(to)) throw new Error('impact needs two known models');

  const a = MODELS[from];
  const b = MODELS[to];
  const totalA = total(a);
  const totalB = total(b);

  const channels = CHANNELS.map((c) => {
    const delta = b[c] - a[c];
    return {
      channel: c,
      from: lakh(a[c]),
      to: lakh(b[c]),
      delta: signed(delta),
      deltaValue: Number(delta.toFixed(2)),
      shareFrom: `${((a[c] / totalA) * 100).toFixed(1)}%`,
      shareTo: `${((b[c] / totalB) * 100).toFixed(1)}%`,
      direction: delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat',
    };
  });

  /* The single line a revenue manager needs: which channel moves most, and by
     how much. Ties broken by magnitude only — direction is already in `delta`. */
  const biggest = [...channels].sort((x, y) => Math.abs(y.deltaValue) - Math.abs(x.deltaValue))[0];

  return {
    from, to,
    fromName: a.name, toName: b.name,
    channels,
    metaRoasFrom: a.roas,
    metaRoasTo: b.roas,
    /* Total credited revenue is not constant across the design's table, so it
       is reported rather than assumed away. */
    totalFrom: lakh(totalA),
    totalTo: lakh(totalB),
    headline: biggest && biggest.direction !== 'flat'
      ? `${biggest.channel} ${biggest.direction === 'up' ? 'gains' : 'loses'} ${signed(biggest.deltaValue).replace(/^[+−]/, '')}`
      : 'no channel moves materially',
    unchanged: from === to,
    requiresJustification: REQUIRES_JUSTIFICATION.has(to),
  };
}

/* The credit split under one model, in the shape a screen renders. */
function credit(model) {
  const key = isModel(model) ? model : DEFAULT;
  const m = MODELS[key];
  const t = total(m);
  return CHANNELS.map((c) => ({
    channel: c,
    rev: lakh(m[c]),
    share: `${((m[c] / t) * 100).toFixed(1)}%`,
  }));
}

module.exports = {
  MODELS, ORDER, CHANNELS, DEFAULT, REQUIRES_JUSTIFICATION, STORE,
  Workspace, impact, credit, isModel, total,
};
