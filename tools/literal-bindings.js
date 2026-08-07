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
