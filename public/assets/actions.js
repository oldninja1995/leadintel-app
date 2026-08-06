/* The design declares click targets as `onClick="{{ someFn }}"`; those functions
 * live in its data script, which has not been transcribed yet, so the converter
 * preserves them as `data-action="someFn"` rather than inventing behaviour.
 *
 * Only actions whose behaviour is unambiguous from the markup itself are wired
 * here. Everything else is deliberately inert — see data/generated/*.js for the
 * full list of declared actions per screen.
 */

/* Actions whose name states the destination, and whose destination is a route
   this app already serves. Nothing here is a guess about behaviour: `goPipe`
   goes to the pipeline, `backToLeads` goes back to leads. */
const NAVIGATE = {
  backToCampaigns: '/campaigns',
  backToLeads: '/leads',
  closeCr: '/creatives',
  goPipe: '/pipeline',
  goSales: '/sales',
  goPresent: '/reports?v=repPresent',
  aiGoHealth: '/ai?v=aiHealth',
  pipeKanban: '/pipeline?v=pipeIsKanban',
  pipeListGo: '/pipeline?v=pipeIsList',
  toggleAi: '/ai',
};

/* Panels the server renders on a query flag, so the toggle just flips it. */
const TOGGLES = {
  toggleWs: 'ws',
  toggleEdit: 'edit',
};

const HANDLERS = {
  /* The sidebar's own markup is the whole story: collapse narrows it and hides
     the labels. Nothing else is implied. */
  toggleSidebar(el) {
    const sidebar = el.closest('nav') || document.querySelector('nav');
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle('is-collapsed');
    sidebar.classList.toggle('is-expanded', !collapsed);
    const caret = el.querySelector('i');
    if (caret) {
      caret.classList.toggle('ph-caret-double-left', !collapsed);
      caret.classList.toggle('ph-caret-double-right', collapsed);
    }
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');

  /* Item-scoped actions are evaluated at render, so the data can supply a
     destination per row. A path means navigate. */
  if (action.startsWith('/')) {
    window.location.href = action;
    return;
  }

  if (NAVIGATE[action]) {
    window.location.href = NAVIGATE[action];
    return;
  }

  if (TOGGLES[action]) {
    const url = new URL(window.location.href);
    const key = TOGGLES[action];
    if (url.searchParams.has(key)) url.searchParams.delete(key);
    else url.searchParams.set(key, '1');
    window.location.href = url.toString();
    return;
  }

  const handler = HANDLERS[action];
  if (handler) handler(el, ev);
});
