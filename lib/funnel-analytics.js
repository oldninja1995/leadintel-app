/* Full Funnel Analytics — paid ads to CRM to revenue, in one walk.
 *
 * Everything this screen decides is decided here, so the template formats and
 * nothing more, the same split OTA Analytics keeps with lib/ota.js.
 *
 * **A cohort, not a ledger.** The leads are the ones *created* in the selected
 * window, and the bookings and revenue are what those leads went on to produce,
 * whenever the deal closed. That is the only basis on which "qualified → booked
 * 12%" is a rate: dividing this month's closed deals by this month's new leads
 * divides two different groups of people. It also means revenue here will not
 * match the Executive Dashboard, which dates a deal by when it last moved — the
 * screen says so.
 *
 * **Spend is never joined.** Ad-side figures (spend, impressions, clicks,
 * platform leads) are summed from campaign days on their own, CRM-side figures
 * from leads on their own, and the two meet only as totals keyed by campaign.
 * Joining a campaign day to its leads row by row is how one campaign's spend
 * gets counted once per lead.
 *
 * **A booking is counted once.** Deals are keyed by booking reference where the
 * CRM has one, and by deal id where it does not, so two deals pointing at one
 * reservation are one booking and one revenue figure.
 *
 * **Absent is not zero.** Organic leads have no spend, impressions or clicks —
 * those stages are `null` and render as N/A, never as 0, and every ratio over a
 * missing side is null too.
 */

const registry = require('./metrics/registry');
const { QUALIFIED_STAGES } = require('./creative-goals');

const { INTERESTED, UNTOUCHED, CANCELLED } = registry;

/* The channel switch. `paid` is Meta and Google together and is the default,
   because this screen exists to judge ad money. `organic` is every lead the CRM
   did not tag to a paid platform — the same "matches by absence" rule as the
   topbar's Non-ad chip (lib/metrics/scope.js), so the two never disagree. */
const CHANNELS = [
  { id: 'paid', label: 'Paid (Meta + Google)', platforms: ['meta_ads', 'google_ads'] },
  { id: 'meta', label: 'Meta Ads', platforms: ['meta_ads'] },
  { id: 'google', label: 'Google Ads', platforms: ['google_ads'] },
  { id: 'organic', label: 'Organic', platforms: [] },
];
const PAID = new Set(['meta', 'google']);
const PLATFORM_CHANNEL = { meta_ads: 'meta', google_ads: 'google' };

const GRAINS = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
];

const channelOf = (id) => CHANNELS.find((c) => c.id === id) || CHANNELS[0];
const grainOf = (id) => GRAINS.find((g) => g.id === id) || GRAINS[0];

const tag = (lead) => String(lead.channel || '').toLowerCase().trim();

function leadInChannel(lead, channel) {
  const t = tag(lead);
  if (channel === 'organic') return !PAID.has(t);
  if (channel === 'paid') return PAID.has(t);
  return t === channel;
}

/* ── the stage ladder ──────────────────────────────────────────────────────
 *
 * Declared once, as data, because "the funnel stages must match the actual CRM
 * workflow" means a reader has to be able to see which of their statuses lands
 * where — the screen prints this mapping against every status the CRM holds.
 *
 * The rules are the registry's own (contacted, interested) and Creative
 * Intelligence's (qualified), not new ones: a lead that is "qualified" here
 * and not on the Creative screen would be two answers to one question.
 *
 * Each stage is **cumulative**: a booked lead was qualified, interested and
 * contacted, whatever its status says now. Without that the funnel could widen
 * — a lead moved straight from Fresh to Won would be booked and not contacted. */
const STAGE_RULES = [
  { key: 'contacted', label: 'Contacted', rule: 'any status other than Fresh / New / Open / Unassigned / Uncontacted' },
  { key: 'interested', label: 'Interested', rule: 'status mentions interest, hot, warm, won, converted, qualified, quoted or booked' },
  { key: 'qualified', label: 'Qualified', rule: `status is one of: ${[...QUALIFIED_STAGES].join(', ')}` },
  { key: 'booked', label: 'Booked', rule: 'has a CRM deal marked won whose booking is not cancelled' },
];

const stageOf = (lead) => String(lead.stage || '').trim();

function reach(lead, booked) {
  const s = stageOf(lead);
  const qualified = booked || QUALIFIED_STAGES.has(s.toLowerCase());
  const interested = qualified || INTERESTED.test(s);
  const contacted = interested || (s !== '' && !UNTOUCHED.test(s));
  return { contacted, interested, qualified, booked };
}

/* ── bookings, deduplicated ──────────────────────────────────────────────── */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isWon = (d) => d.outcome === 'won' && !CANCELLED.test(String(d.bookingStatus || ''));

/* Lead id → its bookings, each reservation once. A reservation two deals point
   at keeps the larger value rather than the sum — the duplicate is the CRM
   recording one stay twice, not a second stay. */
function bookingsByLead(deals) {
  const byKey = new Map();
  for (const d of deals || []) {
    if (!isWon(d) || d.leadId == null) continue;
    const key = d.bookingRef ? `ref:${d.bookingRef}` : `deal:${d.id}`;
    const seen = byKey.get(key);
    if (!seen || num(d.revenue) > num(seen.revenue)) byKey.set(key, d);
  }
  const out = new Map();
  for (const [key, d] of byKey) {
    const id = String(d.leadId);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ key, id: d.id, ref: d.bookingRef || null, revenue: num(d.revenue), at: d.updatedAt || null, stage: d.stage || null });
  }
  return out;
}

/* ── buckets ─────────────────────────────────────────────────────────────── */

/* UTC, like every other window in the app (lib/metrics/period.js). Weeks start
   on Monday. */
function bucketOf(stamp, grain) {
  if (!stamp) return null;
  const day = String(stamp).slice(0, 10);
  if (grain === 'month') return day.slice(0, 7);
  if (grain === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const back = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }
  return day;
}

/* ── the walk ────────────────────────────────────────────────────────────── */

const ratio = (a, b) => (a == null || b == null || !b ? null : a / b);

function blank() {
  return {
    spend: 0, impressions: 0, clicks: 0, platformLeads: 0,
    leads: 0, people: new Set(), contacted: 0, interested: 0, qualified: 0,
    bookedLeads: 0, bookings: 0, revenue: 0, newRevenue: 0,
  };
}

/* Folds a tally into the plain numbers the screen reads, with every ratio
   computed here once. `adSide` is false for organic, where the ad figures do
   not exist and must read as null rather than 0. */
function finish(t, adSide) {
  const spend = adSide ? t.spend : null;
  const out = {
    spend,
    impressions: adSide ? t.impressions : null,
    clicks: adSide ? t.clicks : null,
    platformLeads: adSide ? t.platformLeads : null,
    leads: t.leads,
    people: t.people.size,
    contacted: t.contacted,
    interested: t.interested,
    qualified: t.qualified,
    bookedLeads: t.bookedLeads,
    bookings: t.bookings,
    revenue: t.revenue,
    newRevenue: t.newRevenue,
  };
  out.ctr = ratio(out.clicks, out.impressions);
  out.cpc = ratio(spend, out.clicks);
  out.cpl = ratio(spend, out.leads);
  out.cpql = ratio(spend, out.qualified);
  out.cpb = ratio(spend, out.bookings);
  out.roas = ratio(out.revenue, spend);
  out.ncRoas = ratio(out.newRevenue, spend);
  out.leadToBooking = ratio(out.bookedLeads, out.leads);
  out.aov = ratio(out.revenue, out.bookings);
  return out;
}

/**
 * @param {object} input
 * @param {object[]} input.leads         leads created in the window (cohort)
 * @param {object[]} input.deals         ALL deals — joined to the cohort by leadId
 * @param {object[]} input.campaignDays  campaign days delivered in the window
 * @param {object}   opts  { channel, grain, stage, drillLimit }
 */
function analyse({ leads = [], deals = [], campaignDays = [] } = {}, opts = {}) {
  const channel = channelOf(opts.channel);
  const grain = grainOf(opts.grain);
  const adSide = channel.platforms.length > 0;
  const platforms = new Set(channel.platforms);

  const total = blank();
  const byPeriod = new Map();
  const byCampaign = new Map();
  const stageCounts = new Map();
  const drill = { contacted: [], interested: [], qualified: [], booked: [], leads: [] };
  const period = (key) => {
    if (!byPeriod.has(key)) byPeriod.set(key, blank());
    return byPeriod.get(key);
  };
  const campaign = (key, label, platform) => {
    if (!byCampaign.has(key)) byCampaign.set(key, { key, label, platforms: new Set(), t: blank(), hasAds: false });
    const row = byCampaign.get(key);
    if (platform) row.platforms.add(platform);
    return row;
  };

  /* Ad side — summed alone. */
  if (adSide) {
    for (const day of campaignDays) {
      if (!platforms.has(day.platform)) continue;
      const add = (t) => {
        t.spend += num(day.spend);
        t.impressions += num(day.impressions);
        t.clicks += num(day.clicks);
        t.platformLeads += num(day.leads);
      };
      add(total);
      const b = bucketOf(day.date, grain.id);
      if (b) add(period(b));
      const row = campaign(day.campaign || '(unnamed campaign)', day.label || day.campaign || '(unnamed campaign)', PLATFORM_CHANNEL[day.platform]);
      row.hasAds = true;
      add(row.t);
    }
  }

  /* CRM side — the cohort. */
  const booked = bookingsByLead(deals);
  for (const lead of leads) {
    if (!leadInChannel(lead, channel.id)) continue;
    const bookings = booked.get(String(lead.id)) || [];
    const r = reach(lead, bookings.length > 0);
    const revenue = bookings.reduce((s, b) => s + b.revenue, 0);
    const isNew = registry.isNewCustomer(lead);

    const add = (t) => {
      t.leads += 1;
      t.people.add(lead.customer || `lead:${lead.id}`);
      if (r.contacted) t.contacted += 1;
      if (r.interested) t.interested += 1;
      if (r.qualified) t.qualified += 1;
      if (r.booked) t.bookedLeads += 1;
      t.bookings += bookings.length;
      t.revenue += revenue;
      if (isNew) t.newRevenue += revenue;
    };
    add(total);
    const b = bucketOf(lead.createdAt, grain.id);
    if (b) add(period(b));
    const t = tag(lead);
    const key = lead.campaign || (PAID.has(t) ? '(no campaign on the lead)' : '(organic — no campaign)');
    add(campaign(key, key, PAID.has(t) ? t : 'organic').t);

    const s = stageOf(lead) || '(no status)';
    stageCounts.set(s, (stageCounts.get(s) || 0) + 1);

    const row = {
      id: lead.id, name: lead.name || null, createdAt: lead.createdAt || null,
      channel: t || null, source: lead.source || null, campaign: lead.campaign || null,
      ad: lead.adName || null, stage: stageOf(lead) || null, owner: lead.owner || null,
      repeat: lead.repeat === true, bookings: bookings.length, revenue,
    };
    drill.leads.push(row);
    for (const k of ['contacted', 'interested', 'qualified', 'booked']) if (r[k]) drill[k].push(row);
  }

  const summary = finish(total, adSide);

  /* The funnel itself. Each stage carries its count, its rate from the stage
     before, and its rate from the top of what is measured. A stage that cannot
     be measured for this channel is in the list with `n: null` so the reader
     sees it exists and why it is empty. */
  const raw = [
    { key: 'impressions', label: 'Impressions', n: summary.impressions, side: 'ads' },
    { key: 'clicks', label: 'Clicks', n: summary.clicks, side: 'ads' },
    { key: 'platformLeads', label: 'Platform leads', n: summary.platformLeads, side: 'ads', note: 'leads the ad platform reports' },
    { key: 'leads', label: 'CRM leads', n: summary.leads, side: 'crm', note: 'leads that reached TeleCRM' },
    { key: 'contacted', label: 'Contacted', n: summary.contacted, side: 'crm' },
    { key: 'interested', label: 'Interested', n: summary.interested, side: 'crm' },
    { key: 'qualified', label: 'Qualified', n: summary.qualified, side: 'crm' },
    { key: 'booked', label: 'Booked', n: summary.bookedLeads, side: 'crm', note: 'leads with a won, uncancelled deal' },
  ];
  let top = null;
  let prev = null;
  const stages = raw.map((s) => {
    const out = { ...s, fromPrev: null, fromTop: null, dropped: null, isTop: false };
    if (s.n != null) {
      if (top == null) { top = s.n; out.isTop = true; }
      out.fromTop = ratio(s.n, top);
      if (prev != null) {
        out.fromPrev = ratio(s.n, prev);
        out.dropped = prev - s.n;
      }
      prev = s.n;
    }
    return out;
  });

  const periods = [...byPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, t]) => ({ key, ...finish(t, adSide) }));

  const campaigns = [...byCampaign.values()]
    .map((c) => ({
      key: c.key,
      label: c.label,
      platforms: [...c.platforms],
      /* A campaign the CRM names but no ad platform reported in this window —
         a renamed campaign, a UTM typo, or spend outside the range. Kept and
         flagged rather than dropped, because its leads are real. */
      matched: c.hasAds,
      ...finish(c.t, adSide && c.hasAds),
    }))
    .sort((a, b) => (b.spend || 0) - (a.spend || 0) || b.leads - a.leads);

  const stageMap = [...stageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => {
      const r = reach({ stage: status === '(no status)' ? '' : status }, false);
      return { status, n, reaches: r.qualified ? 'Qualified' : r.interested ? 'Interested' : r.contacted ? 'Contacted' : 'Lead only' };
    });

  const limit = opts.drillLimit || 100;
  const drillKey = opts.stage && drill[opts.stage] ? opts.stage : null;
  const drillRows = drillKey
    ? drill[drillKey].slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    : [];

  return {
    channel, grain, adSide,
    summary, stages, periods, campaigns, stageMap,
    drill: drillKey ? { stage: drillKey, total: drillRows.length, rows: drillRows.slice(0, limit) } : null,
    matchedCampaigns: campaigns.filter((c) => c.matched && c.leads > 0).length,
    /* Only a question for paid leads: an organic lead was never going to match
       ad data, and flagging it would read as a tracking fault. */
    unmatchedLeads: adSide ? campaigns.filter((c) => !c.matched).reduce((s, c) => s + c.leads, 0) : 0,
  };
}

module.exports = { CHANNELS, GRAINS, STAGE_RULES, analyse, bucketOf, bookingsByLead, reach, leadInChannel };
