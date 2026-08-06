/* Data for the "sales" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 *
 * NOTE: this screen's markup was cut off by the read cap and is incomplete.
 */

module.exports = {
  salesCalls: false,
  salesTeam: true,
  /* each item: { border, color, label } */
  salesTabs: [],
  /* each item: { abv, bookings, calls, close, closeColor, coach, comp, compColor, init, name, rating, resp, respColor, rev, wa } */
  salesRows: [],
  /* each item: { delta, deltaColor, label, value } */
  callKpis: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   t.go
 */
