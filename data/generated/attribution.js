/* Data for the "attribution" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  attrModelName: '',
  /* each item: { bg, color, label } */
  attrModels: [],
  /* each item: { icon, label, when } */
  journey: [],
  /* each item: { bookings, channel, conv, rev, share, time, tp } */
  attrChannels: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   m.go
 */
