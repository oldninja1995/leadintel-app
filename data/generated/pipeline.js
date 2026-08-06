/* Data for the "pipeline" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  pipeIsKanban: true,
  pipeIsList: false,
  pipeKanbanBg: '',
  pipeKanbanColor: '',
  pipeListBg: '',
  pipeListColor: '',
  /* each item: { conv, drop, dropColor, n, name, rev, time } */
  /*   .cards[] each: { age, ageColor, chan, name, own, val, what } */
  pipeStages: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   pipeKanban
 *   pipeListGo
 */
