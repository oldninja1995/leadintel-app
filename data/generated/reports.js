/* Data for the "reports" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  down: '',
  repBuilder: false,
  repPresent: false,
  repSchedule: false,
  repScorecard: false,
  repTemplates: true,
  up: '',
  selReport: {
    name: '',
    period: '',
    /* each item: { — } */
    recs: [],
    summary: '',
    /* each item: { name, val } */
    top: [],
    /* each item: { name, val } */
    worst: [],
  },
  /* each item: { border, color, label } */
  repTabs: [],
  /* each item: { label } */
  /*   .items[] each: { icon, name } */
  widgetGroups: [],
  /* each item: { bg, color, label } */
  dashTabs: [],
  /* each item: { delta, deltaColor, h, isAi, isBar, isDonut, isFunnel, isKpi, isLine, isTable, span, text, title, value } */
  canvasWidgets: [],
  /* each item: { delta, deltaColor, label, value } */
  scorecardKpis: [],
  /* each item: { text, value } */
  scoreOpps: [],
  /* each item: { text, value } */
  scoreRisks: [],
  /* each item: { delta, deltaColor, label, value } */
  presentKpis: [],
  /* each item: { freq, icon, name, next, status, statusColor, to } */
  /*   .channels[] each: { — } */
  schedules: [],
  /* each item: { access, init, meta, who } */
  shareRows: [],
  /* each item: { color, icon, meta, name } */
  exportOpts: [],
  /* each item: { bg, border, freq, icon, iconColor, name } */
  reportList: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   goPresent
 *   r.go
 *   t.go
 */
