/* The Meta Ads connector.
 *
 * Tested against a stubbed Graph API rather than the real one — there is no
 * token here, and a test that needs a live credential is a test that does not
 * run. What is checked is everything that can be got wrong without the network:
 * the request built, the paging loop, the errors distinguished, and the two
 * spellings stage 2 has to read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const meta = require('../lib/ingest/http/meta-ads');
const httpConnectors = require('../lib/ingest/http');
const { httpTransport } = require('../lib/ingest/transport');
const connectors = require('../lib/ingest/connectors');
const canonical = require('../lib/ingest/canonical');
const sources = require('../lib/ingest/sources');

const CREDS = { accountId: 'act_1234567890', accessToken: 'EAAtoken' };
const META = sources.get('meta_ads');

/* A stub that answers each url in turn and records what it was asked for. */
function stub(pages) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const page = (data, next = null) => ({
  data,
  paging: next ? { next, cursors: { after: next } } : { cursors: { after: 'trailing' } },
});

/* ── the request ────────────────────────────────────────────────────────── */

test('the insights request names the level, a day at a time', () => {
  const { url } = meta.request({ kind: 'campaign_day', window: null, credentials: CREDS });
  const params = new URL(url).searchParams;

  assert.ok(url.startsWith('https://graph.facebook.com/v25.0/act_1234567890/insights'));
  assert.equal(params.get('level'), 'campaign');
  assert.equal(params.get('time_increment'), '1');
  assert.ok(params.get('fields').includes('campaign_id'));
});

/* The currency must be asked for, or `money()` is normalising against an
   assumption. */
test('every insights request asks for the account currency', () => {
  for (const kind of ['campaign_day', 'adset_day', 'ad_day']) {
    const params = new URL(meta.request({ kind, window: null, credentials: CREDS }).url).searchParams;
    assert.ok(params.get('fields').includes('account_currency'), `${kind} must ask for the currency`);
  }
});

/* The bug this would have caused is invisible: one extra day, every pull. */
test('a half-open window becomes an inclusive until, one day back', () => {
  const range = meta.timeRange({ from: '2026-07-01', to: '2026-07-15' });
  assert.deepEqual(range, { since: '2026-07-01', until: '2026-07-14' });
});

test('no window falls back to a preset rather than an account\'s whole history', () => {
  const params = new URL(meta.request({ kind: 'campaign_day', window: null, credentials: CREDS }).url).searchParams;
  assert.equal(params.get('date_preset'), 'last_7d');
  assert.equal(params.get('time_range'), null);
});

test('a bare account number is prefixed rather than refused', () => {
  assert.equal(meta.accountPath('1234567890'), 'act_1234567890');
  assert.equal(meta.accountPath('act_1234567890'), 'act_1234567890');
  assert.throws(() => meta.accountPath(''), /ad account id/);
});

test('creatives use their own edge, not insights', () => {
  const { url } = meta.request({ kind: 'creative', window: null, credentials: CREDS });
  assert.ok(url.includes('/adcreatives?'));
  assert.ok(!url.includes('/insights'));
});

test('a kind with no request shape is refused rather than pulled as empty', () => {
  assert.throws(() => meta.request({ kind: 'keyword_day', window: null, credentials: CREDS }), /no request shape/);
});

/* ── paging ─────────────────────────────────────────────────────────────── */

test('pages are followed and concatenated', async () => {
  const { fetchImpl, calls } = stub([
    page([{ campaign_id: '1', date_start: '2026-07-01' }], 'CURSOR1'),
    page([{ campaign_id: '2', date_start: '2026-07-02' }]),
  ]);

  const rows = await httpTransport({ credentials: CREDS, fetchImpl })
    .fetch({ source: META, kind: 'campaign_day', window: null });

  assert.equal(rows.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('after=CURSOR1'), 'the second call must carry the cursor');
});

/* `cursors.after` is present on the last page too — following it would loop. */
test('a trailing cursor with no next link ends the loop', async () => {
  const { fetchImpl, calls } = stub([page([{ campaign_id: '1', date_start: '2026-07-01' }])]);

  const rows = await httpTransport({ credentials: CREDS, fetchImpl })
    .fetch({ source: META, kind: 'campaign_day', window: null });

  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1, 'a trailing after cursor must not be followed');
});

test('runaway paging stops and says so, rather than writing a partial pull', async () => {
  const { fetchImpl } = stub([page([{ campaign_id: '1', date_start: '2026-07-01' }], 'ALWAYS')]);

  await assert.rejects(
    () => httpTransport({ credentials: CREDS, fetchImpl, maxPages: 3 })
      .fetch({ source: META, kind: 'campaign_day', window: null }),
    /more than 3 pages/
  );
});

/* ── failures, told apart ───────────────────────────────────────────────── */

test('a rate limit is not reported as a credential problem', () => {
  assert.throws(
    () => meta.checkForError({ error: { message: 'User request limit reached', code: 17 } }, { ok: false, status: 400 }),
    /rate limit, not a credential problem/
  );
});

test('an expired token keeps Meta\'s own wording', () => {
  assert.throws(
    () => meta.checkForError(
      { error: { message: 'Error validating access token: Session has expired', code: 190, fbtrace_id: 'Abc' } },
      { ok: false, status: 401 }
    ),
    /Session has expired/
  );
});

test('a missing credential and a missing connector are different errors', async () => {
  await assert.rejects(
    () => httpTransport({ credentials: null }).fetch({ source: META, kind: 'campaign_day', window: null }),
    /no credential stored/
  );

  await assert.rejects(
    () => httpTransport({ credentials: { apiKey: 'x' } })
      .fetch({ source: sources.get('pms'), kind: 'booking', window: null }),
    /no connector/
  );
});

test('a credential missing a required field says which', async () => {
  await assert.rejects(
    () => httpTransport({ credentials: { accountId: 'act_1' } })
      .fetch({ source: META, kind: 'campaign_day', window: null }),
    /missing accessToken/
  );
});

/* The registry is deliberately sparse — a source absent from it still gets the
   "no connector" error rather than a guessed request. */
test('the three sources with no request shape are still absent', () => {
  for (const id of ['telecrm', 'pms', 'razorpay']) {
    assert.equal(httpConnectors.has(id), false, `${id} must not claim a connector it does not have`);
  }
  assert.equal(httpConnectors.has('meta_ads'), true);
});

/* ── the shape reaching the rest of the pipeline ────────────────────────── */

/* A whole pull covers four kinds against two different edges, so the stub has
   to answer per endpoint the way Meta does. */
function accountStub() {
  return async (url) => {
    const body = url.includes('/adcreatives')
      ? page([{ id: 'CR-9021', name: 'UGC video 03' }])
      : page([{
        campaign_id: '23851', adset_id: '88101', ad_id: '99201',
        date_start: '2026-07-14', account_currency: 'INR', spend: '1',
      }]);
    return { ok: true, status: 200, json: async () => body };
  };
}

/* Live rows and fixture rows must key identically, or re-pulling a day would
   duplicate it instead of replacing it. */
test('a live row keys the same way a fixture row does', async () => {
  const pulled = await connectors.get('meta_ads')
    .pull(null, httpTransport({ credentials: CREDS, fetchImpl: accountStub() }));

  const byKind = Object.fromEntries(pulled.map((r) => [r.kind, r.externalId]));
  assert.equal(byKind.campaign_day, '23851:2026-07-14');
  assert.equal(byKind.adset_day, '88101:2026-07-14');
  assert.equal(byKind.ad_day, '99201:2026-07-14');
  /* Meta names a creative's id plainly `id`. */
  assert.equal(byKind.creative, 'CR-9021');
});

test('a pull covers every kind the source declares', async () => {
  const pulled = await connectors.get('meta_ads')
    .pull(null, httpTransport({ credentials: CREDS, fetchImpl: accountStub() }));

  assert.deepEqual([...new Set(pulled.map((r) => r.kind))].sort(), META.kinds.slice().sort());
});

test('stage 2 reads date_start, account_currency and actions', () => {
  const mapped = canonical.MAPPERS.meta_ads.campaign_day({
    campaign_id: '23851',
    campaign_name: 'meta | Munnar Honeymoon — JUL',
    date_start: '2026-07-14',
    date_stop: '2026-07-14',
    account_currency: 'INR',
    spend: '7000.50',
    impressions: '148200',
    clicks: '3140',
    actions: [
      { action_type: 'link_click', value: '3140' },
      { action_type: 'lead', value: '21' },
    ],
  });

  assert.equal(mapped.date.value, '2026-07-14');
  /* Paise — the trap this codebase already has a regression test for. */
  assert.equal(mapped.spend.value, 700050);
  assert.equal(mapped.leads.value, 21);
});

test('leads absent entirely is unknown, not zero', () => {
  const mapped = canonical.MAPPERS.meta_ads.campaign_day({
    campaign_id: '1', date_start: '2026-07-14', account_currency: 'INR', spend: '10',
  });
  assert.equal(mapped.leads.value, null, 'a row that never reported actions did not report no leads');
});

test('actions present but carrying no lead type is a real zero', () => {
  const mapped = canonical.MAPPERS.meta_ads.campaign_day({
    campaign_id: '1', date_start: '2026-07-14', account_currency: 'INR', spend: '10',
    actions: [{ action_type: 'link_click', value: '12' }],
  });
  assert.equal(mapped.leads.value, 0);
});

test('the fixture spelling still maps, so replay is unaffected', () => {
  const mapped = canonical.MAPPERS.meta_ads.campaign_day({
    campaign_id: '23851', campaign_name: '  meta | Munnar Honeymoon — JUL  ',
    date: '2026-07-14', currency: 'INR', spend: '₹7,000', impressions: 148200, clicks: 3140, leads: 21,
  });

  assert.equal(mapped.date.value, '2026-07-14');
  assert.equal(mapped.spend.value, 700000);
  assert.equal(mapped.leads.value, 21);
});
