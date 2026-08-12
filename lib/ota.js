/* Channel production: what each OTA sold, and what it kept.
 *
 * The one question this screen exists to answer is the one a gross-revenue
 * figure cannot: **a channel's rank changes when you subtract its commission.**
 * Airbnb bills a host three per cent and Agoda twenty, so a channel that looks
 * mid-table on what the guest paid can be top on what the property banks, and a
 * mix decision made on gross is made on the wrong number.
 *
 * Lives here rather than in the template for the reason lib/connections.js's
 * `stateOf` does: a rule with a test beats a rule in an EJS partial.
 *
 * Money is in paise throughout, as canonical entities carry it — see the note
 * at the top of lib/metrics/registry.js and the bug that rule exists to
 * prevent. Nothing here divides; formatting does.
 */

const { OTA_CHANNELS } = require('./ingest/sources');

/* Which statuses count as production and which as loss.
 *
 * Deliberately two named sets rather than "confirmed or not". A reservation
 * that is neither — `pending`, or a status a channel invents next year — is
 * counted in neither total and reported separately, because silently folding an
 * unknown state into one side or the other decides revenue on a guess. The
 * canonical mapper already flags an unrecognised status as a normalisation
 * problem; this is the second half of the same refusal to assume.
 */
const CONFIRMED = new Set(['confirmed', 'modified', 'new', 'ok', 'checked_in', 'checked_out', 'stayed']);
const CANCELLED = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'rejected']);

const isConfirmed = (r) => CONFIRMED.has(String(r && r.status || ''));
const isCancelled = (r) => CANCELLED.has(String(r && r.status || ''));

/* Sums a field over rows that reported one, and returns **null when none did**.
 *
 * The distinction is the whole reason this is a function. A channel with no
 * reservations in the window has not earned zero rupees — it has not been asked
 * or has not sold, and a screen that prints ₹0 for it says something false with
 * total confidence. Nulls render as "—". */
function total(rows, field) {
  const values = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  return values.length ? values.reduce((sum, v) => sum + Number(v), 0) : null;
}

/* Division that answers "unknown" rather than a number it cannot justify —
   the same rule the metric registry's evaluator follows. */
function ratio(numerator, denominator) {
  if (numerator === null || denominator === null) return null;
  if (!denominator) return null;
  return numerator / denominator;
}

/* One channel's row.
 *
 * Cancellations are counted but their money is not. A cancelled reservation's
 * gross is a stay that did not happen, and adding it to channel revenue would
 * make a channel with a high cancellation rate look like the best performer —
 * exactly backwards. It is kept on the row as `cancelledGross` so the loss is
 * visible rather than merely absent.
 */
function rowFor(channel, reservations) {
  const mine = reservations.filter((r) => r.channel === channel.id);
  const confirmed = mine.filter(isConfirmed);
  const cancelled = mine.filter(isCancelled);
  const unclassified = mine.filter((r) => !isConfirmed(r) && !isCancelled(r));

  const gross = total(confirmed, 'gross');
  const commission = total(confirmed, 'commission');
  const net = total(confirmed, 'net');
  const roomNights = total(confirmed, 'nights');

  return {
    channel: channel.id,
    name: channel.name,
    reservations: mine.length,
    confirmed: confirmed.length,
    cancelled: cancelled.length,
    unclassified: unclassified.length,
    roomNights,
    gross,
    commission,
    net,
    cancelledGross: total(cancelled, 'gross'),
    /* Per room night, on what the guest paid — the figure a rate comparison
       between channels is normally made on. */
    adr: ratio(gross, roomNights),
    /* Effective, not contracted: what the channel actually took over the window,
       which is the only rate this app can know. A contracted rate lives in an
       agreement nothing here reads. */
    commissionRate: ratio(commission, gross),
    cancellationRate: ratio(cancelled.length, confirmed.length + cancelled.length),
    /* Whether any net on this row was worked out rather than reported. Carried
       so the screen can say so — a derived net assumes commission is the only
       deduction, which is true of these six and is still an assumption. */
    netDerived: confirmed.some((r) => r.netDerived),
  };
}

/* Every channel, in descending order of what the property banked.
 *
 * **Ranked on net, not gross**, which is the opinion this module exists to
 * hold. A channel with no reservations sorts last and keeps its nulls rather
 * than being dropped: "Airbnb sold nothing this month" and "Airbnb is not
 * connected" are different facts and the screen shows both, so neither may be
 * silently omitted here.
 */
function channels(reservations = [], { list = OTA_CHANNELS } = {}) {
  const rows = list.map((channel) => rowFor(channel, reservations || []));
  return rows.sort((a, b) => {
    if (a.net === b.net) return a.name.localeCompare(b.name);
    if (a.net === null) return 1;
    if (b.net === null) return -1;
    return b.net - a.net;
  });
}

/* The workspace total, plus the two things a total alone cannot say.
 *
 * `share` is each channel's portion of net, computed here rather than on the
 * row because a share needs the whole set — a row cannot know its own. */
function summary(reservations = [], { list = OTA_CHANNELS } = {}) {
  const rows = channels(reservations, { list });
  const all = (reservations || []);
  const confirmed = all.filter(isConfirmed);
  const cancelled = all.filter(isCancelled);

  const gross = total(confirmed, 'gross');
  const commission = total(confirmed, 'commission');
  const net = total(confirmed, 'net');
  const roomNights = total(confirmed, 'nights');

  return {
    rows: rows.map((r) => ({ ...r, share: ratio(r.net, net) })),
    totals: {
      reservations: all.length,
      confirmed: confirmed.length,
      cancelled: cancelled.length,
      unclassified: all.length - confirmed.length - cancelled.length,
      roomNights,
      gross,
      commission,
      net,
      adr: ratio(gross, roomNights),
      commissionRate: ratio(commission, gross),
      cancellationRate: ratio(cancelled.length, confirmed.length + cancelled.length),
    },
    /* Which channels reported anything at all in this window. The screen needs
       it to tell an empty row apart from an absent one, and counting it here
       keeps that judgement out of the template. */
    reporting: rows.filter((r) => r.reservations > 0).map((r) => r.channel),
  };
}

module.exports = { channels, summary, CONFIRMED, CANCELLED, isConfirmed, isCancelled, total, ratio };
