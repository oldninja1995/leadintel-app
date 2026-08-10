#!/usr/bin/env node
/* Mint a Google Ads refresh token, locally.
 *
 * Four of the five things `lib/ingest/http/google-ads.js` needs can be copied
 * out of a Google console. The refresh token cannot: it is only ever handed
 * over at the end of a consent flow, once, and only when the request asks for
 * offline access. That is the step this script exists for.
 *
 *   node tools/google-oauth.js <client-id> <client-secret>
 *
 * It prints a URL, waits on a loopback redirect for the code Google sends back,
 * exchanges it, and prints the refresh token. Nothing is stored: the token goes
 * to your terminal and from there into the Connections screen, which encrypts
 * it. This script never writes to `var/`.
 *
 * **Use a "Desktop app" OAuth client.** Loopback redirects are permitted for
 * that type without registering a redirect URI, which is what lets this work
 * with no public hostname. A "Web application" client will refuse the callback
 * unless you add `http://localhost:<port>` to its authorised redirect URIs.
 *
 * Three things make Google withhold a refresh token even on a successful
 * consent, and all three are handled here rather than left to be discovered:
 *   - `access_type=offline` must be set, or you get an access token only.
 *   - `prompt=consent` must be forced, or a *re-*authorisation returns no
 *     refresh token at all — Google issues one per grant, and silently omits it
 *     when the grant already exists. This is the single most common reason for
 *     "it worked but there was no refresh token".
 *   - The Google Ads API must be enabled on the Cloud project behind the
 *     client, or consent succeeds and every later call fails instead.
 */

const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/* The same endpoint the connector exchanges against, so a token minted here is
   redeemable by exactly the code that will use it. */
const TOKEN_URL = require('../lib/ingest/http/google-ads').TOKEN_URL;
const PORT = Number(process.env.PORT || 8765);

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error('usage: node tools/google-oauth.js <client-id> <client-secret>');
  console.error('');
  console.error('The client id ends in .apps.googleusercontent.com and comes from');
  console.error('Google Cloud Console -> APIs & Services -> Credentials -> OAuth client -> Desktop app.');
  process.exit(2);
}

if (!clientId.includes('apps.googleusercontent.com')) {
  console.error(`That does not look like an OAuth client id — they end in .apps.googleusercontent.com.`);
  console.error('If it starts "1//" you have pasted a refresh token; if it is 22 characters you have');
  console.error('pasted the developer token. Both are needed too, but not here.');
  process.exit(2);
}

/* Guards against a stray browser tab completing somebody else's flow into this
   terminal. Checked on the way back and the request refused if it does not
   match. */
const state = crypto.randomBytes(16).toString('hex');
const redirectUri = `http://localhost:${PORT}`;

const authUrl = `${AUTH_URL}?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  state,
})}`;

async function exchange(code) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${payload.error || response.status}: ${payload.error_description || 'no detail given'}`);
  }
  if (!payload.refresh_token) {
    /* Named rather than left as an empty field: this is the failure people hit
       and it looks like success everywhere else. */
    throw new Error(
      'Google returned an access token but no refresh token. That happens when this client has '
      + 'already been granted access — revoke it at https://myaccount.google.com/permissions and run this again.'
    );
  }
  return payload.refresh_token;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }

  const say = (title, detail) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="font-family:system-ui;padding:40px;max-width:520px">`
      + `<h2 style="font-weight:600">${title}</h2><p style="color:#555;line-height:1.6">${detail}</p></body></html>`);
  };

  const error = url.searchParams.get('error');
  if (error) {
    say('Authorisation refused', `Google said: ${error}. Nothing was minted.`);
    console.error(`\nGoogle refused the authorisation: ${error}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  if (url.searchParams.get('state') !== state) {
    say('Refused', 'That callback did not match this run. Nothing was minted.');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) { say('No code', 'Google did not send an authorisation code.'); return; }

  try {
    const refreshToken = await exchange(code);
    say('Done — the token is in your terminal', 'You can close this tab.');
    console.log('\n────────────────────────────────────────────────────────');
    console.log('OAuth refresh token (paste into Connections -> Google Ads):\n');
    console.log(refreshToken);
    console.log('\n────────────────────────────────────────────────────────');
    console.log('It is shown once here and never stored by this script.');
    console.log('You still need: customer id, developer token, and this client id + secret.');
  } catch (err) {
    say('Exchange failed', String(err.message));
    console.error(`\nCould not exchange the code: ${err.message}`);
    process.exitCode = 1;
  }
  server.close();
});

server.listen(PORT, () => {
  console.log('Open this URL, sign in as a user with access to the Google Ads account,');
  console.log('and approve. Waiting for the redirect on ' + redirectUri + '\n');
  console.log(authUrl + '\n');
});
