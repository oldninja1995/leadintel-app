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

/* Anything other than 'spend' is the default order, so a mistyped query string
   is a table in the usual order rather than an error page. */
function orderAccountKeywords(list, sort) {
  const rows = [...(list || [])];
  if (String(sort) !== 'spend') return rows.sort(byName);

  const has = (k) => Boolean(k && k.measured && k.spend !== null && k.spend !== undefined);
  return rows.sort((a, b) => {
    if (has(a) !== has(b)) return has(a) ? -1 : 1;
    if (has(a) && a.spend !== b.spend) return b.spend - a.spend;
    return byName(a, b);
  });
}

module.exports = { rollUp, rate, orderAccountKeywords };
