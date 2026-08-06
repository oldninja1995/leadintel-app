/* The read API.
 *
 * Everything a request needs in order to render comes through one of these
 * five calls. Nothing above this line — no route, no view — knows where the
 * data is kept; the static modules under `data/` are the first implementation,
 * not the interface.
 *
 * Every call is asynchronous. The static implementation could answer
 * synchronously and a database-backed one cannot, so the contract takes the
 * slower shape: an implementation swap must not become a caller rewrite.
 *
 *   screens()                     → Screen[]
 *       The screen registry, in sidebar order. Each entry:
 *       { slug, view, gate, name, icon, group }. `view` doubles as the name of
 *       the resource that screen reads and of the template that renders it.
 *
 *   navigation(activeSlug)        → NavGroup[]
 *       The sidebar, grouped and with the active item marked. Each group:
 *       { label, showLabel, items: [{ ...screen, go, color, bg, rail, … }] }.
 *
 *   subviewGroups(view)           → SubviewGroup[]
 *       The alternative sub-views a screen can show, as declared by the design.
 *       Each group: { tabList, views: [{ flag, label, default }] }. Empty for a
 *       screen with a single view.
 *
 *   read(resource, params)        → object | null
 *       A resource's content, shaped as `schemas/<resource>.json` states. null
 *       when the resource does not exist. `params` carries the request's own
 *       selections — the attribution model, a granularity, a date range — for
 *       resources whose content depends on them; an implementation that ignores
 *       params must still return the default content.
 *
 *   resources()                   → string[]
 *       Every resource name this implementation can answer for.
 *
 * A resource name is a screen's `view`, plus `_shell` for the chrome and
 * `overlay-*` for the overlays.
 */

const METHODS = ['screens', 'navigation', 'subviewGroups', 'read', 'resources'];

function assertImplements(repo, name) {
  const missing = METHODS.filter((m) => typeof repo[m] !== 'function');
  if (missing.length) {
    throw new Error(`repository "${name}" does not implement ${missing.join(', ')}`);
  }
  return repo;
}

module.exports = { METHODS, assertImplements };
