/* The Copilot tab on the AI Command Center.
 *
 * Posts the question, the conversation so far and the range in the address bar
 * to /ai/ask, and draws the answer. The conversation lives in sessionStorage so
 * changing the range (a page load) keeps it; it never leaves this browser
 * except as the history sent with the next question. */
(function () {
  const log = document.getElementById('li-copilot-log');
  const form = document.getElementById('li-copilot-form');
  const input = document.getElementById('li-copilot-q');
  if (!log || !form || !input) return;

  const KEY = 'li-copilot';
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || []; } catch (e) { return []; } };
  const save = (turns) => { try { sessionStorage.setItem(KEY, JSON.stringify(turns.slice(-24))); } catch (e) { /* private mode */ } };
  let turns = load();
  let busy = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Enough markdown for an analyst's answer — bold, bullets, numbered lines,
     headings — escaped first, so nothing the model writes becomes markup. */
  function render(text) {
    const lines = esc(text).split(/\r?\n/);
    let html = '';
    let list = null;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
        close(); html += `<div class="li-cp-h">${inline(m[1])}</div>`;
      } else if (!line.trim()) {
        close();
      } else {
        close(); html += `<p>${inline(line)}</p>`;
      }
    }
    close();
    return html;
  }

  function bubble(role, html, extra) {
    const empty = log.querySelector('[data-copilot-empty]');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = `li-cp-msg li-cp-${role}${extra ? ` ${extra}` : ''}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function draw() {
    for (const t of turns) bubble(t.role, t.role === 'user' ? esc(t.text) : render(t.text));
  }

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || busy) return;
    busy = true;
    input.value = '';
    const history = turns.slice();
    bubble('user', esc(q));
    const wait = bubble('assistant', '<span class="li-cp-dots"><i></i><i></i><i></i></span> Reading this range…', 'li-cp-wait');

    const here = new URLSearchParams(location.search);
    const body = { question: q, history };
    for (const k of ['period', 'from', 'to', 'property', 'channel', 'campaign']) {
      const v = here.get(k) || here.get(`f_${k}`);
      if (v) body[k] = v;
    }

    try {
      const res = await fetch('/ai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({ error: `The server answered ${res.status}` }));
      wait.remove();
      if (!res.ok || !out.answer) {
        const link = out.connect ? ` <a href="${esc(out.connect)}">Open Connections →</a>` : '';
        bubble('assistant', `${esc(out.error || 'No answer came back.')}${link}`, 'li-cp-error');
      } else {
        turns.push({ role: 'user', text: q }, { role: 'assistant', text: out.answer });
        save(turns);
        const el = bubble('assistant', render(out.answer));
        if (out.range) el.insertAdjacentHTML('beforeend', `<div class="li-cp-meta">${esc(out.range)} · Claude</div>`);
      }
    } catch (err) {
      wait.remove();
      bubble('assistant', 'Could not reach LeadIntel — check the connection and ask again.', 'li-cp-error');
    } finally {
      busy = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-copilot-ask]');
    if (chip) { ask(chip.getAttribute('data-copilot-ask')); return; }
    if (e.target.closest('[data-copilot-clear]')) {
      turns = [];
      save(turns);
      location.reload();
    }
  });

  draw();
  input.focus();
})();
