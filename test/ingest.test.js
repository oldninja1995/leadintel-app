/* Phase 4 sub-phases 4.1–4.4, against their stated exit criteria.
 *
 *   node --test        or        npm test
 *
 * The raw store writes to disk, so those tests use a temporary root rather
 * than `var/raw` — a test that pollutes the real store would make the next
 * replay non-reproducible, which is the one property being tested.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PRECEDENCE, assertConnector } = require('../lib/ingest/contract');
const sources = require('../lib/ingest/sources');
const connectors = require('../lib/ingest/connectors');
const n = require('../lib/ingest/normalise');
const { merge } = require('../lib/ingest/precedence');
const canonical = require('../lib/ingest/canonical');
const { RawStore, checksum } = require('../lib/ingest/raw-store');
const { fixtureTransport, httpTransport } = require('../lib/ingest/transport');
const ingest = require('../lib/ingest');

const tmpStore = () => new RawStore(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-raw-')));
const FIXED = '2026-08-03T00:00:00.000Z';

/* ── 4.1 Source registry & connector contract ───────────────────────────── */

test('all five sources are registered with a connector', () => {
  assert.deepEqual(sources.list().map((s) => s.id).sort(),
    ['google_ads', 'meta_ads', 'pms', 'razorpay', 'telecrm']);
  for (const s of sources.list()) assert.ok(connectors.get(s.id), `${s.id} has no connector`);
});

test('the precedence table matches the Analytics Engine page field for field', () => {
  assert.deepEqual(PRECEDENCE.map((r) => [r.field, r.wins]), [
    ['revenue', 'pms'],
    ['bookingStatus', 'pms'],
    ['leadStage', 'crm'],
    ['campaignIds', 'crm'],
    ['spendDelivery', 'ads'],
    ['payment', 'gateway'],
  ]);
});

test('every claimed field is one the source\'s system actually wins', () => {
  for (const s of sources.list()) {
    for (const field of s.wins) {
      assert.equal(PRECEDENCE.find((r) => r.field === field).wins, s.system, `${s.id} claims ${field}`);
    }
  }
});

test('a source cannot claim authority it does not have', () => {
  assert.throws(
    () => assertConnector({
      source: { id: 'rogue', system: 'ads', kinds: [], wins: ['revenue'] },
      pull: async () => [], receive: async () => [],
    }),
    /is ads but "revenue" is won by pms/
  );
});

test('a connector rejects a kind it never declared', async () => {
  await assert.rejects(
    () => connectors.get('telecrm').receive({ kind: 'invoice', body: { lead_id: 'L-1' } }),
    /has no identifier|undeclared kind/
  );
});

test('a source that cannot stream returns nothing from a webhook', async () => {
  assert.deepEqual(await connectors.get('meta_ads').receive({ kind: 'campaign_day', body: {} }), []);
});

test('the live transport says which half is missing, not just that it failed', async () => {
  /* Two different failures, and telling them apart is the point: one is fixed
     by pasting a key on the Connections screen, the other needs that vendor's
     API documentation. A single vague error would send somebody hunting for
     the wrong thing. */
  await assert.rejects(
    () => httpTransport().fetch({ source: sources.get('pms') }),
    /no credential stored .* add one on the Connections screen/s
  );

  await assert.rejects(
    () => httpTransport({ credentials: { apiKey: 'x' } }).fetch({ source: sources.get('pms') }),
    /has a credential but no connector/s
  );
});

test('a stored credential does not make a connector', async () => {
  /* The distinction the Connections screen must not blur: a key that is saved
     and a source that can actually be read are different states. */
  await assert.rejects(
    () => httpTransport({ credentials: { apiKey: 'x' } }).fetch({ source: sources.get('telecrm') }),
    /needs that vendor's API documentation, not another key/s
  );
});

/* ── 4.2 Raw store & replay ─────────────────────────────────────────────── */

test('re-pulling an overlapping window writes nothing new', async () => {
  const store = tmpStore();
  const first = await ingest.sync('meta_ads', { store, fetchedAt: FIXED });
  const second = await ingest.sync('meta_ads', { store, fetchedAt: FIXED });

  assert.ok(first.written > 0, 'first sync wrote nothing');
  assert.equal(second.pulled, first.pulled, 'second pull saw fewer records');
  assert.equal(second.written, 0, 'second sync duplicated records');
});

test('a changed payload is appended beside the old one, never over it', () => {
  const store = tmpStore();
  const record = (spend) => ({ kind: 'campaign_day', externalId: '23851:2026-07-14', body: { campaign_id: '23851', date: '2026-07-14', spend } });

  store.append('meta_ads', [record('₹7,000')], { fetchedAt: FIXED });
  store.append('meta_ads', [record('₹7,400')], { fetchedAt: FIXED });

  assert.equal(store.envelopes('meta_ads', 'campaign_day').length, 2, 'the earlier version was lost');
  const current = store.replay('meta_ads', 'campaign_day');
  assert.equal(current.length, 1, 'replay returned a superseded version');
  assert.equal(current[0].body.spend, '₹7,400');
});

test('checksums ignore key order', () => {
  assert.equal(checksum({ a: 1, b: { c: 2, d: 3 } }), checksum({ b: { d: 3, c: 2 }, a: 1 }));
});

test('replay produces byte-identical entities, and does not expose fetchedAt', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const first = ingest.snapshot({ store });

  /* A second sync at a different clock time changes every envelope's
     fetchedAt and nothing else. If anything downstream read it, this would
     differ. */
  await ingest.syncAll({ store, fetchedAt: '2027-01-01T00:00:00.000Z' });
  const second = ingest.snapshot({ store });

  assert.equal(JSON.stringify(second), JSON.stringify(first), 'replay was not reproducible');
  assert.ok(!JSON.stringify(store.replay()).includes('fetchedAt'), 'replay leaked fetchedAt downstream');
});

/* ── 4.3 Normalisation ──────────────────────────────────────────────────── */

test('currency: the formats that actually arrive', () => {
  assert.equal(n.money('₹7,000', 'INR').value, 700000);
  assert.equal(n.money('₹1,23,456', 'INR').value, 12345600, 'Indian digit grouping');
  assert.equal(n.money('₹52.3L', 'INR').value, 523000000, 'lakh notation');
  assert.equal(n.money('₹1.2Cr', 'INR').value, 1200000000, 'crore notation');
  assert.equal(n.money(6820.5, 'INR').value, 682050, 'a bare number of rupees');
  assert.equal(n.money(4800000000, 'INR', { unit: 'micros' }).value, 480000, "Google's micros");
  assert.equal(n.money(4280000, 'INR', { unit: 'minor' }).value, 4280000, "the gateway's paise");
});

test('currency: keeps the raw value and names what it could not read', () => {
  const bad = n.money('about seven thousand', 'INR');
  assert.equal(bad.value, null);
  assert.equal(bad.raw, 'about seven thousand');
  assert.match(bad.problem, /unrecognised/);
  assert.match(n.money(100, 'XYZ').problem, /unknown currency/);
});

test('timezone: IST becomes UTC, including across a date boundary', () => {
  assert.equal(n.timestamp('2026-07-14T02:15:00+05:30').value, '2026-07-13T20:45:00.000Z',
    'an early-morning IST lead belongs to the previous UTC day');
  assert.equal(n.timestamp('2026-07-14T11:40:00+05:30').value, '2026-07-14T06:10:00.000Z');
  assert.equal(n.timestamp('2026-07-14', { assume: 'Asia/Kolkata' }).value, '2026-07-13T18:30:00.000Z',
    'a bare date is the start of the local day');
  assert.equal(n.timestamp('2026-07-14T09:12:00+00:00').value, '2026-07-14T09:12:00.000Z');
});

test('casing: fixes shouting and whispering, leaves deliberate casing alone', () => {
  assert.equal(n.text('  ANJALI  MENON ').value, 'Anjali Menon');
  assert.equal(n.text('rahul  nair').value, 'Rahul Nair');
  assert.equal(n.text('George Kurien').value, 'George Kurien');
  assert.equal(n.text("d'Souza").value, "d'Souza", 'already mixed case — left alone');
  assert.equal(n.text('MG Road').value, 'MG Road');
});

test('phone: the four shapes an Indian CRM accumulates', () => {
  assert.equal(n.phone('+91 98470 12345').value, '+919847012345');
  assert.equal(n.phone('9847098765').value, '+919847098765', 'bare ten digits');
  assert.equal(n.phone('098470-11223').value, '+919847011223', 'trunk zero');
  assert.equal(n.phone('0091 8547 663311').value, '+918547663311', '0091 prefix');
  assert.equal(n.phone('12345').value, null);
  assert.match(n.phone('1234567890').problem, /not an Indian mobile/, 'Indian mobiles start 6–9');
});

test('campaign cleanup: three spellings of one campaign produce one key', () => {
  const spellings = ['  meta | Munnar Honeymoon — JUL  ', 'meta | munnar honeymoon — jul', 'Meta|Munnar Honeymoon|Jul'];
  const keys = new Set(spellings.map((s) => n.campaignName(s).value));
  assert.equal(keys.size, 1, [...keys].join(' vs '));
  assert.equal([...keys][0], 'munnar honeymoon jul');
  assert.equal(n.campaignName(spellings[0]).label, 'Munnar Honeymoon Jul', 'the readable form');
});

test('campaign cleanup: a platform token is only dropped when something remains', () => {
  assert.equal(n.campaignName('google').value, 'google');
  assert.equal(n.campaignName('brand search').value, 'brand search');
});

/* ── 4.4 Canonical entities & precedence ────────────────────────────────── */

test('a disagreement resolves to the folio and keeps the CRM figure', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const { bookings } = ingest.snapshot({ store });

  const booking = bookings.find((b) => b.id === 'B-1001');
  assert.ok(booking, 'B-1001 was not built');

  assert.equal(booking.revenue.value, 4280000, 'the settled folio total, in paise');
  assert.equal(booking.revenue.system, 'pms');
  assert.equal(booking.revenue.authoritative, true);
  assert.equal(booking.revenue.disputed, true);
  assert.match(booking.revenue.reason, /Folio is the settled figure/);

  const loser = booking.revenue.superseded.find((s) => s.system === 'crm');
  assert.ok(loser, 'the CRM figure was discarded');
  assert.equal(loser.value, 4600000, 'the CRM expectation, retained');
  assert.equal(loser.raw, '₹46,000');
});

test('an agreement is not reported as a dispute', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const booking = ingest.snapshot({ store }).bookings.find((b) => b.id === 'B-1002');
  assert.equal(booking.revenue.disputed, false);
  assert.equal(booking.bookingStatus.value, 'Cancelled', 'the PMS status wins');
});

test('falling back to a non-authoritative source is marked as such', () => {
  const resolved = merge('revenue', [{ system: 'crm', source: 'telecrm', value: 4600000, raw: '₹46,000' }]);
  assert.equal(resolved.value, 4600000);
  assert.equal(resolved.authoritative, false);
  assert.match(resolved.reason, /pms did not report/);
});

test('both ad platforms land in one campaignDay shape despite different units', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const { campaignDays } = ingest.snapshot({ store });

  const meta = campaignDays.find((c) => c.campaign === 'munnar honeymoon jul' && c.date === '2026-07-14');
  const google = campaignDays.find((c) => c.campaign === 'kumarakom ayurveda retreat search jul');

  assert.equal(meta.platform, 'meta_ads');
  assert.equal(meta.spend, 700000, '₹7,000 in paise');
  assert.equal(google.platform, 'google_ads');
  assert.equal(google.spend, 480000, '4.8bn micros of INR in paise');
});

test('the two July 14 spellings of one campaign collapse to one key', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const { campaignDays } = ingest.snapshot({ store });
  const munnar = campaignDays.filter((c) => c.campaign === 'munnar honeymoon jul');
  assert.deepEqual(munnar.map((c) => c.date).sort(), ['2026-07-14', '2026-07-15']);
});

test('normalisation problems are collected, not thrown, and the fixtures raise none', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const { problems } = ingest.snapshot({ store });
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
});

test('a lead carries its E.164 phone and its UTC creation time', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const lead = ingest.snapshot({ store }).leads.find((l) => l.id === 'L-7781');
  assert.equal(lead.name, 'Anjali Menon');
  assert.equal(lead.phone, '+919847012345');
  assert.equal(lead.createdAt, '2026-07-13T20:45:00.000Z');
  assert.equal(lead.campaign, 'munnar honeymoon jul', 'joins to the ad platform on the cleaned key');
});

test('a refund nets off the payment it reverses', async () => {
  const store = tmpStore();
  await ingest.syncAll({ store, fetchedAt: FIXED });
  const booking = ingest.snapshot({ store }).bookings.find((b) => b.id === 'B-1002');
  assert.equal(booking.settled.value, 0, 'a captured payment and its full refund settle to nothing');
});

test('a webhook delivery takes the same path as a pull', async () => {
  const store = tmpStore();
  const result = await ingest.receive('telecrm', {
    kind: 'lead',
    body: { lead_id: 'L-9999', name: 'PRIYA  RAJ', phone: '9847000111', email: 'p@example.com', created_at: '2026-07-16T22:10:00+05:30', stage: 'new', owner: 'Reshma K', utm_campaign: 'meta | Munnar Honeymoon — JUL', ad_id: null, property: 'Munnar Hillside' },
  }, { store, fetchedAt: FIXED });

  assert.equal(result.written, 1);
  const lead = ingest.snapshot({ store }).leads.find((l) => l.id === 'L-9999');
  assert.equal(lead.name, 'Priya Raj');
  assert.equal(lead.createdAt, '2026-07-16T16:40:00.000Z');
});

test('the fixture transport windows records by their own timestamp', async () => {
  const transport = fixtureTransport();
  const rows = await transport.fetch({
    source: sources.get('meta_ads'),
    kind: 'campaign_day',
    window: { from: '2026-07-15T00:00:00Z', to: '2026-07-16T00:00:00Z' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-07-15');
});
