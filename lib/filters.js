/* The global filter chips, made real.
 *
 * Phase 2 left these rendering but inert, with a stated reason: filtering
 * needs a repository that can answer "revenue for Munnar only", and there was
 * no repository. Phase 3 built one. What Phase 3 did *not* build is a second
 * data snapshot per screen — the authored modules hold one set of figures, so
 * a KPI headline cannot be recomputed for a subset.
 *
 * So this filters exactly what the data can honestly answer and nothing else.
 * A chip filters a collection of rows when every row in it carries the field
 * that chip names — `leadRows` carry `property`, `campRows` carry `platform`
 * — and leaves everything else untouched. It never recomputes a total, never
 * scales a chart, and never invents a subset figure.
 *
 * The gap is then reported rather than hidden: `applyFilters` returns what it
 * filtered and what it could not, and the shell renders that as a note above
 * the screen. A filter that silently left the headline KPIs at their unfiltered
 * values while shrinking the table below would be the exact lie the original
 * decision refused to tell.
 */

/* Chip label -> the row fields that can answer it. Several names per dimension
   because the design's own row shapes disagree: a lead has `property`, a
   booking has it too, but a campaign row calls its channel `platform` while a
   creative row calls it `channel`. */
const DIMENSIONS = [
  { key: 'property', chip: 'Property', fields: ['property'] },
  { key: 'channel', chip: 'Channel', fields: ['platform', 'channel'] },
  { key: 'campaign', chip: 'Campaign', fields: ['campaign', 'camp'] },
  { key: 'room', chip: 'Room type', fields: ['room', 'roomType'] },
];

const BY_CHIP = Object.fromEntries(DIMENSIONS.map((d) => [d.chip, d]));

/* Everything that is not a paid ad platform, as one selectable channel.
 *
 * It covers two different things and says so in its label: leads whose source
 * the CRM recorded as something else — walk-in, referral, a phone call — and
 * leads it recorded no source for at all. They are lumped together because the
 * question people ask is "how much of this did we not pay for", and the honest
 * answer to that includes the ones nobody tagged.
 *
 * What it must never be called is "organic". Nothing here can tell a genuinely
 * organic lead from one whose campaign field was left blank, and a chip that
 * claimed otherwise would credit paid demand to the website — the same mistake
 * blended CPL was making before the channel split. */
const NON_AD = 'non-ad';
const NON_AD_LABEL = 'Non-ad';
const ALWAYS_OFFER_AGAINST = new Set(['meta', 'google']);

/* Chips the data cannot answer at all. `Booking window` is a derived range over
   check-in dates that no row carries as a field, so it stays inert and says so
   rather than appearing to work. */
const INERT = { 'Booking window': 'no row carries a booking window' };

const isRows = (v) => Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r === 'object' && !Array.isArray(r));

/* A collection answers a dimension only when *every* row carries one of its
   fields. Requiring all of them, not one, keeps a table where the field is
   incidental to a single row from being filtered on it. */
function fieldFor(rows, dimension) {
  return dimension.fields.find((f) => rows.every((r) => Object.prototype.hasOwnProperty.call(r, f) && r[f] != null));
}

/* Which chips this payload can actually answer, and with what values. Options
   come from the rows themselves — offering a value the data does not contain
   would be another way of implying a subset exists. */
function optionsFor(payload) {
  const found = {};
  for (const rows of Object.values(payload || {})) {
    if (!isRows(rows)) continue;
    for (const dimension of DIMENSIONS) {
      const field = fieldFor(rows, dimension);
      if (!field) continue;
      const set = (found[dimension.key] = found[dimension.key] || new Set());
      for (const row of rows) set.add(String(row[field]));
    }
  }
  const options = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]));

  /* One channel that no row carries.
   *
   * The chips are built from the values present in the rows, which is right for
   * a property or a campaign — those exist because something has one. "Not an
   * ad platform" is the opposite: it is defined by absence, so no row will ever
   * announce it and it has to be offered explicitly.
   *
   * Only offered when there is a paid channel to exclude, so a workspace with
   * no ad data does not get a chip separating its leads from nothing. */
  if (options.channel && options.channel.some((v) => ALWAYS_OFFER_AGAINST.has(String(v).toLowerCase()))) {
    if (!options.channel.some((v) => String(v).toLowerCase() === NON_AD)) options.channel.push(NON_AD_LABEL);
  }

  return options;
}

/* The active selections, read from the query string. `f_property=Munnar+Hillside`. */
function selected(query = {}) {
  const active = {};
  for (const dimension of DIMENSIONS) {
    const value = query[`f_${dimension.key}`];
    if (typeof value === 'string' && value && value !== 'All') active[dimension.key] = value;
  }
  return active;
}

/* Returns a new payload — the repository's own object is shared across
   requests through `require`, so filtering in place would leak one request's
   selection into the next. */
function applyFilters(payload, query = {}) {
  const active = selected(query);
  const options = optionsFor(payload);
  const keys = Object.keys(active);
  if (!payload || !keys.length) {
    return { payload, active, options, filtered: [], unmatched: [], dropped: 0 };
  }

  const out = { ...payload };
  const filtered = [];
  const unmatched = [];
  let dropped = 0;

  for (const [name, rows] of Object.entries(payload)) {
    if (!isRows(rows)) continue;

    let kept = rows;
    const applied = [];
    for (const key of keys) {
      const dimension = DIMENSIONS.find((d) => d.key === key);
      const field = fieldFor(kept, dimension);
      if (!field) continue;
      kept = kept.filter((r) => String(r[field]) === active[key]);
      applied.push(key);
    }

    if (!applied.length) { unmatched.push(name); continue; }
    dropped += rows.length - kept.length;
    filtered.push({ collection: name, by: applied, before: rows.length, after: kept.length });
    out[name] = kept;
  }

  return { payload: out, active, options, filtered, unmatched, dropped };
}

/* The note the shell renders. Deliberately states the limit as prominently as
   the effect: N tables narrowed, and everything else — totals, charts, the
   figures that would need a second snapshot — left alone. */
function summarise(result) {
  const { active, filtered, unmatched, dropped } = result;
  const keys = Object.keys(active);
  if (!keys.length) return null;

  return {
    chips: keys.map((k) => ({ key: k, chip: DIMENSIONS.find((d) => d.key === k).chip, value: active[k] })),
    tables: filtered.length,
    dropped,
    untouched: unmatched.length,
    /* Empty when a selection matched no row: a real answer, not a failure. */
    empty: filtered.length > 0 && filtered.every((f) => f.after === 0),
  };
}

module.exports = { DIMENSIONS, BY_CHIP, INERT, applyFilters, optionsFor, selected, summarise };
