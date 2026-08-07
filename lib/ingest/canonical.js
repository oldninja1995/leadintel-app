/* Raw payloads in, canonical entities out.
 *
 * Two steps, kept apart because they fail differently. `normaliseRecord` turns
 * one payload into typed fields — a per-source concern, and the only place in
 * the codebase that knows Google reports micros and the PMS stamps IST.
 * `build` groups normalised records into the four things the product actually
 * talks about and resolves any disagreement between them.
 *
 *   campaignDay   one campaign, one day, from either ad platform
 *   lead          one enquiry, from the CRM
 *   booking       one reservation — PMS, CRM and gateway all have a view
 *   payment       one settlement, from the gateway
 *
 * Only `booking` is contested, so it is the only entity that goes through the
 * precedence rules. The others have exactly one authoritative source and
 * pretending otherwise would be ceremony.
 */

const n = require('./normalise');
const sources = require('./sources');
const { merge } = require('./precedence');

/* ── Per-source, per-kind normalisation ─────────────────────────────────── */

/* Instants go through `timestamp`, which assumes IST when a source stamps
   local time without an offset. Whole-day facts go through `date` and keep
   their calendar date untouched — see the note in normalise.js for why the
   two must not be confused. */

/* Reads the first spelling of a field that is actually present, flat or
   nested. The vendors disagree and the raw store keeps whichever arrived. */
function g(body, ...paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), body);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const googleDay = (b) => g(b, 'date', 'segments.date');
const googleCost = (b) => g(b, 'cost_micros', 'metrics.costMicros');
const googleCurrency = (b) => g(b, 'currency', 'customer.currencyCode');

/* Google returns counts as strings under `metrics`. `null` rather than 0 when
   absent, for the reason stated on metaLeads: a row that did not report a
   figure is not a row reporting none. */
function metric(b, name) {
  const raw = g(b, name, `metrics.${name}`);
  if (raw === undefined) return { value: null, raw: null };
  const value = Number(raw);
  return { value: Number.isFinite(value) ? value : null, raw };
}

const metaDay = (b) => b.date ?? b.date_start;
const metaCurrency = (b) => b.currency ?? b.account_currency;

/* Meta reports conversions as a list of typed actions rather than a column, so
   a lead count has to be picked out of it. `lead` is the on-platform lead form;
   the offsite pixel variants are counted too, because an account using one and
   an account using the other are both generating leads and a metric that saw
   only the first would read zero for half of them.
   `null` rather than 0 when the field is absent entirely: a row that was never
   asked for its actions did not report no leads, it reported nothing — and
   carrying a zero would turn "don't know" into "it's nothing". */
const LEAD_ACTIONS = new Set([
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);

function metaLeads(b) {
  if (b.leads !== undefined && b.leads !== null) return { value: b.leads, raw: b.leads };
  if (!Array.isArray(b.actions)) return { value: null, raw: b.actions ?? null };

  const matched = b.actions.filter((a) => a && LEAD_ACTIONS.has(a.action_type));
  if (!matched.length) return { value: 0, raw: b.actions };

  /* Meta returns action values as strings. */
  const total = matched.reduce((sum, a) => sum + (Number(a.value) || 0), 0);
  return { value: total, raw: b.actions };
}

const MAPPERS = {
  /* Meta's live payloads and the fixtures spell three things differently, and
     both spellings reach here because stage 1 stores what the source sent:

       day       `date_start` live, `date` in fixtures
       currency  `account_currency` live, `currency` in fixtures
       leads     inside `actions[]` live, a plain `leads` count in fixtures

     Read here rather than reconciled in the connector, which is where this
     codebase has always put interpretation. */
  meta_ads: {
    campaign_day: (b) => ({
      campaign: n.campaignName(b.campaign_name),
      date: n.date(metaDay(b)),
      spend: n.money(b.spend, metaCurrency(b)),
      impressions: { value: b.impressions ?? null, raw: b.impressions },
      clicks: { value: b.clicks ?? null, raw: b.clicks },
      leads: metaLeads(b),
    }),
    adset_day: (b) => ({
      adset: n.text(b.adset_name),
      date: n.date(metaDay(b)),
      spend: n.money(b.spend, metaCurrency(b)),
    }),
    /* Impressions and clicks are carried at ad level too, because that is the
       grain the Creative Intelligence screen measures a creative at — a
       click-through rate averaged up to the campaign says nothing about which
       ad earned it. */
    ad_day: (b) => ({
      ad: n.text(b.ad_name),
      date: n.date(metaDay(b)),
      spend: n.money(b.spend, metaCurrency(b)),
      impressions: { value: b.impressions ?? null, raw: b.impressions },
      clicks: { value: b.clicks ?? null, raw: b.clicks },
      leads: metaLeads(b),
    }),
    /* From the ads edge: the ad's identity plus the id of the creative it runs.
       `updated_at` is not among the fields requested, so it comes back as a
       stated problem rather than a fabricated timestamp. */
    creative: (b) => ({
      title: n.text(b.title ?? b.name),
      /* Absent is not malformed. A field the request did not ask for must not
         raise a normalisation problem — that channel is for values that arrived
         and could not be read, and filling it with "you didn't fetch this"
         would drown the ones that matter. */
      status: b.status === undefined ? { value: null, raw: null } : n.text(b.status),
      creativeId: { value: (b.creative && b.creative.id) || b.creative_id || null, raw: b.creative ?? null },
      campaignId: { value: b.campaign_id ?? null, raw: b.campaign_id ?? null },
      /* Kept raw. A thumbnail URL is a signed, expiring address rather than a
         value to normalise, and rewriting it in any way would break it. */
      thumbnailUrl: {
        value: (b.creative && b.creative.thumbnail_url) || b.thumbnail_url || null,
        raw: (b.creative && b.creative.thumbnail_url) || null,
      },
      objectType: {
        value: (b.creative && b.creative.object_type) || b.object_type || b.type || null,
        raw: (b.creative && b.creative.object_type) || null,
      },
      updatedAt: n.timestamp(b.updated_at),
    }),
  },

  /* Google's REST reporting nests its fields and renames them to
     lowerCamelCase — `metrics.costMicros`, `segments.date`,
     `customer.currencyCode` — while the fixtures are flat snake_case. Both
     arrive, for the same reason Meta's two spellings do, and both are read
     here rather than flattened in the connector. */
  google_ads: {
    /* Google reports cost in micros of the account currency — the one unit
       difference between the two ad platforms, and the reason `money` takes a
       unit rather than assuming rupees. */
    campaign_day: (b) => ({
      campaign: n.campaignName(g(b, 'campaign_name', 'campaign.name')),
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
      impressions: metric(b, 'impressions'),
      clicks: metric(b, 'clicks'),
      leads: metric(b, 'conversions'),
    }),
    adgroup_day: (b) => ({
      adgroup: n.text(g(b, 'adgroup_name', 'ad_group.name')),
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
    }),
    keyword_day: (b) => ({
      keyword: n.text(g(b, 'keyword', 'ad_group_criterion.keyword.text')),
      date: n.date(googleDay(b)),
      spend: n.money(googleCost(b), googleCurrency(b), { unit: 'micros' }),
    }),
  },

  telecrm: {
    lead: (b) => ({
      name: n.text(b.name),
      phone: n.phone(b.phone),
      email: n.text(b.email),
      createdAt: n.timestamp(b.created_at),
      stage: n.text(b.stage),
      owner: n.text(b.owner),
      campaign: n.campaignName(b.utm_campaign),
      adId: { value: b.ad_id ?? null, raw: b.ad_id },
      property: n.text(b.property),
    }),
    lead_event: (b) => ({
      leadId: { value: b.lead_id, raw: b.lead_id },
      /* An event type is a machine token, not prose. `n.text` title-cases —
         correct for a guest's name, wrong here, because it turns
         `first_response` into `First_response` and every downstream comparison
         then has to know the normaliser mangled it. Raw passthrough, the same
         as the ids beside it. */
      type: { value: b.type, raw: b.type },
      at: n.timestamp(b.at),
    }),
    deal: (b) => ({
      leadId: { value: b.lead_id, raw: b.lead_id },
      bookingRef: { value: b.booking_ref ?? null, raw: b.booking_ref },
      revenue: n.money(b.value, b.currency),
      stage: n.text(b.stage),
      updatedAt: n.timestamp(b.updated_at),
    }),
  },

  pms: {
    booking: (b) => ({
      guest: n.text(b.guest_name),
      phone: n.phone(b.guest_phone),
      property: n.text(b.property),
      roomType: n.text(b.room_type),
      checkIn: n.date(b.check_in),
      checkOut: n.date(b.check_out),
      bookingStatus: n.text(b.status),
      nights: { value: b.nights ?? null, raw: b.nights },
      updatedAt: n.timestamp(b.updated_at),
    }),
    folio: (b) => ({
      bookingId: { value: b.booking_id, raw: b.booking_id },
      revenue: n.money(b.total, b.currency),
      roomRevenue: n.money(b.room_revenue, b.currency),
      commission: n.money(b.commission, b.currency),
      closedAt: n.timestamp(b.closed_at),
    }),
    inventory_day: (b) => ({
      date: n.date(b.date),
      available: { value: b.rooms_available ?? null, raw: b.rooms_available },
      sold: { value: b.rooms_sold ?? null, raw: b.rooms_sold },
    }),
  },

  razorpay: {
    /* The gateway already reports paise, which is the unit everything else is
       converted into — so this is the one money field that needs no scaling. */
    payment: (b) => ({
      bookingRef: { value: b.booking_ref ?? null, raw: b.booking_ref },
      payment: n.money(b.amount, b.currency, { unit: 'minor' }),
      status: n.text(b.status),
      method: n.text(b.method),
      phone: n.phone(b.contact),
      createdAt: n.timestamp(b.created_at),
    }),
    refund: (b) => ({
      paymentId: { value: b.payment_id, raw: b.payment_id },
      bookingRef: { value: b.booking_ref ?? null, raw: b.booking_ref },
      payment: n.money(-b.amount, b.currency, { unit: 'minor' }),
      status: n.text(b.status),
      reason: n.text(b.reason),
      createdAt: n.timestamp(b.created_at),
    }),
  },
};

function normaliseRecord(record) {
  const mapper = MAPPERS[record.source] && MAPPERS[record.source][record.kind];
  if (!mapper) return null;
  const source = sources.get(record.source);
  return {
    source: record.source,
    system: source.system,
    kind: record.kind,
    externalId: record.externalId,
    fields: mapper(record.body),
    raw: record.body,
  };
}

/* Any field a normaliser could not read. Collected rather than thrown so one
   bad row does not stop a sync, and counted so a source degrading is visible
   rather than merely survivable. */
function problems(normalised) {
  const found = [];
  for (const record of normalised) {
    for (const [name, field] of Object.entries(record.fields)) {
      if (field && field.problem) {
        found.push({ source: record.source, kind: record.kind, externalId: record.externalId, field: name, problem: field.problem, raw: field.raw });
      }
    }
  }
  return found;
}

/* ── Entities ───────────────────────────────────────────────────────────── */

const val = (field) => (field ? field.value : null);

function build(rawRecords) {
  const normalised = rawRecords.map(normaliseRecord).filter(Boolean);
  const of = (source, kind) => normalised.filter((r) => r.source === source && r.kind === kind);

  /* campaignDay — one authoritative source per row, but two possible ones, so
     the key is the cleaned campaign name rather than either platform's id.
     That is the join Phase 5 will need and the reason cleanup happens now. */
  const campaignDays = [];
  for (const source of ['meta_ads', 'google_ads']) {
    for (const r of of(source, 'campaign_day')) {
      const f = r.fields;
      campaignDays.push({
        entity: 'campaignDay',
        id: `${val(f.campaign)}:${val(f.date)}`,
        campaign: val(f.campaign),
        label: f.campaign.label,
        date: val(f.date),
        platform: source,
        spend: val(f.spend),
        impressions: val(f.impressions),
        clicks: val(f.clicks),
        leads: val(f.leads),
        sources: [{ source, externalId: r.externalId }],
      });
    }
  }

  const leads = of('telecrm', 'lead').map((r) => {
    const f = r.fields;
    return {
      entity: 'lead',
      id: r.externalId,
      name: val(f.name),
      phone: val(f.phone),
      email: val(f.email),
      createdAt: val(f.createdAt),
      stage: val(f.stage),
      owner: val(f.owner),
      campaign: val(f.campaign),
      adId: val(f.adId),
      property: val(f.property),
      sources: [{ source: 'telecrm', externalId: r.externalId }],
    };
  });

  const payments = [...of('razorpay', 'payment'), ...of('razorpay', 'refund')].map((r) => {
    const f = r.fields;
    return {
      entity: 'payment',
      id: r.externalId,
      bookingRef: val(f.bookingRef),
      amount: val(f.payment),
      status: val(f.status),
      method: val(f.method) || null,
      createdAt: val(f.createdAt),
      sources: [{ source: 'razorpay', externalId: r.externalId }],
    };
  });

  /* booking — the only contested entity. Three systems have a view of it and
     the precedence rules decide each field separately, so a booking can take
     its status from the PMS and its campaign from the CRM in the same breath. */
  const folios = of('pms', 'folio');
  const deals = of('telecrm', 'deal');

  const bookings = of('pms', 'booking').map((r) => {
    const f = r.fields;
    const id = r.externalId;
    const folio = folios.find((x) => val(x.fields.bookingId) === id);
    const deal = deals.find((x) => val(x.fields.bookingRef) === id);
    const paid = payments.filter((p) => p.bookingRef === id);

    const revenue = merge('revenue', [
      folio && { system: 'pms', source: 'pms', value: val(folio.fields.revenue), raw: folio.fields.revenue.raw },
      deal && { system: 'crm', source: 'telecrm', value: val(deal.fields.revenue), raw: deal.fields.revenue.raw },
    ].filter(Boolean));

    const status = merge('bookingStatus', [
      { system: 'pms', source: 'pms', value: val(f.bookingStatus), raw: f.bookingStatus.raw },
      deal && { system: 'crm', source: 'telecrm', value: val(deal.fields.stage), raw: deal.fields.stage.raw },
    ].filter(Boolean));

    const settled = merge('payment', paid.length
      ? [{ system: 'gateway', source: 'razorpay', value: paid.reduce((t, p) => t + (p.amount || 0), 0), raw: paid.map((p) => p.id) }]
      : []);

    return {
      entity: 'booking',
      id,
      guest: val(f.guest),
      phone: val(f.phone),
      property: val(f.property),
      roomType: val(f.roomType),
      checkIn: val(f.checkIn),
      checkOut: val(f.checkOut),
      nights: val(f.nights),
      revenue,
      bookingStatus: status,
      settled,
      leadId: deal ? val(deal.fields.leadId) : null,
      sources: [
        { source: 'pms', externalId: id },
        ...(folio ? [{ source: 'pms', externalId: folio.externalId }] : []),
        ...(deal ? [{ source: 'telecrm', externalId: deal.externalId }] : []),
        ...paid.map((p) => ({ source: 'razorpay', externalId: p.id })),
      ],
    };
  });

  /* inventoryDay — rooms available and sold, per property per night. Not
     contested: only the PMS knows its own inventory. Added in Phase 6 because
     occupancy and RevPAR are defined over available room nights and there was
     nothing to define them against; the payloads were already being normalised
     and simply never became an entity.

     The property id lives in the record's own key (`P-MUN:2026-07-14`) rather
     than in the mapped fields, because the mapper keeps names and measures, not
     ids — so it is read back off the key here. */
  /* A booking carries both the property's id and its name; an inventory row
     carries only the id. Without this map the two entities key on different
     things — inventory on `P-MUN`, bookings on `Munnar Hillside` — and
     occupancy for a property silently reads zero available rooms, because the
     filter matches neither. The id is kept alongside the name so the join can
     still be traced. */
  const propertyNames = new Map();
  for (const r of of('pms', 'booking')) {
    if (r.raw && r.raw.property_id && r.raw.property) propertyNames.set(r.raw.property_id, r.raw.property);
  }

  const inventoryDays = of('pms', 'inventory_day').map((r) => {
    const f = r.fields;
    const [propertyId] = String(r.externalId).split(':');
    return {
      entity: 'inventoryDay',
      id: r.externalId,
      propertyId,
      property: propertyNames.get(propertyId) || null,
      date: val(f.date),
      available: val(f.available),
      sold: val(f.sold),
      sources: [{ source: 'pms', externalId: r.externalId }],
    };
  });

  /* leadEvent — what happened to a lead and when. The first-response event is
     what makes the 44-minute median on the dashboard measurable at all, which
     is the reason TeleCRM streams rather than polls. */
  const leadEvents = of('telecrm', 'lead_event').map((r) => {
    const f = r.fields;
    return {
      entity: 'leadEvent',
      id: r.externalId,
      leadId: val(f.leadId),
      type: val(f.type),
      at: val(f.at),
      sources: [{ source: 'telecrm', externalId: r.externalId }],
    };
  });

  /* creative — an ad and what it achieved.
   *
   * The identity comes from the ads edge and the measurement from ad-level
   * insights, joined on the ad id. They arrive as two kinds because they are
   * two requests, but they describe one thing: the creative as it actually ran.
   *
   * A creative with no insight rows keeps its identity and reports null spend
   * rather than zero — an ad that has never been measured has not spent
   * nothing, it has no measurement, and the two must not read alike. */
  const adDayById = new Map();
  for (const r of of('meta_ads', 'ad_day')) {
    const [adId] = String(r.externalId).split(':');
    if (!adDayById.has(adId)) adDayById.set(adId, []);
    adDayById.get(adId).push(r);
  }

  const totalOf = (rows, field) => {
    const values = rows.map((r) => val(r.fields[field])).filter((v) => v !== null && v !== undefined);
    return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
  };

  const creatives = of('meta_ads', 'creative').map((r) => {
    const f = r.fields;
    const adId = String(r.externalId);
    const days = adDayById.get(adId) || [];

    return {
      entity: 'creative',
      id: adId,
      adId,
      /* The ad's name. Meta's creative object carries its own name, but it is
         not requested here — the ads edge answers an object field with its id
         alone, and inventing a second request to fetch names would be a lot of
         round trips for a label the ad already has. */
      title: val(f.title),
      status: val(f.status),
      creativeId: val(f.creativeId),
      campaignId: val(f.campaignId),
      thumbnailUrl: val(f.thumbnailUrl),
      objectType: val(f.objectType),
      platform: 'meta',
      /* Measured, or null where nothing measured it. */
      spend: totalOf(days, 'spend'),
      impressions: totalOf(days, 'impressions'),
      clicks: totalOf(days, 'clicks'),
      leads: totalOf(days, 'leads'),
      days: days.length,
      sources: [{ source: 'meta_ads', externalId: r.externalId }],
    };
  });

  return {
    campaignDays, leads, bookings, payments, inventoryDays, leadEvents, creatives,
    problems: problems(normalised),
  };
}

module.exports = { build, normaliseRecord, problems, MAPPERS };
