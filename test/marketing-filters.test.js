/* The topbar chips are built by walking the screen payload for a field named
   `platform` or `channel`. The platform table called its channel `name`, so no
   collection answered any dimension and every chip offered nothing — while
   still rendering as a control somebody could click. */

const test = require('node:test');
const assert = require('node:assert');

const filters = require('../lib/filters');

test('the platform table answers the Channel chip', () => {
  const payload = {
    platforms: [
      { name: 'Meta Ads', channel: 'meta', spend: '₹1.69L' },
      { name: 'Google Ads', channel: 'google', spend: '₹1.17L' },
    ],
  };

  const options = filters.optionsFor(payload);
  assert.deepEqual(options.channel.filter((v) => v !== 'Non-ad').sort(), ['google', 'meta']);
});

test('a platform table without the token offers nothing, which is the bug this guards', () => {
  const options = filters.optionsFor({ platforms: [{ name: 'Google Ads', spend: '₹1.17L' }] });
  assert.equal(options.channel, undefined);
});
