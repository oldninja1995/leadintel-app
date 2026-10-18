/* Report exports — Excel (.xlsx), PowerPoint (.pptx) and CSV.
 *
 * Reports' "PDF / Excel / PPT" buttons were drawings. The content of every
 * export is the screen's own: the figures come out of the same projection and
 * the same metric resolver that draw Reports, so a downloaded file and the
 * screen cannot disagree. PDF is the print view (views/print-report.ejs) through
 * the browser's own "Save as PDF" — there is no browser engine on the server to
 * render one, and a hand-drawn PDF would not match the screen.
 *
 * `data` is the shape `collect` returns:
 *   { title, period, generated, kpis: [{label, value, delta}], summary,
 *     top: [{name, val}], worst: [{name, val}], recs: [string],
 *     campaigns: [{name, platform, spend, leads, cpl, bookings, roas}] }
 */

const JSZip = require('jszip');
const PptxGenJS = require('pptxgenjs');

const NONE = '—';
const str = (v) => (v == null ? '' : String(v));

/* ── data ───────────────────────────────────────────────────────────────── */

function collect({ title, period, kpis = [], summary = null, top = [], worst = [], recs = [], campaigns = [] }, now = new Date()) {
  return {
    title: str(title) || 'LeadIntel report',
    period: str(period),
    generated: now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    kpis: kpis.map((k) => ({ label: str(k.label), value: str(k.value || NONE), delta: k.delta === NONE ? '' : str(k.delta) })),
    summary: summary && summary !== NONE ? str(summary) : null,
    top: top.map((t) => ({ name: str(t.name), val: str(t.val) })),
    worst: worst.map((t) => ({ name: str(t.name), val: str(t.val) })),
    recs: recs.map(str),
    campaigns: campaigns.map((c) => ({
      name: str(c.name), platform: str(c.platform), spend: str(c.spend), leads: str(c.leads),
      cpl: str(c.cpl), bookings: str(c.bookings), roas: str(c.roas),
    })),
  };
}

const fileName = (data, ext) => `${data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}-${data.generated.slice(0, 10)}.${ext}`;

/* ── CSV ────────────────────────────────────────────────────────────────── */

function toCsv(data) {
  const q = (v) => { const s = str(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [[data.title], [data.period], []];
  lines.push(['Figure', 'Value', 'Change'], ...data.kpis.map((k) => [k.label, k.value, k.delta]), []);
  if (data.campaigns.length) {
    lines.push(['Campaign', 'Platform', 'Spend', 'Leads', 'CPL', 'Bookings', 'ROAS']);
    lines.push(...data.campaigns.map((c) => [c.name, c.platform, c.spend, c.leads, c.cpl, c.bookings, c.roas]));
  }
  return '﻿' + lines.map((r) => r.map(q).join(',')).join('\r\n');
}

/* ── Excel ──────────────────────────────────────────────────────────────── */

/* A workbook is a zip of a few XML parts. Text is written as inline strings
   (no shared-string table to keep in step) and figures stay as the screen
   formats them — "₹3.30L", "5.6x" — because that is what was asked for: the
   report as read, not a second computation of it. Row 1 of every sheet is
   bold, through one cell style. */
const xml = (s) => str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i) => { let s = ''; let n = i + 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function sheetXml(rows, widths) {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')}</row>`).join('');
  const cols = widths ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

async function toXlsx(data) {
  const sheets = [
    { name: 'Figures', widths: [38, 18, 22], rows: [['Figure', 'Value', 'Change'], ...data.kpis.map((k) => [k.label, k.value, k.delta])] },
  ];
  if (data.campaigns.length) {
    sheets.push({ name: 'Campaigns', widths: [36, 12, 14, 10, 12, 10, 10], rows: [['Campaign', 'Platform', 'Spend', 'Leads', 'CPL', 'Bookings', 'ROAS'], ...data.campaigns.map((c) => [c.name, c.platform, c.spend, c.leads, c.cpl, c.bookings, c.roas])] });
  }
  const highlights = [['Section', 'Item', 'Detail']];
  for (const t of data.top) highlights.push(['Top performer', t.name, t.val]);
  for (const t of data.worst) highlights.push(['Needs attention', t.name, t.val]);
  for (const r of data.recs) highlights.push(['Recommendation', r, '']);
  if (data.summary) highlights.push(['Summary', data.summary, '']);
  if (highlights.length > 1) sheets.push({ name: 'Highlights', widths: [18, 60, 70], rows: highlights });
  sheets.push({ name: 'About', widths: [16, 70], rows: [['Report', data.title], ['Period', data.period], ['Generated', data.generated], ['Source', 'LeadIntel — the same figures as the Reports screen']] });

  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ── PowerPoint ─────────────────────────────────────────────────────────── */

const INK = '1F2330';
const MUTE = '6B7180';
const ACCENT = '6D5BD0';

async function toPptx(data) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = data.title;
  const heading = (slide, text) => slide.addText(text, { x: 0.5, y: 0.35, w: 12.3, h: 0.6, fontSize: 24, bold: true, color: INK });
  const foot = (slide) => slide.addText(`${data.title} · ${data.period}`, { x: 0.5, y: 7.0, w: 12.3, h: 0.3, fontSize: 9, color: MUTE });

  const cover = pptx.addSlide();
  cover.background = { color: 'F4F3FA' };
  cover.addText(data.title, { x: 0.8, y: 2.3, w: 11.7, h: 1.1, fontSize: 40, bold: true, color: INK });
  cover.addText(data.period, { x: 0.8, y: 3.4, w: 11.7, h: 0.5, fontSize: 18, color: ACCENT });
  cover.addText(`Generated ${data.generated} · LeadIntel`, { x: 0.8, y: 4.0, w: 11.7, h: 0.4, fontSize: 12, color: MUTE });

  if (data.kpis.length) {
    const s = pptx.addSlide();
    heading(s, 'Key figures');
    const per = 4;
    data.kpis.slice(0, 12).forEach((k, i) => {
      const x = 0.5 + (i % per) * 3.1;
      const y = 1.3 + Math.floor(i / per) * 1.85;
      s.addShape(pptx.ShapeType.roundRect, { x, y, w: 2.9, h: 1.65, fill: { color: 'F4F3FA' }, line: { color: 'E1DEF2' }, rectRadius: 0.08 });
      s.addText(k.label, { x: x + 0.15, y: y + 0.1, w: 2.6, h: 0.45, fontSize: 10, color: MUTE, bold: true });
      s.addText(k.value, { x: x + 0.15, y: y + 0.55, w: 2.6, h: 0.6, fontSize: 22, bold: true, color: INK });
      if (k.delta) s.addText(k.delta, { x: x + 0.15, y: y + 1.15, w: 2.6, h: 0.35, fontSize: 11, color: ACCENT });
    });
    foot(s);
  }

  if (data.summary) {
    const s = pptx.addSlide();
    heading(s, 'Summary');
    s.addText(data.summary, { x: 0.5, y: 1.2, w: 12.3, h: 5.5, fontSize: 14, color: INK, valign: 'top', paraSpaceAfter: 6 });
    foot(s);
  }

  if (data.top.length || data.worst.length) {
    const s = pptx.addSlide();
    heading(s, 'Highlights');
    const list = (items, x, title, color) => {
      s.addText(title, { x, y: 1.2, w: 6, h: 0.4, fontSize: 14, bold: true, color });
      /* Each item: its headline in bold, its explanation beneath, a gap. */
      const runs = items.flatMap((t) => [
        { text: t.name, options: { bold: true, color: INK, breakLine: true } },
        { text: t.val, options: { color: MUTE, fontSize: 11, breakLine: true } },
        { text: ' ', options: { fontSize: 6, breakLine: true } },
      ]);
      s.addText(runs.length ? runs : [{ text: 'Nothing flagged.', options: { color: MUTE } }], { x, y: 1.7, w: 6, h: 5, fontSize: 13, valign: 'top' });
    };
    list(data.top, 0.5, 'Top performers', '1F8F4E');
    list(data.worst, 6.9, 'Needs attention', 'C0392B');
    foot(s);
  }

  if (data.recs.length) {
    const s = pptx.addSlide();
    heading(s, 'Recommendations');
    s.addText(data.recs.map((r) => ({ text: r, options: { bullet: true } })), { x: 0.5, y: 1.2, w: 12.3, h: 5.5, fontSize: 15, color: INK, valign: 'top', paraSpaceAfter: 10 });
    foot(s);
  }

  if (data.campaigns.length) {
    const s = pptx.addSlide();
    heading(s, 'Campaigns');
    const head = ['Campaign', 'Platform', 'Spend', 'Leads', 'CPL', 'Bookings', 'ROAS'].map((t) => ({ text: t, options: { bold: true, color: MUTE, fill: { color: 'F4F3FA' } } }));
    const rows = data.campaigns.slice(0, 14).map((c) => [c.name, c.platform, c.spend, c.leads, c.cpl, c.bookings, c.roas]);
    s.addTable([head, ...rows], { x: 0.5, y: 1.2, w: 12.3, colW: [4.3, 1.4, 1.4, 1.1, 1.3, 1.4, 1.4], fontSize: 11, color: INK, border: { type: 'solid', color: 'E1DEF2', pt: 0.5 } });
    foot(s);
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { collect, toCsv, toXlsx, toPptx, fileName };
