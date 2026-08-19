/* Which way a creative is going.
 *
 * Lifetime performance hides the thing that matters most: a creative that
 * averaged a fine cost per lead over a month may have spent the last week
 * collapsing, and the average will go on looking fine for another fortnight.
 * By the time a lifetime figure moves, the money is gone.
 *
 * So every creative is also read as **the last seven days against the seven
 * before them** — the same window fatigue uses, for the same reason: it is the
 * cadence ad-operations guidance is written in, and a shorter one swings on a
 * single bad day.
 *
 * **Two sources, because the funnel spans two systems.** Delivery — spend,
 * impressions, clicks, CPM — comes off the creative's own daily series from
 * Meta. Leads and interested leads come off the CRM, where each lead carries
 * the date it was created and the ad that produced it. Bookings likewise. A
 * trend built from delivery alone would miss the case this exists to catch:
 * clicks steady, interested leads gone.
 *
 * **A trend needs two comparable halves.** A creative with four days of history
 * has no previous week to compare against, and reporting it as "stable" would
 * be a confident answer about a question nobody asked. It returns null.
 */

const RECENT_DAYS = 7;

/* Below this a percentage change is noise. Ad delivery moves a few points
   day to day without meaning anything, and a dashboard that shouts about a 3%
   move trains people to ignore it when it shouts about a 40% one. */
const MATERIAL = 0.15;

/* A window needs enough underneath it to be a rate rather than an anecdote.
   Three leads in a week is not a trend in cost per lead. */
const MIN_EVENTS = 3;

const DIRECTIONS = {
  improving: { key: 'improving', label: 'Improving', marker: '📈', color: 'var(--signal-good)' },
  stable: { key: 'stable', label: 'Stable', marker: '🟢', color: 'var(--signal-info)' },
  declining: { key: 'declining', label: 'Declining', marker: '📉', color: 'var(--signal-warn)' },
  fatiguing: { key: 'fatiguing', label: 'Fatiguing', marker: '🔥', color: 'var(--signal-bad)' },
  unknown: { key: 'unknown', label: 'No trend yet', marker: '·', color: 'var(--signal-none)' },
};

const sum = (rows, field) => rows.reduce((t, r) => t + (Number(r[field]) || 0), 0);

const mean = (rows, field) => {
  const values = rows.map((r) => r[field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};

const rate = (a, b) => (
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && b > 0
    ? a / b
    : null
);

/* Proportional change, guarding the case every naive version gets wrong: a
   baseline of zero. Going from no interested leads to some is not an infinite
   improvement, it is a creative that had nothing to compare. */
const change = (recent, before) => (
  typeof recent === 'number' && typeof before === 'number' && before > 0
    ? (recent - before) / before
    : null
);

/* The two windows, in dates, from the latest day the creative reported. Anchored
   on the data rather than on the clock: a sync that has not run since Friday
   should not report Monday and Tuesday as two empty days of collapse. */
function windows(series = []) {
  const dates = (series || []).map((d) => d.date).filter(Boolean).sort();
  if (dates.length < RECENT_DAYS * 2) return null;

  const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  /* A date the source sent that JavaScript cannot parse is not a reason to
     bring the screen down. It means there is no trustworthy window, which is
     the same answer as too little history. */
  if (Number.isNaN(last.getTime())) return null;

  const at = (daysBack) => {
    const d = new Date(last);
    d.setUTCDate(d.getUTCDate() - daysBack);
    return d.toISOString().slice(0, 10);
  };

  return {
    recentFrom: at(RECENT_DAYS - 1),
    beforeFrom: at(RECENT_DAYS * 2 - 1),
    beforeTo: at(RECENT_DAYS),
    to: dates[dates.length - 1],
  };
}

const inWindow = (rows, from, to, field = 'date') => rows.filter((r) => {
  const d = String(r[field] || '').slice(0, 10);
  return d >= from && d <= to;
});

/* One measure's movement, phrased the way the reader would say it. `direction`
   says which way is good, so "cost per interested lead up 52%" reads as a
   worsening and "booking rate up 52%" reads as an improvement. */
function movement(label, recent, before, direction, format) {
  const delta = change(recent, before);
  if (delta === null) return null;

  const worse = direction === 'cost' ? delta > 0 : delta < 0;
  const size = Math.abs(delta);

  return {
    label,
    from: before,
    to: recent,
    delta,
    material: size >= MATERIAL,
    worse,
    /* "Cost per interested lead ₹620 → ₹940 (+52%)" */
    said: `${label} ${format(before)} → ${format(recent)} (${delta > 0 ? '+' : ''}${Math.round(delta * 100)}%)`,
  };
}

/* `creative` carries its own daily series; `leads` and `bookings` are the CRM
 * and PMS rows already filtered to this creative.
 */
function trend(creative, { leads = [], bookings = [], isInterested = () => false, money = String } = {}) {
  const w = windows(creative.series);
  if (!w) return { ...DIRECTIONS.unknown, movements: [], window: null };

  const recent = inWindow(creative.series || [], w.recentFrom, w.to);
  const before = inWindow(creative.series || [], w.beforeFrom, w.beforeTo);
  if (!recent.length || !before.length) return { ...DIRECTIONS.unknown, movements: [], window: null };

  const recentLeads = inWindow(leads, w.recentFrom, w.to, 'createdAt');
  const beforeLeads = inWindow(leads, w.beforeFrom, w.beforeTo, 'createdAt');
  const recentInterested = recentLeads.filter(isInterested).length;
  const beforeInterested = beforeLeads.filter(isInterested).length;

  const recentBookings = inWindow(bookings, w.recentFrom, w.to, 'checkIn').length;
  const beforeBookings = inWindow(bookings, w.beforeFrom, w.beforeTo, 'checkIn').length;

  const pctOf = (v) => `${(v * 100).toFixed(1)}%`;
  const movements = [
    /* Cost per interested lead first: it is the measure the score turns on and
       the earliest place a creative's decline shows in money terms. */
    recentInterested >= MIN_EVENTS && beforeInterested >= MIN_EVENTS
      ? movement('Cost per interested lead',
        rate(sum(recent, 'spend'), recentInterested),
        rate(sum(before, 'spend'), beforeInterested), 'cost', money)
      : null,
    recentLeads.length >= MIN_EVENTS && beforeLeads.length >= MIN_EVENTS
      ? movement('Cost per lead',
        rate(sum(recent, 'spend'), recentLeads.length),
        rate(sum(before, 'spend'), beforeLeads.length), 'cost', money)
      : null,
    recentBookings >= MIN_EVENTS && beforeBookings >= MIN_EVENTS
      ? movement('Booking rate',
        rate(recentBookings, recentLeads.length),
        rate(beforeBookings, beforeLeads.length), 'value', pctOf)
      : null,
    movement('CTR',
      rate(sum(recent, 'clicks'), sum(recent, 'impressions')),
      rate(sum(before, 'clicks'), sum(before, 'impressions')), 'value', pctOf),
    movement('CPM', mean(recent, 'cpm'), mean(before, 'cpm'), 'cost', money),
  ].filter(Boolean);

  const material = movements.filter((m) => m.material);
  const worsening = material.filter((m) => m.worse);
  const improving = material.filter((m) => !m.worse);

  /* **Fatiguing is a specific shape, not a synonym for declining.** It is the
     one where reach cost is rising *and* engagement is falling together, which
     is what an exhausted audience looks like in Meta's numbers — and it calls
     for a different action from a creative that is simply getting worse. */
  const cpm = movements.find((m) => m.label === 'CPM');
  const ctr = movements.find((m) => m.label === 'CTR');
  const exhausted = cpm && ctr && cpm.material && ctr.material && cpm.worse && ctr.worse;

  const direction = exhausted ? DIRECTIONS.fatiguing
    : worsening.length > improving.length ? DIRECTIONS.declining
      : improving.length > worsening.length ? DIRECTIONS.improving
        : DIRECTIONS.stable;

  return {
    ...direction,
    movements,
    /* The two or three that moved, for the card. A list of everything that
       stayed still is a list nobody reads. */
    said: material.length
      ? material.slice(0, 3).map((m) => m.said).join(' · ')
      : 'No material change over the last week',
    window: w,
    worsening: worsening.length,
    improving: improving.length,
  };
}

module.exports = { trend, windows, movement, DIRECTIONS, RECENT_DAYS, MATERIAL, MIN_EVENTS };
