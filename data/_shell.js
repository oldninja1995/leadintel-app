/* Chrome content: the date-range control and the global filter chips.
 *
 * AUTHORED, not transcribed — see PHASES.md, Phase 1. Consistent with the
 * period the design's own hardcoded markup states (Jul 1 – Jul 30, 2026,
 * compared against the previous period). */

const { UP, seg } = require('./_tokens');

module.exports = {
  up: UP,
  aiBtnBg: 'transparent',

  ranges: [
    { label: 'Today', ...seg(false) },
    { label: '7d', ...seg(false) },
    { label: '30d', ...seg(true) },
    { label: '90d', ...seg(false) },
  ],

  filters: [
    { k: 'Property', v: 'All 3' },
    { k: 'Channel', v: 'All' },
    { k: 'Campaign', v: 'All' },
    { k: 'Room type', v: 'All' },
    { k: 'Booking window', v: 'Any' },
  ],
};
