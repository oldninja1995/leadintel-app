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

/* Thirty days, not seven: fatigue is a comparison of a creative's recent week
   against its own baseline, and a seven-day pull leaves nothing to compare. */
test('no window falls back to a preset rather than an account\'s whole history', () => {
  const params = new URL(meta.request({ kind: 'campaign_day', window: null, credentials: CREDS }).url).searchParams;
  assert.equal(params.get('date_preset'), 'last_30d');
  assert.equal(params.get('time_range'), null);
});

test('the ad-level request asks for what fatigue, hook and hold need', () => {
  const fields = new URL(meta.request({ kind: 'ad_day', window: null, credentials: CREDS }).url)
    .searchParams.get('fields');

  for (const field of ['frequency', 'cpm', 'video_play_actions', 'video_p100_watched_actions']) {
    assert.ok(fields.includes(field), `ad level must request ${field}`);
  }
});

test('a bare account number is prefixed rather than refused', () => {
  assert.equal(meta.accountPath('1234567890'), 'act_1234567890');
  assert.equal(meta.accountPath('act_1234567890'), 'act_1234567890');
  assert.throws(() => meta.accountPath(''), /ad account id/);
});

/* /adcreatives lists creatives with no reference to the ads running them, and a
   creative with no ad has no spend to show. The ads edge carries the join. */
test('creatives come from the ads edge, so they can be joined to spend', () => {
  const { url } = meta.request({ kind: 'creative', window: null, credentials: CREDS });
  const params = new URL(url).searchParams;

  assert.ok(url.includes('/ads?'), 'must use the ads edge');
  assert.ok(!url.includes('/adcreatives'), 'not the unjoinable creatives edge');
  assert.ok(!url.includes('/insights'));
  assert.ok(params.get('fields').includes('creative'), 'must request the creative link');
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

/* ── asking for too much ────────────────────────────────────────────────── */

/* Ad-level daily rows are the same account multiplied by every ad in it, so
   they cannot use the page size campaign-level can. */
test('a heavier level asks for a smaller page', () => {
  assert.ok(meta.pageSizeFor('ad_day') < meta.pageSizeFor('campaign_day'));
  assert.equal(new URL(meta.request({ kind: 'ad_day', window: null, credentials: CREDS }).url)
    .searchParams.get('limit'), String(meta.PAGE_FOR.ad_day));
});

/* Recognised by wording, because Meta returns it as its generic code 1/99. */
test('"reduce the amount of data" is recognised as a size refusal', () => {
  assert.equal(meta.isTooMuchData(new Error("Please reduce the amount of data you're asking for")), true);
  assert.equal(meta.isTooMuchData(new Error('User request limit reached')), false);
});

test('a size refusal is retried smaller, from the same cursor, and succeeds', async () => {
  const limits = [];
  let refusals = 2;
  const fetchImpl = async (url) => {
    limits.push(Number(new URL(url).searchParams.get('limit')));
    if (refusals-- > 0) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Please reduce the amount of data you're asking for", code: 1, error_subcode: 99 } }),
      };
    }
    return { ok: true, status: 200, json: async () => page([{ ad_id: '1', date_start: '2026-07-14' }]) };
  };

  const rows = await httpTransport({ credentials: CREDS, fetchImpl })
    .fetch({ source: META, kind: 'ad_day', window: null });

  assert.equal(rows.length, 1, 'the pull must still return its rows');
  assert.deepEqual(limits, [100, 25, 10], 'each retry asks for less, down to the floor');
});

/* The bug this guards: retrying re-requests the same page, and on page one the
   cursor is null — a loop keyed on the cursor would read that as "no more
   results" and return nothing at all. */
test('a first-page retry does not end the pull', async () => {
  let refused = false;
  const fetchImpl = async () => {
    if (!refused) {
      refused = true;
      return { ok: false, status: 400, json: async () => ({ error: { message: "Please reduce the amount of data you're asking for" } }) };
    }
    return { ok: true, status: 200, json: async () => page([{ ad_id: '1', date_start: '2026-07-14' }]) };
  };

  const rows = await httpTransport({ credentials: CREDS, fetchImpl })
    .fetch({ source: META, kind: 'ad_day', window: null });

  assert.equal(rows.length, 1, 'the retried first page must still be collected');
});

/* Shrinking for ever would turn a permanent refusal into an infinite loop. */
test('a refusal that never relents is reported rather than retried for ever', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 400, json: async () => ({ error: { message: "Please reduce the amount of data you're asking for" } }) };
  };

  await assert.rejects(
    () => httpTransport({ credentials: CREDS, fetchImpl }).fetch({ source: META, kind: 'ad_day', window: null }),
    /reduce the amount of data/
  );
  assert.ok(calls <= 5, `gave up after ${calls} attempts rather than looping`);
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
    const body = url.includes('/adsets?')
      ? page([{
        id: '88101', name: 'HM · Lookalike 1%', campaign_id: '23851',
        targeting: { custom_audiences: [{ id: '77001' }] },
      }])
      : url.includes('/customaudiences?')
      ? page([{ id: '77001', name: 'All 60 Days KL', subtype: 'ENGAGEMENT', retention_days: 60 }])
      : url.includes('/ads?')
      ? page([{ id: '99201', name: 'UGC video 03', status: 'ACTIVE', creative: { id: 'CR-9021' } }])
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
  /* Keyed by the ad, because that is the unit a creative is measured in. */
  assert.equal(byKind.creative, '99201');
  /* Configuration, keyed with no day in it: re-pulling replaces the row rather
     than adding a second one for today. An ad set's targeting is its current
     state, not a series. */
  assert.equal(byKind.adset, '88101');
  assert.equal(byKind.audience, '77001');
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

/* The ads edge answers with every ad ever created unless told otherwise, and
   expanding a creative for each is what made Meta refuse the request. */
test('the ads request asks only for ads that still exist', () => {
  const { url } = meta.request({ kind: 'creative', window: null, credentials: CREDS });
  const filtering = JSON.parse(new URL(url).searchParams.get('filtering'));

  assert.equal(filtering[0].field, 'ad.effective_status');
  /* Paused is kept deliberately: an ad paused yesterday still spent yesterday. */
  assert.ok(filtering[0].value.includes('PAUSED'));
  assert.ok(!filtering[0].value.includes('ARCHIVED'));
});

test('a refusal names the kind that caused it', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 400,
    json: async () => ({ error: { message: "Please reduce the amount of data you're asking for" } }),
  });

  await assert.rejects(
    () => httpTransport({ credentials: CREDS, fetchImpl }).fetch({ source: META, kind: 'ad_day', window: null }),
    /asking for ad_day/
  );
});

/* Meta's customaudiences edge needs a wider permission than the insights edges
   do, so a token scoped to read performance can fetch every day of spend and
   still be refused the audience list. Under the old bare loop that refusal
   threw the entire pull away, and the account showed a stale store while the
   log filled with one permission error. */
test('one refused kind does not lose the others', async () => {
  const partly = async (url) => {
    if (url.includes('/customaudiences?')) {
      return { ok: false, status: 403, json: async () => ({ error: { message: 'Insufficient permission', code: 200 } }) };
    }
    return accountStub()(url);
  };

  const pulled = await connectors.get('meta_ads')
    .pull(null, httpTransport({ credentials: CREDS, fetchImpl: partly }));

  const kinds = new Set(pulled.map((r) => r.kind));
  assert.ok(kinds.has('ad_day'), 'the spend must survive a refused audience list');
  assert.ok(kinds.has('adset'), 'and so must the targeting');
  assert.ok(!kinds.has('audience'));
  assert.equal(pulled.failures.length, 1);
  assert.match(pulled.failures[0].reason, /permission/i);
});

/* A token that reads nothing is not a quiet account. */
test('every kind failing is still an error', async () => {
  const refuse = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Session has expired' } }) });

  await assert.rejects(
    () => connectors.get('meta_ads').pull(null, httpTransport({ credentials: CREDS, fetchImpl: refuse })),
    /every kind failed/,
  );
});
