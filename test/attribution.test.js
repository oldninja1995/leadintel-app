/* Phase 5 sub-phase 5.2 — attribution as a workspace parameter.
 *
 *   node --test        or        npm test
 *
 * The workspace persists to disk, so every test here gets its own file. A test
 * that wrote to `var/workspace.json` would change how the running app credits
 * revenue, which is precisely the blast radius this sub-phase is about.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const attribution = require('../lib/attribution');
const { Workspace, MODELS, DEFAULT, impact, credit, isModel } = attribution;

const tmpWorkspace = () => new Workspace(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-ws-')), 'workspace.json'));
const AT = '2026-08-05T12:00:00.000Z';

/* ── the setting ────────────────────────────────────────────────────────── */

test('a fresh workspace uses the design\'s default model', () => {
  const ws = tmpWorkspace();
  assert.equal(ws.model(), DEFAULT);
  assert.equal(ws.state().changedAt, null, 'a default was recorded as if someone had chosen it');
  assert.deepEqual(ws.state().history, []);
});

test('applying a model persists it', () => {
  const ws = tmpWorkspace();
  ws.apply('first', { justification: 'testing discovery credit', at: AT });

  assert.equal(ws.model(), 'first');
  assert.equal(ws.state().changedAt, AT);
  assert.equal(new Workspace(ws.file).model(), 'first', 'the setting did not survive a reload');
});

test('a change records where it came from, where it went, and why', () => {
  const ws = tmpWorkspace();
  const change = ws.apply('last', { justification: 'board wants a conservative view', at: AT });

  assert.equal(change.from, DEFAULT);
  assert.equal(change.to, 'last');
  assert.equal(change.justification, 'board wants a conservative view');
  assert.ok(change.impact, 'a change was recorded without the impact it had');
});

test('history is newest first and survives reload', () => {
  const ws = tmpWorkspace();
  ws.apply('first', { at: AT });
  ws.apply('linear', { at: AT });

  const history = new Workspace(ws.file).state().history;
  assert.equal(history.length, 2);
  assert.equal(history[0].to, 'linear', 'the oldest change was listed first');
  assert.equal(history[1].to, 'first');
});

test('an unknown model is refused rather than silently defaulted', () => {
  const ws = tmpWorkspace();
  assert.throws(() => ws.apply('shapley-ish'), /unknown attribution model/);
  assert.equal(ws.model(), DEFAULT, 'a rejected change still moved the setting');
});

/* ── justification ──────────────────────────────────────────────────────── */

test('the custom model cannot be applied without a written reason', () => {
  /* The page's own words: "Your weights; requires justification". */
  const ws = tmpWorkspace();
  assert.throws(() => ws.apply('custom'), /cannot be applied without a written justification/);
  assert.throws(() => ws.apply('custom', { justification: '   ' }), /written justification/);
  assert.equal(ws.model(), DEFAULT);
});

test('the custom model applies once a reason is given', () => {
  const ws = tmpWorkspace();
  ws.apply('custom', { justification: 'GM signed off on 50/30/20', at: AT });
  assert.equal(ws.model(), 'custom');
});

test('the other six models record a reason but do not require one', () => {
  for (const key of attribution.ORDER.filter((k) => k !== 'custom')) {
    const ws = tmpWorkspace();
    ws.apply(key, { at: AT });
    assert.equal(ws.model(), key, `${key} demanded a justification it should not`);
    assert.equal(ws.state().justification, null);
  }
});

/* ── impact preview ─────────────────────────────────────────────────────── */

test('the preview names the channel that moves most, and which way', () => {
  const preview = impact('datadriven', 'last');
  assert.equal(preview.headline, 'direct gains 9.4L');
  assert.equal(preview.metaRoasFrom, '4.8x');
  assert.equal(preview.metaRoasTo, '2.9x');
});

test('every channel is shown moving, with direction', () => {
  const preview = impact('datadriven', 'last');
  const meta = preview.channels.find((c) => c.channel === 'meta');
  assert.equal(meta.from, '₹18.9L');
  assert.equal(meta.to, '₹14.1L');
  assert.equal(meta.delta, '−4.8L');
  assert.equal(meta.direction, 'down');

  const direct = preview.channels.find((c) => c.channel === 'direct');
  assert.equal(direct.direction, 'up');
});

test('a channel that barely moves is flat, not noise', () => {
  const preview = impact('datadriven', 'last');
  assert.equal(preview.channels.find((c) => c.channel === 'email').direction, 'flat');
});

test('previewing the model already in force says nothing changes', () => {
  const preview = impact('linear', 'linear');
  assert.equal(preview.unchanged, true);
  assert.equal(preview.headline, 'no channel moves materially');
});

test('the preview flags a candidate that will demand a justification', () => {
  assert.equal(impact('linear', 'custom').requiresJustification, true);
  assert.equal(impact('linear', 'first').requiresJustification, false);
});

test('attribution reapportions revenue, it does not create or destroy it', () => {
  /* Every model credits the same ₹52.3L — the July net revenue the design
     states — give or take a 0.1 rounding artefact from its one-decimal
     figures. That invariant is the sanity check on the whole table: a model
     that credited a different total would not be an attribution model. */
  /* Rounded before comparing: summing one-decimal figures in binary floating
     point leaves 52.30000000000001, and a test that failed on that would be
     testing IEEE 754 rather than the design's table. */
  const totals = attribution.ORDER.map((k) => Number(attribution.total(MODELS[k]).toFixed(2)));
  const spread = Number((Math.max(...totals) - Math.min(...totals)).toFixed(2));
  assert.ok(spread <= 0.1, `models credit totals spanning ${spread}L — one of them is not reapportioning`);
  for (const t of totals) {
    const off = Number(Math.abs(t - 52.3).toFixed(2));
    assert.ok(off <= 0.1, `a model credits ₹${t.toFixed(1)}L, not the stated ₹52.3L`);
  }
});

test('the preview reports both totals, so the rounding is visible not hidden', () => {
  const preview = impact('first', 'decay');
  assert.equal(preview.totalFrom, '₹52.3L');
  assert.equal(preview.totalTo, '₹52.4L');
});

test('an unknown model has no impact to show', () => {
  assert.throws(() => impact('datadriven', 'nope'), /two known models/);
});

/* ── credit ─────────────────────────────────────────────────────────────── */

test('credit shares sum to a hundred percent', () => {
  for (const key of attribution.ORDER) {
    const sum = credit(key).reduce((t, c) => t + parseFloat(c.share), 0);
    assert.ok(Math.abs(sum - 100) < 0.15, `${key} shares sum to ${sum}`);
  }
});

test('credit falls back to the default rather than throwing on a bad key', () => {
  assert.deepEqual(credit('nonsense'), credit(DEFAULT));
});

test('the seven models are the seven the page names', () => {
  assert.deepEqual(attribution.ORDER, ['first', 'last', 'linear', 'position', 'decay', 'datadriven', 'custom']);
  assert.equal(Object.keys(MODELS).length, 7);
  assert.equal(isModel('datadriven'), true);
  assert.equal(isModel('toString'), false, 'an inherited property passed as a model');
});

/* ── the screen reads the workspace, not the URL ────────────────────────── */

const screen = require('../data/attribution');

test('the attribution screen credits by the workspace model', () => {
  const payload = screen.select({ model: 'last' });
  assert.equal(payload.attrModelName, 'Last click');
  assert.equal(payload.attrChannels.find((c) => c.channel === 'Meta Ads').rev, '₹14.1L');
});

test('a preview shows the candidate without the workspace having changed', () => {
  const payload = screen.select({ model: 'datadriven', preview: 'first' });
  assert.equal(payload.attrModelName, 'First click', 'the preview did not reach the screen');
  assert.equal(payload.attrChannels.find((c) => c.channel === 'Meta Ads').rev, '₹24.1L');
});

test('previewing the active model is not a preview', () => {
  const payload = screen.select({ model: 'linear', preview: 'linear' });
  assert.equal(payload.attrModelName, 'Linear');
  const active = payload.attrModels.find((m) => m.label === 'Linear');
  assert.equal(active.go, '/attribution', 'the active model still linked to its own preview');
});

test('the model buttons offer previews, not direct application', () => {
  const payload = screen.select({ model: 'datadriven' });
  for (const button of payload.attrModels.filter((m) => m.label !== 'Data driven')) {
    assert.match(button.go, /\?preview=/, 'a model button applied a change by link');
  }
});

test('an unknown model in params falls back to the default', () => {
  const payload = screen.select({ model: 'nonsense' });
  assert.equal(payload.attrModelName, MODELS[DEFAULT].name);
});

/* ── a broken store must not silently become a choice ───────────────────── */

test('an unreadable workspace file resets to the default and records why', () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(ws.file, '{ not json');

  assert.equal(ws.model(), DEFAULT);
  const [entry] = ws.state().history;
  assert.equal(entry.reset, true, 'a corrupt file was reset with no trace');
  assert.match(entry.justification, /unreadable workspace file/);
});

test('a file naming a model that no longer exists resets too', () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(ws.file, JSON.stringify({ model: 'retired-model' }));
  assert.equal(ws.model(), DEFAULT);
});
