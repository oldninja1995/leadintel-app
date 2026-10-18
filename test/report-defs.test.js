const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReportDefs } = require('../lib/report-defs');

const fresh = () => new ReportDefs(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'li-rd-')), 'r.json'));

test('every change to a dashboard records a version, and restore brings a version back', () => {
  const d = fresh();
  const r = d.create('ws', { name: 'Owner', from: 'executive', by: 'A' });
  const start = r.widgets.length;
  d.addWidget('ws', r.id, { kind: 'kpi', ref: 'ads.spend' }, 'A');
  const after = d.report('ws', r.id);
  assert.equal(after.widgets.length, start + 1);
  assert.deepEqual(after.versions.map((v) => v.v), [1, 2]);
  d.restore('ws', r.id, 1, 'B');
  assert.equal(d.report('ws', r.id).widgets.length, start);
  assert.equal(d.report('ws', r.id).versions.slice(-1)[0].note, 'restored version 1');
});

test('comments live per report and survive saving dashboards and bookmarks', () => {
  const d = fresh();
  d.comment('ws', 'tpl:owner', { text: 'Diwali dip expected', by: 'A' });
  d.create('ws', { name: 'X', by: 'A' });
  d.bookmark('ws', { name: 'Booked', url: '/leads?progress=booked', by: 'A' });
  assert.deepEqual(d.comments('ws', 'tpl:owner').map((c) => c.text), ['Diwali dip expected']);
  const [c] = d.comments('ws', 'tpl:owner');
  assert.throws(() => d.uncomment('ws', 'tpl:owner', c.id, { by: 'B' }), /only the person who wrote/);
  assert.equal(d.uncomment('ws', 'tpl:owner', c.id, { by: 'B', allowAny: true }), true);
});

test('a bookmark must be a page in this app', () => {
  assert.throws(() => fresh().bookmark('ws', { name: 'x', url: 'https://evil.example' }), /only a page in this app/);
});
