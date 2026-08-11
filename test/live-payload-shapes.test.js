/* Two bugs that the fixtures could not have caught, because both are about the
 * difference between a fixture and the real account.
 *
 *   1. Meta returns counts as strings; the fixtures write them as numbers.
 *      `sum()` starts at 0, so strings concatenated instead of adding and the
 *      marketing dashboard showed a 250-digit impressions figure.
 *
 *   2. Fixture payloads are stored in the same append-only file as live ones.
 *      No live pull ever restates a fixture's external id, so three invented
 *      campaigns kept replaying as current truth after Meta was connected.
 *
 * Everything here therefore uses *string* counts and a store on a temp root.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const canonical = require('../lib/ingest/canonical');
const { RawStore } = require('../lib/ingest/raw-store');

const tmpStore = () => new RawStore(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-live-')));

/* Shaped like a real `/insights` row: every count a string, `date_start`
   rather than `date`, `account_currency` rather than `currency`. */
const metaDay = (campaign, date, impressions, clicks) => ({
  source: 'meta_ads',
  kind: 'campaign_day',
  externalId: `${campaign}:${date}`,
  body: {
    campaign_id: '120215',
    campaign_name: campaign,
    date_start: date,
    account_currency: 'INR',
    spend: '1250.55',
    impressions: String(impressions),
    clicks: String(clicks),
    actions: [{ action_type: 'lead', value: '12' }],
  },
});

/* ── counts arriving as strings ─────────────────────────────────────────── */

test('Meta string counts are added, not concatenated', () => {
  const entities = canonical.build([
    metaDay('S1 Tofu Leads Conversion', '2026-08-01', 51020, 1041),
    metaDay('S1 Tofu Leads Conversion', '2026-08-02', 48310, 987),
  ]);

  const days = entities.campaignDays;
  assert.equal(days.length, 2);

  for (const d of days) {
    assert.equal(typeof d.impressions, 'number', 'impressions must be a number');
    assert.equal(typeof d.clicks, 'number', 'clicks must be a number');
  }

  const total = days.reduce((t, d) => t + d.impressions, 0);
  assert.equal(total, 99330);
  /* The bug it replaces: 0 + '51020' + '48310' === '05102048310'. */
  assert.equal(String(total).length, 5);
});

test('a string lead count sums as a number too', () => {
  const [day] = canonical.build([{
    source: 'meta_ads',
    kind: 'campaign_day',
    externalId: 'c:2026-08-01',
    body: {
      campaign_name: 'c', date_start: '2026-08-01', spend: '10', account_currency: 'INR',
      impressions: '100', clicks: '5', leads: '7',
    },
  }]).campaignDays;

  assert.equal(day.leads, 7);
});

test('an absent count is still null rather than zero', () => {
  const [day] = canonical.build([{
    source: 'meta_ads',
    kind: 'campaign_day',
    externalId: 'c:2026-08-01',
    body: { campaign_name: 'c', date_start: '2026-08-01', spend: '10', account_currency: 'INR' },
  }]).campaignDays;

  assert.equal(day.impressions, null, 'a row that reported nothing did not report none');
  assert.equal(day.clicks, null);
});

/* Ad-level counts reach the screens through a creative's daily series, which
   is what the fatigue and trend readings are computed from. The totals were
   already safe — `totalOf` coerces — but the series carried the raw strings. */
test('ad-level counts are coerced on the same rule', () => {
  const { creatives } = canonical.build([
    {
      source: 'meta_ads', kind: 'creative', externalId: 'AD1',
      body: { id: 'AD1', name: 'Monsoon 15s', status: 'ACTIVE', campaign_id: '120215' },
    },
    {
      source: 'meta_ads', kind: 'ad_day', externalId: 'AD1:2026-08-01',
      body: {
        ad_name: 'Monsoon 15s', date_start: '2026-08-01', spend: '10', account_currency: 'INR',
        impressions: '4000', clicks: '80',
      },
    },
  ]);

  assert.equal(creatives.length, 1);
  const [day] = creatives[0].series;
  assert.equal(day.impressions, 4000);
  assert.equal(day.clicks, 80);
  assert.equal(creatives[0].impressions, 4000);
});

/* ── demo payloads beside real ones ─────────────────────────────────────── */

/* From lib/ingest/fixtures/meta_ads.json. What has to match is the external id
   the connector would name it with — `campaign_id:date` — not the body. */
const FIXTURE_DAY = {
  source: 'meta_ads',
  kind: 'campaign_day',
  externalId: '23851:2026-07-14',
  body: {
    campaign_id: '23851',
    campaign_name: '  meta | Munnar Honeymoon — JUL  ',
    date: '2026-07-14',
    currency: 'INR',
    spend: '₹7,000',
    impressions: 148200,
    clicks: 3140,
    leads: 21,
  },
};

test('a fixture payload replays while it is the only thing the source has', () => {
  const store = tmpStore();
  store.append('meta_ads', [FIXTURE_DAY], { transport: 'fixture' });

  const ids = store.replay().map((r) => r.externalId);
  assert.deepEqual(ids, ['23851:2026-07-14'], 'demo mode still shows its demo data');
});

test('a real payload retires the fixtures for that kind', () => {
  const store = tmpStore();
  store.append('meta_ads', [FIXTURE_DAY], { transport: 'fixture' });
  store.append('meta_ads', [metaDay('S1 Tofu Leads Conversion', '2026-08-01', 51020, 1041)], { transport: 'http' });

  const names = store.replay().map((r) => r.body.campaign_name);
  assert.deepEqual(names, ['S1 Tofu Leads Conversion']);
  assert.ok(!names.some((nm) => /Munnar/.test(nm)), 'no invented campaign beside a real one');
});

/* The rows already on the Railway volume predate the `transport` field. */
test('an unmarked fixture payload is recognised by its external id', () => {
  const store = tmpStore();
  store.append('meta_ads', [FIXTURE_DAY]);
  store.append('meta_ads', [metaDay('S1 Tofu Leads Conversion', '2026-08-01', 51020, 1041)]);

  const names = store.replay().map((r) => r.body.campaign_name);
  assert.deepEqual(names, ['S1 Tofu Leads Conversion']);
});

/* The regression that made identity the rule instead of content. The store
   keeps the superseded line, and it must not be mistaken for a live payload. */
test('an edited fixture does not make its own older line look real', () => {
  const store = tmpStore();
  store.append('meta_ads', [FIXTURE_DAY]);
  store.append('meta_ads', [{
    ...FIXTURE_DAY,
    body: { ...FIXTURE_DAY.body, spend: '₹7,100' },
  }]);

  const rows = store.replay();
  assert.equal(rows.length, 1, 'one campaign day, restated');
  assert.match(rows[0].body.campaign_name, /Munnar/,
    'both lines are the same fixture row — neither retires the other');
});

test('retiring is per kind — an unrelated kind is untouched', () => {
  const store = tmpStore();
  store.append('meta_ads', [FIXTURE_DAY], { transport: 'fixture' });
  store.append('meta_ads', [{
    source: 'meta_ads', kind: 'adset_day', externalId: 'as:2026-07-14',
    body: { adset_name: 'demo', date: '2026-07-14', spend: 100, currency: 'INR' },
  }], { transport: 'fixture' });
  store.append('meta_ads', [metaDay('S1 Tofu Leads Conversion', '2026-08-01', 51020, 1041)], { transport: 'http' });

  const kinds = store.replay().map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['adset_day', 'campaign_day'],
    'campaign_day went live; adset_day has no live rows and keeps what it has');
});

test('nothing is deleted — the store still remembers what it stopped replaying', () => {
  const store = tmpStore();
  store.append('meta_ads', [FIXTURE_DAY], { transport: 'fixture' });
  store.append('meta_ads', [metaDay('S1 Tofu Leads Conversion', '2026-08-01', 51020, 1041)], { transport: 'http' });

  const kept = store.envelopes('meta_ads', 'campaign_day');
  assert.equal(kept.length, 2);
  assert.ok(kept.some((e) => e.transport === 'fixture'));
});

/* What a webhook test leaves behind, and what it must not cost. */
test('a payload carrying only an identifier retires nothing', () => {
  const store = tmpStore();
  store.append('telecrm', [{
    source: 'telecrm', kind: 'lead', externalId: 'L-7781',
    body: { lead_id: 'L-7781', name: 'Anjali Menon', phone: '+91 98470 12345', stage: 'new' },
  }], { transport: 'fixture' });
  store.append('telecrm', [{
    source: 'telecrm', kind: 'lead', externalId: 'L-2', body: { lead_id: 'L-2' },
  }]);

  const ids = store.replay().map((r) => r.externalId).sort();
  assert.deepEqual(ids, ['L-2', 'L-7781'], 'a probe is not the CRM taking over');
});

test('the transport is recorded on what a sync writes', () => {
  const store = tmpStore();
  const [written] = store.append('meta_ads', [metaDay('c', '2026-08-01', 10, 1)], { transport: 'http' });
  assert.equal(written.transport, 'http');
});

/* ── which sources may still serve demo data ────────────────────────────── */

const ingest = require('../lib/ingest');

/* The rule has to match `transportFor` in server.js: a source pulling for real
   while its fixtures keep replaying is the state that put three invented
   campaigns at the top of Campaign Analytics. */
test('forcing the http transport retires demo data everywhere', () => {
  const live = ingest.liveSources({ forced: 'http' });

  for (const source of ingest.sources.list()) {
    assert.ok(live.has(source.id), `${source.id} would still serve fixtures in production`);
  }
});

test('a local run with no forced transport keeps demo mode', () => {
  const live = ingest.liveSources({ forced: undefined, connections: null, workspace: null });
  assert.equal(live.size, 0);
});

test('without a forced transport only connected sources retire theirs', () => {
  const live = ingest.liveSources({
    forced: undefined,
    connections: { configured: () => new Set(['meta_ads']) },
    workspace: 'parakkat',
  });

  assert.deepEqual([...live], ['meta_ads']);
});
