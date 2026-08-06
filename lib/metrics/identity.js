/* Phase 5, stage 3 — "Identity resolution joins ad records to CRM records on
 * the key ladder. Confidence scored."
 *
 * The ladder is `coalesce(ad_id, phone_e164, utm_campaign)`, and the order is
 * the whole design: each rung is weaker than the one above it, so a match is
 * only as good as the best key that produced it.
 *
 *   ad_id         the platform's own click identifier, captured at lead
 *                 creation. One lead, one ad. Unambiguous.
 *   phone_e164    the guest is the same person, but the same person may have
 *                 enquired twice from different ads.
 *   utm_campaign  the lead came from this campaign, and so did four hundred
 *                 others. It attributes a lead to a campaign, never to a click.
 *
 * The confidences below are the honest reading of that: a `utm_campaign` match
 * is not a bad `ad_id` match, it is a different and much weaker claim, and
 * nothing downstream should treat the two alike. The match *rate* is exposed
 * for the same reason — an attribution figure computed over 40% of bookings
 * needs saying out loud.
 */

const RUNGS = [
  { key: 'adId', confidence: 0.98, why: 'ad click id captured at lead creation' },
  { key: 'phone', confidence: 0.90, why: 'same phone number in E.164' },
  { key: 'campaign', confidence: 0.60, why: 'same campaign, not the same click' },
];

/* Which channel a touch belongs to. Paid channels come from the ad platform
   that reported the spend; a lead with no campaign at all is direct, which is
   an assumption worth naming rather than burying — it is the residual, not a
   measurement. */
const CHANNEL = {
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
};

const DIRECT = 'Direct / booking engine';
const ORGANIC = 'Organic search';

function channelOfCampaign(campaign, campaignDays) {
  if (!campaign) return DIRECT;
  const day = campaignDays.find((c) => c.campaign === campaign);
  if (day) return CHANNEL[day.platform] || DIRECT;
  /* A campaign the CRM knows and no ad platform reported spend for is not
     paid media — a branded landing page, an organic post, a referral link. */
  return ORGANIC;
}

/* One lead against the ad-side records, on the best rung that matches. */
function resolveLead(lead, { campaignDays, ads = [] }) {
  for (const rung of RUNGS) {
    if (rung.key === 'adId' && lead.adId) {
      const ad = ads.find((a) => a.id === lead.adId);
      const campaign = ad ? ad.campaign : lead.campaign;
      return {
        leadId: lead.id,
        matched: true,
        rung: 'ad_id',
        confidence: rung.confidence,
        why: rung.why,
        campaign,
        channel: channelOfCampaign(campaign, campaignDays),
      };
    }

    if (rung.key === 'campaign' && lead.campaign) {
      const known = campaignDays.some((c) => c.campaign === lead.campaign);
      return {
        leadId: lead.id,
        matched: known,
        rung: 'utm_campaign',
        confidence: known ? rung.confidence : 0,
        why: known ? rung.why : 'campaign is not one any ad platform reported spend for',
        campaign: lead.campaign,
        channel: channelOfCampaign(lead.campaign, campaignDays),
      };
    }
  }

  return {
    leadId: lead.id,
    matched: false,
    rung: null,
    confidence: 0,
    why: 'no ad id and no campaign — the lead did not arrive from measurable media',
    campaign: null,
    channel: DIRECT,
  };
}

/* Bookings reach the ad side only through the lead the deal names, or through
   the guest's phone number if it does not. The phone rung is what recovers a
   walk-in that was originally an enquiry. */
function resolveBooking(booking, leads, leadMatches) {
  if (booking.leadId) {
    const match = leadMatches.get(booking.leadId);
    if (match) return { bookingId: booking.id, ...match, via: 'deal' };
  }

  if (booking.phone) {
    const lead = leads.find((l) => l.phone && l.phone === booking.phone);
    if (lead) {
      const match = leadMatches.get(lead.id);
      /* Two weak links in series are weaker than either — the phone rung's
         confidence caps whatever the lead's own match was worth. */
      if (match) {
        return {
          bookingId: booking.id,
          ...match,
          confidence: Math.min(match.confidence, 0.90),
          rung: `phone → ${match.rung}`,
          why: 'matched to a lead on phone number, then that lead to media',
          via: 'phone',
        };
      }
    }
  }

  return {
    bookingId: booking.id,
    leadId: booking.leadId || null,
    matched: false,
    rung: null,
    confidence: 0,
    why: 'no lead and no phone match — this booking cannot be credited to media',
    campaign: null,
    channel: DIRECT,
    via: null,
  };
}

function resolve({ leads = [], bookings = [], campaignDays = [], ads = [] }) {
  const leadMatches = new Map();
  for (const lead of leads) leadMatches.set(lead.id, resolveLead(lead, { campaignDays, ads }));

  const bookingMatches = bookings.map((b) => resolveBooking(b, leads, leadMatches));

  const matchedLeads = [...leadMatches.values()].filter((m) => m.matched);
  const matchedBookings = bookingMatches.filter((m) => m.matched);

  /* The metric the Analytics Engine asks to be "measured and exposed". Two
     rates, not one: leads and bookings fail to match for different reasons and
     a single blended figure would hide which. */
  const rate = (matched, total) => (total ? Number((matched / total).toFixed(4)) : null);

  return {
    leads: leadMatches,
    bookings: bookingMatches,
    matchRate: {
      leads: rate(matchedLeads.length, leads.length),
      bookings: rate(matchedBookings.length, bookings.length),
      leadsMatched: matchedLeads.length,
      leadsTotal: leads.length,
      bookingsMatched: matchedBookings.length,
      bookingsTotal: bookings.length,
      /* Weighted by how much each match is actually worth, which is the figure
         to quote when someone asks how good the joins are. */
      meanConfidence: matchedBookings.length
        ? Number((matchedBookings.reduce((t, m) => t + m.confidence, 0) / matchedBookings.length).toFixed(3))
        : null,
    },
  };
}

module.exports = { resolve, resolveLead, resolveBooking, channelOfCampaign, RUNGS, DIRECT, ORGANIC, CHANNEL };
