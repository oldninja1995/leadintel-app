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

test('the chip labels a channel the way the table names it', () => {
  /* The value stays the token the URL and scope layer use; only the spelling
     changes. Both maps are the same object, so the table and the filter that
     narrows it cannot disagree. */
  assert.equal(filters.labelsFor('channel').google, 'Google Ads');
  assert.equal(filters.labelsFor('channel').meta, 'Meta Ads');
  assert.deepEqual(filters.labelsFor('property'), {});
});

test('a seeded channel is offered even when no row on the screen carries it', () => {
  /* The Executive Dashboard's campaign table is ranked by spend and truncated,
     so over a full year Meta pushed every Google campaign below the cut and the
     chip stopped offering a platform with real spend in the window. The chip
     sets metricScope and every KPI is recomputed from the entities, so what it
     must reflect is the store, not one table's visible rows. */
  const payload = { campaigns: [{ name: 'Munnar Honeymoon', platform: 'Meta' }] };

  const without = filters.optionsFor(payload);
  assert.ok(!without.channel.includes('google'));

  const seeded = filters.optionsFor(payload, { channel: ['meta', 'google'] });
  const lower = seeded.channel.map((v) => v.toLowerCase());
  assert.ok(lower.includes('google'), 'the seeded channel is offered');

  /* The row's own spelling wins: `applyFilters` compares a selection against
     the row value exactly, so seeding `meta` beside a table carrying `Meta`
     would offer the same platform twice, one of which matches no row. */
  assert.ok(seeded.channel.includes('Meta'));
  assert.ok(!seeded.channel.includes('meta'));
  assert.equal(lower.filter((v) => v === 'meta').length, 1);
});

test('an empty seed changes nothing', () => {
  const payload = { rows: [{ property: 'Munnar Hillside' }] };
  assert.deepEqual(filters.optionsFor(payload, { channel: [] }), filters.optionsFor(payload));
});
