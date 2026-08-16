/* NC — new customers, from paid ads.
 *
 *   node --test        or        npm test
 *
 * "New" is a claim about every OTHER enquiry, not about the lead in front of
 * you, and that is what makes it easy to get quietly wrong. A metric only ever
 * sees the window it was handed, so it cannot tell a first enquiry from a
 * fourth — the earlier three are outside that window. The comparison is made
 * once in canonical.js against the whole store and stamped onto the lead; these
 * tests run the real build so the stamp and the metric cannot drift apart.
 *
 * Three failure modes are pinned here, all of them silent:
 *
 *   an unstamped lead counting as new, which would put the rate near 100% and
 *   have it measuring the absence of a field;
 *
 *   one person counted as several, because their number is written three ways;
 *
 *   and the interested test being asked of a LEAD rather than of a PERSON,
 *   which drops the ordinary case of somebody marked Fresh on Monday and
 *   Interested on Friday.
 */

const test = require('node:test');
const assert = require('node:assert');

const metrics = require('../lib/metrics');
const registry = require('../lib/metrics/registry');
const canonical = require('../lib/ingest/canonical');
const resolve = require('../lib/metrics/resolve');
const scope = require('../lib/metrics/scope');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.parse('2026-08-16T00:00:00.000Z') - msAgo).toISOString();

const lead = (over) => ({
  entity: 'lead', id: 'L', phone: null, email: null, createdAt: iso(0),
  stage: 'Fresh', channel: 'meta', campaign: null, adId: null, ...over,
});

/* Through the real canonical build, so `customer` and `repeat` are whatever
   production would stamp rather than what a test wishes they were. */
function stamped(leads) {
  const records = leads.map((l, i) => ({
    source: 'telecrm', kind: 'lead', externalId: l.id || `L-${i}`, checksum: 'x', transport: 'fixture',
    body: {
      lead_id: l.id || `L-${i}`, name: l.name || 'Guest', phone: l.phone, email: l.email,
      created_at: l.createdAt, stage: l.stage, owner: null,
      utm_campaign: l.campaign, ad_id: l.adId, property: null, channel: l.channel,
    },
  }));
  return canonical.build(records).leads;
}

const evaluate = (leads, options) => metrics.evaluate(
  { leads, campaignDays: [], bookings: [], payments: [], deals: [], leadEvents: [], inventoryDays: [] },
  options,
).values;

/* ── what makes a customer new ──────────────────────────────────────────── */

test('a first enquiry is a new customer and a later one from the same person is not', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9876543210', createdAt: iso(300 * DAY) }),
    lead({ id: 'L-2', phone: '9876543210', createdAt: iso(1 * DAY) }),
  ]);
  const first = leads.find((l) => l.id === 'L-1');
  const second = leads.find((l) => l.id === 'L-2');

  assert.equal(registry.isNewCustomer(first), true);
  assert.equal(registry.isNewCustomer(second), false);
  assert.equal(evaluate(leads)['leads.new_customers'], 1, 'one person, one new customer');
});

test('past the 365-day horizon the same number is new again', () => {
  /* Two enquiries 400 days apart are not one continuing relationship. */
  const leads = stamped([
    lead({ id: 'L-1', phone: '9876543210', createdAt: iso(400 * DAY) }),
    lead({ id: 'L-2', phone: '9876543210', createdAt: iso(1 * DAY) }),
  ]);
  assert.equal(evaluate(leads)['leads.new_customers'], 2);
});

test('one person written three ways is one new customer', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '+91 98765 43210', createdAt: iso(9 * DAY) }),
    lead({ id: 'L-2', phone: '098765 43210', createdAt: iso(5 * DAY) }),
    lead({ id: 'L-3', phone: '9876543210', createdAt: iso(1 * DAY) }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.new_customers'], 1);
  assert.equal(values['leads.ad_customers'], 1);
  assert.equal(values['leads.new_customer_rate'], 1);
});

test('an UNSTAMPED lead is not new — absence of a field is not evidence of anything', () => {
  /* `!undefined` would call it new, every unstamped lead would be a new
     customer, and the rate would read 100% while measuring nothing. */
  assert.equal(registry.isNewCustomer({ id: 'X' }), false);
  assert.equal(registry.isNewCustomer({ id: 'X', repeat: undefined }), false);
  assert.equal(registry.isNewCustomer({ id: 'X', repeat: false }), true);

  const raw = [{ id: 'L-1', channel: 'meta', stage: 'Fresh' }];
  const values = evaluate(raw);
  assert.equal(values['leads.new_customers'], 0);
  assert.equal(values['leads.ad_customers'], 1, 'it is still a customer, just not a new one');
});

test('a lead with no phone and no email is its own customer, never merged', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: null, email: null }),
    lead({ id: 'L-2', phone: null, email: null }),
  ]);
  assert.notEqual(leads[0].customer, leads[1].customer);
  assert.equal(evaluate(leads)['leads.new_customers'], 2);
});

test('email identifies a person when the phone is missing', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: null, email: 'Guest@Example.com', createdAt: iso(2 * DAY) }),
    lead({ id: 'L-2', phone: null, email: 'guest@example.com', createdAt: iso(1 * DAY) }),
  ]);
  assert.equal(evaluate(leads)['leads.new_customers'], 1);
});

/* ── ads only ───────────────────────────────────────────────────────────── */

test('an untagged lead is outside the count AND outside the base', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', channel: 'meta' }),
    lead({ id: 'L-2', phone: '9000000002', channel: null }),
    lead({ id: 'L-3', phone: '9000000003', channel: 'google' }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.ad_customers'], 2);
  assert.equal(values['leads.new_customers'], 2);
  assert.equal(values['leads.new_customer_rate'], 1);
});

test('the channel chip narrows it further, so Meta alone is a selection', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', channel: 'meta' }),
    lead({ id: 'L-2', phone: '9000000002', channel: 'google' }),
  ]);
  assert.equal(evaluate(leads)['leads.new_customers'], 2);
  assert.equal(evaluate(leads, { at: { dimension: 'channel', value: 'meta' } })['leads.new_customers'], 1);
});

test('every ad-only metric really does ignore an untagged lead', () => {
  /* What keeps the hand-written list in resolve.js honest. */
  const untagged = stamped([lead({ id: 'L-1', phone: '9000000001', channel: null, stage: 'Interested' })]);
  const values = evaluate(untagged);

  for (const id of ['leads.ad_customers', 'leads.new_customers', 'leads.new_customers_interested']) {
    assert.equal(values[id], 0, `${id} counted an untagged lead`);
  }
  assert.equal(values['leads.new_customer_rate'], null, 'a rate over nothing is unknown, not zero');
});

/* ── NC interested ──────────────────────────────────────────────────────── */

test('interest is asked of the PERSON, not of one enquiry', () => {
  /* The ordinary case: Fresh on Monday, Interested on Friday. Testing a single
     lead for both conditions would drop this person entirely. */
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', stage: 'Fresh', createdAt: iso(5 * DAY) }),
    lead({ id: 'L-2', phone: '9000000001', stage: 'Interested', createdAt: iso(1 * DAY) }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.new_customers'], 1);
  assert.equal(values['leads.new_customers_interested'], 1);
  assert.equal(values['leads.new_customers_interested_rate'], 1);
});

test('a returning customer who is interested is not an NC interested lead', () => {
  /* Interested, but not new — and the metric is about newly acquired demand. */
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', stage: 'Fresh', createdAt: iso(200 * DAY) }),
    lead({ id: 'L-2', phone: '9000000001', stage: 'Interested', createdAt: iso(1 * DAY) }),
    lead({ id: 'L-3', phone: '9000000002', stage: 'Interested', createdAt: iso(1 * DAY) }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.new_customers'], 2, 'both people are new — L-1 is the first of its person');
  assert.equal(values['leads.new_customers_interested'], 2);
});

test('the rate divides by new customers, not by every customer', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001', stage: 'Interested', createdAt: iso(300 * DAY) }),
    lead({ id: 'L-2', phone: '9000000001', stage: 'Interested', createdAt: iso(2 * DAY) }),
    lead({ id: 'L-3', phone: '9000000002', stage: 'Fresh', createdAt: iso(1 * DAY) }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.ad_customers'], 2);
  assert.equal(values['leads.new_customers'], 2);
  assert.equal(values['leads.new_customers_interested'], 1);
  assert.equal(values['leads.new_customers_interested_rate'], 0.5);
});

test('an unrecognised status is not interest, so the figure understates', () => {
  const leads = stamped([lead({ id: 'L-1', phone: '9000000001', stage: 'Ringing no answer' })]);
  const values = evaluate(leads);

  assert.equal(values['leads.new_customers'], 1);
  assert.equal(values['leads.new_customers_interested'], 0);
});

/* ── where the tiles show ───────────────────────────────────────────────── */

test('the NC tiles are hidden on the Non-ad view, where they are a structural zero', () => {
  const payload = {
    kpis: [
      { metric: 'leads.new_customers', label: 'NC customers', value: '—' },
      { metric: 'leads.new_customer_rate', label: 'NC %', value: '—' },
      { metric: 'leads.new_customers_interested', label: 'NC interested leads', value: '—' },
      { metric: 'leads.new_customers_interested_rate', label: 'NC interested leads %', value: '—' },
      { metric: 'leads.count', label: 'Leads', value: '—' },
    ],
  };
  const out = resolve.resolve(payload, {
    valuesFor: () => ({}), at: { dimension: 'channel', value: 'non-ad' },
  });
  assert.deepEqual((out.kpis || []).map((c) => c.label), ['Leads']);
});

test('they are shown unfiltered and under a paid channel', () => {
  const payload = { kpis: [{ metric: 'leads.new_customers', label: 'NC customers', value: '—' }] };
  for (const at of [null, { dimension: 'channel', value: 'meta' }]) {
    const out = resolve.resolve(payload, { valuesFor: () => ({}), at });
    assert.equal((out.kpis || []).length, 1, `hidden at ${JSON.stringify(at)}`);
  }
});

test('the metrics are answerable at every grain the leads collection supports', () => {
  for (const id of ['leads.ad_customers', 'leads.new_customers', 'leads.new_customers_interested']) {
    assert.equal(scope.supports(id, 'channel', 'meta'), true);
    assert.equal(scope.supports(id, 'campaign', 'monsoon'), true);
  }
});

/* ── RC, the returning half ─────────────────────────────────────────────── */

test('a returning customer is RC and their first enquiry is not', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9876543210', createdAt: iso(200 * DAY) }),
    lead({ id: 'L-2', phone: '9876543210', createdAt: iso(1 * DAY) }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.repeat_customers'], 1);
  assert.equal(values['leads.new_customers'], 1, 'the same person, seen both ways');
  assert.equal(values['leads.ad_customers'], 1);
});

test('NC % and RC % do NOT sum to 100 — the two overlap', () => {
  /* One person, first and second enquiry both inside the window. They are a
     new customer AND a returning one, so drawing these as two halves of a bar
     would claim 200% of the base. */
  const leads = stamped([
    lead({ id: 'L-1', phone: '9876543210', createdAt: iso(20 * DAY) }),
    lead({ id: 'L-2', phone: '9876543210', createdAt: iso(1 * DAY) }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.new_customer_rate'], 1);
  assert.equal(values['leads.repeat_customer_rate'], 1);
  assert.equal(
    values['leads.new_customer_rate'] + values['leads.repeat_customer_rate'],
    2,
    'they overlap by construction; nothing may present them as a split',
  );
});

test('RC is zero when nobody has enquired before, rather than unknown', () => {
  const leads = stamped([
    lead({ id: 'L-1', phone: '9000000001' }),
    lead({ id: 'L-2', phone: '9000000002' }),
  ]);
  const values = evaluate(leads);

  assert.equal(values['leads.repeat_customers'], 0);
  assert.equal(values['leads.repeat_customer_rate'], 0);
  assert.equal(values['leads.new_customer_rate'], 1);
});

test('an unstamped lead is neither new nor returning', () => {
  /* `repeat` undefined is an absent measurement. It must not fall into either
     bucket, or one of the two rates starts counting missing data. */
  assert.equal(registry.isNewCustomer({ id: 'X' }), false);
  assert.equal(registry.isReturningCustomer({ id: 'X' }), false);
});

/* ── NC ROAS ────────────────────────────────────────────────────────────── */

/* Deals go through the real build too, so the first-time flag they carry is
   whatever canonical inherits from the lead rather than a hand-set field. */
function stampedWith(leads, deals) {
  const records = [
    ...leads.map((l, i) => ({
      source: 'telecrm', kind: 'lead', externalId: l.id || `L-${i}`, checksum: 'x', transport: 'fixture',
      body: {
        lead_id: l.id, name: 'Guest', phone: l.phone, email: null, created_at: l.createdAt,
        stage: l.stage, owner: null, utm_campaign: null, ad_id: null, property: null, channel: l.channel,
      },
    })),
    ...deals.map((d) => ({
      source: 'telecrm', kind: 'deal', externalId: d.id, checksum: 'x', transport: 'fixture',
      body: {
        /* `value`, not `revenue` — the deal mapper reads `b.value` through
           n.money. Writing the wrong key here produces a null reservation
           value and a silent zero, which is the same shape as the bug these
           tests exist to catch. */
        deal_id: d.id, lead_id: d.leadId, value: d.revenue, currency: 'INR', stage: d.stage || 'Won',
        outcome: d.outcome || 'won', booking_status: d.bookingStatus || 'Confirmed',
        updated_at: d.updatedAt || iso(1 * DAY), booking_ref: null,
      },
    })),
  ];
  const built = canonical.build(records);
  return { leads: built.leads, deals: built.deals || [] };
}

test('a deal inherits the first-time flag from its lead', () => {
  const { deals } = stampedWith(
    [
      lead({ id: 'L-1', phone: '9000000001', createdAt: iso(200 * DAY) }),
      lead({ id: 'L-2', phone: '9000000001', createdAt: iso(2 * DAY) }),
    ],
    [{ id: 'D-1', leadId: 'L-1', revenue: 100000 }, { id: 'D-2', leadId: 'L-2', revenue: 200000 }],
  );

  assert.equal(deals.find((d) => d.id === 'D-1').repeat, false, 'first enquiry');
  assert.equal(deals.find((d) => d.id === 'D-2').repeat, true, 'the same person, returning');
});

test('a deal whose lead cannot be found is unclassified, not new', () => {
  /* null, never false. Reading an unknown as "new" would move revenue INTO the
     NC figure on the strength of a missing join. */
  const { deals } = stampedWith([], [{ id: 'D-9', leadId: 'GONE', revenue: 5000 }]);
  assert.equal(deals[0].repeat, null);

  const values = metrics.evaluate({
    leads: [], deals, campaignDays: [{ spend: 100000 }], bookings: [], payments: [],
  }).values;
  assert.equal(values['revenue.new_customers'], 0);
});

test('NC ROAS divides first-time reservation value by all ad spend', () => {
  const { leads, deals } = stampedWith(
    [
      lead({ id: 'L-1', phone: '9000000001', createdAt: iso(200 * DAY) }),
      lead({ id: 'L-2', phone: '9000000001', createdAt: iso(2 * DAY) }),
    ],
    /* Rupees in, paise out — `n.money` multiplies by 100, and every figure the
       registry handles is in paise. ₹4,000 becomes 400000. */
    [{ id: 'D-1', leadId: 'L-1', revenue: 4000 }, { id: 'D-2', leadId: 'L-2', revenue: 6000 }],
  );
  const values = metrics.evaluate({
    leads, deals, campaignDays: [{ spend: 200000, platform: 'meta_ads' }], bookings: [], payments: [],
  }).values;

  assert.equal(values['revenue.new_customers'], 400000, 'only the first-timer\'s deal, in paise');
  assert.equal(values['roas.new_customers'], 2, '400000 paise / 200000 paise');
  /* The asymmetry, stated as a test: the denominator keeps the spend that
     produced the returning customer, so this is a floor. */
  assert.equal(values['ads.spend'], 200000);
});

test('a cancelled first-time deal is excluded from NC revenue', () => {
  const { deals } = stampedWith(
    [lead({ id: 'L-1', phone: '9000000001' })],
    [{ id: 'D-1', leadId: 'L-1', revenue: 4000, bookingStatus: 'Cancelled' }],
  );
  const values = metrics.evaluate({
    leads: [], deals, campaignDays: [{ spend: 100000 }], bookings: [], payments: [],
  }).values;
  assert.equal(values['revenue.new_customers'], 0);
});

test('NC ROAS is unknown rather than zero when there is no spend', () => {
  const { deals } = stampedWith(
    [lead({ id: 'L-1', phone: '9000000001' })],
    [{ id: 'D-1', leadId: 'L-1', revenue: 4000 }],
  );
  const values = metrics.evaluate({
    leads: [], deals, campaignDays: [], bookings: [], payments: [],
  }).values;
  assert.equal(values['roas.new_customers'], null);
});
