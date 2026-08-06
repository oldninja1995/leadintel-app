/* Data for the "shell (sidebar, top bar, filter bar)" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  aiBtnBg: '',
  collapseIcon: '',
  expanded: true,
  sidebarWidth: '',
  up: '',
  wsOpen: false,
  /* each item: { label, showLabel } */
  /*   .items[] each: { badge, bg, color, icon, name, pinned, rail, showBadge } */
  navGroups: [],
  /* each item: { bg, color, label } */
  ranges: [],
  /* each item: { k, v } */
  filters: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   it.go
 *   openPalette
 *   r.go
 *   toggleAi
 *   toggleNotif
 *   toggleSidebar
 *   toggleWs
 */
