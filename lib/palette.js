/* The ⌘K command index.
 *
 * The design has no palette markup, so this is mine (Phase 2). What keeps it
 * from being invented is that it holds no list of its own: every entry is
 * derived from the repository's screen registry and the sub-view map the
 * converter extracted from the design. A screen the design does not declare
 * cannot appear here, and one it adds later appears without this file changing.
 *
 * That is also why it is built server-side. The palette needs every screen's
 * sub-views, and a client that had to ask for them one screen at a time would
 * either fetch fourteen times or hold a hand-maintained copy — and a
 * hand-maintained copy is the thing that goes stale silently.
 */

/* A sub-view whose flag is the screen's default lands on the same URL as the
   screen itself, so it would be a second row that goes nowhere new. */
function subviewEntries(screen, groups) {
  const entries = [];
  for (const group of groups || []) {
    for (const view of group.views || []) {
      if (view.default) continue;
      entries.push({
        kind: 'subview',
        label: view.label,
        context: screen.name,
        icon: screen.icon,
        go: `/${screen.slug}?v=${view.flag}`,
        /* Both names are searchable, so "pipeline kanban" finds the Kanban
           sub-view of Pipeline without the user knowing which is which. */
        terms: `${screen.name} ${view.label}`.toLowerCase(),
      });
    }
  }
  return entries;
}

async function build(repo) {
  const screens = await repo.screens();

  const entries = screens.map((s) => ({
    kind: 'screen',
    label: s.name,
    context: s.group || null,
    icon: s.icon,
    go: `/${s.slug}`,
    terms: `${s.name} ${s.group || ''} ${s.slug}`.toLowerCase(),
  }));

  for (const screen of screens) {
    entries.push(...subviewEntries(screen, await repo.subviewGroups(screen.view)));
  }

  return entries;
}

module.exports = { build, subviewEntries };
