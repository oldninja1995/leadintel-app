const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Annotations } = require('../lib/annotations');

const fresh = () => new Annotations(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'li-notes-')), 'a.json'));

test('notes are shared per workspace, newest date first, and need text', () => {
  const a = fresh();
  a.add('ws', { campaign: 'A', date: '2026-10-01', text: 'raised budget', by: 'Anand' });
  a.add('ws', { campaign: null, date: '2026-10-05', text: 'Diwali week', by: 'Dhanya' });
  a.add('other', { campaign: 'A', date: '2026-10-09', text: 'not ours', by: 'X' });
  assert.deepEqual(a.list('ws').map((n) => n.text), ['Diwali week', 'raised budget']);
  assert.deepEqual(a.list('ws', { campaign: 'A' }).map((n) => n.text), ['raised budget']);
  assert.throws(() => a.add('ws', { text: '   ' }), /needs some text/);
});

test('only the author, or the owner, may delete a note', () => {
  const a = fresh();
  const n = a.add('ws', { campaign: 'A', date: '2026-10-01', text: 'x', by: 'Anand' });
  assert.throws(() => a.remove('ws', n.id, { by: 'Dhanya' }), /only the person who wrote/);
  assert.equal(a.remove('ws', n.id, { by: 'Dhanya', allowAny: true }), true);
  assert.equal(a.list('ws').length, 0);
});
