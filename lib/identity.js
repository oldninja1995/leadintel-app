/* Stage 3 — identity resolution.
 *
 * Sub-phase 5.1. The Analytics Engine page states this stage in one line:
 *
 *   join_key = coalesce(ad_id, phone_e164, utm_campaign) · confidence ≥ 0.86
 *   "Ad records joined to CRM bookings on campaign_id + ad_id, falling back to
 *    phone then UTM."
 *
 * That line compresses two joins, and reading it as one is how this gets built
 * wrong. A booking has to reach a *lead* before it can reach an *ad*: the PMS
 * knows a guest and a folio, the ad platform knows a campaign and an ad, and
 * the CRM lead is the only record that carries both. So the ladder below is
 * about how well each booking got connected, and the rung names the weakest
 * link in that chain — which is what a confidence score is for.
 *
 *   ad_id          the lead carries an ad id, so credit lands on one ad   0.98
 *   phone_e164     no CRM deal linked this booking; the guest's phone     0.92
 *                  matched a lead, so credit lands on that lead's campaign
 *   utm_campaign   only the campaign name connected them                  0.86
 *
 * 0.86 is the page's own floor, so anything that would score lower is left
 * unresolved rather than counted. An unresolved booking is revenue nobody can
 * credit, which is a fact worth surfacing — not a row to quietly drop.
 *
 * **Stated limitation.** The `ad_id` rung records that the CRM captured an ad
 * id; it does not verify that id against the ad platform's own ad record. The
 * id chain (ad -> adset -> campaign) lives in the raw payloads and stage 2's
 * mappers keep only names, dates and spend, so canonical entities cannot see
 * it today. Verifying it means carrying those ids through normalisation, which
 * is a Phase 4 change and is not smuggled in here.
 */

/* The ladder, best first. Confidences are the spacing the page implies rather
   than values it states: it gives the floor (0.86) and the shape (ad id beats
   phone beats campaign), so the rungs sit above the floor in that order. */
const LADDER = [
  { rung: 'ad_id', confidence: 0.98, why: 'the CRM captured an ad id at lead creation' },
  { rung: 'phone_e164', confidence: 0.92, why: 'matched on the guest phone in E.164' },
  { rung: 'utm_campaign', confidence: 0.86, why: 'matched on campaign name only' },
];

const THRESHOLD = 0.86;
const BY_RUNG = Object.fromEntries(LADDER.map((l) => [l.rung, l]));

/* Two phones are the same phone or they are not — normalise.js already put
   every one of them in E.164, so this is an equality test and not a fuzzy
   one. Anything looser would manufacture matches. */
const samePhone = (a, b) => Boolean(a) && Boolean(b) && a === b;

/* One booking's chain to an ad source. Returns the rung that carried it, or an
   unresolved record explaining where the chain broke — never a silent null. */
function resolveBooking(booking, { leads, campaigns }) {
  /* The CRM deal is the strongest link there is: the CRM asserted it. */
  let lead = booking.leadId ? leads.find((l) => l.id === booking.leadId) : null;
  let via = lead ? 'deal' : null;

  /* No deal link is exactly the case this stage exists for. B-1002 in the
     fixtures is a real booking with no deal row, reachable only by phone. */
  if (!lead) {
    lead = leads.find((l) => samePhone(l.phone, booking.phone)) || null;
    via = lead ? 'phone' : null;
  }

  if (!lead) {
    return {
      booking: booking.id, lead: null, campaign: null, adId: null,
      rung: null, confidence: 0, resolved: false,
      reason: 'no CRM lead carries this booking\'s reference or phone',
    };
  }

  /* The rung is the weakest link in the chain, not the strongest available
     fact: a booking found only by phone is a phone-grade match even when the
     lead it found happens to carry an ad id. */
  let rung;
  if (via === 'phone') rung = 'phone_e164';
  else if (lead.adId) rung = 'ad_id';
  else rung = 'utm_campaign';

  const campaign = lead.campaign && campaigns.has(lead.campaign) ? lead.campaign : null;
  if (!campaign) {
    return {
      booking: booking.id, lead: lead.id, campaign: null, adId: lead.adId || null,
      rung: null, confidence: 0, resolved: false,
      reason: lead.campaign
        ? `lead names campaign "${lead.campaign}", which no ad platform reported`
        : 'lead carries no campaign',
    };
  }

  const step = BY_RUNG[rung];
  return {
    booking: booking.id,
    lead: lead.id,
    campaign,
    adId: lead.adId || null,
    rung,
    confidence: step.confidence,
    resolved: step.confidence >= THRESHOLD,
    reason: step.why,
  };
}

function resolve(entities) {
  const campaigns = new Set(entities.campaignDays.map((d) => d.campaign));
  return entities.bookings.map((b) => resolveBooking(b, { leads: entities.leads, campaigns }));
}

/* The match-rate metric the page puts on its confidence bar ("97% matched · 3
   unresolved", "of bookings"). Reported as a fraction as well as a percentage
   because 1 of 2 and 97 of 100 are not the same claim, and at fixture scale
   only the fraction is honest. */
function matchRate(resolutions) {
  const total = resolutions.length;
  const matched = resolutions.filter((r) => r.resolved).length;

  const byRung = {};
  for (const step of LADDER) byRung[step.rung] = resolutions.filter((r) => r.rung === step.rung).length;

  return {
    matched,
    total,
    unresolved: total - matched,
    rate: total ? matched / total : null,
    pct: total ? `${Math.round((matched / total) * 100)}%` : '—',
    byRung,
    /* Weakest first — the reason anyone opens this is to find what broke. */
    unresolvedDetail: resolutions.filter((r) => !r.resolved).map((r) => ({ booking: r.booking, reason: r.reason })),
    threshold: THRESHOLD,
  };
}

/* Revenue that no campaign can be credited with, which is the number that
   makes an unresolved booking matter rather than being a tidy-up task. */
function unattributedRevenue(entities, resolutions) {
  const unresolved = new Set(resolutions.filter((r) => !r.resolved).map((r) => r.booking));
  return entities.bookings
    .filter((b) => unresolved.has(b.id))
    .reduce((total, b) => total + ((b.revenue && b.revenue.value) || 0), 0);
}

module.exports = { LADDER, THRESHOLD, resolve, resolveBooking, matchRate, unattributedRevenue, samePhone };
