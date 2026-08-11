/* Evaluating the registry over a period.
 *
 * Sub-phase 6.4's largest honest gap. Every metric until now was computed over
 * *whatever the store holds*, with no notion of when. So a card labelled "New
 * leads today" or "Lost this month" could not resolve: pointing it at a
 * period-less metric would print an all-time figure under a period label, which
 * is wrong in exactly the quiet way that is hardest to catch.
 *
 * Like a grain, a period narrows the **entities** rather than the definitions —
 * one definition per KPI is still the promise, and `leads.count` means the same
 * thing over July as over all time. Because derived metrics are arithmetic over
 * base metrics, narrowing the entity set narrows the whole graph.
 *
 * **Which date a record belongs to is a decision, not a detail**, so every one
 * is declared here rather than assumed at the call site:
 *
 *   campaignDays   `date`        the day the spend was delivered
 *   inventoryDays  `date`        the night the room was available
 *   leads          `createdAt`   when the enquiry arrived
 *   leadEvents     `at`          when the thing happened
 *   payments       `createdAt`   when the gateway settled
 *   bookings       `checkIn`     the night stayed, **not** the day booked
 *
 * That last one is the load-bearing choice. A hotel's revenue belongs to the
 * night it was earned, which is what lets revenue sit beside occupancy and
 * RevPAR — those come from `inventoryDays`, which are per night by
 * construction. Dating a booking by when it was *made* would put July revenue
 * against August room nights and quietly break every rate metric. It also means
 * a booking made in June for an August stay counts in August, which is correct
 * for a revenue manager and surprising to anyone expecting a sales ledger.
 */

const FIELD = {
  campaignDays: 'date',
  adsetDays: 'date',
  inventoryDays: 'date',
  leads: 'createdAt',
  leadEvents: 'at',
  payments: 'createdAt',
  bookings: 'checkIn',
};

/* A calendar date and an instant compare correctly as ISO strings only if both
   are anchored the same way. Dates are whole days with no timezone — `date()`
   in stage 2 keeps them that way on purpose — so they are compared on their
   first ten characters, and instants on their full value. */
function at(record, field) {
  const value = record[field];
  if (!value) return null;
  const text = String(value);
  return text.length <= 10 ? `${text}T00:00:00.000Z` : text;
}

function inRange(stamp, from, to) {
  if (!stamp) return false;
  if (from && stamp < from) return false;
  if (to && stamp >= to) return false;
  return true;
}

/* `{ from, to }`, both ISO, `to` exclusive. Either may be null for an open end
   — "everything before August" is a real question. */
function within(entities, period) {
  if (!period || (!period.from && !period.to)) return entities;

  const out = { ...entities };
  for (const [collection, field] of Object.entries(FIELD)) {
    const rows = entities[collection];
    if (!Array.isArray(rows)) continue;
    out[collection] = rows.filter((r) => inRange(at(r, field), period.from, period.to));
  }
  if (Array.isArray(entities.creatives)) out.creatives = creativesWithin(entities.creatives, period);
  return out;
}

/* A creative is not a dated row and cannot be filtered like one.
 *
 * It is an ad plus everything measured about it, and what carries the dates is
 * its own daily `series`. Being absent from `FIELD` meant it was never narrowed
 * at all: Creative Intelligence answered the same figures under "7d" and "90d",
 * with the range control above them saying otherwise. Nothing looked broken,
 * which is what made it worth fixing — a wrong number that admits nothing is
 * worse than a missing one.
 *
 * So the series is filtered and the totals re-added from it. A creative with no
 * day inside the window reports `null` rather than 0, which is the same thing
 * an unmeasured creative reports and what `measuredCreatives` then leaves out
 * of the screen — an ad that did not run last week did not run badly.
 */
function creativesWithin(creatives, period) {
  const total = (rows, key) => {
    const values = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
  };
  /* Ratios average over the days that reported one; adding them would grow a
     rate with the length of the window. */
  const mean = (rows, key) => {
    const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };

  return creatives.map((c) => {
    const series = (c.series || []).filter((d) => inRange(d.date, period.from, period.to));
    if (series.length === (c.series || []).length) return c;

    return {
      ...c,
      series,
      days: series.length,
      spend: total(series, 'spend'),
      impressions: total(series, 'impressions'),
      clicks: total(series, 'clicks'),
      leads: total(series, 'leads'),
      videoPlays: total(series, 'videoPlays'),
      videoCompletions: total(series, 'videoCompletions'),
      frequency: mean(series, 'frequency'),
      cpm: mean(series, 'cpm'),
    };
  });
}

/* Relative windows need a reference instant, which is passed in rather than
   read from the clock — a metric layer that consulted `Date.now()` internally
   could not be reproduced, and 6.2's whole promise rests on it being pure. */
function fromLabel(label, now) {
  if (!now) throw new Error('a relative period needs a reference instant');
  const ref = new Date(now);
  if (Number.isNaN(ref.getTime())) throw new Error(`"${now}" is not a time`);

  const iso = (d) => d.toISOString();
  const minus = (ms) => iso(new Date(ref.getTime() - ms));
  const HOUR = 3600000;
  const DAY = 24 * HOUR;

  switch (label) {
    case 'all': return null;
    case 'last-24h': return { from: minus(DAY), to: iso(ref), label };
    case 'last-2h': return { from: null, to: minus(2 * HOUR), label };
    /* Calendar-anchored, not a rolling 24 hours — the chip says "Today", and a
       window that started at this time yesterday is not today. */
    case 'today': {
      const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
      return { from: iso(start), to: iso(ref), label };
    }
    case '7d': return { from: minus(7 * DAY), to: iso(ref), label };
    case '30d': return { from: minus(30 * DAY), to: iso(ref), label };
    case '90d': return { from: minus(90 * DAY), to: iso(ref), label };
    case 'this-month': {
      const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
      return { from: iso(start), to: iso(ref), label };
    }
    default: throw new Error(`unknown period "${label}"`);
  }
}

const LABELS = ['all', 'last-2h', 'last-24h', 'today', '7d', '30d', '90d', 'this-month'];

/* `last-2h` is the odd one: it selects everything *older* than two hours, for
   "untouched > 2h". Naming it here keeps the inversion out of the metric. */
const IS_OLDER_THAN = new Set(['last-2h']);

module.exports = { FIELD, within, fromLabel, LABELS, IS_OLDER_THAN, at, inRange };
