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
