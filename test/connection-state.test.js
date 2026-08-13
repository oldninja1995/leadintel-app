/* What the Connections screen says a source is doing.
 *
 * The failure these exist to prevent is the one that shipped: the state was
 * derived from webhook deliveries alone, so a *polled* source could never be
 * anything but "stored, no data yet" however well it was working. Meta Ads sat
 * that way in production while it was the only connector carrying live data,
 * and TeleCRM sat that way through a day of failing every attempt with a
 * precise, actionable reason nobody could see.
 *
 * So the two directions are tested separately: a working source must be able to
 * say so, and a failing one must never be able to look merely unconfigured.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { stateOf } = require('../lib/connections');

/* One row of SyncRunner.status(), with the shape the screen is handed. */
const sync = (over = {}) => ({
  source: 'meta_ads', name: 'Meta Ads', cadence: { mode: 'poll', every: 900 },
  lastSuccessAt: '2026-08-10T09:34:03.345Z', lastPulled: 240, lastWritten: 12,
  lagSeconds: 184, health: 'ok', due: false, transport: 'http',
  recentFailures: 0, lastError: null,
  ...over,
});

const hook = (over = {}) => ({ minted: true, deliveries: 0, records: 0, ...over });

/* ── a polled source, which had no way to say it was working ────────────── */

test('a polled source pulling real records reads as receiving', () => {
  const { state, label } = stateOf({ configured: true, readable: true, sync: sync() });
  assert.equal(state, 'on');
  assert.equal(label, 'receiving');
});

/* The bug, stated as a test: no webhook must not mean no data. */
test('having no webhook does not make a working source look silent', () => {
  assert.equal(stateOf({ configured: true, readable: true, webhook: null, sync: sync() }).state, 'on');
});

/* A poll that finds nothing new is a normal poll, not a dead connection. */
test('a sync that wrote nothing new still counts as receiving', () => {
  assert.equal(stateOf({ configured: true, readable: true, sync: sync({ lastWritten: 0 }) }).state, 'on');
});

test('a sync that returned nothing at all does not count as receiving', () => {
  assert.equal(stateOf({ configured: true, readable: true, sync: sync({ lastPulled: 0 }) }).state, 'idle');
});

/* The distinction the whole product rests on. Fixtures return records every
   run, so counting them would paint every source green. */
test('records from fixtures never read as receiving', () => {
  const { state } = stateOf({ configured: true, readable: true, sync: sync({ transport: 'fixture' }) });
  assert.equal(state, 'idle');
});

/* ── failure, which had nowhere to appear ───────────────────────────────── */

test('a stored credential whose syncs are failing says so', () => {
  const { state, label } = stateOf({
    configured: true, readable: true,
    sync: sync({ recentFailures: 20, lastError: 'no connector written', health: 'down', lastPulled: 0 }),
  });
  assert.equal(state, 'failing');
  assert.equal(label, 'failing');
});

/* Silence and failure are different incidents: one has errors to read, the
   other has a runner that stopped asking. */
test('a source that has simply stopped syncing is named separately', () => {
  const { state, label } = stateOf({
    configured: true, readable: true,
    sync: sync({ health: 'down', recentFailures: 0, lagSeconds: 90000 }),
  });
  assert.equal(state, 'failing');
  assert.equal(label, 'not syncing');
});

/* Failure outranks a stale success — a source that pulled records this morning
   and has failed every attempt since is failing, not receiving. */
test('recent failures outrank an earlier good sync', () => {
  assert.equal(
    stateOf({ configured: true, readable: true, sync: sync({ recentFailures: 3, lastError: '401' }) }).state,
    'failing'
  );
});

/* The runner asks every source on its cadence, connected or not, so an
   unconfigured source accumulates "no credential stored" errors. That is the
   absence of a connection, not a broken one, and must not be dressed as an
   incident on a card offering an empty form. */
test('errors against a source with no credential still read as not connected', () => {
  const { state, label } = stateOf({
    configured: false, readable: null,
    sync: sync({ recentFailures: 20, lastError: 'no credential stored for Google Ads', health: 'down', lastPulled: 0 }),
  });
  assert.equal(state, 'off');
  assert.equal(label, 'not connected');
});

/* ── the states that already existed, which must not have moved ─────────── */

test('an undecryptable credential outranks everything else', () => {
  const { state, label } = stateOf({
    configured: true, readable: false,
    sync: sync({ recentFailures: 20, lastError: 'boom' }),
  });
  assert.equal(state, 'broken');
  assert.equal(label, 'unreadable');
});

test('a pushing source with deliveries reads as receiving', () => {
  assert.equal(stateOf({ configured: true, readable: true, webhook: hook({ deliveries: 4, records: 9 }) }).state, 'on');
});

test('a minted token with nothing delivered is stored, not connected-looking', () => {
  const { state, label } = stateOf({ configured: false, readable: null, webhook: hook() });
  assert.equal(state, 'idle');
  assert.equal(label, 'stored, no data yet');
});

test('nothing stored and nothing minted is not connected', () => {
  assert.equal(stateOf({ configured: false, readable: null }).state, 'off');
});

/* ── a workspace the sync loop does not serve ───────────────────────────── */

/* Its run log belongs to another tenant. Absent is the honest answer, and it
   must not be read as "never synced" and coloured as a problem. */
test('a workspace with no sync status falls back to what it can see', () => {
  assert.equal(stateOf({ configured: true, readable: true, sync: null }).state, 'idle');
  assert.equal(stateOf({ configured: true, readable: true, sync: null, webhook: hook({ records: 3 }) }).state, 'on');
});

test('a source that failed once and has recovered is not "failing"', () => {
  /* The bug this guards: `recentFailures` counts failures across the last
     twenty runs, so one failure kept the red badge for ever. Meta showed
     "failing" directly above its own line reading "Last succeeded 8 min ago.
     It carried 684 records" — the failure in its window was the run before the
     credential was saved. The card contradicted itself, and the screen was
     believed over the data. */
  const state = stateOf({
    configured: true,
    readable: true,
    sync: {
      health: 'ok',
      transport: 'http',
      lastPulled: 684,
      recentFailures: 1,
      lastError: null,
      priorError: 'meta_ads: every kind failed — no credential stored',
    },
  });

  assert.equal(state.state, 'on');
  assert.equal(state.label, 'receiving');
});

test('a source whose latest run failed still reads "failing"', () => {
  const state = stateOf({
    configured: true,
    readable: true,
    sync: {
      health: 'ok',
      transport: 'http',
      lastPulled: 0,
      recentFailures: 1,
      lastError: 'google_ads: every kind failed — no credential stored',
    },
  });

  assert.equal(state.state, 'failing');
  assert.equal(state.label, 'failing');
});
