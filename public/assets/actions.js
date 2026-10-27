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
};

/* Panels the server renders on a query flag, so the toggle just flips it. */
const TOGGLES = {
  toggleWs: 'ws',
  toggleEdit: 'edit',
  toggleCompare: 'compare',
  toggleNotes: 'notes',
  toggleBm: 'bm',
};

/* A short confirmation in the corner, for actions with no visible result of
   their own (a copied link). */
function toast(text) {
  const t = document.createElement('div');
  t.className = 'li-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* Every table on the screen as one CSV, each under the heading of the panel it
   sits in. Read from what is rendered, so the file matches the screen — range,
   filters and all — without a second definition of the figures. */
function screenCsv() {
  const quote = (v) => {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blocks = [];
  for (const table of document.querySelectorAll('main table')) {
    const panel = table.closest('[style*="border-radius:12px"]') || table.parentElement;
    const title = panel && panel.querySelector('div[style*="font-weight:500"]');
    const rows = [...table.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('th, td')].map((c) => quote(c.innerText)))
      .filter((r) => r.some((c) => c));
    if (rows.length) blocks.push([title ? quote(title.innerText) : '', ...rows.map((r) => r.join(','))].filter(Boolean).join('\n'));
  }
  return blocks.join('\n\n');
}

const HANDLERS = {
  /* The Copilot, on the range the reader is looking at: its answers are about
     the window in the address bar, so the window travels with the click. */
  toggleAi() {
    const here = new URLSearchParams(window.location.search);
    const next = new URLSearchParams({ v: 'aiChat' });
    for (const k of ['period', 'from', 'to']) if (here.get(k)) next.set(k, here.get(k));
    window.location.href = `/ai?${next.toString()}`;
  },
  exportCsv() {
    const csv = screenCsv();
    if (!csv) { toast('Nothing to export on this screen'); return; }
    const name = (document.querySelector('main h1') || {}).innerText || 'leadintel';
    const a = document.createElement('a');
    /* The BOM is what makes Excel read ₹ and other non-ASCII text as UTF-8. */
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },
  async shareLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied — it opens this screen with the same dates and filters');
    } catch (err) {
      window.prompt('Copy this link', location.href);
    }
  },
  printPage() { window.print(); },
  /* Presentation mode. Full screen enlarges the presented area; TV mode does
     the same and reloads every five minutes so a lobby screen keeps current
     — the reload re-enters TV mode from the ?tv=1 it carries. */
  presentFullscreen() {
    const stage = document.querySelector('[data-li-present]') || document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => toast('This browser would not go full screen'));
  },
  presentTv() {
    const url = new URL(window.location.href);
    url.searchParams.set('tv', '1');
    window.history.replaceState(null, '', url);
    HANDLERS.presentFullscreen();
    setTimeout(() => window.location.reload(), 5 * 60 * 1000);
    toast('TV mode — figures refresh every 5 minutes. Press Esc to leave full screen.');
  },
  /* A sub-screen list that folds away, and stays that way.
   *
   * Server-rendered open when the reader is standing in the branch, and
   * remembered in localStorage otherwise — a fold that reopened on every
   * navigation would be a decoration rather than a control. The key is the
   * parent's slug, so adding another parent needs nothing here. */
  toggleNav(el, ev) {
    if (ev) ev.stopPropagation();
    const slug = el.getAttribute('data-nav');
    const box = document.querySelector('[data-nav-children="' + slug + '"]');
    if (!box) return;
    const open = box.style.display === 'none';
    box.style.display = open ? '' : 'none';
    el.classList.toggle('ph-caret-down', open);
    el.classList.toggle('ph-caret-right', !open);
    try {
      window.localStorage.setItem('li-nav:' + slug, open ? 'open' : 'shut');
    } catch (err) {
      /* Private browsing refuses storage. The fold still works for this page;
         it simply does not outlive it, which is better than the click doing
         nothing at all. */
    }
  },
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

  /* Handlers first: a fold caret lives inside a row that navigates, and the
     row's path would otherwise win the moment the caret's own name is not
     recognised here. */
  if (HANDLERS[action]) {
    HANDLERS[action](el, ev);
    return;
  }

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
