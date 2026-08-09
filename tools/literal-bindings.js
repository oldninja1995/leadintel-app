/* Figures the design draws as literal text rather than as `{{ }}`.
 *
 * A Claude Design file interpolates data through `sc-for` and `{{ }}`, but a
 * hand-drawn SVG has neither — so the attribution Sankey's node labels are
 * typed straight into the markup. They therefore never re-credit when the
 * attribution model changes, and the diagram ends up contradicting the table
 * beneath it on the same screen. That was Phase 2's one remaining known flaw.
 *
 * Binding them here rather than editing `views/screens/` keeps the rule that
 * generated views are never hand-edited: the **conversion** owns the change, so
 * a re-run against the real design file reproduces it rather than silently
 * dropping it. `tools/rebind.js` applies the same function to views that were
 * already generated.
 *
 * Each binding must be an exact literal that appears **exactly once** in its
 * screen. A `find` matching twice would bind the wrong node with no sign of it,
 * so that is an error rather than a first-match-wins guess.
 *
 * Applying this twice is a no-op: after the first pass the literal is gone.
 */

const LITERAL_BINDINGS = [
  /* The creative card's middle metric was HOOK RATE, which is a video statistic
     this product does not fetch and cannot compute — it renders "—" on every
     row and always will. Cost per lead can be computed from what Meta already
     reports at ad level, and is the number this screen is read for. So the cell
     is re-labelled rather than left dead. Both halves are bound: a label
     changed without its value would be worse than either. */
  {
    screen: 'creatives',
    find: '>HOOK RATE<',
    replace: '>CPL<',
    relabel: true,
    why: 'hook rate is not fetchable; the cell carries cost per lead instead',
  },
  {
    screen: 'creatives',
    find: '<%= cr.hookRate %>',
    replace: '<%= cr.cpl %>',
    pairedWith: '>HOOK RATE<',
    why: 'the value beneath the re-labelled CPL cell',
  },
  /* Three cells the design gave to figures Meta cannot supply — bookings,
     revenue and net ROAS all need PMS and CRM data that is still fixtures —
     re-labelled to three it can. The values move with them, below. */
  {
    screen: 'creatives',
    find: '>BOOKINGS<',
    replace: '>CPM<',
    relabel: true,
    valueFrom: 'cr.bookings',
    why: 'bookings need PMS revenue; CPM is fetched and judges reach cost',
  },
  {
    screen: 'creatives',
    find: '>REVENUE<',
    replace: '>FREQUENCY<',
    relabel: true,
    valueFrom: 'cr.rev',
    why: 'revenue needs the CRM; frequency is fetched and is the first fatigue signal',
  },
  {
    screen: 'creatives',
    find: '>NET ROAS<',
    replace: '>CPC<',
    relabel: true,
    valueFrom: 'cr.roas',
    why: 'ROAS needs attributed revenue; cost per click is derivable from spend and clicks',
  },
  {
    screen: 'creatives',
    find: '>WINNING SCORE<',
    replace: '>HOLD RATE<',
    relabel: true,
    valueFrom: 'cr.winning',
    why: 'nothing computes a winning score; hold rate measures whether the creative earns attention',
  },
  /* The screen carried two scores and defined neither. A number on a badge that
     the reader cannot interpret is worse than no badge: it gets quoted and then
     acted on. So the heading line names what is on the cards, each badge
     carries its own definition as a tooltip, and the fatigue badge says its
     band in words next to the number — "50 · Act soon" needs no legend at all.

     The `title` attribute is not decoration here. It is the only place on a
     card-sized surface where a definition fits, and the design draws no room
     for one. */
  {
    screen: 'creatives',
    find: '>24 active creatives · sorted by revenue<',
    replace: '><%= creativeSummary %><',
    why: 'the line was fixed at 24 creatives sorted by revenue whatever was on screen and however it was ranked',
  },
  {
    screen: 'creatives',
    find: 'Fatigue <%= cr.fatigue %></span>',
    replace: 'Fatigue <%= cr.fatigue %> · <%= cr.fatigueBand %></span>',
    why: 'the score alone is the thing readers could not interpret; the band names it in words',
  },
  {
    screen: 'creatives',
    find: 'background:<%= cr.fatigueBg %>; color:<%= cr.fatigueColor %>;">Fatigue',
    replace: 'background:<%= cr.fatigueBg %>; color:<%= cr.fatigueColor %>; cursor:help;" title="<%= cr.fatigueWhy %>">Fatigue',
    pairedWith: 'Fatigue <%= cr.fatigue %></span>',
    why: 'what the score reads, over what window, against what — there is nowhere else on the card for it',
  },
  /* The leaderboard's position. The design draws no rank column — it draws one
     card grid — so the number rides in the corner of the card it belongs to,
     and renders only in the view that has positions to show. */
  /* Anchored on the format badge's opening tag, which the replacement rewrites
     with a `data-li-slot` marker so the pattern cannot match a second time.
     This binding *adds* markup rather than swapping it, and an add that still
     matches its own output stacks another copy on every rebind. */
  {
    screen: 'creatives',
    find: '<span style="position:absolute; top:8px; left:8px; font-size:10px;',
    replace: [
      '<% if (cr.rank) { %><span style="position:absolute; bottom:8px; left:8px; font-size:11px; font-weight:600; border-radius:5px; padding:2px 8px; background:rgba(20,22,31,.82); color:var(--color-accent-300); font-variant-numeric:tabular-nums;">#<%= cr.rank %></span><% } %>',
      '                  <span data-li-slot="format" style="position:absolute; top:8px; left:8px; font-size:10px;',
    ].join('\n'),
    why: 'the leaderboard needs to show position, and the design gives it no column to show it in',
  },
  {
    screen: 'creatives',
    find: 'color:var(--color-neutral-300);"><%= cr.dur %></span>',
    replace: 'color:var(--color-neutral-300); cursor:help;" title="<%= cr.durWhy %>"><%= cr.dur %></span>',
    why: 'the funnel badge needs to say why a top-of-funnel creative booking nothing is not underperforming',
  },
  /* The verdict. Fatigue tells a reader something is wrong and leaves them to
     work out what to do; this is the other half. It goes below the hold-rate
     bar because it is the line the card is read for — see lib/creative-verdict.js
     for how it is decided and why cost is weighed against the set's median. */
  {
    screen: 'creatives',
    find: '<%= cr.winning %></span>\n                  </div>\n                </div>',
    replace: [
      '<%= cr.winning %></span>',
      '                  </div>',
      '                  <div style="display:flex; align-items:flex-start; gap:8px; margin-top:10px; padding-top:9px; border-top:1px solid var(--color-neutral-900);" title="<%= cr.verdictWhy %>">',
      '                    <span style="flex:none; font-size:10px; font-weight:500; border-radius:5px; padding:3px 8px; background:<%= cr.verdictBg %>; color:<%= cr.verdictColor %>;"><%= cr.verdict %></span>',
      '                    <span style="font-size:10.5px; color:var(--color-neutral-500); line-height:1.35;"><%= cr.verdictInstruction %> — <%= cr.verdictBecause %></span>',
      '                  </div>',
      '                </div>',
    ].join('\n'),
    why: 'a score with no instruction leaves the reader to decide what to do about it, which is the half that was missing',
  },
  /* The segmented control the design draws as three inert spans — no onClick,
     so nothing for the converter to preserve. Bound as one block because the
     three are one control: binding them singly would leave the strip half
     wired if a later re-run matched only some of them. */
  {
    screen: 'creatives',
    find: [
      '<span style="padding:5px 12px; background:var(--color-accent-900); color:var(--color-accent-300);">Gallery</span>',
      '              <span class="hv-3" style="padding:5px 12px; color:var(--color-neutral-500); cursor:pointer; border-left:1px solid var(--color-neutral-900);">Leaderboard</span>',
      '              <span class="hv-3" style="padding:5px 12px; color:var(--color-neutral-500); cursor:pointer; border-left:1px solid var(--color-neutral-900);">Timeline</span>',
    ].join('\n'),
    replace: [
      '<% (viewTabs || []).forEach(function (tab, i) { %>',
      '                <span class="hv-3" data-action="<%= tab.go %>" title="<%= tab.title %>" style="padding:5px 12px; cursor:pointer; background:<%= tab.bg %>; color:<%= tab.color %>; <% if (i) { %>border-left:1px solid var(--color-neutral-900);<% } %>"><%= tab.label %></span>',
      '              <% }); %>',
    ].join('\n'),
    why: 'the design draws the three views and wires none of them; each re-ranks the same cards',
  },
  /* What the two scores on the cards mean, on the page rather than in a
     document nobody opens. Injected between the header row and the card grid,
     which is the only gap the design leaves.
   *
   * The find is anchored on the sort control's caret rather than on the bare
   * `</div>` that closes the header row, and that is not fussiness: this is the
   * one binding whose replacement *re-emits its own closing tags*, so anchoring
   * it on those tags would match again on the next run and stack a second
   * legend under the first. The caret is consumed into the middle of the
   * replacement, where the pattern can no longer find it. */
  {
    screen: 'creatives',
    find: '</i></div>\n          </div>\n          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">',
    replace: [
      '</i></div>',
      '          </div>',
      '          <div style="display:flex; flex-wrap:wrap; gap:6px 18px; margin:-4px 0 14px; font-size:10.5px; color:var(--color-neutral-600); line-height:1.5;">',
      '            <span><%= fatigueLegend %></span>',
      '            <span><%= verdictLegend %></span>',
      '          </div>',
      '          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">',
    ].join('\n'),
    why: 'both scores are this product\'s own, not Meta\'s, and a score with no definition beside it is a number that gets acted on anyway',
  },
  /* The sort control was drawn with a cursor and no behaviour — no handler, no
     parameter, nothing behind it — so it has never sorted anything. Giving it a
     `data-action` is a conversion concern for the same reason the Sankey labels
     were: the design declares the control, and binding it here means a
     converter re-run reproduces the wiring rather than dropping it. */
  {
    screen: 'creatives',
    find: 'cursor:pointer;">Sort: Revenue<i class="ph ph-caret-down"',
    replace: 'cursor:pointer;" data-action="<%= sortNext %>">Sort: <%= sortLabel %><i class="ph ph-caret-down"',
    why: 'the design draws the control but wires nothing to it; revenue is not a column this screen can fill',
  },
  {
    screen: 'attribution',
    find: '>₹18.9L<',
    replace: '><%= attrSankeyMeta %><',
    why: 'Meta node — must follow the workspace attribution model',
  },
  {
    screen: 'attribution',
    find: '>₹52.3L<',
    replace: '><%= attrSankeyTotal %><',
    why: 'booking node — total credited revenue under the model in force',
  },
];

function bindLiterals(html, screen, { onBind } = {}) {
  let out = html;
  for (const binding of LITERAL_BINDINGS.filter((b) => b.screen === screen)) {
    const occurrences = out.split(binding.find).length - 1;
    if (occurrences === 0) continue;
    if (occurrences > 1) {
      throw new Error(`${screen}: "${binding.find}" appears ${occurrences} times — a binding must be unambiguous`);
    }
    out = out.replace(binding.find, binding.replace);
    if (onBind) onBind(binding);
  }
  return out;
}

module.exports = { LITERAL_BINDINGS, bindLiterals };
