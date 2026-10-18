/* Saved dashboards and bookmarks for Reports & Dashboards.
 *
 * The screen's "New dashboard", "Bookmarks" and builder were drawings: nothing
 * could be created, saved or reopened. A dashboard here is a name and an
 * ordered list of widgets; every change records a version, so "Version
 * history" can list and restore them. Bookmarks are named links to any view in
 * the app (a report, a filtered list, a date range).
 *
 * Shared per workspace and stored like Layouts and Annotations — one document
 * in the docs backend (a file locally), written with `put`, whose promise the
 * route awaits before answering.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE = path.join(__dirname, '..', 'var', 'report-defs.json');
const DOC_KEY = 'reportDefs';
const MAX_VERSIONS = 50;
const MAX_WIDGETS = 24;

/* What a widget may be. `ref` names the metric (kpi) or the chart / table /
   narrative block; the view decides how each is drawn. */
const KINDS = ['kpi', 'chart', 'table', 'narrative'];

/* Starting points for "New dashboard". Metric ids are the registry's; chart
   ids are lib/dashboard-charts.js's. */
const STARTERS = {
  blank: { label: 'Blank', widgets: [] },
  executive: {
    label: 'Executive overview',
    widgets: [
      ['kpi', 'revenue.reservations'], ['kpi', 'bookings.reservations'], ['kpi', 'roas.total'], ['kpi', 'leads.count'],
      ['chart', 'leadsVsBookings'], ['chart', 'bookingsByChannel'], ['narrative', 'summary'],
    ],
  },
  marketing: {
    label: 'Marketing performance',
    widgets: [
      ['kpi', 'ads.spend'], ['kpi', 'cost.per_lead'], ['kpi', 'roas.attributed_total'], ['kpi', 'ads.ctr'],
      ['chart', 'cplTrend'], ['chart', 'platformFunnel'], ['chart', 'roasByCampaign'], ['table', 'campaigns'],
    ],
  },
  sales: {
    label: 'Sales & leads',
    widgets: [
      ['kpi', 'leads.count'], ['kpi', 'leads.interested_rate'], ['kpi', 'leads.conversion_rate'], ['kpi', 'leads.response_rate'],
      ['chart', 'leadStatus'], ['chart', 'arrivals'], ['chart', 'leadMix'],
    ],
  },
};

const newId = () => crypto.randomBytes(6).toString('hex');

class ReportDefs {
  constructor(file = STORE, { backend = null, docKey = DOC_KEY } = {}) {
    this.file = file;
    this.backend = backend;
    this.docKey = docKey;
    this._state = null;
    this._pending = null;
  }

  async hydrate(value = undefined) {
    if (!this.backend) return this;
    const stored = value === undefined ? await this.backend.get(this.docKey) : value;
    this._state = stored && typeof stored === 'object' ? stored : {};
    return this;
  }

  flush() {
    return this._pending;
  }

  state() {
    if (this._state) return this._state;
    if (this.backend) {
      this._state = {};
      return this._state;
    }
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this._state = {};
    }
    return this._state;
  }

  _ws(workspace) {
    const s = this.state();
    const ws = s[workspace] && typeof s[workspace] === 'object' ? s[workspace] : {};
    return { reports: Array.isArray(ws.reports) ? ws.reports : [], bookmarks: Array.isArray(ws.bookmarks) ? ws.bookmarks : [] };
  }

  _put(workspace, ws) {
    this._state = { ...this.state(), [workspace]: ws };
    this._write();
  }

  /* ── dashboards ─────────────────────────────────────────────────────── */

  reports(workspace) {
    return this._ws(workspace).reports.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  report(workspace, id) {
    return this._ws(workspace).reports.find((r) => r.id === id) || null;
  }

  create(workspace, { name, from = 'blank', by = null }, { now = new Date() } = {}) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new Error('a dashboard needs a name');
    const starter = STARTERS[from] || STARTERS.blank;
    const widgets = starter.widgets.map(([kind, ref]) => ({ id: newId(), kind, ref }));
    const at = now.toISOString();
    const report = {
      id: newId(), name: clean, widgets, createdBy: by, createdAt: at, updatedAt: at,
      versions: [{ v: 1, at, by, note: `created from ${starter.label}`, name: clean, widgets }],
    };
    const ws = this._ws(workspace);
    this._put(workspace, { ...ws, reports: [report, ...ws.reports] });
    return report;
  }

  /* Every change goes through here, so every change is a version. */
  _change(workspace, id, by, note, mutate, now = new Date()) {
    const ws = this._ws(workspace);
    const i = ws.reports.findIndex((r) => r.id === id);
    if (i < 0) throw new Error('that dashboard no longer exists');
    const current = ws.reports[i];
    const next = mutate({ ...current, widgets: current.widgets.slice() });
    const at = now.toISOString();
    const v = (current.versions[current.versions.length - 1] || { v: 0 }).v + 1;
    next.updatedAt = at;
    next.versions = [...current.versions, { v, at, by, note, name: next.name, widgets: next.widgets }].slice(-MAX_VERSIONS);
    const reports = ws.reports.slice();
    reports[i] = next;
    this._put(workspace, { ...ws, reports });
    return next;
  }

  addWidget(workspace, id, { kind, ref }, by) {
    if (!KINDS.includes(kind)) throw new Error(`unknown widget kind "${kind}"`);
    if (!ref) throw new Error('choose what the widget shows');
    return this._change(workspace, id, by, `added ${kind} ${ref}`, (r) => {
      if (r.widgets.length >= MAX_WIDGETS) throw new Error(`a dashboard holds at most ${MAX_WIDGETS} widgets`);
      r.widgets.push({ id: newId(), kind, ref: String(ref).slice(0, 80) });
      return r;
    });
  }

  removeWidget(workspace, id, widgetId, by) {
    return this._change(workspace, id, by, 'removed a widget', (r) => {
      const w = r.widgets.find((x) => x.id === widgetId);
      if (!w) throw new Error('that widget is not on this dashboard');
      r.widgets = r.widgets.filter((x) => x.id !== widgetId);
      return r;
    });
  }

  moveWidget(workspace, id, widgetId, step, by) {
    return this._change(workspace, id, by, 'reordered widgets', (r) => {
      const i = r.widgets.findIndex((x) => x.id === widgetId);
      const j = i + (step < 0 ? -1 : 1);
      if (i < 0) throw new Error('that widget is not on this dashboard');
      if (j < 0 || j >= r.widgets.length) return r;
      const w = r.widgets.slice();
      [w[i], w[j]] = [w[j], w[i]];
      r.widgets = w;
      return r;
    });
  }

  rename(workspace, id, name, by) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new Error('a dashboard needs a name');
    return this._change(workspace, id, by, `renamed to ${clean}`, (r) => ({ ...r, name: clean }));
  }

  restore(workspace, id, v, by) {
    const current = this.report(workspace, id);
    if (!current) throw new Error('that dashboard no longer exists');
    const target = current.versions.find((x) => x.v === Number(v));
    if (!target) throw new Error(`version ${v} is not in this dashboard's history`);
    return this._change(workspace, id, by, `restored version ${target.v}`, (r) => ({
      ...r, name: target.name, widgets: target.widgets.map((w) => ({ ...w })),
    }));
  }

  remove(workspace, id) {
    const ws = this._ws(workspace);
    if (!ws.reports.some((r) => r.id === id)) return false;
    this._put(workspace, { ...ws, reports: ws.reports.filter((r) => r.id !== id) });
    return true;
  }

  /* ── bookmarks ──────────────────────────────────────────────────────── */

  bookmarks(workspace) {
    return this._ws(workspace).bookmarks.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  bookmark(workspace, { name, url, by }, { now = new Date() } = {}) {
    const link = String(url || '');
    if (!link.startsWith('/') || link.startsWith('//')) throw new Error('only a page in this app can be bookmarked');
    const clean = String(name || '').trim().slice(0, 80) || link;
    const ws = this._ws(workspace);
    const mark = { id: newId(), name: clean, url: link.slice(0, 500), by: by || null, at: now.toISOString() };
    this._put(workspace, { ...ws, bookmarks: [mark, ...ws.bookmarks].slice(0, 200) });
    return mark;
  }

  unbookmark(workspace, id) {
    const ws = this._ws(workspace);
    if (!ws.bookmarks.some((b) => b.id === id)) return false;
    this._put(workspace, { ...ws, bookmarks: ws.bookmarks.filter((b) => b.id !== id) });
    return true;
  }

  _write() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n');
  }
}

module.exports = { ReportDefs, STARTERS, KINDS, DOC_KEY };
