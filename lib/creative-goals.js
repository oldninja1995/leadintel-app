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
function context(entities = {}) {
  const leads = entities.leads || [];
  const bookings = entities.bookings || [];

  const leadsByAd = new Map();
  for (const lead of leads) {
    const ad = lead.adId && String(lead.adId);
    if (!ad) continue;
    if (!leadsByAd.has(ad)) leadsByAd.set(ad, []);
    leadsByAd.get(ad).push(lead);
  }

  const adByLead = new Map();
  for (const lead of leads) if (lead.adId) adByLead.set(String(lead.id), String(lead.adId));

  const firstStay = firstStayByPhone(bookings);

  const byAd = new Map();
  const bump = (ad) => {
    if (!byAd.has(ad)) {
      byAd.set(ad, { crmLeads: 0, qualified: 0, bookings: 0, revenue: 0, newRevenue: 0, newBookings: 0 });
    }
    return byAd.get(ad);
  };

  for (const [ad, list] of leadsByAd) {
    const row = bump(ad);
    row.crmLeads = list.length;
    row.qualified = list.filter(isQualified).length;
  }

  for (const booking of bookings) {
    const ad = booking.leadId && adByLead.get(String(booking.leadId));
    if (!ad) continue;
    const row = bump(ad);
    const value = revenueOf(booking);
    row.bookings += 1;
    row.revenue += value;

    const phone = booking.phone && String(booking.phone).trim();
    const isFirst = phone && booking.checkIn && String(firstStay.get(phone)) === String(booking.checkIn);
    if (isFirst) {
      row.newBookings += 1;
      row.newRevenue += value;
    }
  }

  /* Whether the sources behind each goal answered at all. A CRM that returned
     no leads and a CRM nobody connected look identical on a screen, and only
     one of them is the reader's problem to fix. */
  return {
    byAd,
    hasCrm: leads.length > 0,
    hasBookings: bookings.length > 0,
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

const ORDER = ['cpl', 'qcpl', 'roas', 'ncroas', 'bookingValue', 'bookings'];

const DEFAULT = 'cpl';

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
  context, resolve, unavailable, isQualified, firstStayByPhone,
};
