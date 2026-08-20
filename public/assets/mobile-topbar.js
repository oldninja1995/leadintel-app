/* The top bar, on a phone.
 *
 * Measured on production at 390px before any of this existed: the header laid
 * out **1,257px of controls into a 390px viewport** and the filter bar another
 * 1,124px. Making them scroll sideways — which is what the first pass did —
 * left eight controls reachable only by dragging a row: the range chips, which
 * are the primary control on every screen, plus search, theme, notifications,
 * Ask AI and the profile menu. Scrollable is not the same as usable.
 *
 * So on a phone the bar becomes one row of six things:
 *
 *   ☰   PH   [ This month ▾ ]   [ Filters 2 ]   🔔   AP
 *
 * and everything else is either behind one of those two buttons or in the
 * drawer.
 *
 * **Nothing here is re-implemented.** The range chips and the filter chips keep
 * their own markup, their own hrefs and their own enhancers — they are shown in
 * a panel instead of in a row. The quiet controls are *moved* into the drawer
 * rather than copied, because app-ui.js binds several of them by element rather
 * than by delegation and a copy would be inert.
 *
 * Loaded as its own file rather than added to app-ui.js so that a throw in here
 * cannot take the palette, the chips and the range menu down with it — which is
 * the failure mode that file's own header warns about.
 */
(function () {
  'use strict';

  const PHONE = '(max-width: 860px)';

  /* Only on a phone, and only once. The relocation below changes the DOM, so it
     must not run at a width where the desktop bar is correct — a reader who
     rotates gets the layout they loaded with, which is the same bargain every
     server-rendered breakpoint makes here. */
  if (!window.matchMedia || !window.matchMedia(PHONE).matches) return;

  document.addEventListener('DOMContentLoaded', run);
  if (document.readyState !== 'loading') run();

  let done = false;

  function run() {
    if (done) return;
    done = true;
    try {
      enhance();
    } catch (err) {
      /* A broken bar is worse than a scrolling one: leave the page as it was
         rather than half-rearranged. */
      const app = document.querySelector('.app');
      if (app) app.classList.remove('li-m-bar');
      if (window.console) console.warn('mobile top bar: ' + err.message);
    }
  }

  function enhance() {
    const app = document.querySelector('.app');
    const header = document.querySelector('.main-col > header');
    const nav = app && app.querySelector(':scope > nav');
    if (!app || !header || !nav) return;

    const kids = Array.from(header.children);

    /* The range group is the one holding the period chips. Found by its
       contents rather than by position, because the bar's order is the
       converter's and may change. */
    const rangeGroup = kids.find((el) => el.querySelector('[data-action^="?period="], [data-action*="period="]'))
      || kids.find((el) => el.children.length > 3 && /today/i.test(el.textContent || ''));

    const byAction = (name) => kids.find((el) => el.getAttribute('data-action') === name);
    const quiet = ['openPalette', 'toggleTheme', 'toggleAi'].map(byAction).filter(Boolean);

    /* The "vs previous period" note and the flex spacer: one is a caption that
       costs a third of the row, the other only exists to push things right in a
       row that no longer has a right. */
    const note = kids.find((el) => el !== rangeGroup && /vs previous/i.test(el.textContent || ''));
    const spacer = kids.find((el) => /flex:\s*1/.test(el.getAttribute('style') || '') && !el.textContent.trim());

    if (rangeGroup) rangeGroup.setAttribute('data-li-m', 'range');
    if (note) note.setAttribute('data-li-m', 'quiet');
    if (spacer) spacer.setAttribute('data-li-m', 'spacer');

    /* ── the drawer's second half ──────────────────────────────────────────
       Search, theme and Ask AI, plus whatever the filter bar keeps on its
       right — the freshness line and the saved views. Moved, not copied. */
    const shelf = document.createElement('div');
    shelf.className = 'li-m-shelf';
    for (const el of quiet) shelf.appendChild(el);

    const filterbar = findFilterBar();
    if (filterbar) {
      filterbar.setAttribute('data-li-m', 'filters');
      const tail = Array.from(filterbar.children).find((el) => (
        el.children.length && !el.querySelector('.ph-funnel-simple') && /saved|crm|ads/i.test(el.textContent || '')
      ));
      if (tail) shelf.appendChild(tail);
    }
    if (shelf.children.length) nav.appendChild(shelf);

    /* ── the two buttons that replace two rows ─────────────────────────── */
    if (rangeGroup) {
      header.insertBefore(
        panelButton(app, 'li-range-open', rangeLabel(rangeGroup), 'ph-calendar-blank'),
        rangeGroup
      );
    }
    if (filterbar) {
      const chipRow = filterbar.querySelector('.ph-funnel-simple');
      const group = chipRow ? chipRow.parentElement : filterbar;
      const count = Array.from(group.children).filter((c) => c.querySelector && c.querySelector('.ph-caret-down')).length;
      /* Anchored on the range group, not on an index: inserting the range
         button already shifted the indices, which put Filters ahead of the
         control the screen is actually read with. */
      header.insertBefore(
        panelButton(app, 'li-filters-open', 'Filters', 'ph-funnel-simple', count),
        rangeGroup || null
      );
    }

    /* On `.app`, not on the root: the open-state classes go there too, and the
       stylesheet joins them — `.li-m-bar.li-range-open` — which can only match
       if one element carries both. Set last, so a page that failed halfway
       through keeps the plain scrolling bar rather than a half-applied one. */
    app.classList.add('li-m-bar');
  }

  /* The filter bar is the sibling after the header that holds the chips. */
  function findFilterBar() {
    /* The same landmark enhanceChips uses — the funnel icon — rather than a
       second way of naming the same row that could drift from it. The chips
       themselves carry no attribute to find them by. */
    const funnel = document.querySelector('.main-col .ph-funnel-simple');
    const row = funnel && funnel.closest('.main-col > *');
    return row && row.tagName !== 'HEADER' && row.tagName !== 'MAIN' ? row : null;
  }

  /* What the button says: the chip that is currently on. Falls back to the date
     picker's own text, which always describes the resolved window, and then to
     a bare word — a button with no label is worse than a vague one. */
  function rangeLabel(group) {
    const chips = Array.from(group.querySelectorAll('[data-action]'));
    const active = chips.find((c) => {
      const bg = getComputedStyle(c).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      if (!m) return false;
      const parts = m[1].split(',').map((n) => parseFloat(n));
      return parts.length < 4 || parts[3] > 0.05;
    });
    const text = (active && active.textContent.trim())
      || (group.lastElementChild && group.lastElementChild.textContent.trim());
    return (text || 'Range').replace(/\s+/g, ' ').slice(0, 18);
  }

  /* One button, one class on `.app`. The stylesheet decides what open looks
     like; this only records which panel the reader asked for, and closes the
     other so two panels can never cover each other. */
  function panelButton(app, openClass, label, icon, count) {
    const other = openClass === 'li-range-open' ? 'li-filters-open' : 'li-range-open';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'li-m-btn';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<i class="ph ' + icon + '" aria-hidden="true"></i><span>' + escape(label) + '</span>'
      + (count ? '<em class="li-m-count">' + count + '</em>' : '')
      + '<i class="ph ph-caret-down li-m-caret" aria-hidden="true"></i>';

    const set = (open) => {
      app.classList.toggle(openClass, open);
      if (open) app.classList.remove(other);
      button.setAttribute('aria-expanded', String(open));
    };

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      set(!app.classList.contains(openClass));
    });

    /* A panel that stays open over the thing it filtered is the same complaint
       as a drawer that stays open over the page it loaded. */
    document.addEventListener('click', (e) => {
      if (!app.classList.contains(openClass)) return;
      if (button.contains(e.target)) return;
      const panel = document.querySelector('[data-li-m="' + (openClass === 'li-range-open' ? 'range' : 'filters') + '"]');
      if (panel && panel.contains(e.target) && !e.target.closest('[data-action], a')) return;
      set(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') set(false);
    });

    return button;
  }

  function escape(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }
})();
