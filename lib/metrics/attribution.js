/* Phase 5, stage 4 — "Workspace attribution model assigns revenue credit
 * across the touchpoint chain."
 *
 * The Analytics Engine page is unusually specific about this and every clause
 * is implemented here:
 *
 *   "a workspace-level parameter on every revenue read, not a per-report
 *    toggle"            → `setting()` is global; `credit()` takes the model
 *                          from it unless explicitly overridden for a preview
 *   "preview its impact before applying"   → `preview()`
 *   "restate history"                      → `apply()` returns a restatement
 *   "record a written justification"       → `apply()` refuses without one
 *
 * The seven models differ only in how they weight positions in a chain, so
 * they are seven weighting functions over one credit routine rather than seven
 * implementations.
 */

const fs = require('fs');
const path = require('path');

const SETTING_FILE = path.join(__dirname, '..', '..', 'var', 'attribution.json');

const DEFAULT_MODEL = 'datadriven';

const MODELS = {
  first: { name: 'First click', character: 'Credits discovery; flatters top-of-funnel' },
  last: { name: 'Last click', character: 'Credits the closer; over-rewards direct' },
  linear: { name: 'Linear', character: 'Neutral; ignores position entirely' },
  position: { name: 'Position based', character: '40/20/40 — the pragmatic default' },
  decay: { name: 'Time decay', character: 'Suits short booking windows' },
  datadriven: { name: 'Data driven', character: 'Shapley on your own history' },
  custom: { name: 'Custom weighted', character: 'Your weights; requires justification' },
};

/* The page states the custom model's constraints: weights must total 100% and
   the lookback window is 30 days, applying to bookings rather than enquiries. */
const CUSTOM_DEFAULT = { first: 40, middle: 20, last: 40 };
const LOOKBACK_DAYS = 30;
const DECAY_HALF_LIFE_DAYS = 7;

/* ── Weighting ────────────────────────────────────────────────────────────
   Each function takes the chain and returns one weight per touch. They are
   normalised afterwards, so a function only has to get the proportions right. */

const WEIGHTS = {
  first: (chain) => chain.map((_, i) => (i === 0 ? 1 : 0)),
  last: (chain) => chain.map((_, i) => (i === chain.length - 1 ? 1 : 0)),
  linear: (chain) => chain.map(() => 1),

  position: (chain, { weights = CUSTOM_DEFAULT } = {}) => {
    const n = chain.length;
    if (n === 1) return [1];
    if (n === 2) return [weights.first, weights.last];
    const middleEach = weights.middle / (n - 2);
    return chain.map((_, i) => (i === 0 ? weights.first : i === n - 1 ? weights.last : middleEach));
  },

  /* Half-life on the gap to conversion, not to the first touch: a booking made
     today is influenced by last week's ad far more than by last quarter's. */
  decay: (chain, { convertedAt } = {}) => {
    const end = convertedAt ? Date.parse(convertedAt) : Date.parse(chain[chain.length - 1].at);
    return chain.map((t) => {
      const days = Math.max(0, (end - Date.parse(t.at)) / 86400000);
      return 2 ** (-days / DECAY_HALF_LIFE_DAYS);
    });
  },

  custom: (chain, options) => WEIGHTS.position(chain, options),
};

function normalise(weights) {
  const total = weights.reduce((t, w) => t + w, 0);
  if (!total) return weights.map(() => 1 / weights.length);
  return weights.map((w) => w / total);
}

/* ── Data driven ──────────────────────────────────────────────────────────
   Shapley value over the channels present in a chain, against a conversion
   rate estimated from the observed chains. The estimator is the honest part:
   `v(S)` is the share of chains containing exactly the channels in S that
   converted, so a channel's credit is its average marginal contribution to
   that rate across every ordering.

   With four leads this is noise, and it says so — `dataDrivenReady` reports
   whether there is enough history for the result to mean anything. It is
   implemented properly anyway, because a placeholder here would be the one
   model nobody could check later. */

const MIN_CHAINS_FOR_DATA_DRIVEN = 200;

function coalitionValue(chains, subset) {
  const wanted = new Set(subset);
  const matching = chains.filter((c) => {
    const present = new Set(c.chain.map((t) => t.channel));
    return present.size === wanted.size && [...wanted].every((ch) => present.has(ch));
  });
  if (!matching.length) return 0;
  return matching.filter((c) => c.converted).length / matching.length;
}

function shapley(chains, channels) {
  const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));
  const N = channels.length;
  const values = Object.fromEntries(channels.map((c) => [c, 0]));

  /* Every subset of the other channels, weighted by how many orderings it
     represents — the textbook Shapley sum, feasible because a hospitality
     workspace has five channels, not five hundred. */
  for (const channel of channels) {
    const others = channels.filter((c) => c !== channel);
    for (let mask = 0; mask < 2 ** others.length; mask += 1) {
      const subset = others.filter((_, i) => mask & (1 << i));
      const weight = (factorial(subset.length) * factorial(N - subset.length - 1)) / factorial(N);
      values[channel] += weight * (coalitionValue(chains, [...subset, channel]) - coalitionValue(chains, subset));
    }
  }
  return values;
}

function dataDrivenWeights(chain, { shapleyValues = {} } = {}) {
  const weights = chain.map((t) => Math.max(0, shapleyValues[t.channel] || 0));
  /* No history yet, or every channel scored zero: fall back to linear and let
     the caller see it in `basis` rather than silently returning zeros. */
  return weights.some((w) => w > 0) ? weights : chain.map(() => 1);
}

/* ── Chains ───────────────────────────────────────────────────────────────
   A touchpoint chain per converting booking. Built from the lead's own arrival
   touch plus whatever the CRM recorded afterwards, ordered in time and clipped
   to the lookback window the page specifies. */

function buildChains({ bookings, leads, leadEvents = [], identity }) {
  return bookings.map((booking) => {
    const match = identity.bookings.find((m) => m.bookingId === booking.id);
    const lead = leads.find((l) => l.id === (match && match.leadId));

    const touches = [];
    if (lead) {
      touches.push({
        channel: match.channel,
        campaign: match.campaign,
        at: lead.createdAt,
        kind: 'lead_created',
        confidence: match.confidence,
      });
      for (const e of leadEvents.filter((e) => e.leadId === lead.id)) {
        touches.push({ channel: match.channel, campaign: match.campaign, at: e.at, kind: e.type, confidence: match.confidence });
      }
    }

    /* A booking with no measurable media behind it still has a chain — one
       direct touch. Dropping it would quietly shrink the denominator and
       inflate every paid channel's share. */
    if (!touches.length) {
      touches.push({
        channel: (match && match.channel) || 'Direct / booking engine',
        campaign: null,
        at: booking.checkIn,
        kind: 'booking',
        confidence: 0,
      });
    }

    const convertedAt = booking.checkIn;
    const cutoff = Date.parse(convertedAt) - LOOKBACK_DAYS * 86400000;
    const chain = touches
      .filter((t) => t.at && Date.parse(t.at) >= cutoff)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    return {
      bookingId: booking.id,
      chain: chain.length ? chain : touches.slice(-1),
      revenue: booking.revenue ? booking.revenue.value : 0,
      convertedAt,
      converted: true,
    };
  });
}

/* ── Crediting ────────────────────────────────────────────────────────────── */

function creditChain(entry, model, options = {}) {
  const weightFn = model === 'datadriven'
    ? (chain) => dataDrivenWeights(chain, options)
    : WEIGHTS[model];
  if (!weightFn) throw new Error(`unknown attribution model "${model}"`);

  const raw = weightFn(entry.chain, { ...options, convertedAt: entry.convertedAt });
  const weights = normalise(raw);

  return entry.chain.map((touch, i) => ({
    bookingId: entry.bookingId,
    channel: touch.channel,
    campaign: touch.campaign,
    weight: weights[i],
    /* Rounded to the minor unit at the last possible moment, and the remainder
       given to the largest share, so channel credit always sums to the revenue
       it came from rather than to a rupee less. */
    amount: Math.round(entry.revenue * weights[i]),
  }));
}

function reconcile(credits, revenue) {
  if (!credits.length) return credits;
  const total = credits.reduce((t, c) => t + c.amount, 0);
  const drift = revenue - total;
  if (!drift) return credits;
  const largest = credits.reduce((a, b) => (b.amount > a.amount ? b : a));
  largest.amount += drift;
  return credits;
}

function credit(entities, { model = setting().model, identity, leadEvents = [], weights } = {}) {
  if (!MODELS[model]) throw new Error(`unknown attribution model "${model}"`);

  const chains = buildChains({ ...entities, identity, leadEvents });

  const channels = [...new Set(chains.flatMap((c) => c.chain.map((t) => t.channel)))];
  const shapleyValues = model === 'datadriven' ? shapley(chains, channels) : {};

  const all = [];
  for (const entry of chains) {
    all.push(...reconcile(creditChain(entry, model, { shapleyValues, weights }), entry.revenue));
  }

  const byChannel = new Map();
  for (const c of all) byChannel.set(c.channel, (byChannel.get(c.channel) || 0) + c.amount);

  const byCampaign = new Map();
  for (const c of all.filter((x) => x.campaign)) {
    byCampaign.set(c.campaign, (byCampaign.get(c.campaign) || 0) + c.amount);
  }

  const total = [...byChannel.values()].reduce((t, v) => t + v, 0);

  return {
    model,
    modelName: MODELS[model].name,
    character: MODELS[model].character,
    total,
    credits: all,
    chains,
    byChannel: [...byChannel.entries()]
      .map(([channel, amount]) => ({ channel, amount, share: total ? Number((amount / total).toFixed(4)) : 0 }))
      .sort((a, b) => b.amount - a.amount),
    byCampaign: [...byCampaign.entries()]
      .map(([campaign, amount]) => ({ campaign, amount }))
      .sort((a, b) => b.amount - a.amount),
    basis: model === 'datadriven'
      ? { shapleyValues, ready: chains.length >= MIN_CHAINS_FOR_DATA_DRIVEN, chains: chains.length, needs: MIN_CHAINS_FOR_DATA_DRIVEN }
      : null,
  };
}

/* ── The workspace setting, and changing it ──────────────────────────────── */

function readSetting() {
  if (!fs.existsSync(SETTING_FILE)) return { model: DEFAULT_MODEL, weights: CUSTOM_DEFAULT, changes: [] };
  return JSON.parse(fs.readFileSync(SETTING_FILE, 'utf8'));
}

function writeSetting(value) {
  fs.mkdirSync(path.dirname(SETTING_FILE), { recursive: true });
  fs.writeFileSync(SETTING_FILE, JSON.stringify(value, null, 2) + '\n');
  return value;
}

function setting() {
  return readSetting();
}

/* "Changing it must preview its impact before applying." The preview is the
   same computation as the real read, run across every model — which is the
   only way the comparison can be trusted to mean what it says. */
function preview(entities, options = {}) {
  const current = setting().model;
  const rows = Object.keys(MODELS).map((model) => {
    const result = credit(entities, { ...options, model });
    return {
      model,
      name: MODELS[model].name,
      character: MODELS[model].character,
      current: model === current,
      total: result.total,
      byChannel: result.byChannel,
    };
  });

  /* "The spread between first and last click is the honest measure of how much
     your channels assist each other." */
  const spread = {};
  for (const { channel } of rows[0].byChannel) {
    const amounts = rows.map((r) => (r.byChannel.find((c) => c.channel === channel) || { amount: 0 }).amount);
    spread[channel] = { min: Math.min(...amounts), max: Math.max(...amounts), range: Math.max(...amounts) - Math.min(...amounts) };
  }

  return { rows, spread };
}

/* Applying a model restates every number already computed on the old one. The
   page requires a written justification, so this refuses without one — a rule
   that is only worth having if it cannot be skipped. */
function apply(model, { justification, by, at, weights, entities, options = {} } = {}) {
  if (!MODELS[model]) throw new Error(`unknown attribution model "${model}"`);
  if (!justification || !String(justification).trim()) {
    throw new Error('changing the attribution model requires a written justification');
  }
  if (!by) throw new Error('changing the attribution model requires a named actor');

  if (model === 'custom') {
    const w = weights || CUSTOM_DEFAULT;
    const total = w.first + w.middle + w.last;
    if (Math.round(total) !== 100) throw new Error(`custom position weights must total 100%, got ${total}%`);
  }

  const previous = setting();
  const change = {
    from: previous.model,
    to: model,
    at: at || new Date().toISOString(),
    by,
    justification: String(justification).trim(),
  };

  /* The restatement is computed before the setting moves, so the record shows
     what actually changed rather than what changed after it changed. */
  let restatement = null;
  if (entities) {
    const before = credit(entities, { ...options, model: previous.model, weights: previous.weights });
    const after = credit(entities, { ...options, model, weights: weights || previous.weights });
    restatement = {
      total: { before: before.total, after: after.total },
      byChannel: after.byChannel.map((row) => {
        const was = before.byChannel.find((b) => b.channel === row.channel) || { amount: 0 };
        return { channel: row.channel, before: was.amount, after: row.amount, delta: row.amount - was.amount };
      }),
      /* "Already-sent reports are flagged on restatement rather than silently
         altered" — the flag is raised here; Phase 8 is what routes it. */
      flagsSentReports: true,
    };
  }

  writeSetting({
    model,
    weights: weights || previous.weights || CUSTOM_DEFAULT,
    changes: [...(previous.changes || []), { ...change, restatement }],
  });

  return { ...change, restatement };
}

module.exports = {
  MODELS, DEFAULT_MODEL, CUSTOM_DEFAULT, LOOKBACK_DAYS, MIN_CHAINS_FOR_DATA_DRIVEN,
  credit, preview, apply, setting, writeSetting, buildChains, shapley, WEIGHTS,
};
