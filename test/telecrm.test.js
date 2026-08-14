/* TeleCRM's Sync API — the request shape, written from docs.telecrm.in/sync.
 *
 *   node --test test/telecrm.test.js
 *
 * What these hold in place is mostly the things that were *wrong* for five
 * sessions: which host serves reads, that a token type is not the same as a
 * credential, that "no read API" was a claim about the wrong document. The
 * paging tests exist because actions hang off a lead and the walk between them
 * is the only stateful thing in any connector here.
 */

const test = require('node:test');
const assert = require('node:assert');

const telecrm = require('../lib/ingest/http/telecrm');
const httpConnectors = require('../lib/ingest/http');
const { httpTransport } = require('../lib/ingest/transport');
const sources = require('../lib/ingest/sources');

const CREDS = { enterpriseId: 'ent123', apiKey: 'tok_abc' };
const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' };

const json = (body, status = 200) => ({ status, async json() { return body; } });

/* ── which host ─────────────────────────────────────────────────────────── */

test('reads go to the sync host, not the async one', () => {
  assert.equal(telecrm.baseFrom({}), 'https://next.telecrm.in/autoupdate/v2');
});

test('a stored async host is corrected rather than obeyed', () => {
  /* The old form hint. Obeying it fails as a 401/404 that reads exactly like a
     bad token, which is the whole reason this connection looked broken. */
  assert.equal(
    telecrm.baseFrom({ baseUrl: 'https://next-api.telecrm.in' }),
    'https://next.telecrm.in/autoupdate/v2'
  );
});

test('a host without the api prefix gains it', () => {
  assert.equal(
    telecrm.baseFrom({ baseUrl: 'https://next.telecrm.in' }),
    'https://next.telecrm.in/autoupdate/v2'
  );
});

test('a genuinely different base is honoured', () => {
  assert.equal(telecrm.baseFrom({ baseUrl: 'https://crm.internal/v2/' }), 'https://crm.internal/v2');
});

/* ── the window ─────────────────────────────────────────────────────────── */

test('the window is sent as epoch milliseconds, not a formatted date', async () => {
  /* The API accepts "the workspace-defined format", and the spec's own examples
     disagree about what that is. A workspace on MM/DD/YYYY would read 03/04 as
     March 4th where we meant April 3rd — weeks of missing data, no error. */
  const req = await telecrm.request({ kind: 'lead', window: WINDOW, credentials: CREDS });
  const body = JSON.parse(req.body);
  assert.equal(typeof body.fields.created_on.from, 'number');
  assert.equal(body.fields.created_on.from, Date.parse(WINDOW.from));
});

test('the half-open window loses a millisecond, not a day', () => {
  /* Meta and Google need `to` stepped back a whole day because they take dates.
     These are timestamps: stepping back a day would drop the last day of every
     pull. */
  const range = telecrm.createdOn(WINDOW);
  assert.equal(range.to, Date.parse(WINDOW.to) - 1);
});

test('no window means no filter rather than an empty one', async () => {
  const req = await telecrm.request({ kind: 'lead', window: null, credentials: CREDS });
  assert.deepEqual(JSON.parse(req.body), { fields: {} });
});

/* ── identity ───────────────────────────────────────────────────────────── */

test('a lead id is taken from whichever spelling the response uses', () => {
  assert.equal(telecrm.leadIdOf({ _id: 'a1' }), 'a1');
  assert.equal(telecrm.leadIdOf({ id: 'b2' }), 'b2');
});

test('a lead with no id falls back to phone, which is TeleCRM\'s own default identity', () => {
  /* Not a guess: the async docs state leads are identified by the workspace's
     unique identifier field, default phone. The documented search response
     carries no id at all. */
  assert.equal(telecrm.leadIdOf({ fields: { phone: '+919400000001' } }), '+919400000001');
});

test('a lead with neither id nor phone is dropped, not stored under a synthetic key', () => {
  /* A synthetic key would duplicate the same lead on every pull for ever. */
  assert.equal(telecrm.leadIdOf({ fields: { name: 'No Contact' } }), null);
  const { rows } = telecrm.extract({ data: [{ fields: { name: 'No Contact' } }], total_count: 1 }, { kind: 'lead' });
  assert.equal(rows.length, 0);
});

/* ── mapping ────────────────────────────────────────────────────────────── */

test('a lead is flattened into the spelling canonical reads', () => {
  const body = telecrm.leadBody({
    _id: 'l1',
    created_on: 1786000000000,
    fields: {
      name: 'Asha R', phone: '+919400000002', email: 'a@example.com',
      status: 'Fresh', assignee: 'anand@example.com', utm_campaign: 'Munnar Honeymoon',
    },
  });

  assert.equal(body.lead_id, 'l1');
  assert.equal(body.stage, 'Fresh', 'status is what canonical calls stage');
  assert.equal(body.owner, 'anand@example.com');
  assert.equal(body.campaign, undefined, 'canonical reads utm_campaign, not campaign');
  assert.equal(body.utm_campaign, 'Munnar Honeymoon');
  assert.equal(body.created_at, new Date(1786000000000).toISOString());
});

test('the whole original row is kept, so an unknown custom field is not lost', () => {
  const row = { _id: 'l1', fields: { phone: '+91', jacuzzi_interest: 'yes' } };
  assert.equal(telecrm.leadBody(row).raw.fields.jacuzzi_interest, 'yes');
});

test('seconds and milliseconds are both read as the same instant', () => {
  assert.equal(telecrm.isoFrom(1786000000), telecrm.isoFrom(1786000000000));
});

/* ── paging ─────────────────────────────────────────────────────────────── */

test('paging stops when the count is reached rather than trusting the echo', () => {
  const first = telecrm.extract({ data: [{ _id: 'a' }, { _id: 'b' }], total_count: 3, skip: 0 }, { kind: 'lead' });
  assert.deepEqual(first.nextCursor, { skip: 2 });

  const second = telecrm.extract({ data: [{ _id: 'c' }], total_count: 3 }, { kind: 'lead', cursor: { skip: 2 } });
  assert.equal(second.nextCursor, null);
});

test('an API that ignores skip and limit stops after one page instead of spinning', () => {
  /* Neither is documented as an input — only echoed back — so the loop must not
     depend on them being honoured. */
  const out = telecrm.extract({ data: [{ _id: 'a' }, { _id: 'b' }], total_count: 2 }, { kind: 'lead' });
  assert.equal(out.nextCursor, null);
});

/* ── actions walk one lead at a time ────────────────────────────────────── */

test('lead_event starts by fetching leads and produces no rows from that page', () => {
  const out = telecrm.extract({ data: [{ _id: 'l1' }, { _id: 'l2' }], total_count: 2 }, { kind: 'lead_event' });
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.nextCursor, { leads: ['l1', 'l2'], at: 0, skip: 0 });
});

test('lead_event walks to the next lead when one is exhausted', () => {
  const cursor = { leads: ['l1', 'l2'], at: 0, skip: 0 };
  const out = telecrm.extract({ data: [{ id: 'a1', type: 'INCOMING_CALL' }], total_count: 1 }, { kind: 'lead_event', cursor });

  assert.equal(out.rows[0].lead_id, 'l1', 'an action page does not say which lead it belongs to');
  assert.deepEqual(out.nextCursor, { leads: ['l1', 'l2'], at: 1, skip: 0 });
});

test('lead_event finishes after the last lead', () => {
  const cursor = { leads: ['l1'], at: 0, skip: 0 };
  const out = telecrm.extract({ data: [{ id: 'a1' }], total_count: 1 }, { kind: 'lead_event', cursor });
  assert.equal(out.nextCursor, null);
});

test('lead_event pages within one lead before moving on', () => {
  const cursor = { leads: ['l1', 'l2'], at: 0, skip: 0 };
  const out = telecrm.extract({ data: [{ id: 'a1' }, { id: 'a2' }], total_count: 5 }, { kind: 'lead_event', cursor });
  assert.deepEqual(out.nextCursor, { leads: ['l1', 'l2'], at: 0, skip: 2 });
});

test('an action request is addressed to the lead the cursor is on', async () => {
  const req = await telecrm.request({
    kind: 'lead_event', window: WINDOW, credentials: CREDS, cursor: { leads: ['l1', 'l9'], at: 1, skip: 0 },
  });
  assert.ok(req.url.includes('/lead/l9/action/search'), req.url);
});

/* ── deals are derived, and only from the workspace's own pipeline ──────── */

test('a deal is a lead that left the open stages, read from the pipeline', async () => {
  telecrm.clearPipelineCache();
  const fetchImpl = async () => json({
    leadStages: [
      { stageid: 's1', stageType: 'OPEN', activeStatuses: [{ statusid: 1, label: 'Fresh' }] },
      { stageid: 's2', stageType: 'WON', activeStatuses: [{ statusid: 2, label: 'Booked' }] },
      { stageid: 's3', stageType: 'LOST', activeStatuses: [{ statusid: 3, label: 'Dropped' }] },
    ],
  });
  await telecrm.request({ kind: 'deal', window: WINDOW, credentials: CREDS, fetchImpl });

  const { rows } = telecrm.extract({
    data: [
      { _id: 'l1', fields: { status: 'Fresh' } },
      { _id: 'l2', fields: { status: 'Booked' } },
      { _id: 'l3', fields: { status: 'Dropped' } },
    ],
    total_count: 3,
  }, { kind: 'deal' });

  assert.deepEqual(rows.map((r) => [r.deal_id, r.outcome]), [['l2', 'won'], ['l3', 'lost']]);
});

test('an open lead is not a deal worth zero', () => {
  /* Emitting one would put a zero into every conversion figure reading deals. */
  telecrm.clearPipelineCache();
  const { rows } = telecrm.extract({ data: [{ _id: 'l1', fields: { status: 'Fresh' } }], total_count: 1 }, { kind: 'deal' });
  assert.equal(rows.length, 0);
});

test('a deal never carries an invented amount', async () => {
  telecrm.clearPipelineCache();
  const fetchImpl = async () => json({
    leadStages: [{ stageid: 's2', stageType: 'WON', activeStatuses: [{ statusid: 2, label: 'Booked' }] }],
  });
  await telecrm.request({ kind: 'deal', window: WINDOW, credentials: CREDS, fetchImpl });

  const { rows } = telecrm.extract({ data: [{ _id: 'l2', fields: { status: 'Booked' } }], total_count: 1 }, { kind: 'deal' });
  /* The PMS folio is the authority on revenue — the precedence table says so.
     A number here would outrank nothing and mislead everything. */
  assert.equal(rows[0].value, null);
});

/* ── errors name the right half of the credential ───────────────────────── */



test('a 404 points at the base URL rather than the token', () => {
  assert.throws(
    () => telecrm.checkForError({}, { status: 404 }),
    /base URL/
  );
});

test('a clean payload raises nothing', () => {
  assert.doesNotThrow(() => telecrm.checkForError({ data: [], total_count: 0 }, { status: 200 }));
});

/* ── through the transport, the way a sync actually runs ────────────────── */

test('the registry now offers telecrm a request shape', () => {
  assert.equal(httpConnectors.has('telecrm'), true);
});

test('a whole lead pull reaches the store shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    return json({
      data: [{ _id: 'l1', created_on: Date.parse('2026-08-02T10:00:00.000Z'), fields: { name: 'Asha R', phone: '+919400000002', status: 'Fresh' } }],
      total_count: 1,
    });
  };

  const transport = httpTransport({ credentials: CREDS, fetchImpl });
  const rows = await transport.fetch({ source: sources.get('telecrm'), kind: 'lead', window: WINDOW });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].lead_id, 'l1');
  assert.ok(calls[0].startsWith('https://next.telecrm.in/autoupdate/v2/enterprise/ent123/lead/search'), calls[0]);
});

test('a missing credential field is named rather than sent empty', async () => {
  const transport = httpTransport({ credentials: { enterpriseId: 'ent123' }, fetchImpl: async () => json({}) });
  await assert.rejects(
    transport.fetch({ source: sources.get('telecrm'), kind: 'lead', window: WINDOW }),
    /missing apiKey/
  );
});

test('the base URL is not required, so a connection predating this file still works', () => {
  assert.equal(telecrm.requires.includes('baseUrl'), false);
});

test('an error body that is an object is serialised, not stringified to [object Object]', () => {
  /* TeleCRM answers 401 with an object under `error`. Concatenating it printed
     "[object Object]" and threw away the only diagnostic in the response. */
  assert.throws(
    () => telecrm.checkForError({ error: { code: 'TOKEN_TYPE', detail: 'async token' } }, { status: 401 }),
    /TOKEN_TYPE/
  );
});

/* ── a refusal must name the right half of the credential ───────────────── */

/* TeleCRM returns one code, NOT_AUTHORIZED, for two unrelated mistakes. Which
   hint it produces decides whether somebody fixes a field or burns one of their
   three allowed tokens regenerating a credential that was never wrong. */

/* `assert.throws` does not hand the error back, and its wording is the whole
   subject of these. */
const refusal = (payload, status) => {
  try {
    telecrm.checkForError(payload, { status });
  } catch (err) {
    return err;
  }
  throw new Error('checkForError did not throw');
};

test('a refusal that names the enterprise id points at the enterprise id', () => {
  /* The live failure: TeleCRM said it could not find the enterprise, and the
     stored id was a token pasted into the wrong field. An error blaming the
     token would have sent somebody to regenerate a perfectly good one — and
     TeleCRM only issues three. */
  const err = refusal({
    error: { code: 'NOT_AUTHORIZED', message: 'Enterprise with id "abc:def" not found or invalid access token.' },
  }, 401);
  assert.match(err.message, /enterprise id/i);
  assert.doesNotMatch(err.message, /created with type/i, 'blamed the token for an enterprise id TeleCRM could not find');
});

test('a refusal that names nothing specific falls back to the token type', () => {
  assert.match(refusal({ message: 'invalid token' }, 401).message, /Sync/);
});

test('the vendor\'s own sentence survives into the error either way', () => {
  assert.match(refusal({ message: 'invalid token' }, 401).message, /invalid token/);
});

test('a 404 points at the base URL rather than the token', () => {
  assert.throws(() => telecrm.checkForError({}, { status: 404 }), /base URL/);
});

test('a clean payload raises nothing', () => {
  assert.doesNotThrow(() => telecrm.checkForError({ data: [], total_count: 0 }, { status: 200 }));
});
