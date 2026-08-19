/* Folding several reads into one round trip.
 *
 *   node --test test/store-batch.test.js
 *
 * Why this exists: the request edge fills six stores before it serves
 * anything, and `pg.batch` was written to send them together — but only
 * through Neon's HTTP `transaction()`. The deployment moved to a driver that
 * has no such method, every batched read quietly went back to one query at a
 * time, and Server-Timing read `prefetch;dur=932` on every signed-in route
 * including one that returns four hundred bytes of session JSON. Four asks at
 * the ~230ms this deployment pays for one.
 *
 * `combine` is the fold that replaces those asks. It is pure string work, so
 * it can be tested without a database — which matters, because the database is
 * exactly what `npm test` does not have.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pg = require('../lib/store/pg');
const { PgDocs, PgLineLog } = require('../lib/store/pg-docs');

test('every query keeps its own parameters, renumbered into one list', () => {
  const { text, params } = pg.combine([
    { text: 'SELECT key, value FROM docs WHERE key = ANY($1::text[])', params: [['a', 'b']] },
    { text: 'SELECT line FROM lines WHERE key = $1 LIMIT $2', params: ['runs', 500] },
    { text: 'SELECT line FROM lines WHERE key = $1 LIMIT $2', params: ['fires', 2000] },
  ]);

  /* Each query was written against its own $1. Shared, they cannot all be $1. */
  assert.deepEqual(params, [['a', 'b'], 'runs', 500, 'fires', 2000]);
  assert.ok(text.includes('key = ANY($1::text[])'), 'the first query was renumbered when it should not have been');
  assert.ok(text.includes("WHERE key = $2 LIMIT $3"), 'the second query was not renumbered');
  assert.ok(text.includes("WHERE key = $4 LIMIT $5"), 'the third query was not renumbered');
});

test('one row per query, in the order asked', () => {
  const { text } = pg.combine([
    { text: 'SELECT 1', params: [] },
    { text: 'SELECT 2', params: [] },
  ]);
  assert.match(text, /SELECT 0 AS i/);
  assert.match(text, /SELECT 1 AS i/);
  assert.match(text, /ORDER BY i$/);
  assert.equal(text.split('UNION ALL').length, 2);
});

test('a query that declares an order is aggregated by it, one that does not is not', () => {
  /* json_agg makes no promise about the order it consumes input in, so a
     caller that depends on order has to say which column carries it. */
  const { text } = pg.combine([
    { text: 'SELECT line, seq FROM lines WHERE key = $1', params: ['runs'], order: 'seq' },
    { text: 'SELECT key, value FROM docs WHERE key = ANY($1::text[])', params: [['a']] },
  ]);
  assert.ok(text.includes('json_agg(t ORDER BY t.seq)'), 'the ordered query lost its order');
  assert.ok(text.includes("json_agg(t)"), 'an unordered query was given one');
});

test('an empty result is an empty array, never null', () => {
  /* json_agg over no rows is NULL, and a store primed with null would throw
     where it expected to find nothing. */
  const { text } = pg.combine([{ text: 'SELECT 1', params: [] }]);
  assert.ok(text.includes("COALESCE(json_agg(t), '[]'::json)"));
});

test('every query the request edge batches declares its order or is keyed', () => {
  /* The guard: a new batched query that depends on order and forgets to say so
     would come back shuffled, and shuffled looks like data rather than a bug. */
  const log = new PgLineLog('runs');

  assert.equal(log.lastQuery(500).order, 'seq');
  assert.equal(log.hydrateQuery(500).order, 'seq');
  assert.equal(PgDocs.listQuery('dispatch:').order, 'key');

  /* Keyed by the caller — `primeMany` maps rows by key, so order is nothing. */
  assert.equal(PgDocs.manyQuery(['a']).order, undefined);
});

test('the ordered log queries select the column they are ordered by', () => {
  /* Aggregating by a column the subquery does not return is a runtime error,
     and it would only ever surface on the deployment that folds. */
  const log = new PgLineLog('runs');
  for (const q of [log.lastQuery(500), log.hydrateQuery(500)]) {
    assert.match(q.text, /SELECT[^]*\bseq\b/, `${q.order} is ordered by a column it does not select`);
  }
});
