'use strict';

const test = require('node:test');
const assert = require('node:assert');
const thumbSign = require('../lib/http/thumb-sign');

const URL_ = 'https://scontent.xx.fbcdn.net/v/t45/abc.jpg?stp=dst&oh=00_x&oe=6700';
const parse = (q) => Object.fromEntries(new URLSearchParams(q));

test('a signed thumbnail address verifies back to itself', () => {
  const { u, s } = parse(thumbSign.signedQuery('123', URL_));
  assert.strictEqual(thumbSign.verify('123', u, s), URL_);
});

test('the signature is bound to the ad id', () => {
  const { u, s } = parse(thumbSign.signedQuery('123', URL_));
  assert.strictEqual(thumbSign.verify('124', u, s), null);
});

test('a swapped address is refused', () => {
  const { s } = parse(thumbSign.signedQuery('123', URL_));
  const u = Buffer.from('https://evil.example/x.jpg').toString('base64url');
  assert.strictEqual(thumbSign.verify('123', u, s), null);
});

test('missing or malformed parameters are refused, not thrown', () => {
  assert.strictEqual(thumbSign.verify('123', undefined, undefined), null);
  assert.strictEqual(thumbSign.verify('123', '', 'x'), null);
  assert.strictEqual(thumbSign.verify('123', ['a'], 'x'), null);
  assert.strictEqual(thumbSign.verify('123', 'abc', 'short'), null);
});
