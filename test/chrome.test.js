/* Phase 2 — the three controls the design declares but never draws:
 * the filter chips, the notification panel and the ⌘K palette.
 *
 *   node --test        or        npm test
 *
 * The filter tests care most about what filtering *does not* do. Narrowing a
 * table is easy to get right; leaving the totals above it alone, and saying so,
 * is the part that was deliberately not built in Phase 2 and could regress
 * without anything looking broken.
 */

const test = require('node:test');
const assert = require('node:assert');

const filters = require('../lib/filters');
const alerts = require('../lib/alerts');
const palette = require('../lib/palette');

/* Shaped like a real screen payload: rows that carry a dimension, rows that do
   not, and scalars that must survive untouched. */
const payload = () => ({
  headlineRevenue: '₹52.3L',
  occupancy: '78%',
  leadRows: [
    { name: 'Ananya', property: 'Munnar Hillside', platform: 'Meta', campaign: 'Munnar Honeymoon' },
    { name: 'Karthik', property: 'Alleppey Lake Villas', platform: 'Meta', campaign: 'Alleppey Houseboat' },
    { name: 'Meera', property: 'Munnar Hillside', platform: 'Google', campaign: 'Brand search' },
  ],
  ownerRows: [{ owner: 'Reshma', deals: '14' }, { owner: 'Arun', deals: '9' }],
  legend: ['Meta', 'Google'],
});

/* ── Filter chips ───────────────────────────────────────────────────────── */

test('a chip narrows the rows that carry its field', () => {
  const result = filters.applyFilters(payload(), { f_property: 'Munnar Hillside' });
  assert.deepEqual(result.payload.leadRows.map((r) => r.name), ['Ananya', 'Meera']);
  assert.equal(result.dropped, 1);
});

test('rows that do not carry the field are left alone, not emptied', () => {
  const result = filters.applyFilters(payload(), { f_property: 'Munnar Hillside' });
  assert.equal(result.payload.ownerRows.length, 2, 'a table without the field was filtered anyway');
  assert.deepEqual(result.unmatched, ['ownerRows']);
});

test('totals and scalars are never touched', () => {
  const result = filters.applyFilters(payload(), { f_property: 'Munnar Hillside' });
  assert.equal(result.payload.headlineRevenue, '₹52.3L', 'a headline figure was rewritten for a subset');
  assert.equal(result.payload.occupancy, '78%');
  assert.deepEqual(result.payload.legend, ['Meta', 'Google'], 'a scalar list was filtered as if it were rows');
});

test('the note states the limit alongside the effect', () => {
  const note = filters.summarise(filters.applyFilters(payload(), { f_property: 'Munnar Hillside' }));
  assert.equal(note.tables, 1);
  assert.equal(note.dropped, 1);
  assert.equal(note.untouched, 1, 'the note did not count the tables it could not filter');
  assert.deepEqual(note.chips, [{ key: 'property', chip: 'Property', value: 'Munnar Hillside' }]);
});

test('two chips both apply', () => {
  const result = filters.applyFilters(payload(), { f_property: 'Munnar Hillside', f_channel: 'Google' });
  assert.deepEqual(result.payload.leadRows.map((r) => r.name), ['Meera']);
});

test('a selection matching nothing is an empty table, not an unfiltered one', () => {
  const result = filters.applyFilters(payload(), { f_property: 'Nowhere' });
  assert.equal(result.payload.leadRows.length, 0);
  assert.equal(filters.summarise(result).empty, true);
});

test('the repository payload is not mutated', () => {
  const original = payload();
  filters.applyFilters(original, { f_property: 'Munnar Hillside' });
  assert.equal(original.leadRows.length, 3, 'filtering leaked into the shared module object');
});

test('no selection is a pass-through, not a copy that drops keys', () => {
  const original = payload();
  const result = filters.applyFilters(original, {});
  assert.equal(result.payload, original);
  assert.equal(filters.summarise(result), null);
});

test('"All" is not a filter', () => {
  const result = filters.applyFilters(payload(), { f_property: 'All' });
  assert.deepEqual(result.active, {});
  assert.equal(result.payload.leadRows.length, 3);
});

test('options come from the rows, not from a hardcoded list', () => {
  const options = filters.optionsFor(payload());
  assert.deepEqual(options.property, ['Alleppey Lake Villas', 'Munnar Hillside']);
  /* Plus one the rows do not carry: 'not an ad platform' is defined by
     absence, so it has to be offered explicitly. */
  assert.deepEqual(options.channel, ['Google', 'Meta', 'Non-ad']);
  assert.equal(options.room, undefined, 'offered a dimension no row carries');
});

test('a field missing from some rows does not make the table filterable', () => {
  const mixed = { rows: [{ property: 'Munnar Hillside' }, { name: 'no property here' }] };
  const result = filters.applyFilters(mixed, { f_property: 'Munnar Hillside' });
  assert.equal(result.payload.rows.length, 2, 'filtered on a field only some rows carry');
});

test('the inert chip is declared, not silently absent', () => {
  assert.ok(filters.INERT['Booking window'], 'Booking window lost its stated reason');
  assert.ok(!filters.DIMENSIONS.some((d) => d.chip === 'Booking window'), 'an unanswerable chip claims to filter');
});

/* ── Notification panel ─────────────────────────────────────────────────── */

const status = (over = {}) => ({
  source: 'pms', name: 'Property management system', cadence: { every: 900 },
  lastSuccessAt: null, lagSeconds: null, health: 'ok', recentFailures: 0, lastError: null, ...over,
});

test('a healthy pipeline produces no notifications', () => {
  const built = alerts.build({ status: [status({ health: 'ok', lagSeconds: 0 })], problems: [] });
  assert.equal(built.count, 0);
  assert.equal(built.empty, true);
});

test('a down connector is critical and a lagging one is not', () => {
  const built = alerts.build({
    status: [status({ health: 'lagging', lagSeconds: 3000 }), status({ source: 'meta_ads', name: 'Meta Ads', health: 'down', lagSeconds: 9000 })],
    problems: [],
  });
  assert.equal(built.critical, 1);
  assert.equal(built.alerts[0].severity, 'critical', 'the critical alert was not sorted first');
  assert.match(built.alerts[0].title, /Meta Ads has stopped syncing/);
});

test('never-synced is reported as such, not as stale', () => {
  const built = alerts.build({ status: [status({ health: 'never-synced' })], problems: [] });
  assert.match(built.alerts[0].title, /has never synced/);
  assert.match(built.alerts[0].meta, /no successful sync on record/);
  assert.match(built.alerts[0].body, /Nothing received yet/);
  assert.doesNotMatch(built.alerts[0].body, /sync never/, 'a source with no history was described as if it had one');
});

test('the connector error is shown when there is one', () => {
  const built = alerts.build({ status: [status({ health: 'down', lagSeconds: 9000, lastError: 'pms is unreachable' })], problems: [] });
  assert.equal(built.alerts[0].body, 'pms is unreachable');
});

test('many bad rows from one source are one alert, not many', () => {
  const problems = Array.from({ length: 40 }, (_, i) => ({ source: 'telecrm', field: i % 2 ? 'phone' : 'revenue', raw: 'x' }));
  const built = alerts.build({ status: [], problems });
  assert.equal(built.count, 1);
  assert.match(built.alerts[0].title, /40 values from telecrm could not be read/);
  assert.match(built.alerts[0].meta, /2 field\(s\)/);
});

test('lag is phrased in the largest unit that stays honest', () => {
  assert.equal(alerts.ago(null), 'never');
  assert.equal(alerts.ago(45), '45s ago');
  assert.equal(alerts.ago(600), '10m ago');
  assert.equal(alerts.ago(7200), '2h ago');
});

/* ── Command palette ────────────────────────────────────────────────────── */

const fakeRepo = {
  async screens() {
    return [
      { slug: '', view: 'dashboard', name: 'Executive Dashboard', icon: 'ph ph-gauge', group: 'Overview' },
      { slug: 'pipeline', view: 'pipeline', name: 'Pipeline', icon: 'ph ph-flow-arrow', group: 'Sales' },
    ];
  },
  async subviewGroups(view) {
    return view === 'pipeline'
      ? [{ tabList: 'pipeViews', views: [{ flag: 'pipeIsList', label: 'List', default: true }, { flag: 'pipeIsKanban', label: 'Kanban' }] }]
      : [];
  },
};

test('the index is every screen plus every non-default sub-view', async () => {
  const entries = await palette.build(fakeRepo);
  assert.deepEqual(entries.map((e) => e.go), ['/', '/pipeline', '/pipeline?v=pipeIsKanban']);
});

test('a default sub-view is not a second row to the same place', async () => {
  const entries = await palette.build(fakeRepo);
  assert.ok(!entries.some((e) => e.go === '/pipeline?v=pipeIsList'), 'the default sub-view duplicated its screen');
});

test('a sub-view is findable by its screen name as well as its own', async () => {
  const entries = await palette.build(fakeRepo);
  const kanban = entries.find((e) => e.go === '/pipeline?v=pipeIsKanban');
  assert.ok(kanban.terms.includes('pipeline'));
  assert.ok(kanban.terms.includes('kanban'));
  assert.equal(kanban.context, 'Pipeline', 'the sub-view does not say which screen it belongs to');
});

test('the index holds no list of its own — an empty registry yields nothing', async () => {
  const entries = await palette.build({ async screens() { return []; }, async subviewGroups() { return []; } });
  assert.deepEqual(entries, []);
});

/* ── the not-found page ─────────────────────────────────────────────────── */

/* `layout.ejs` renders for the 404 as well as for the fifteen screens, and the
   404 has no screen behind it: server.js passes `data: null`. Two script tags
   read straight through it, so every unknown URL answered 500 instead of 404 —
   including /favicon.ico, which a browser requests on every page load.
 *
 * Rendering the layout here would mean building the whole shell — sidebar,
 * topbar and filterbar locals — so this reads the template instead and holds
 * the one rule that matters: nothing outside the `hasView` body may dereference
 * `data` without checking it first. */
test('the layout never reads through data, which is null on the 404', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require('path').join(__dirname, '..', 'views', 'layout.ejs'), 'utf8');

  const unguarded = [];
  for (const m of source.matchAll(/(.{0,12})\bdata\.\w+/g)) {
    if (!/data && $/.test(m[1])) unguarded.push(m[0].trim());
  }

  assert.deepEqual(unguarded, [], 'these would throw on the not-found page');
});

/* ── avatars hold initials ──────────────────────────────────────────────── */

/* The pipeline card's owner avatar is a 16-pixel circle set in 7-pixel type,
   and this module was handing it whole names. A name does not fit in sixteen
   pixels: it overflowed the circle and printed on top of the age beside it, so
   every card on the board read "Vishnu Joseph" and "2 days" as one smear and an
   unassigned lead read "Unassignedtouched 3h". Every other avatar in the
   product is fed an `init` field; this was the one that was not. */
test('a pipeline card gives its avatar initials, not a name', () => {
  const pipeline = require('../data/pipeline');

  for (const stage of pipeline.pipeStages) {
    for (const card of stage.cards || []) {
      assert.ok(card.own.length <= 2,
        `${stage.name}/${card.name}: "${card.own}" is too long for a 16px avatar`);
    }
  }
});

test('an unassigned lead still gets a circle, since it is the one to chase', () => {
  const pipeline = require('../data/pipeline');
  const newStage = pipeline.pipeStages.find((s) => s.name === 'New');
  const unowned = newStage.cards.find((c) => c.name === 'Rahul Menon');

  assert.equal(unowned.own, '—', 'the avatar disappeared instead of saying it is empty');
});
