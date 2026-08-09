/* What to do about a creative — the instruction, not the score.
 *
 * Fatigue says a creative is tiring. It does not say whether to turn it off.
 * A tired creative that still returns leads cheaper than anything else on the
 * account is not the one to pause, and a fresh creative that has never returned
 * a lead is not saved by being fresh. So the instruction reads both, and says
 * which of the two decided it.
 *
 * **Fatigue is a creative against itself; efficiency is a creative against its
 * peers.** Those are deliberately different comparisons. Cost per lead has no
 * absolute meaning — ₹900 is cheap for a suite and dear for a day pass — so the
 * only honest reference is what the rest of the account is paying right now.
 * Fatigue, by contrast, is meaningless as a peer comparison: an account whose
 * creatives all run at frequency 3 is not evidence that any one of them is
 * tiring. See lib/creative-fatigue.js for why that line is drawn there.
 *
 * **The median, not the mean.** One creative burning half the budget at four
 * times the cost per lead drags a mean up until every other creative looks
 * efficient by comparison — the outlier would exonerate the whole account. The
 * median is the typical creative, which is what "compared to the rest" means.
 *
 * **A verdict with no reason is a verdict to distrust.** Every decision carries
 * the numbers that produced it, in the reader's terms, because the instruction
 * is going to be argued with and it should be arguable.
 *
 * **Not enough data is its own answer.** A creative with no fatigue history and
 * no leads yet does not get "keep running" — that reads as approval. It gets
 * told there is nothing to judge on, which is the truth and prompts the only
 * useful action, which is to wait.
 */

const fatigue = require('./creative-fatigue');

/* How far from the middle of the account a cost per lead has to sit before it
   is an argument on its own. Half again as expensive as the typical creative is
   the point ad-operations guidance treats as "cut it"; a quarter cheaper is the
   point it treats as "put more behind it". Both are judgement calls made
   explicit rather than buried in an if. */
const WASTEFUL = 1.5;
const EFFICIENT = 0.75;

/* Below three leads a cost per lead is one or two events, not a rate — the
   difference between two leads and three moves it by a third. */
const MIN_LEADS = 3;

/* A median of two creatives is not a benchmark, it is the other creative. */
const MIN_PEERS = 3;

/* Colours match the fatigue bands so one creative does not speak in two palettes
   — the badge and the instruction agree at a glance or they are noise. */
const ACTIONS = {
  scale: {
    action: 'scale',
    label: 'Scale',
    instruction: 'Raise its budget',
    color: '#9ce0b4',
    bg: 'rgba(120,200,150,.14)',
  },
  keep: {
    action: 'keep',
    label: 'Keep running',
    instruction: 'Leave it as it is',
    color: '#a9d4ff',
    bg: 'rgba(140,180,230,.14)',
  },
  refresh: {
    action: 'refresh',
    label: 'Refresh',
    instruction: 'Queue a replacement now',
    color: '#ffcf85',
    bg: 'rgba(200,190,120,.16)',
  },
  stop: {
    action: 'stop',
    label: 'Stop',
    instruction: 'Turn it off',
    color: '#ff9a9a',
    bg: 'rgba(220,140,140,.16)',
  },
  unknown: {
    action: 'unknown',
    label: 'Not enough data',
    instruction: 'Let it run and re-check',
    color: '#c9ccd6',
    bg: 'rgba(20,22,31,.86)',
  },
};

/* Most urgent first — what the leaderboard ranks by, and the order a reader
   would want to work down. */
const ACTION_ORDER = ['stop', 'refresh', 'keep', 'scale', 'unknown'];

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/* The account's typical cost per lead, from the creatives that returned enough
   leads to have one. A creative with two leads contributes nothing to the
   benchmark it is then judged against, which is the point: the reference has to
   be steadier than the thing being referenced. */
function benchmarkCpl(rows) {
  const usable = rows
    .filter((r) => (r.leads || 0) >= MIN_LEADS && typeof r.cpl === 'number' && r.cpl > 0)
    .map((r) => r.cpl);
  return usable.length >= MIN_PEERS ? median(usable) : null;
}

/* One creative's instruction.
 *
 * `row` carries what both drivers can supply: `cpl` (cost per lead, in the same
 * unit the benchmark is in), `leads`, and `worn` — the object lib/creative-fatigue
 * returns, or null when there is not enough history to score it.
 *
 * The rules are ordered, and the first that matches decides. Order is the whole
 * design: money beats tiredness, because an ad that is not paying for itself
 * should stop whether or not it is fresh, and tiredness beats silence, because
 * a creative on the way down should be replaced before it is the one costing
 * the most.
 */
function verdict(row, benchmark) {
  const worn = row.worn || null;
  const band = worn ? worn.band : null;
  const judgeable = benchmark !== null
    && typeof row.cpl === 'number'
    && row.cpl > 0
    && (row.leads || 0) >= MIN_LEADS;

  const ratio = judgeable ? row.cpl / benchmark : null;
  const because = [];

  /* The cost half of the argument, phrased as the reader would say it. */
  if (judgeable) {
    const off = Math.round(Math.abs(ratio - 1) * 100);
    if (off >= 5) because.push(`cost per lead ${off}% ${ratio > 1 ? 'above' : 'below'} the account median`);
    else because.push('cost per lead in line with the account median');
  }

  /* The tiredness half — fatigue already wrote its own reasons, so they are
     borrowed rather than restated in a second vocabulary. */
  if (worn && worn.reasons.length) because.push(...worn.reasons);

  /* 1 — nothing to judge on. Said plainly rather than dressed as approval. */
  if (!judgeable && !worn) {
    return {
      ...ACTIONS.unknown,
      because: [
        (row.leads || 0) > 0 || row.cpl
          ? `only ${row.leads || 0} lead${row.leads === 1 ? '' : 's'} so far`
          : 'no leads yet',
        `and under ${fatigue.RECENT_DAYS + fatigue.MIN_BASELINE_DAYS} days of usable history`,
      ],
      ratio,
      benchmark,
    };
  }

  const decided = (() => {
    /* 2 — expensive *and* tiring. The two arguments agree; there is nothing
       left to wait for. */
    if (judgeable && ratio >= WASTEFUL && (band === 'replace' || band === 'act')) return ACTIONS.stop;

    /* 3 — expensive on its own. A creative half again dearer than the typical
       one is losing money whether or not it is fresh, and "it might improve" is
       what keeps them running. */
    if (judgeable && ratio >= WASTEFUL) return ACTIONS.stop;

    /* 4 — tired enough that it will keep getting worse. Refresh rather than
       stop: it is still paying its way today, and pausing it before the
       replacement exists just moves the spend somewhere unmeasured. */
    if (band === 'replace' || band === 'act') return ACTIONS.refresh;

    /* 5 — cheap and not tired. The only case where more budget is the answer. */
    if (judgeable && ratio <= EFFICIENT && (band === 'healthy' || band === 'watch')) return ACTIONS.scale;

    /* 6 — cheap, but with no fatigue reading to confirm it will hold. Worth
       more budget is a claim about tomorrow, and there is no history to make
       it, so it keeps running instead. */
    if (judgeable && ratio <= EFFICIENT) return ACTIONS.keep;

    return ACTIONS.keep;
  })();

  /* Watch-band creatives keep running, but the reader should know why the badge
     is amber when the instruction says nothing is wrong. */
  if (decided.action === 'keep' && band === 'watch' && !worn.reasons.length) {
    because.push('early fatigue signal, nothing confirmed');
  }

  return { ...decided, because, ratio, benchmark };
}

/* The whole screen at once, because the benchmark is a property of the set. A
   per-creative verdict computed in isolation would have nothing to compare cost
   against and would silently degrade to fatigue-only. */
function decide(rows) {
  const benchmark = benchmarkCpl(rows);
  return rows.map((row) => verdict(row, benchmark));
}

/* One sentence a reader can act on without opening anything. */
const sentence = (v) => (v.because.length ? `${v.instruction} — ${v.because.join(', ')}` : v.instruction);

module.exports = {
  decide,
  verdict,
  benchmarkCpl,
  sentence,
  median,
  ACTIONS,
  ACTION_ORDER,
  WASTEFUL,
  EFFICIENT,
  MIN_LEADS,
  MIN_PEERS,
};
