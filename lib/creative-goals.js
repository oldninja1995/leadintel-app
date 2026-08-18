/* What "best" means, per business.
 *
 * The verdict used to weigh one thing: cost per lead. That is the right measure
 * for a lead-gen account and the wrong one for most others — a resort selling
 * rooms is judged on booking value, a repeat-heavy business on new-customer
 * ROAS, and this account on **qualified** lead CPL, because an unqualified lead
 * is a number that flatters the ad and costs the sales team an afternoon.
 *
 * So the measure is a choice, and this file is the list of choices. Each goal
 * says three things about itself:
 *
 *   direction  whether more is better. A cost goal is bad when it is high; a
 *              value goal is bad when it is low. The verdict's thresholds are
 *              the same numbers read in opposite directions, which is why they
 *              live once in lib/creative-verdict.js rather than twice here
 *   needs      which sources must be connected before it can be computed at
 *              all. Meta knows what an ad cost and how many leads it claimed;
 *              it does not know which of them were any good, and it has never
 *              heard of a booking
 *   events     the denominator's count, so "three leads is not a rate" has a
 *              meaning for every goal rather than only for CPL
 *
 * **A goal that cannot be computed says what it needs.** The alternative — a
 * screen of dashes under a control that appears to work — is the failure this
 * codebase keeps having to undo. Selecting ROAS with no PMS connected should
 * read "ROAS needs the property management system connected", not read as an
 * account that earned nothing.
 */

/* ── the join ───────────────────────────────────────────────────────────────
 *
 * Meta reports a lead against the ad that produced it, TeleCRM carries that
 * same `ad_id` on the lead it created, and the PMS booking carries the lead it
 * came from. So an ad reaches a booking through two hops, and every goal below
 * that involves revenue is only as real as those two hops:
 *
 *   creative.adId  <-  lead.adId ... lead.id  <-  booking.leadId
 *
 * This is the closed loop the Analytics Engine page specifies. It is built
 * here rather than per goal because all four revenue goals need the same walk,
 * and doing it four times would be four chances to do it differently.
 */

/* A stage at or past which a lead counts as qualified. Anything earlier is an
   enquiry that has not been assessed yet — counting it would make the cheapest
   creative the one that attracts the most people who were never going to book,
   which is the exact failure "qualified" exists to catch. */
const scoring = require('./creative-score');

const QUALIFIED_STAGES = new Set([
  'qualified', 'quoted', 'negotiation', 'booked', 'closed-won', 'won',
]);

const isQualified = (lead) => QUALIFIED_STAGES.has(String(lead.stage || '').toLowerCase().trim());

/* Whether a booking is a guest's first.
 *
 * By phone, and by check-in date rather than by booking date: a returning guest
 * is one who has *stayed* before, and two bookings made in one week for stays a
 * year apart are one new customer and one repeat. A booking with no phone is
 * left out of the new-customer split rather than assumed new — assuming would
 * inflate exactly the number this goal exists to protect. */
function firstStayByPhone(bookings) {
  const first = new Map();
  for (const b of bookings) {
    const phone = b.phone && String(b.phone).trim();
    if (!phone || !b.checkIn) continue;
    const seen = first.get(phone);
    if (!seen || String(b.checkIn) < String(seen)) first.set(phone, b.checkIn);
  }
  return first;
}

const revenueOf = (b) => {
  const r = b && b.revenue;
  const v = r && typeof r === 'object' && 'value' in r ? r.value : r;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/* Everything the goals need about one creative, walked once. */
/* Which creative a lead came from, by the strongest rung that answers.
 *
 * **`adId` where the CRM has one.** It is the platform's own claim and cannot
 * be confused with anything else.
 *
 * **The ad NAME where it does not**, which on this account is every lead:
 * TeleCRM sends `facebook_ad` ("Guest Review 11") and no ad id, so the whole
 * per-creative CRM join produced nothing and five columns on every card read
 * "—" while the tooltip said "no CRM data". It was not that the data was
 * missing; it was that the two systems named the same ad differently.
 *
 * **A name is only trusted when it resolves to exactly one creative.** Meta
 * does not enforce unique ad names, and an account that reuses "Ad 1" across
 * three campaigns would otherwise have one booking credited to three
 * creatives — the cost-per-booking on all three would be wrong and nothing
 * would say so. Ambiguous names resolve to nothing, which leaves those cards
 * exactly as they are today rather than confidently wrong.
 *
 * Matched case- and space-insensitively, because one side of this went
 * through a title-caser on the way in and the other did not.
 */
function adOfLead(entities = {}) {
  const tidy = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const byName = new Map();
  const ambiguous = new Set();
  for (const creative of entities.creatives || []) {
    const name = tidy(creative.title);
    if (!name || !creative.adId) continue;
    if (byName.has(name) && byName.get(name) !== String(creative.adId)) ambiguous.add(name);
    byName.set(name, String(creative.adId));
  }
  for (const name of ambiguous) byName.delete(name);

  const out = new Map();
  for (const lead of entities.leads || []) {
    if (lead.adId) { out.set(String(lead.id), String(lead.adId)); continue; }
    const viaName = byName.get(tidy(lead.adName));
    if (viaName) out.set(String(lead.id), viaName);
  }
  return out;
}

/* How well that join is doing, for the status endpoint. A join nobody can
   measure is a join that quietly stops working. */
function adMatch(entities = {}) {
  /* The same rule the resolver uses. It lost its backslash once and became
     /s+/ — which strips the letter s, so the diagnostic reported 'gue t
     review' and counted ambiguity and orphans against names it had mangled
     itself. The resolver was never affected; only the report was. */
  const tidy = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const creatives = entities.creatives || [];
  const leads = entities.leads || [];

  /* Which creative names are usable, and which were thrown away for being
     shared. An account that names three ads "Ad 1" loses all three, and that is
     a different problem from a CRM that sends no ad name at all — the fix for
     one is renaming ads and for the other is a lead-form mapping. */
  const seen = new Map();
  for (const c of creatives) {
    const name = tidy(c.title);
    if (!name || !c.adId) continue;
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name).add(String(c.adId));
  }
  const ambiguous = [...seen.entries()].filter(([, ids]) => ids.size > 1);

  const resolved = adOfLead(entities);
  const byAdId = leads.filter((l) => l.adId).length;

  /* Lead ad-names that match no creative on the account, most common first.
     This is the list somebody can act on: either the ad was renamed in Meta
     after the lead came in, or it is outside the window the ads pull covers. */
  const orphan = new Map();
  const known = new Set([...seen.keys()]);
  let withoutName = 0;
  for (const lead of leads) {
    if (lead.adId) continue;
    const name = tidy(lead.adName);
    if (!name) { withoutName += 1; continue; }
    if (known.has(name)) continue;
    orphan.set(name, (orphan.get(name) || 0) + 1);
  }

  const creativesMatched = new Set([...resolved.values()]).size;

  return {
    leads: leads.length,
    matched: resolved.size,
    byAdId,
    byAdName: resolved.size - byAdId,
    pct: leads.length ? `${((resolved.size / leads.length) * 100).toFixed(1)}%` : '—',
    creatives: creatives.length,
    creativesMatched,
    /* The three reasons a lead does not resolve, counted apart so the fix is
       obvious rather than a guess. */
    leadsWithNoAdName: withoutName,
    ambiguousNames: ambiguous.length,
    ambiguousExamples: ambiguous.slice(0, 5).map(([name, ids]) => `${name} (${ids.size} ads)`),
    unmatchedNames: [...orphan.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10)
      .map(([name, n]) => `${name} × ${n}`),
  };
}

function context(entities = {}) {
  const leads = entities.leads || [];
  const bookings = entities.bookings || [];

  /* Through the resolver, so a lead the CRM identified only by ad name counts
     for the creative it names — see adOfLead above. */
  const adByLead = adOfLead(entities);

  const leadsByAd = new Map();
  for (const lead of leads) {
    const ad = adByLead.get(String(lead.id));
    if (!ad) continue;
    if (!leadsByAd.has(ad)) leadsByAd.set(ad, []);
    leadsByAd.get(ad).push(lead);
  }

  const firstStay = firstStayByPhone(bookings);

  const byAd = new Map();
  const bump = (ad) => {
    if (!byAd.has(ad)) {
      byAd.set(ad, { crmLeads: 0, qualified: 0, interested: 0, bookings: 0, revenue: 0, newRevenue: 0, newBookings: 0 });
    }
    return byAd.get(ad);
  };

  for (const [ad, list] of leadsByAd) {
    const row = bump(ad);
    row.crmLeads = list.length;
    row.qualified = list.filter(isQualified).length;
    /* The denominator of the measure that carries the most weight — see
       WEIGHTS in lib/creative-score.js. */
    row.interested = list.filter(scoring.isInterested).length;
  }

  /* What a reservation IS here, and why it may come from either system.
   *
   * This walked `entities.bookings` — the PMS folio — and there is no PMS. So
   * every creative scored with `bookings: 0` and `revenue: 0`, which is not a
   * missing number but a wrong one: a creative that sells and a creative that
   * does not were given the same outcome, and ROAS carries 15-25% of the
   * composite score. Creative Intelligence was ranking on delivery alone while
   * appearing to rank on results.
   *
   * The folio still wins where it exists. The CRM's won deals stand in where it
   * does not, joined ad-wards through the lead exactly as the folio is.
   *
   * The new-guest split survives the substitution and gets BETTER from it. On a
   * folio it is inferred by comparing a phone number's earliest stay date — a
   * guess that breaks whenever a guest books under a second number. A deal
   * carries `repeat`, stamped in canonical against the whole store on a
   * 365-day horizon, which is the same question answered directly. */
  const won = (entities.deals || []).filter((d) => d.outcome === 'won'
    && !/cancel/i.test(String(d.bookingStatus || '')));

  const reservations = bookings.length
    ? bookings.map((booking) => {
      const phone = booking.phone && String(booking.phone).trim();
      return {
        leadId: booking.leadId,
        value: revenueOf(booking),
        isFirst: Boolean(phone && booking.checkIn && String(firstStay.get(phone)) === String(booking.checkIn)),
      };
    })
    /* `repeat === false`, never `!repeat`: an unstamped deal is unclassified,
       and reading it as first-time would inflate the new-guest goals with
       whatever the store could not identify. */
    : won.map((deal) => ({ leadId: deal.leadId, value: deal.revenue || 0, isFirst: deal.repeat === false }));

  for (const reservation of reservations) {
    const ad = reservation.leadId && adByLead.get(String(reservation.leadId));
    if (!ad) continue;
    const row = bump(ad);
    row.bookings += 1;
    row.revenue += reservation.value;

    if (reservation.isFirst) {
      row.newBookings += 1;
      row.newRevenue += reservation.value;
    }
  }

  /* Whether the sources behind each goal answered at all. A CRM that returned
     no leads and a CRM nobody connected look identical on a screen, and only
     one of them is the reader's problem to fix. */
  return {
    byAd,
    hasCrm: leads.length > 0,
    /* True when reservations are answerable AT ALL, from either system. It read
       the folio alone, so every booking-shaped goal declared itself unavailable
       and rendered its note while the CRM held the reservations — the screen
       said the data was missing when it was merely being read from the wrong
       place. */
    hasBookings: reservations.length > 0,
  };
}

const forAd = (ctx, adId) => (ctx.byAd && ctx.byAd.get(String(adId))) || null;

const per = (numerator, denominator) => (
  typeof numerator === 'number' && typeof denominator === 'number' && denominator > 0
    ? numerator / denominator
    : null
);

/* ── the goals ──────────────────────────────────────────────────────────── */

const GOALS = {
  /* **The default.** A resort does not buy leads, it books rooms — so "best" is
     a weighted business score rather than any single column. Its value is
     computed over the whole set at once (every component is a comparison
     against the other creatives on screen), so unlike the goals below it is
     supplied to `of` rather than derived by it. See lib/creative-score.js. */
  bestOverall: {
    key: 'bestOverall',
    label: 'Best Overall',
    describes: 'the weighted business-impact score',
    direction: 'value',
    minEvents: 0,
    composite: true,
    needs: [],
    of: (c, ctx) => {
      const s = ctx.scored && ctx.scored.get(String(c.adId));
      return { value: s ? s.score : null, events: c.leads || 0 };
    },
  },

  /* The single most important column, and 35% of Best Overall. An interested
     lead is one a human has looked at and judged real; everything before that
     is a form submission, which is the thing Meta already counts and the thing
     this score exists to stop rewarding. */
  cpil: {
    key: 'cpil',
    label: 'Cost per interested lead',
    describes: 'spend for each lead the CRM marked interested or better',
    direction: 'cost',
    minEvents: 3,
    needs: ['the CRM'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(c.spend, row.interested) : null, events: row ? row.interested : 0 };
    },
  },

  costPerBooking: {
    key: 'costPerBooking',
    label: 'Cost per booking',
    describes: 'spend for each booking the creative closed',
    direction: 'cost',
    minEvents: 1,
    needs: ['the CRM', 'the property management system'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(c.spend, row.bookings) : null, events: row ? row.bookings : 0 };
    },
  },

  interestedRate: {
    key: 'interestedRate',
    label: 'Interested lead rate',
    describes: 'share of leads the CRM marked interested or better',
    direction: 'value',
    minEvents: 3,
    needs: ['the CRM'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(row.interested, c.leads) : null, events: c.leads || 0 };
    },
  },

  bookingRate: {
    key: 'bookingRate',
    label: 'Booking rate',
    describes: 'share of leads that became bookings',
    direction: 'value',
    minEvents: 3,
    needs: ['the CRM', 'the property management system'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(row.bookings, c.leads) : null, events: c.leads || 0 };
    },
  },

  ctr: {
    key: 'ctr',
    label: 'CTR',
    describes: 'clicks for each impression',
    direction: 'value',
    minEvents: 0,
    needs: [],
    of: (c) => ({ value: per(c.clicks, c.impressions), events: c.clicks || 0 }),
  },

  holdRate: {
    key: 'holdRate',
    label: 'Hold rate',
    describes: 'share of video plays watched to the end — video only',
    direction: 'value',
    minEvents: 0,
    needs: [],
    of: (c) => ({ value: scoring.metricsFor(c, null).holdRate, events: c.impressions || 0 }),
  },

  hookRate: {
    key: 'hookRate',
    label: 'Hook rate',
    describes: 'three-second views for each impression — video only',
    direction: 'value',
    minEvents: 0,
    needs: [],
    of: (c) => ({ value: scoring.metricsFor(c, null).hookRate, events: c.impressions || 0 }),
  },

  /* Meta's own ad-level lead actions. The only goal that needs nothing beyond
     the ad platform, which is why it is the default. */
  cpl: {
    key: 'cpl',
    label: 'CPL',
    describes: 'cost per lead the ad platform reported',
    direction: 'cost',
    minEvents: 3,
    needs: [],
    of: (c) => ({ value: per(c.spend, c.leads), events: c.leads || 0 }),
  },

  /* The one this account actually buys against.
   *
   * Meta counts a lead the moment a form is submitted; it has no idea whether
   * anybody wanted it. The cheapest creative on platform-reported CPL is
   * routinely the one filling the pipeline with people who were never going to
   * book, and it takes the CRM to know the difference. */
  qcpl: {
    key: 'qcpl',
    label: 'Qualified lead CPL',
    describes: 'cost per lead the CRM marked qualified or better',
    direction: 'cost',
    minEvents: 3,
    needs: ['the CRM'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(c.spend, row.qualified) : null, events: row ? row.qualified : 0 };
    },
  },

  roas: {
    key: 'roas',
    label: 'ROAS',
    describes: 'booking revenue returned for each rupee spent',
    direction: 'value',
    minEvents: 3,
    needs: ['the CRM', 'the property management system'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(row.revenue, c.spend) : null, events: row ? row.bookings : 0 };
    },
  },

  /* New-customer ROAS. A repeat guest would very likely have come back anyway,
     so crediting their stay to the ad that happened to be running flatters
     every creative equally and tells you nothing about which one *grew* the
     business. */
  ncroas: {
    key: 'ncroas',
    label: 'New-customer ROAS',
    describes: 'revenue from first-time guests for each rupee spent',
    direction: 'value',
    minEvents: 3,
    needs: ['the CRM', 'the property management system'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row ? per(row.newRevenue, c.spend) : null, events: row ? row.newBookings : 0 };
    },
  },

  bookingValue: {
    key: 'bookingValue',
    label: 'Booking value',
    describes: 'revenue booked against the creative',
    direction: 'value',
    minEvents: 1,
    needs: ['the CRM', 'the property management system'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row && row.bookings ? row.revenue : null, events: row ? row.bookings : 0 };
    },
  },

  bookings: {
    key: 'bookings',
    label: 'Bookings',
    describes: 'bookings closed from the creative',
    direction: 'value',
    minEvents: 1,
    needs: ['the CRM', 'the property management system'],
    of: (c, ctx) => {
      const row = forAd(ctx, c.adId);
      return { value: row && row.bookings ? row.bookings : null, events: row ? row.bookings : 0 };
    },
  },
};

/* The order the menu offers them in: the composite first, then the measures
   that decide it, then the platform-level ones, then the two that need the
   fullest picture. */
const ORDER = [
  'bestOverall', 'cpil', 'costPerBooking', 'roas', 'interestedRate',
  'cpl', 'bookingRate', 'ctr', 'hookRate', 'holdRate',
  'qcpl', 'ncroas', 'bookingValue', 'bookings',
];

/* Best Overall, not CPL. The cheapest lead is not the most valuable creative,
   and defaulting to the column that says otherwise made that the first thing
   anybody saw. */
const DEFAULT = 'bestOverall';

const resolve = (key) => (GOALS[key] ? key : DEFAULT);

/* Why a goal is answering nothing, in terms of what the reader can do about it.
   Returns null when the goal is computable — a note that appears whether or not
   there is a problem is a note nobody reads. */
function unavailable(goal, ctx) {
  if (!goal.needs.length) return null;

  const missing = [];
  if (goal.needs.includes('the CRM') && !ctx.hasCrm) missing.push('the CRM');
  if (goal.needs.includes('the property management system') && !ctx.hasBookings) {
    missing.push('the property management system');
  }
  if (!missing.length) return null;

  return `${goal.label} needs ${missing.join(' and ')} connected — nothing here has answered yet. Connect at /connections.`;
}

module.exports = {
  GOALS, ORDER, DEFAULT, QUALIFIED_STAGES,
  context, resolve, unavailable, isQualified, firstStayByPhone, adOfLead, adMatch,
};
