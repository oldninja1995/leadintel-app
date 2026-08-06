/* Data for the "marketing" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  /* each item: { delta, deltaColor, icon, label, spark, src, srcBorder, srcColor, sub, tip, value } */
  mktHero: [],
  /* each item: { delta, deltaColor, label, src, srcBorder, srcColor, tip, value } */
  mktKpis: [],
  /* each item: { label, n, pct, w } */
  mktFunnel: [],
  /* each item: { bookings, cpa, cpl, icon, mer, name, netColor, netRoas, rec, recBorder, recColor, rev, roas, spark, spend } */
  platforms: [],
};
