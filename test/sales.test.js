/* Sales Analytics — the per-executive leaderboard.
 *
 *   node --test test/sales.test.js
 *
 * The screen had no test at all, and the thing most worth holding is the one
 * that was wrong: the table printed a close rate and not the lead count it
 * divides by, so "7.1%" sat beside "38 bookings" and the only way to learn it
 * was over 535 leads was to divide backwards.
 *
 * So these assert the relationship rather than the number: whatever the rows
 * say, `bookings / leads` must be the close rate on the same row, and the
 * footer must be the sum of the column above it rather than the mean of the
 * rates.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');

const project = (entities, params = {}) => PROJECTIONS.sales(entities, params, { callKpis: [] });

/* `n` leads for an owner, the first `won` of them converted. Deal revenue is in
   paise, like everything else that crosses the metric layer. */
function world(spec) {
  const leads = [];
  const deals = [];
  for (const [owner, s] of Object.entries(spec)) {
    for (let i = 0; i < s.leads; i += 1) {
      const id = `${owner}-L${i}`;
      leads.push({ entity: 'lead', id, owner, stage: 'new', createdAt: '2026-08-01T09:00:00.000Z' });
      if (i < (s.won || 0)) {
        deals.push({
          entity: 'deal', id: `${owner}-D${i}`, leadId: id, outcome: 'won',
          revenue: s.revenuePer || 100000, updatedAt: '2026-08-10T09:00:00.000Z',
        });
      }
    }
  }
  return { leads, deals };
}

const pct = (text) => Number(String(text).replace('%', ''));
const int = (text) => Number(String(text).replace(/,/g, ''));

test('every executive reports the lead count their close rate divides by', () => {
  const { salesRows } = project(world({
    'a@resort.com': { leads: 225, won: 36, revenuePer: 1800000 },
    'b@resort.com': { leads: 535, won: 38, revenuePer: 1700000 },
  }));

  assert.equal(salesRows.length, 2);

  for (const row of salesRows) {
    assert.ok(row.leads, `${row.name} has no lead count`);
    /* The relationship, not the figure: whatever the row says, the rate has to
       be the two numbers beside it. */
    const implied = (int(row.bookings) / int(row.leads)) * 100;
    assert.ok(
      Math.abs(implied - pct(row.close)) < 0.05,
      `${row.name}: ${row.bookings} bookings over ${row.leads} leads is ${implied.toFixed(1)}%, but the row says ${row.close}`
    );
  }
});

test('the busier executive can close at a lower rate and still be the one to look at', () => {
  /* The reason the column is worth a column: 16% of 225 and 7% of 535 are the
     same handful of bookings, and one of those is a routing problem rather
     than a performance one. Neither is visible from the rate alone. */
  const { salesRows } = project(world({
    'few@resort.com': { leads: 225, won: 36, revenuePer: 100000 },
    'many@resort.com': { leads: 535, won: 38, revenuePer: 100000 },
  }));

  const by = Object.fromEntries(salesRows.map((r) => [r.who, r]));
  assert.equal(int(by['few@resort.com'].leads), 225);
  assert.equal(int(by['many@resort.com'].leads), 535);
  assert.ok(pct(by['few@resort.com'].close) > pct(by['many@resort.com'].close));
});

test('the team footer sums the lead column rather than averaging the rates', () => {
  /* The mean of two close rates is not the team's close rate — it weights
     somebody with nine leads the same as somebody with nine hundred. */
  const { salesRows, salesTotal } = project(world({
    'a@resort.com': { leads: 900, won: 9 },
    'b@resort.com': { leads: 9, won: 3 },
  }));

  assert.equal(int(salesTotal.leads), 909);
  assert.equal(int(salesTotal.leads), salesRows.reduce((t, r) => t + int(r.leads), 0));

  /* 12 over 909 is 1.3%; the mean of 1.0% and 33.3% is 17.2%. */
  assert.ok(Math.abs(pct(salesTotal.close) - 1.3) < 0.05, `the footer read ${salesTotal.close}`);
});

test('a lead nobody owns is in no row, and the footer says so by being smaller', () => {
  /* Deliberate: this table is about executives, and an unassigned lead belongs
     to none of them. It does mean the footer is legitimately below the
     workspace lead count the CRM dashboard shows, which is why the footer's
     tooltip says "leads owned" rather than "leads". */
  const entities = world({ 'a@resort.com': { leads: 10, won: 2 } });
  entities.leads.push({ entity: 'lead', id: 'orphan', owner: '', stage: 'new', createdAt: '2026-08-02T09:00:00.000Z' });
  entities.leads.push({ entity: 'lead', id: 'orphan-2', stage: 'new', createdAt: '2026-08-02T09:00:00.000Z' });

  const { salesRows, salesTotal } = project(entities);

  assert.equal(salesRows.length, 1);
  assert.equal(int(salesTotal.leads), 10, 'an unowned lead was counted into somebody');
  assert.match(salesTotal.who, /10 leads owned/);
});

test('an executive with leads and no bookings reports the leads, not a dash', () => {
  /* Zero bookings out of forty is a finding. Declining the row would hide the
     worst case the screen exists to surface. */
  const { salesRows } = project(world({ 'quiet@resort.com': { leads: 40, won: 0 } }));

  assert.equal(int(salesRows[0].leads), 40);
  assert.equal(salesRows[0].close, '0.0%');
});

test('every row carries the fields the table draws', () => {
  /* The schema audit only runs in development and only warns, so a row missing
     a field renders an empty cell in production and nothing says so. */
  const { salesRows } = project(world({ 'a@resort.com': { leads: 5, won: 1 } }));
  const required = require('../schemas/sales.json').fields.salesRows.item;

  for (const field of required) {
    assert.ok(field in salesRows[0], `salesRows is missing "${field}", which the schema declares`);
  }
});
