/* Paste-time credential checks.
 *
 * The failure these exist to prevent: a wrong-but-plausible string stores
 * happily, the screen reads "connected", and the mistake only surfaces against
 * the vendor a quarter of an hour later as "Cannot parse access token" — which
 * names neither the field nor the fix.
 *
 * The risk they introduce is the opposite one, so it is tested harder: a check
 * that refuses a *valid* credential is worse than the error it prevents.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Connections } = require('../lib/connections');

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-creds-')), 'connections.json');
const fresh = () => new Connections({ file: temp(), secret: 'test-secret' });

/* Shaped like the real thing: EAA prefix, several hundred characters. */
const REAL_META_TOKEN = `EAA${'x'.repeat(180)}`;

const setMeta = (store, accessToken, accountId = 'act_1234567890') =>
  store.set('parakkat', 'meta_ads', { accountId, accessToken });

/* ── the wrong credential, caught where it is pasted ────────────────────── */

test('an App Secret in the token box is refused and named', () => {
  assert.throws(
    () => setMeta(fresh(), 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'),
    /App Secret or Client Token/
  );
});

test('an App ID in the token box is refused and named', () => {
  assert.throws(() => setMeta(fresh(), '1234567890123456'), /App ID/);
});

test('a truncated token is refused for being short, not for its prefix', () => {
  assert.throws(() => setMeta(fresh(), 'EAAshort'), /too short/);
});

test('a token that does not start EAA is refused', () => {
  assert.throws(() => setMeta(fresh(), `ya29.${'x'.repeat(100)}`), /does not start with "EAA"/);
});

test('a copy that picked up a line break is refused', () => {
  assert.throws(() => setMeta(fresh(), `EAA${'x'.repeat(180)}\nextra`), /space or line break/);
});

/* The swap is a real mistake and produces a confusing vendor error. */
test('an access token in the account id box is sent to the right field', () => {
  assert.throws(
    () => setMeta(fresh(), REAL_META_TOKEN, REAL_META_TOKEN),
    /belongs in the Access token field/
  );
});

test('an ad account id that is not act_ + digits is refused', () => {
  assert.throws(() => setMeta(fresh(), REAL_META_TOKEN, 'my-account'), /act_ followed by digits/);
});

/* ── the valid credential, which must never be refused ──────────────────── */

test('a real-shaped Meta token and account id are accepted', () => {
  const store = fresh();
  assert.doesNotThrow(() => setMeta(store, REAL_META_TOKEN));
  assert.equal(store.describe('parakkat', 'meta_ads').configured, true);
});

test('an account id without the act_ prefix is accepted, since the connector adds it', () => {
  assert.doesNotThrow(() => setMeta(fresh(), REAL_META_TOKEN, '1234567890'));
});

/* ── the message ────────────────────────────────────────────────────────── */

/* It travels in a redirect URL, so it must describe the value without being
   the value. */
test('the message never contains the rejected value', () => {
  const secret = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  try {
    setMeta(fresh(), secret);
    assert.fail('should have been refused');
  } catch (err) {
    assert.ok(!err.message.includes(secret), 'a refusal must not echo the credential');
    assert.match(err.message, /Access token/, 'but it must name the field');
  }
});

test('every wrong field is reported at once, not one per attempt', () => {
  try {
    fresh().set('parakkat', 'meta_ads', { accountId: 'nonsense', accessToken: '1234567890123456' });
    assert.fail('should have been refused');
  } catch (err) {
    assert.match(err.message, /Ad account id/);
    assert.match(err.message, /Access token/);
  }
});

/* A missing field is a different problem and keeps its own message. */
test('an empty field still reports as missing rather than malformed', () => {
  assert.throws(
    () => fresh().set('parakkat', 'meta_ads', { accountId: 'act_1', accessToken: '' }),
    /needs Access token/
  );
});

/* ── Google, where the five strings are easiest to confuse ──────────────── */

const GOOGLE = {
  customerId: '123-456-7890',
  developerToken: 'devtoken2222222222222',
  refreshToken: '1//0aRefreshToken',
  clientId: '123.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret',
};

test('a valid Google credential set is accepted', () => {
  assert.doesNotThrow(() => fresh().set('parakkat', 'google_ads', GOOGLE));
});

test('the OAuth client id in the developer token box is named', () => {
  assert.throws(
    () => fresh().set('parakkat', 'google_ads', { ...GOOGLE, developerToken: '123.apps.googleusercontent.com' }),
    /OAuth client id, not the developer token/
  );
});

test('the refresh token in the developer token box is named', () => {
  assert.throws(
    () => fresh().set('parakkat', 'google_ads', { ...GOOGLE, developerToken: '1//0aRefreshToken' }),
    /refresh token, not the developer token/
  );
});

test('a client id that is not a Google one is refused', () => {
  assert.throws(
    () => fresh().set('parakkat', 'google_ads', { ...GOOGLE, clientId: 'my-client' }),
    /apps\.googleusercontent\.com/
  );
});

/* Optional fields are only checked when given. */
test('the optional manager id may be omitted entirely', () => {
  assert.doesNotThrow(() => fresh().set('parakkat', 'google_ads', GOOGLE));
});

/* The sources with no checks written must not be blocked by their absence. */
test('a source with no checks stores as before', () => {
  assert.doesNotThrow(() => fresh().set('parakkat', 'pms', { baseUrl: 'https://pms.example', apiKey: 'k' }));
});
