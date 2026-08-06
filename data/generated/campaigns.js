/* Data for the "campaigns" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  campCrumb: '',
  campDetail: false,
  campList: true,
  campTabAds: false,
  campTabAdsets: false,
  campTabCampaigns: false,
  campTabKeywords: false,
  dInsights: false,
  dName: '',
  dOverview: true,
  dRes: false,
  dRevenue: false,
  revGran: '',
  showCrumb: false,
  up: '',
  /* each item: { border, color, label } */
  campTabs: [],
  /* each item: { bookings, cpl, ctr, health, healthColor, impr, leads, name, objective, pace, paceColor, paceLabel, platform, rev, roas, roasColor, spark, spend, status } */
  campRows: [],
  /* each item: { audience, bookings, ctr, freq, freqColor, leads, name, opt, placement, rev, roas, roasColor, sat, satColor, spend } */
  adsetRows: [],
  /* each item: { adset, body, bookings, comments, cta, ctr, freq, grad, name, neg, negColor, platform, rev, roas, roasColor, saves, shares, spark, spend, thumbIcon, type } */
  adRows: [],
  /* each item: { bookings, clicks, cpc, ctr, kw, match, qs, qsColor, rev, roas, roasColor } */
  kwRows: [],
  /* each item: { n, term } */
  searchTerms: [],
  /* each item: { border, color, label } */
  dTabs: [],
  /* each item: { delta, deltaColor, label, value } */
  dMkt: [],
  /* each item: { delta, deltaColor, label, value } */
  dBiz: [],
  /* each item: { label, n, pct, w } */
  dFunnel: [],
  /* each item: { name, rev, w } */
  dRooms: [],
  /* each item: { name, rev, w } */
  dPkgs: [],
  /* each item: { bg, color, label } */
  dGrans: [],
  /* each item: { label, value } */
  dRevStats: [],
  /* each item: { checkin, guest, init, nights, pkg, rev, room, src, status, statusColor } */
  resRows: [],
  /* each item: { action, body, icon, title } */
  /*   .chips[] each: { — } */
  dAi: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   a.go
 *   backToCampaigns
 *   c.go
 *   g.go
 *   t.go
 */
