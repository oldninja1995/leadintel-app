const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../lib/telecrm-write');

const CREDS = { enterpriseId: 'ent123', apiKey: 'sync', writeKey: 'async-token' };

test('a ten-digit number is written with India\'s country code, digits only', () => {
  assert.equal(w.phoneFor('98470 12345'), '919847012345');
  assert.equal(w.phoneFor('09847012345'), '919847012345');
  assert.equal(w.phoneFor('+971 50 123 4567'), '971501234567');
});

test('without an Async token the error says exactly what to add and where', async () => {
  await assert.rejects(
    () => w.createLead({ credentials: { enterpriseId: 'ent123', apiKey: 'sync' }, form: { name: 'A', phone: '9847012345' } }),
    /Async token/,
  );
});

test('a lead is posted to the async host with only the filled fields', async () => {
  let call;
  const fetchImpl = async (url, opts) => { call = { url, opts }; return { ok: true, status: 200, text: async () => '{}' }; };
  await w.createLead({ credentials: CREDS, fetchImpl, form: { name: ' Jane ', phone: '98470 12345', email: '', source: 'Walk-in', message: 'Two rooms' } });
  assert.equal(call.url, 'https://next-api.telecrm.in/enterprise/ent123/autoupdatelead');
  assert.equal(call.opts.headers.authorization, 'Bearer async-token');
  assert.deepEqual(JSON.parse(call.opts.body), { fields: { name: 'Jane', phone: '919847012345', source: 'Walk-in', message: 'Two rooms' } });
});

test('a refusal names the token type, and missing name or phone is refused before any call', async () => {
  const deny = async () => ({ ok: false, status: 401, text: async () => '{"message":"NOT_AUTHORIZED"}' });
  await assert.rejects(() => w.createLead({ credentials: CREDS, fetchImpl: deny, form: { name: 'A', phone: '9847012345' } }), /type Async/);
  let called = false;
  const spy = async () => { called = true; return { ok: true, text: async () => '' }; };
  await assert.rejects(() => w.createLead({ credentials: CREDS, fetchImpl: spy, form: { name: '', phone: '12' } }), /a name and a phone/);
  assert.equal(called, false);
});
