/* Chrome content: the date-range control and the global filter chips.
 *
 * AUTHORED, not transcribed — see PHASES.md, Phase 1. Consistent with the
 * period the design's own hardcoded markup states (Jul 1 – Jul 30, 2026,
 * compared against the previous period). */

const { UP, seg } = require('./_tokens');

module.exports = {
  up: UP,
  aiBtnBg: 'transparent',

  /* The date range is request state, not content: which chip is selected comes
     from the URL, and each chip needs a destination that keeps the rest of the
     query. So the server builds these — see `periodChips` in server.js — and
     what stands here is the shape, and what a reader with no selection sees.
     Left in place rather than deleted because the static driver is a whole
     driver, and `_shell` has to answer without a request behind it. */
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
