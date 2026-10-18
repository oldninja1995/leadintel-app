const test = require('node:test');
const assert = require('node:assert/strict');
const mailer = require('../lib/mailer');

test('recipients: split on commas, spaces or semicolons, checked and de-duplicated', () => {
  assert.deepEqual(mailer.recipients('Owner@x.com, gm@x.com; owner@x.com'), ['owner@x.com', 'gm@x.com']);
  assert.throws(() => mailer.recipients(''), /at least one recipient/);
  assert.throws(() => mailer.recipients('owner@x.com, not-an-address'), /not an email address: not-an-address/);
});

test('Gmail refusals are explained in terms of the App password', () => {
  assert.match(mailer.explain({ response: '535-5.7.8 Username and Password not accepted' }), /App password/);
  assert.match(mailer.explain({ message: '534-5.7.9 Application-specific password required' }), /2-Step Verification/);
});

test('without an Email connection the error says where to add one', async () => {
  await assert.rejects(() => mailer.send({ credentials: null, to: ['a@x.com'], subject: 's', text: 't' }), /Email card in Connections/);
});

test('a message goes to Gmail over TLS from the named sender, App password without spaces', async () => {
  let opts; let mail;
  const transportFor = (o) => { opts = o; return { sendMail: async (m) => { mail = m; return { messageId: 'x', accepted: m.to }; } }; };
  await mailer.send({ credentials: { address: 'reports@x.com', appPassword: 'abcd efgh ijkl mnop', fromName: 'Parakkat Reports' }, to: ['a@x.com'], subject: 'S', text: 'T', attachments: [{ filename: 'r.xlsx', content: Buffer.from('x') }] }, { transportFor });
  assert.equal(opts.host, 'smtp.gmail.com');
  assert.equal(opts.port, 465);
  assert.equal(opts.auth.pass, 'abcdefghijklmnop');
  assert.equal(mail.from, '"Parakkat Reports" <reports@x.com>');
  assert.equal(mail.attachments[0].filename, 'r.xlsx');
});

test('the report email escapes what it is given', () => {
  const data = { title: 'Owner <weekly>', period: 'Oct', generated: '2026-10-18', kpis: [{ label: 'Leads', value: '6,385', delta: '+1%' }], summary: 'a & b', top: [], worst: [], recs: [], campaigns: [] };
  const m = mailer.reportEmail(data, { note: '<script>x</script>', by: 'Anand' });
  assert.equal(m.subject, 'Owner <weekly> · Oct');
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /Owner &lt;weekly&gt;/);
  assert.match(m.text, /Leads: 6,385 \(\+1%\)/);
});
