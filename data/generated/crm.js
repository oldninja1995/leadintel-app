/* Data for the "crm" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  warn: '',
  /* each item: { delta, deltaColor, icon, label, spark, src, srcBorder, srcColor, sub, tip, value } */
  crmHero: [],
  /* each item: { delta, deltaColor, label, src, srcBorder, srcColor, tip, value } */
  crmKpis: [],
  /* each item: { label, n, rev, w } */
  crmStages: [],
  /* each item: { init, meta, name, rev } */
  reps: [],
  /* each item: { dot, meta, name, what, when } */
  followups: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   goPipe
 *   goSales
 */
