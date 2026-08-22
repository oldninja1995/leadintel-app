/* Rolling Google's daily grains up to one row each.
 *
 * Every Google collection — ad group, ad, keyword, search term — arrives as one
 * row per entity **per day**, because that is what makes a date range able to
 * narrow it. The tables on the two Google screens ask a different question:
 * "how is this keyword doing over the range". So the days are summed here.
 *
 * It lived as a closure inside `googleAdsPayload` in server.js, which meant the
 * one piece of arithmetic behind every figure on both screens had no test of
 * its own. It has one now, and the bug in the note below is why.
 */

/* A rate with no denominator is unknown, not zero. A term with no impressions
   has no click-through rate — saying 0% would claim nobody clicked something
   nobody was shown. Shared with the payload so a rate computed for a table and
   a rate computed for the summary above it cannot disagree. */
const rate = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(2)}%` : null);

/* The measures sum across the days; the descriptions come from the **last**
 * day, and that distinction is the whole of this note.
 *
 * `shape(row)` returns what a row *says about itself* rather than what it
 * measured — a search term's excluded/none status, an ad's enabled/paused, a
 * keyword's quality score, a campaign's impression share. It used to be read
 * once, off whichever row happened to reach the map first, which is write order
 * and therefore the *oldest* day in the range. A state that had since changed
 * kept reporting the state it held a month ago.
 *
 * The Status column on the wasted-terms table is where that showed. It is the
 * one column on that screen answering "have I already dealt with this" — and
 * adding a negative keyword today left it reading "none" for the rest of the
 * range, which is the answer that keeps somebody adding it again. A stale
 * status is worse than a missing one, because it looks like an answer.
 *
 * `shape` never returns a measure, so overwriting it cannot disturb a total —
 * the two sets of fields are disjoint by construction, which is why this is an
 * `Object.assign` onto the accumulator rather than a second pass. A row with no
 * date cannot claim to be the latest: it takes the slot if it is first, and
 * yields to anything dated after it.
 *
 * `money` formats a paise figure; it is passed in rather than imported so this
 * file has no opinion about the registry.
 */
function rollUp(rows, keyOf, shape, money) {
  const by = new Map();

  for (const r of rows || []) {
    const key = keyOf(r);
    if (key === null || key === undefined) continue;

    let acc = by.get(key);
    if (!acc) {
      acc = { ...shape(r), spend: 0, impressions: 0, clicks: 0, conversions: 0, measured: false, describedAt: r.date || null };
      by.set(key, acc);
    } else if (r.date && (!acc.describedAt || r.date > acc.describedAt)) {
      Object.assign(acc, shape(r));
      acc.describedAt = r.date;
    }

    /* null is unknown, not zero — a row that reported no figure must not be
       summed as though it reported none. */
    if (r.spend !== null && r.spend !== undefined) { acc.spend += r.spend; acc.measured = true; }
    if (r.impressions !== null && r.impressions !== undefined) acc.impressions += r.impressions;
    if (r.clicks !== null && r.clicks !== undefined) acc.clicks += r.clicks;
    if (r.leads !== null && r.leads !== undefined) acc.conversions += r.leads;
  }

  return [...by.values()]
    /* `describedAt` is bookkeeping for the loop above and not something a screen
       should read: which day supplied a status is not a claim any column makes. */
    .map(({ describedAt, ...a }) => ({
      ...a,
      spendText: a.measured ? money(a.spend) : null,
      /* Cost per conversion. **Null on zero, never Infinity** — a row that spent
         money and converted nobody has no cost *per* anything, and the registry's
         own rule is that a ratio with no denominator is unknown rather than
         infinitely bad. The wasted-spend flag on the search terms table is what
         surfaces those rows; a number here would only look like a very large
         price.

         Named cost-per-conversion rather than cost-per-lead in the column,
         because Google's `conversions` counts every action the account defines —
         a booking enquiry and a phone click alike. The Conversions by action
         table is where that total is broken apart, and until a lead action is
         nominated this figure is not a cost per lead. */
      cplText: a.conversions > 0 ? money(a.spend / a.conversions) : null,
      /* Cost per click, same rule: no clicks means no cost *per* click, so it is
         unknown rather than zero or infinite. */
      cpcText: a.clicks > 0 ? money(a.spend / a.clicks) : null,
      /* The same rule once more. Carried on every rolled-up row because the
         keyword screen reads them, and computing it a second time there would be
         free to disagree. */
      ctr: rate(a.clicks, a.impressions),
      convRate: rate(a.conversions, a.clicks),
    }))
    .sort((x, y) => y.spend - x.spend);
}

/* ── ordering the account's keyword list ──────────────────────────────────
 *
 * A different list from everything above: the rollUp above returns what *delivered*
 * and ranks it by spend, while the account's criterion list is mostly rows with
 * no figures at all — 220 keywords of which six had delivery in the range is the
 * shape this is written for.
 *
 * Alphabetical is still the default, for the reason written where the list is
 * built: the question asked of a criterion list is 'is X in here, and on what
 * match type', which is answered by scanning. But that is an argument for a
 * default, not for a table with one order. Ranking by spend is how the same list
 * answers 'what is this campaign actually paying for', and with 214 dashes in it
 * there is no way to find that by scrolling.
 *
 * **A dash is not a zero and must not sort as one.** A keyword Google reported
 * nothing for did not spend nothing — it was not in the report — so the
 * unmeasured rows go after every measured one rather than mixing into the
 * bottom of the ranking as though they had been beaten. Within each group the
 * tie-break is alphabetical, so the quiet 214 keep the scannable order that is
 * the only order they have.
 */
const BY_NAME = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const byName = (a, b) => BY_NAME.compare(String(a.keyword || ''), String(b.keyword || ''));

/* What each column sorts on.
 *
 * One map for every table on the keyword screen — the account's criterion list,
 * the wasted terms, the word rollup, the measured keywords, the same keywords by
 * campaign, and the whole search-term report. They are different rows with
 * different columns, but a column named CTR means the same thing on all of them,
 * and a second implementation of that is a second chance to disagree.
 *
 * Text columns read A–Z, which is how a list is scanned. Number columns read
 * highest first, which is how a list is judged — nobody opens a keyword table to
 * find the cheapest click.
 *
 * **The ratios are computed here rather than read off the row.** The rows carry
 * them formatted — '2.50%' and '₹12' — and as text ₹9 outranks ₹814 and 2.50%
 * outranks 11.00%. A ratio with no denominator stays null: a keyword with no
 * impressions has no click-through rate, and 0% would claim nobody clicked
 * something nobody was shown.
 *
 * A measure on a row that reported nothing is null too, never zero — the rule
 * the rest of this file is written to. Rows with no value sort to the bottom in
 * **either** direction: a column of dashes at the top of an ascending table is
 * not what anybody asked to see. */
const has = (r) => r.measured !== false;
const ratio = (num, den) => (den > 0 ? num / den : null);

const VALUE = {
  /* text */
  keyword: (r) => String(r.keyword || ''),
  term: (r) => String(r.term || ''),
  word: (r) => String(r.word || ''),
  match: (r) => String(r.matchType || ''),
  /* Ad Analytics' own columns. An unnamed ad sorts by the id it is shown by,
     because responsive search ads and Performance Max assets have no name in
     the account and sorting them all under '' would pile them together. */
  ad: (r) => String(r.ad || (r.adId ? `#${r.adId}` : '')),
  adtype: (r) => String(r.adType || ''),
  campaign: (r) => String(r.campaign || ''),
  channel: (r) => String(r.channel || ''),
  /* The account's criterion list calls it `status`; a search term's is
     `termStatus` — excluded or not. Same column to a reader. */
  status: (r) => String(r.status || r.termStatus || ''),
  adgroup: (r) => String(r.adgroup || ''),

  /* counts */
  spend: (r) => (has(r) ? r.spend ?? null : null),
  impressions: (r) => (has(r) ? r.impressions ?? null : null),
  clicks: (r) => (has(r) ? r.clicks ?? null : null),
  conversions: (r) => (has(r) ? r.conversions ?? null : null),
  quality: (r) => (r.qualityScore === null || r.qualityScore === undefined ? null : Number(r.qualityScore)),
  terms: (r) => (r.terms ?? null),

  /* ratios */
  ctr: (r) => (has(r) ? ratio(r.clicks, r.impressions) : null),
  cpc: (r) => (has(r) ? ratio(r.spend, r.clicks) : null),
  cpl: (r) => (has(r) ? ratio(r.spend, r.conversions) : null),
  convrate: (r) => (has(r) ? ratio(r.conversions, r.clicks) : null),
};

const TEXT = new Set(['keyword', 'term', 'word', 'match', 'status', 'adgroup',
  'ad', 'adtype', 'campaign', 'channel']);

/* Every column a reader may sort on, named once so a header the screen draws and
   a value this file reads cannot drift apart. */
const SORT_KEYS = Object.keys(VALUE);

/* A sort is a column and a direction, and the direction is a leading '-'.
 *
 * Plain is the column's natural order — A–Z for text, highest first for a
 * number — and '-' is that turned round, which is what clicking the column
 * already in use does. Anything not in the map is the table's own default, so a
 * mistyped query string is a table in the usual order rather than an error. */
function parseSort(sort, fallback) {
  const raw = String(sort === null || sort === undefined ? '' : sort);
  const reversed = raw.startsWith('-');
  const key = reversed ? raw.slice(1) : raw;
  if (VALUE[key]) return { key, reversed };
  return { key: VALUE[fallback] ? fallback : 'keyword', reversed: false };
}

/* The label a row is known by, for breaking ties: two keywords on the same spend
   should not land in whatever order the account happened to return them. */
const labelOf = (r) => String(r.keyword || r.term || r.word || r.ad || (r.adId ? `#${r.adId}` : ''));

function orderRows(list, sort, fallback) {
  const state = sort && typeof sort === 'object' ? sort : parseSort(sort, fallback);
  const value = VALUE[state.key] || VALUE[fallback] || VALUE.keyword;
  const rows = [...(list || [])];
  const tie = (a, b) => BY_NAME.compare(labelOf(a), labelOf(b));
  const flip = state.reversed ? -1 : 1;

  if (TEXT.has(state.key)) {
    return rows.sort((a, b) => (BY_NAME.compare(value(a), value(b)) * flip) || tie(a, b));
  }

  const known = (r) => {
    const v = value(r);
    return v !== null && v !== undefined;
  };
  return rows.sort((a, b) => {
    if (known(a) !== known(b)) return known(a) ? -1 : 1;
    if (known(a) && value(a) !== value(b)) return (value(b) - value(a)) * flip;
    return tie(a, b);
  });
}

/* The account's keyword list, in the order the reader asked for. Named
   separately because its default is alphabetical where every other table's is
   spend: this one is a list of what exists, and the question asked of it is
   whether a keyword is in there. */
const orderAccountKeywords = (list, sort) => orderRows(list, sort, 'keyword');

/* ── joining the criterion list to what Google measured ───────────────────
 *
 * Two reports, and the join between them is where a figure gets attached to the
 * wrong row. `ad_group_criterion` is what the account is bidding on — one row
 * per criterion, most of them with no metrics at all — and `keyword_view` is
 * what delivered.
 *
 * **Keyed on the criterion, not on the words.** A campaign bidding the same
 * phrase on exact and on broad has two criteria and Google measures them
 * separately. Keyed on the campaign and the text alone, both rows fetched the
 * same figures: one account read '₹814' against an exact keyword and against
 * the broad keyword spelled the same way, and the campaign line above the table
 * counted it twice — "6 of 220 had delivery, costing ₹1,771" for three keywords
 * that between them cost ₹885. The ad group is in the key for the same reason:
 * the same phrase in two ad groups is two criteria with their own bids.
 *
 * A measured row carrying no match type cannot be told apart that way, so it
 * joins on campaign, ad group and text alone — kept in a second map so it can
 * only ever answer a row that found nothing stricter. Reporting a dash for a
 * keyword that did deliver is the worse half of this bug, not a fix for it.
 */
const strictKey = (r) => `${r.campaignId} | ${r.adgroupId} | ${r.keyword} | ${String(r.matchType || '').toUpperCase()}`;
const looseKey = (r) => `${r.campaignId} | ${r.adgroupId} | ${r.keyword}`;

function keywordMetricsIndex(rows) {
  const strict = new Map();
  const loose = new Map();

  for (const row of rows || []) {
    const into = row.matchType ? strict : loose;
    const key = row.matchType ? strictKey(row) : looseKey(row);
    const acc = into.get(key) || { spend: 0, impressions: 0, clicks: 0, conversions: 0, measured: false };
    /* null is unknown, not zero — the same rule the rollup above is written to,
       and what makes `measured` the difference between a dash and a figure. */
    if (row.spend !== null && row.spend !== undefined) { acc.spend += row.spend; acc.measured = true; }
    if (row.impressions !== null && row.impressions !== undefined) acc.impressions += row.impressions;
    if (row.clicks !== null && row.clicks !== undefined) acc.clicks += row.clicks;
    if (row.leads !== null && row.leads !== undefined) acc.conversions += row.leads;
    into.set(key, acc);
  }

  return { find: (row) => strict.get(strictKey(row)) || loose.get(looseKey(row)) || null };
}

module.exports = { rollUp, rate, orderRows, orderAccountKeywords, parseSort, keywordMetricsIndex, SORT_KEYS };
