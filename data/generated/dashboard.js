/* Data for the "dashboard" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  editBorder: '',
  editColor: '',
  editLabel: '',
  editing: false,
  up: '',
  warn: '',
  /* each item: { delta, deltaColor, icon, label, spark, src, srcBorder, srcColor, sub, tip, value } */
  heroKpis: [],
  /* each item: { delta, deltaColor, label, src, srcBorder, srcColor, tip, value } */
  miniKpis: [],
  /* each item: { label, n, pct, w } */
  funnel: [],
  /* each item: { bookings, cpl, leads, name, platform, roas, roasColor, spend } */
  campaigns: [],
  /* each item: { meta, name, rank, rev } */
  properties: [],
  /* each item: { init, meta, name, rev } */
  reps: [],
  /* each item: { action, icon, impact, text } */
  recs: [],
  /* each item: { dot, text, when } */
  alerts: [],
  /* each item: { icon, text, when } */
  activity: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   toggleEdit
 *   toggleNotif
 */
