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
    color: 'var(--signal-good)',
    bg: 'var(--signal-good-bg)',
  },
  keep: {
    action: 'keep',
    label: 'Keep running',
    instruction: 'Leave it as it is',
    color: 'var(--signal-info)',
    bg: 'var(--signal-info-bg)',
  },
  refresh: {
    action: 'refresh',
    label: 'Refresh',
    instruction: 'Queue a replacement now',
    color: 'var(--signal-warn)',
    bg: 'var(--signal-warn-bg)',
  },
  /* The verdict for a creative that is expensive but too young to be sure.
   *
   * A cost-only "Stop" used to be issued here, and it was the wrong call: a
   * creative with no fatigue reading has under a fortnight of usable history,
   * which means it is at or near Meta's learning phase, and an ad that looks
   * dear in week one routinely settles by week three. Telling someone to turn
   * that off is the mistake every media buyer is warned about.
   *
   * So the instruction says what is actually known — it is costing more than
   * the rest of the account, and there is not yet enough history to say whether
   * that is what it *is* or just where it started. */
  review: {
    action: 'review',
    label: 'Review',
    instruction: 'Check it before deciding',
    color: 'var(--signal-special)',
    bg: 'var(--signal-special-bg)',
  },
  stop: {
    action: 'stop',
    label: 'Stop',
    instruction: 'Turn it off',
    color: 'var(--signal-bad)',
    bg: 'var(--signal-bad-bg)',
  },
  unknown: {
    action: 'unknown',
    label: 'Not enough data',
    instruction: 'Let it run and re-check',
    color: 'var(--signal-none)',
    bg: 'var(--signal-none-bg)',
  },
};

/* Most urgent first — what the leaderboard ranks by, and the order a reader
   would want to work down. */
const ACTION_ORDER = ['stop', 'refresh', 'review', 'keep', 'scale', 'unknown'];

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
function benchmarkCpl(rows, minEvents = MIN_LEADS) {
  const usable = rows
    .filter((r) => (r.events != null ? r.events : r.leads || 0) >= minEvents)
    .map((r) => (r.goalValue != null ? r.goalValue : r.cpl))
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
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
function verdict(row, benchmark, goal = {}) {
  const worn = row.worn || null;
  const band = worn ? worn.band : null;

  /* Whichever measure the business is buying against — see lib/creative-goals.js.
     `cpl` remains the fallback so a caller that has not chosen keeps the old
     behaviour rather than silently judging nothing. */
  const measure = row.goalValue != null ? row.goalValue : row.cpl;
  const events = row.events != null ? row.events : (row.leads || 0);
  const minEvents = goal.minEvents || MIN_LEADS;
  const name = goal.label ? goal.label.toLowerCase() : 'cost per lead';

  const judgeable = benchmark !== null
    && typeof measure === 'number'
    && Number.isFinite(measure)
    && measure > 0
    && events >= minEvents;

  const raw = judgeable ? measure / benchmark : null;

  /* **A cost goal and a value goal are the same test read in opposite
     directions.** For CPL, above the median is bad. For ROAS, above the median
     is good. Rather than duplicate every threshold with its mirror image, a
     value goal's ratio is inverted here — so `ratio >= WASTEFUL` means "half
     again worse than typical" for both, and the rules below never have to ask
     which kind of goal they are looking at. */
  const isValue = goal.direction === 'value';
  const ratio = raw === null ? null : (isValue ? benchmark / measure : raw);

  const because = [];

  /* The efficiency half of the argument, phrased as the reader would say it —
     and in the *goal's* own direction, because "ROAS 40% above the median" and
     "ROAS 40% worse than the median" are opposite claims. */
  if (judgeable) {
    const off = Math.round(Math.abs(raw - 1) * 100);
    if (off >= 5) because.push(`${name} ${off}% ${raw > 1 ? 'above' : 'below'} the account median`);
    else because.push(`${name} in line with the account median`);
  }

  /* The tiredness half — fatigue already wrote its own reasons, so they are
     borrowed rather than restated in a second vocabulary. */
  if (worn && worn.reasons.length) because.push(...worn.reasons);

  /* 1 — nothing to judge on. Said plainly rather than dressed as approval. */
  if (!judgeable && !worn) {
    return {
      ...ACTIONS.unknown,
      because: [
        events > 0
          ? `only ${events} toward ${name} so far`
          : `nothing toward ${name} yet`,
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

    /* 3 — expensive, with enough history behind it to mean something. A
       creative half again dearer than the typical one is losing money whether
       or not it is *tiring*, and "it might improve" is what keeps them running.
       A fatigue reading exists at all only after a fortnight of usable days, so
       reaching here means the cost has had time to settle. */
    if (judgeable && ratio >= WASTEFUL && worn) return ACTIONS.stop;

    /* 3b — expensive, and too young to be sure. Under a fortnight of usable
       history there is no fatigue reading, which also means the creative is at
       or near Meta's learning phase: an ad that looks dear in its first week
       routinely settles by its third. Turning that off on cost alone is the
       mistake every media buyer is warned about, so the instruction says what
       is known and stops short of the decision. */
    if (judgeable && ratio >= WASTEFUL) return ACTIONS.review;

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

  /* A Review says "expensive" and must say why that is not yet "stop", or it
     reads as a Stop somebody lost their nerve over. */
  if (decided.action === 'review') {
    because.push(`under ${fatigue.RECENT_DAYS + fatigue.MIN_BASELINE_DAYS} days of usable history — too new to judge on cost alone`);
  }

  return { ...decided, because, ratio, benchmark };
}

/* The whole screen at once, because the benchmark is a property of the set. A
   per-creative verdict computed in isolation would have nothing to compare cost
   against and would silently degrade to fatigue-only. */
function decide(rows, goal = {}) {
  const benchmark = benchmarkCpl(rows, goal.minEvents || MIN_LEADS);
  return rows.map((row) => verdict(row, benchmark, goal));
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
