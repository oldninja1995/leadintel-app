/* Report schedules — the half of "acts without being opened" that is a clock.
 *
 * Phase 8. The design lists five schedules with their cadence, recipient and
 * channels; those are reproduced below with the human string kept beside a
 * structured cadence, because "Mondays 08:00 IST" is what a person reads and
 * `{ every: 'week', weekday: 1, hour: 8 }` is what a scheduler can act on.
 * Parsing the prose at runtime would put a fragile regex between the design and
 * whether a report goes out.
 *
 * **Due-ness is computed from the last run, not from a timer.** The same
 * reasoning as the 4.5 sync runner: a process that was down over Monday
 * morning should send the Monday report when it comes back, not skip it
 * because the moment passed. So a schedule is due when its next occurrence
 * after the last run has arrived.
 *
 * Everything here is IST, because every cadence in the design is. That is
 * stated rather than assumed — a scheduler that silently ran on the server's
 * timezone would send the "07:30 daily digest" at whatever 07:30 meant to the
 * machine.
 */

const IST_OFFSET_MINUTES = 330;

/* Verbatim from the design's schedule table, with the cadence made explicit. */
const SCHEDULES = [
  {
    id: 'owner-weekly',
    name: 'Owner weekly',
    freq: 'Mondays 08:00 IST',
    cadence: { every: 'week', weekday: 1, hour: 8, minute: 0 },
    to: ['Anand P'],
    channels: ['email', 'whatsapp'],
    status: 'active',
    metrics: ['revenue.net', 'roas.net', 'bookings.confirmed', 'occupancy.rate'],
  },
  {
    id: 'gm-daily-digest',
    name: 'GM daily digest',
    freq: 'Daily 07:30 IST',
    cadence: { every: 'day', hour: 7, minute: 30 },
    to: ['3 GMs'],
    channels: ['email'],
    status: 'active',
    metrics: ['revenue.net', 'occupancy.rate', 'rate.adr', 'bookings.confirmed'],
  },
  {
    id: 'marketing-performance',
    name: 'Marketing performance',
    freq: 'Fridays 17:00 IST',
    cadence: { every: 'week', weekday: 5, hour: 17, minute: 0 },
    to: ['Marketing Director'],
    channels: ['email', 'slack'],
    status: 'active',
    metrics: ['ads.spend', 'roas.net', 'cost.per_lead', 'ads.ctr'],
  },
  {
    id: 'reservations-pace',
    name: 'Reservations pace',
    freq: 'Daily 09:00 IST',
    cadence: { every: 'day', hour: 9, minute: 0 },
    to: ['Reservations Manager'],
    channels: ['email'],
    /* Paused in the design, and paused here — a schedule the product decided
       to run because it could would be the product overriding a person. */
    status: 'paused',
    metrics: ['bookings.confirmed', 'cancellation.rate', 'occupancy.rate'],
  },
  {
    id: 'month-end-board-pack',
    name: 'Month-end board pack',
    freq: 'Last day, 18:00 IST',
    cadence: { every: 'month', day: 'last', hour: 18, minute: 0 },
    to: ['Owner', 'GMs'],
    channels: ['email'],
    status: 'active',
    metrics: ['revenue.net', 'roas.net', 'bookings.confirmed', 'occupancy.rate', 'rate.revpar', 'cancellation.rate'],
  },
];

const BY_ID = Object.fromEntries(SCHEDULES.map((s) => [s.id, s]));

/* ── time, in IST ───────────────────────────────────────────────────────── */

const toIst = (date) => new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
const fromIst = (date) => new Date(date.getTime() - IST_OFFSET_MINUTES * 60000);

/* The first occurrence of a cadence strictly after `after`. Computed by walking
   forward from the day of `after` rather than by arithmetic on intervals, so a
   month boundary or a "last day of the month" needs no special case beyond
   asking the calendar. */
function nextAfter(cadence, after) {
  const start = toIst(new Date(after));
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));

  for (let i = 0; i <= 400; i += 1) {
    const day = new Date(cursor.getTime() + i * 86400000);
    if (!matchesDay(cadence, day)) continue;

    const at = new Date(day.getTime() + (cadence.hour * 60 + (cadence.minute || 0)) * 60000);
    const utc = fromIst(at);
    if (utc.getTime() > new Date(after).getTime()) return utc.toISOString();
  }
  return null;
}

function matchesDay(cadence, day) {
  if (cadence.every === 'day') return true;
  if (cadence.every === 'week') return day.getUTCDay() === cadence.weekday;
  if (cadence.every === 'month') {
    if (cadence.day === 'last') {
      const tomorrow = new Date(day.getTime() + 86400000);
      return tomorrow.getUTCMonth() !== day.getUTCMonth();
    }
    return day.getUTCDate() === cadence.day;
  }
  return false;
}

/* ── due-ness ───────────────────────────────────────────────────────────── */

/* `lastRunAt` is the schedule's own last dispatch. Without one the schedule has
   never run, and its next occurrence is measured from now — a brand-new
   schedule does not immediately fire for every Monday since the epoch. */
function nextRun(schedule, { lastRunAt = null, now }) {
  if (!now) throw new Error('nextRun needs the current time');
  if (schedule.status !== 'active') return null;
  return nextAfter(schedule.cadence, lastRunAt || now);
}

function isDue(schedule, { lastRunAt = null, now }) {
  if (schedule.status !== 'active') return false;
  if (!lastRunAt) return false;
  const next = nextAfter(schedule.cadence, lastRunAt);
  return Boolean(next) && next <= now;
}

/* Which schedules should run, given when each last did. Paused schedules are
   reported as such rather than omitted, so a silent schedule can be told apart
   from a paused one. */
function due(lastRuns = {}, now) {
  return SCHEDULES.map((schedule) => ({
    schedule: schedule.id,
    name: schedule.name,
    status: schedule.status,
    freq: schedule.freq,
    lastRunAt: lastRuns[schedule.id] || null,
    nextRunAt: nextRun(schedule, { lastRunAt: lastRuns[schedule.id] || null, now }),
    due: isDue(schedule, { lastRunAt: lastRuns[schedule.id] || null, now }),
  }));
}

const list = () => SCHEDULES.slice();
const get = (id) => BY_ID[id] || null;

module.exports = { SCHEDULES, list, get, due, isDue, nextRun, nextAfter, IST_OFFSET_MINUTES };
