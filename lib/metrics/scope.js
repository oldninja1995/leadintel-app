/* Evaluating the registry at a grain other than the whole workspace.
 *
 * The ceiling 6.4 hit: Campaign Analytics shows eighteen KPI cards about *one
 * campaign*, while every registry metric is a workspace-wide total. Pointing
 * those cards at `ads.spend` would print total spend on one campaign's page.
 *
 * The fix is not more definitions. One definition per KPI is the whole promise
 * of the registry, so `ads.spend` must mean the same thing at every grain and
 * the *entities* are what narrow. Because base metrics read entities and
 * derived metrics are arithmetic over base metrics, scoping the entity set
 * scopes the entire graph for free — a campaign's ROAS is its own revenue over
 * its own spend without `roas.net` knowing campaigns exist.
 *
 * The hard part is not filtering. It is that **not every metric is meaningful
 * at every grain.** Occupancy per campaign is nonsense: a property's rooms are
 * not attributable to the ad that sold one of them. Ad spend per property is
 * nonsense in the same way. So a metric that reads a collection which cannot be
 * narrowed by the requested dimension is reported as **not applicable** — not
 * as zero, and not as the workspace figure quietly reused.
 *
 * That distinction is the entire value of this file. A campaign page showing
 * the workspace occupancy figure would be wrong in a way nobody would catch.
 */

const registry = require('./registry');

/* Which dimensions each entity collection can honestly be narrowed by.
 *
 * `bookings` and `leadEvents` are reachable through the lead that produced
 * them, which is the same join stage 3 makes — so a campaign scope reaches a
 * booking only when identity resolution connected the two. */
const SCOPEABLE = {
  campaignDays: ['campaign', 'channel'],
  /* Leads gained `channel` when the CRM turned out to hold organic and referral
     leads beside the paid ones. Without it `cost.per_lead` could only be
     blended — paid spend over every lead in the CRM — which is a figure that
     improves whenever the website has a good week. */
  leads: ['campaign', 'property', 'channel'],
  /* A deal carries the channel and campaign of the lead it came from — see
     canonical.build. Scopeable by both, so "reservation value from Meta" is a
     narrowing of one definition rather than a second metric. */
  deals: ['campaign', 'channel'],
  bookings: ['campaign', 'property'],
  leadEvents: ['campaign', 'property'],
  inventoryDays: ['property'],
};

const DIMENSIONS = ['campaign', 'channel', 'property'];

/* Platform ids as the ad sources report them, mapped to the channel names a
   person uses. */
const CHANNEL = { meta_ads: 'meta', google_ads: 'google' };

/* Which collections a metric reads.
 *
 * Derived by calling each base metric's `source` with a recorder in place of
 * the entities, so a metric declares its reads simply by using them and cannot
 * drift from a hand-maintained list. A source that reads a collection only
 * inside a conditional would escape this — so `test/scope.test.js` asserts the
 * derived map against an explicit one, and that test is what makes the trick
 * safe rather than clever. */
function readsOf(metric, seen = new Set()) {
  if (seen.has(metric.id)) return new Set();
  seen.add(metric.id);

  if (metric.formula) {
    const union = new Set();
    for (const dep of metric.dependencies) {
      for (const collection of readsOf(registry.get(dep), seen)) union.add(collection);
    }
    return union;
  }

  const touched = new Set();
  const recorder = new Proxy({}, {
    get(_target, name) {
      if (typeof name === 'string') touched.add(name);
      /* Every collection is an array in the real entity set; handing back an
         empty one lets the source run to completion without throwing. */
      return [];
    },
    has() { return true; },
  });

  try {
    metric.source(recorder);
  } catch (err) {
    /* A source that cannot run against empty collections still told us what it
       reached for before it failed. */
  }
  return touched;
}

const READS = Object.fromEntries(registry.list().map((m) => [m.id, [...readsOf(m)].sort()]));

/* A metric is answerable at a grain when every collection it reads can be
   narrowed by that dimension. All of them, not any: a figure computed from one
   narrowed collection and one workspace-wide collection is a ratio between two
   different questions. */
function supports(metricId, dimension) {
  const reads = READS[metricId] || [];
  if (!reads.length) return false;
  return reads.every((collection) => (SCOPEABLE[collection] || []).includes(dimension));
}

/* ── narrowing ──────────────────────────────────────────────────────────── */

function scope(entities, dimension, value) {
  if (!DIMENSIONS.includes(dimension)) throw new Error(`unknown dimension "${dimension}"`);

  const leads = entities.leads.filter((l) => matchesLead(l, dimension, value));
  const leadIds = new Set(leads.map((l) => l.id));

  return {
    campaignDays: entities.campaignDays.filter((d) => matchesCampaignDay(d, dimension, value)),
    leads,
    /* Narrowed on the deal's own copy of the lead's channel rather than by
       joining back through `leadIds` — a deal whose lead fell outside the
       window would otherwise vanish from a channel it genuinely belongs to. */
    deals: (entities.deals || []).filter((d) => (dimension === 'channel'
      ? Boolean(d.channel) && d.channel === value
      : d.campaign === value)),
    /* A booking reaches a campaign only through its lead — the join stage 3
       makes. A booking whose lead was never resolved is genuinely outside a
       campaign's scope, not silently included. */
    bookings: entities.bookings.filter((b) => (dimension === 'property'
      ? b.property === value
      : Boolean(b.leadId) && leadIds.has(b.leadId))),
    leadEvents: (entities.leadEvents || []).filter((e) => leadIds.has(e.leadId)),
    inventoryDays: (entities.inventoryDays || []).filter((d) => (dimension === 'property' ? d.property === value : false)),
    payments: entities.payments,
    problems: entities.problems,
  };
}

function matchesLead(lead, dimension, value) {
  if (dimension === 'campaign') return lead.campaign === value;
  if (dimension === 'property') return lead.property === value;
  /* A lead the CRM did not tag matches no channel at all — deliberately. It is
     unattributed, not organic, and putting it in either bucket would move a
     cost per lead without anybody deciding to. */
  if (dimension === 'channel') return Boolean(lead.channel) && lead.channel === value;
  return false;
}

function matchesCampaignDay(day, dimension, value) {
  if (dimension === 'campaign') return day.campaign === value;
  if (dimension === 'channel') return (CHANNEL[day.platform] || day.platform) === value;
  return false;
}

/* What can be asked for. Values come from the entities themselves, so no grain
   is offered that holds nothing. */
function available(entities) {
  const campaigns = new Map();
  for (const day of entities.campaignDays) campaigns.set(day.campaign, day.label || day.campaign);

  /* Names only. An inventory row whose property id never appeared on a booking
     has no name to offer, and listing the raw id beside real names would look
     like a fourth property rather than an unresolved one. */
  const properties = new Set();
  for (const b of entities.bookings) if (b.property) properties.add(b.property);
  for (const d of entities.inventoryDays || []) if (d.property) properties.add(d.property);

  const channels = new Set(entities.campaignDays.map((d) => CHANNEL[d.platform] || d.platform));

  return {
    campaign: [...campaigns].map(([key, label]) => ({ key, label })),
    channel: [...channels].sort().map((key) => ({ key, label: key })),
    property: [...properties].sort().map((key) => ({ key, label: key })),
  };
}

module.exports = { SCOPEABLE, DIMENSIONS, CHANNEL, READS, readsOf, supports, scope, available };
