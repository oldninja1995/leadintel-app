/* Data for the "overlay-creative-detail" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  selCr: {
    aiNote: '',
    bestAud: '',
    bestPkg: '',
    bestPlace: '',
    bestResort: '',
    bookings: '',
    campaign: '',
    dur: '',
    fatigue: '',
    fatigueColor: '',
    /* each item: { label, pct, w } */
    funnelV: [],
    grad: '',
    hold: '',
    hook: '',
    leads: '',
    platform: '',
    quality: '',
    roas: '',
    roasColor: '',
    spend: '',
    thumbStop: '',
    title: '',
    type: '',
    /* each item: { note, tag, when } */
    versions: [],
    watch: '',
    winning: '',
  },
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   closeCr
 *   stop
 */
