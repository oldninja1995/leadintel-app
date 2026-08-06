/* Stage 2 — "Currency, timezone, casing, phone to E.164, campaign-name cleanup
 * rules applied."
 *
 * Five rules, no more. Every one is a pure function returning the normalised
 * value beside the raw one, because a normaliser that discards its input makes
 * every later disagreement unarguable — when the PMS and the CRM differ on a
 * figure, the first question is always what each of them actually sent.
 *
 * Each returns { value, raw } and never throws: a value it cannot make sense of
 * comes back as { value: null, raw, problem } and stays visible. Dropping a bad
 * record silently is how a source ends up 3% short and nobody knows why.
 */

/* ── Currency ─────────────────────────────────────────────────────────────
   Everything becomes an integer count of the currency's minor unit — paise for
   INR. Integers because money in floats accumulates error across a million
   rows, and the gateway already reports paise, so this is also the unit that
   needs no conversion at the one place accuracy is legally interesting.

   The formats that actually turn up: a bare number of rupees, a grouped string
   with a symbol, Indian digit grouping (₹1,23,456 — the first group is three
   digits and the rest are two), lakh and crore shorthand, and Google's micros. */

const MINOR_UNITS = { INR: 100, USD: 100, AED: 100 };
const SCALE = { l: 100000, lakh: 100000, lac: 100000, cr: 10000000, crore: 10000000, k: 1000 };

function money(input, currency = 'INR', { unit = 'major' } = {}) {
  const raw = input;
  const minor = MINOR_UNITS[currency];
  if (minor === undefined) return { value: null, raw, problem: `unknown currency ${currency}` };

  if (input === null || input === undefined || input === '') return { value: null, raw, problem: 'empty' };

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { value: null, raw, problem: 'not a finite number' };
    if (unit === 'micros') return { value: Math.round((input / 1e6) * minor), raw, currency };
    if (unit === 'minor') return { value: Math.round(input), raw, currency };
    return { value: Math.round(input * minor), raw, currency };
  }

  if (typeof input !== 'string') return { value: null, raw, problem: `cannot read ${typeof input} as money` };

  const text = input.trim().replace(/[₹$,\s]/g, '');
  const match = /^(-?\d+(?:\.\d+)?)(l|lakh|lac|cr|crore|k)?$/i.exec(text);
  if (!match) return { value: null, raw, problem: 'unrecognised money format' };

  const amount = Number(match[1]) * (match[2] ? SCALE[match[2].toLowerCase()] : 1);
  if (unit === 'micros') return { value: Math.round((amount / 1e6) * minor), raw, currency };
  if (unit === 'minor') return { value: Math.round(amount), raw, currency };
  return { value: Math.round(amount * minor), raw, currency };
}

/* ── Timezone ─────────────────────────────────────────────────────────────
   Everything becomes UTC ISO-8601. Sources that stamp local time without an
   offset are the reason `assume` exists: the PMS and the CRM are both on IST,
   and reading their timestamps as UTC would move every one of them back five
   and a half hours — enough to land a late-evening lead on the previous day
   and quietly wreck any daily figure. */

const OFFSETS = { 'Asia/Kolkata': '+05:30', UTC: '+00:00' };

function timestamp(input, { assume = 'Asia/Kolkata' } = {}) {
  const raw = input;
  if (!input) return { value: null, raw, problem: 'empty' };
  if (typeof input !== 'string') return { value: null, raw, problem: `cannot read ${typeof input} as a time` };

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(input.trim());
  const offset = OFFSETS[assume];
  if (!hasZone && !offset) return { value: null, raw, problem: `unknown timezone ${assume}` };

  /* A date with no time is a whole local day, and its start is the only
     defensible instant to pin it to. */
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input.trim());
  const text = hasZone ? input.trim() : `${input.trim()}${dateOnly ? 'T00:00:00' : ''}${offset}`;

  const t = Date.parse(text);
  if (Number.isNaN(t)) return { value: null, raw, problem: 'unparseable timestamp' };
  return { value: new Date(t).toISOString(), raw };
}

/* A calendar date is not an instant, and must not be treated as one.
   A day of ad spend, a night of inventory, a check-in — each is a whole day in
   the source's own timezone. Converting one to UTC gives 2026-07-14 in IST an
   instant of 2026-07-13T18:30Z, and reading a date back off that instant moves
   the whole day backwards. Every daily figure in the product would be a day
   out, and the error is invisible because the number is still plausible.
   So a date stays a date, and only instants get a timezone. */

function date(input) {
  const raw = input;
  if (!input) return { value: null, raw, problem: 'empty' };
  const text = String(input).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return { value: null, raw, problem: 'not a calendar date' };

  const [, y, m, d] = match;
  const asDate = new Date(Date.UTC(+y, +m - 1, +d));
  if (asDate.getUTCMonth() !== +m - 1 || asDate.getUTCDate() !== +d) {
    return { value: null, raw, problem: 'not a real date' };
  }
  return { value: `${y}-${m}-${d}`, raw };
}

/* ── Casing ───────────────────────────────────────────────────────────────
   Collapse the whitespace, and title-case only what arrived shouting or
   whispering. A name already mixed-case was typed deliberately — "George
   Kurien" and "d'Souza" and "MG Road" all survive, and only "ANJALI MENON"
   and "rahul nair" get touched. */

function text(input) {
  const raw = input;
  if (input === null || input === undefined) return { value: null, raw, problem: 'empty' };
  const collapsed = String(input).replace(/\s+/g, ' ').trim();
  if (!collapsed) return { value: '', raw };

  const uniform = collapsed === collapsed.toUpperCase() || collapsed === collapsed.toLowerCase();
  if (!uniform) return { value: collapsed, raw };

  const value = collapsed
    .toLowerCase()
    .replace(/(^|[\s\-'’(])([a-z])/g, (_, before, letter) => before + letter.toUpperCase());
  return { value, raw };
}

/* ── Phone to E.164 ───────────────────────────────────────────────────────
   India only, because that is the only country these properties book from and
   a general implementation would be a library, not a rule. Handles the four
   shapes a CRM accumulates: +91 prefixed, 0091 prefixed, a leading trunk 0,
   and a bare ten-digit number. Indian mobiles start 6–9, which is what makes a
   ten-digit string unambiguous. */

function phone(input, { country = 'IN' } = {}) {
  const raw = input;
  if (!input) return { value: null, raw, problem: 'empty' };
  if (country !== 'IN') return { value: null, raw, problem: `no rule for country ${country}` };

  let digits = String(input).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);

  if (!/^[6-9]\d{9}$/.test(digits)) return { value: null, raw, problem: 'not an Indian mobile number' };
  return { value: `+91${digits}`, raw };
}

/* ── Campaign-name cleanup ────────────────────────────────────────────────
   The join between ad spend and CRM revenue is a campaign name typed by hand
   in two systems, so the same campaign arrives as "  meta | Munnar Honeymoon —
   JUL  ", "meta | munnar honeymoon — jul" and "Meta|Munnar Honeymoon|Jul".
   Producing one key from all three is the entire point; Phase 5 cannot match
   what stage 2 leaves looking different.

   `key` is for matching — lowercase, punctuation folded to single spaces, a
   leading platform token dropped. `label` is for reading. Deliberately not
   dropping a trailing period token: "Jul" is part of the campaign's identity,
   and two months of the same campaign are two campaigns to a marketer. */

const PLATFORM_TOKENS = new Set(['meta', 'fb', 'facebook', 'ig', 'instagram', 'google', 'gads', 'adwords', 'yt', 'youtube']);

function campaignName(input) {
  const raw = input;
  if (!input) return { value: null, raw, problem: 'empty' };

  const parts = String(input)
    .replace(/[|/·—–]+/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  while (parts.length > 1 && PLATFORM_TOKENS.has(parts[0].toLowerCase().replace(/[^a-z]/g, ''))) {
    parts.shift();
  }
  if (!parts.length) return { value: null, raw, problem: 'nothing left after cleanup' };

  /* Cased token by token rather than as a phrase. "Munnar Honeymoon — JUL" is
     mixed case overall, so casing it as a whole would leave the JUL shouting
     while the same campaign spelled in lowercase came back tidy — one campaign
     with two labels, decided by whichever record arrived first. */
  const label = parts.map((p) => text(p).value).join(' ');
  return { value: parts.join(' ').toLowerCase(), raw, label };
}

module.exports = { money, timestamp, date, text, phone, campaignName, MINOR_UNITS };
