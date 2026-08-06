/* Who wins when two systems disagree.
 *
 * The six rules are in contract.js because they are a property of the sources.
 * This file is only the act of applying them, and it has one opinion of its
 * own: the losing value is kept.
 *
 * "Folio is the settled figure; CRM deal value is the expectation" is not a
 * statement that the CRM is wrong. A booking sold at ₹46,000 and settled at
 * ₹42,800 is a real fact about a discount, a downgrade or a cancelled extra,
 * and it is exactly the fact a revenue manager wants. Discarding the loser
 * would turn a visible ₹3,200 gap into an invisible one.
 */

const { PRECEDENCE } = require('./contract');

const RULES = Object.fromEntries(PRECEDENCE.map((r) => [r.field, r]));

/* candidates: [{ system, source, value, ...rest }] — in no particular order.
   Returns the winner with the others attached, or null if there are none. */
function merge(field, candidates) {
  const present = (candidates || []).filter((c) => c && c.value !== null && c.value !== undefined);
  if (!present.length) return null;

  const rule = RULES[field];
  if (!rule) throw new Error(`no precedence rule for field "${field}"`);

  const winner = present.find((c) => c.system === rule.wins);

  /* No authoritative system reported: the best available answer is still an
     answer, but it is marked, because "the PMS has not posted this folio yet"
     and "the PMS says ₹42,800" must never read the same downstream. */
  if (!winner) {
    return {
      ...present[0],
      field,
      authoritative: false,
      reason: `${rule.wins} did not report; fell back to ${present[0].system}`,
      superseded: present.slice(1).map(strip),
    };
  }

  const losers = present.filter((c) => c !== winner);
  return {
    ...winner,
    field,
    authoritative: true,
    reason: rule.note,
    superseded: losers.map(strip),
    /* A disagreement is worth surfacing on the record rather than making every
       consumer re-derive it from `superseded`. */
    disputed: losers.some((l) => l.value !== winner.value),
  };
}

const strip = ({ system, source, value, raw }) => ({ system, source, value, raw });

module.exports = { merge, RULES };
