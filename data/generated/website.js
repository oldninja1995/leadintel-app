/* Data for the "website" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  webTabFunnels: false,
  webTabLanding: false,
  webTabOverview: false,
  /* each item: { border, color, label } */
  webTabs: [],
  /* each item: { delta, deltaColor, label, value } */
  webKpis: [],
  /* each item: { rev, sessions, src, w } */
  webSources: [],
  /* each item: { avg, clicks, exit, page, views } */
  topPages: [],
  /* each item: { audit, auditBorder, auditColor, bounce, bounceColor, clicks, conv, formDone, formStart, lp, rev, scroll, sessions } */
  lpRows: [],
  /* each item: { drop, label, n, pct, w } */
  webFunnel: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   t.go
 */
