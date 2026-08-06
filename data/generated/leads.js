/* Data for the "leads" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  leadList: true,
  leadProfile: false,
  warn: '',
  selLead: {
    /* each item: { k, v } */
    attribution: [],
    device: '',
    email: '',
    init: '',
    /* each item: { k, v } */
    intent: [],
    location: '',
    name: '',
    owner: '',
    phone: '',
    prob: '',
    score: '',
    scoreColor: '',
    stage: '',
    stageColor: '',
    /* each item: { bg, color, icon, label, ring, tag, tagColor, when, who } */
    timeline: [],
    value: '',
  },
  /* each item: { campaign, check, checkColor, followup, fuColor, name, owner, phone, platform, prob, property, room, score, scoreColor, stage, stageColor, value } */
  leadRows: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   backToLeads
 *   l.go
 */
