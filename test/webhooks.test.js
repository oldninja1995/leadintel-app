/* The webhook credential.
 *
 * What these check is mostly *refusal*: this is the one door in the app that a
 * stranger is expected to knock on, so the interesting cases are the ones that
 * must not open it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Webhooks } = require('../lib/auth/webhooks');

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-hooks-')), 'webhooks.json');
const fresh = () => new Webhooks({ file: temp() });

test('a minted token verifies to its own workspace and source', () => {
  const hooks = fresh();
  const { token } = hooks.mint('parakkat', 'telecrm', { by: 'anand' });

  const claim = hooks.verify(token);
  assert.equal(claim.workspace, 'parakkat');
  assert.equal(claim.source, 'telecrm');
});

/* The invariant the rest of the app depends on: a workspace is never taken from
   the request. For a webhook there is no session to take it from either, so it
   has to come from the credential — and must not be forgeable by changing one. */
test('the workspace comes from the token, so another tenant cannot be reached with it', () => {
  const hooks = fresh();
  const { token } = hooks.mint('parakkat', 'telecrm');
  const other = hooks.mint('kestrel', 'telecrm');

  assert.equal(hooks.verify(token).workspace, 'parakkat');
  assert.equal(hooks.verify(other.token).workspace, 'kestrel');
  assert.notEqual(token, other.token);
});

test('the token is never stored — only proof that one matches', () => {
  const file = temp();
  const hooks = new Webhooks({ file });
  const { token } = hooks.mint('parakkat', 'telecrm');

  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes(token), 'the raw token must not be recoverable from the store');
  /* And the secret half specifically, in case the format ever changes. */
  assert.ok(!onDisk.includes(token.split('_')[2]));
});

test('a forged, malformed or unknown token is refused, all the same way', () => {
  const hooks = fresh();
  hooks.mint('parakkat', 'telecrm');

  assert.equal(hooks.verify('lihook_deadbeef_nope'), null);
  assert.equal(hooks.verify('not-a-token'), null);
  assert.equal(hooks.verify(''), null);
  assert.equal(hooks.verify(null), null);
  assert.equal(hooks.verify({}), null);
});

test('the right id with the wrong secret is refused', () => {
  const hooks = fresh();
  const { token, id } = hooks.mint('parakkat', 'telecrm');
  assert.ok(token.includes(id));

  assert.equal(hooks.verify(`lihook_${id}_${'0'.repeat(48)}`), null);
});

test('minting again replaces rather than adds, so a leaked token stops working', () => {
  const hooks = fresh();
  const first = hooks.mint('parakkat', 'telecrm');
  const second = hooks.mint('parakkat', 'telecrm');

  assert.equal(second.replaced, true);
  assert.equal(hooks.verify(first.token), null, 'the replaced token must be dead');
  assert.ok(hooks.verify(second.token));
});

test('revoking refuses everything afterwards', () => {
  const hooks = fresh();
  const { token } = hooks.mint('parakkat', 'telecrm');

  assert.equal(hooks.revoke('parakkat', 'telecrm'), true);
  assert.equal(hooks.verify(token), null);
  assert.equal(hooks.revoke('parakkat', 'telecrm'), false, 'revoking twice is not an error');
});

/* The distinction the Connections screen exists to draw. */
test('deliveries and records are counted apart, so silence and noise differ', () => {
  const hooks = fresh();
  const { id } = hooks.mint('parakkat', 'telecrm');

  assert.deepEqual(
    { d: hooks.describe('parakkat', 'telecrm').deliveries, r: hooks.describe('parakkat', 'telecrm').records },
    { d: 0, r: 0 }
  );

  hooks.recordDelivery(id, { records: 3 });
  hooks.recordDelivery(id, { records: 0 });

  const described = hooks.describe('parakkat', 'telecrm');
  assert.equal(described.deliveries, 2, 'both arrived');
  assert.equal(described.records, 3, 'only one carried anything');
  assert.ok(described.lastDeliveryAt);
});

test('describe never returns the token', () => {
  const hooks = fresh();
  const { token } = hooks.mint('parakkat', 'telecrm', { by: 'anand' });
  const described = hooks.describe('parakkat', 'telecrm');

  assert.ok(!JSON.stringify(described).includes(token));
  assert.equal(described.minted, true);
  assert.equal(described.createdBy, 'anand');
});

test('an unminted source describes as absent rather than throwing', () => {
  const described = fresh().describe('parakkat', 'razorpay');
  assert.equal(described.minted, false);
  assert.equal(described.deliveries, 0);
});

test('a token must name a workspace and a source', () => {
  const hooks = fresh();
  assert.throws(() => hooks.mint(null, 'telecrm'), /workspace/);
  assert.throws(() => hooks.mint('parakkat', null), /source/);
});

test('tokens survive a reload, since the store is the record', () => {
  const file = temp();
  const { token } = new Webhooks({ file }).mint('parakkat', 'telecrm');

  assert.equal(new Webhooks({ file }).verify(token).workspace, 'parakkat');
});
