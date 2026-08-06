/* Which sub-view a screen is showing, and where its tabs point.
 *
 * This is request state, not content: it is decided by the URL, and the
 * repository is asked only for the sub-view groups the design declares. Kept
 * apart from the routes so the server file stays a wiring file.
 */

/* Flags that ride along with a view rather than being one. The campaign
   drill-down shows a breadcrumb; the converter drops it from the group (it is a
   modifier, not an alternative), so the pairing is stated here. */
const COMPANIONS = {
  campDetail: ['showCrumb'],
};

/* Selection comes from `?v=`, repeatable so screens with several groups can be
   addressed at once (`/campaigns?v=campDetail&v=dRevenue`); anything
   unspecified falls back to the design's own default. */
function subviewState(groups, slug, query) {
  const wanted = new Set([].concat(query.v || []).flatMap((v) => String(v).split(',')));

  const flags = {};
  const active = [];

  for (const group of groups) {
    const picked =
      group.views.find((v) => wanted.has(v.flag)) ||
      group.views.find((v) => v.default) ||
      group.views[0];
    active.push(picked.flag);
    for (const v of group.views) flags[v.flag] = v.flag === picked.flag;
  }

  for (const [flag, companions] of Object.entries(COMPANIONS)) {
    if (flag in flags) for (const c of companions) flags[c] = flags[flag];
  }

  /* Each tab links to itself while holding every other group where it is. */
  const tabLists = {};
  groups.forEach((group, i) => {
    if (!group.tabList) return;
    tabLists[group.tabList] = group.views.map((v) => {
      const selection = active.map((f, j) => (j === i ? v.flag : f));
      const isActive = active[i] === v.flag;
      return {
        label: v.label,
        color: isActive ? 'var(--color-accent-300)' : 'var(--color-neutral-500)',
        border: isActive ? 'var(--color-accent-400)' : 'transparent',
        go: `/${slug}?v=${selection.join('&v=')}`,
      };
    });
  });

  return { flags, tabLists };
}

module.exports = { subviewState, COMPANIONS };
