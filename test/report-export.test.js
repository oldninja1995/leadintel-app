const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const x = require('../lib/report-export');

const data = x.collect({
  title: 'Owner weekly summary', period: '18 Sept – 17 Oct',
  kpis: [{ label: 'Reservation value', value: '₹2.16Cr', delta: '+4%' }, { label: 'Leads', value: '6,319', delta: '—' }],
  summary: 'Over the period, "quoted" text, and a comma.',
  top: [{ name: 'Meta returns 8.8x', val: '50 reservations' }], worst: [], recs: ['Tag every lead'],
  campaigns: [{ name: 'Tofu, Conversation', platform: 'Meta', spend: '₹59,009', leads: '1,828', cpl: '₹32', bookings: '23', roas: '6.4x' }],
}, new Date('2026-10-18T10:00:00Z'));

test('a dash change is dropped and the file name carries the report and date', () => {
  assert.equal(data.kpis[1].delta, '');
  assert.equal(x.fileName(data, 'xlsx'), 'owner-weekly-summary-2026-10-18.xlsx');
});

test('the workbook unzips with a sheet per section and escapes text', async () => {
  const zip = await JSZip.loadAsync(await x.toXlsx(data));
  const wb = await zip.file('xl/workbook.xml').async('string');
  assert.deepEqual([...wb.matchAll(/name="([^"]+)"/g)].map((m) => m[1]), ['Figures', 'Campaigns', 'Highlights', 'About']);
  const campaigns = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(campaigns, /Tofu, Conversation/);
});

test('the deck is a real pptx and the CSV quotes what needs quoting', async () => {
  const deck = await JSZip.loadAsync(await x.toPptx(data));
  assert.ok(deck.file('ppt/presentation.xml'));
  const csv = x.toCsv(data);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"Tofu, Conversation",Meta,"₹59,009"/);
});
