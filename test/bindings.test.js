/* Phase 2's last known flaw — the attribution Sankey's hardcoded node labels.
 *
 *   node --test        or        npm test
 *
 * The design draws the Sankey as a hand-written SVG, so its node figures are
 * literal text rather than `{{ }}`. They therefore never re-credited when the
 * attribution model changed, and the diagram contradicted the table beneath it
 * on the same screen — with a non-default model selected you could read ₹18.9L
 * and ₹14.1L for Meta at once.
 *
 * The fix belongs to the converter (tools/literal-bindings.js), not to the
 * generated view, so a re-run against the real design file reproduces it. These
 * tests hold both halves in place: the binding mechanism, and the data the
 * bound expressions read.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { LITERAL_BINDINGS, bindLiterals } = require('../tools/literal-bindings');
const screen = require('../data/attribution');
const attribution = require('../lib/attribution');

const VIEW = path.join(__dirname, '..', 'views', 'screens', 'attribution.ejs');

/* ── the binding mechanism ──────────────────────────────────────────────── */

/* The booking total, which is still a literal in the design's markup. The Meta
   node used to be the example here and is no longer bound at all — the Sankey's
   channel boxes are generated now, so there is no fixed node to replace. */
test('a literal is replaced with the expression that re-credits it', () => {
  const html = '<text>₹52.3L</text>';
  assert.equal(bindLiterals(html, 'attribution'), '<text><%= attrSankeyTotal %></text>');
});

test('binding is idempotent — the literal is gone after the first pass', () => {
  const once = bindLiterals('<text>₹52.3L</text>', 'attribution');
  assert.equal(bindLiterals(once, 'attribution'), once);
});

test('a binding that would match twice is refused rather than guessing', () => {
  /* First-match-wins would bind the wrong node with nothing to show for it. */
  assert.throws(
    () => bindLiterals('<text>₹52.3L</text><text>₹52.3L</text>', 'attribution'),
    /appears 2 times — a binding must be unambiguous/
  );
});

test('bindings only apply to their own screen', () => {
  const html = '<text>₹52.3L</text>';
  assert.equal(bindLiterals(html, 'dashboard'), html);
});

test('every binding names a screen, a reason, and an expression', () => {
  for (const binding of LITERAL_BINDINGS) {
    assert.ok(binding.screen, 'a binding with no screen would apply nowhere');
    assert.ok(binding.why, `${binding.find} has no stated reason`);

    /* A binding normally exists to make a hardcoded figure follow the data, so
       replacing text with more text usually means somebody bound the wrong
       half. The exception is a re-label — a column that now carries a different
       metric — and it has to be declared, so the ordinary case stays guarded. */
    if (binding.relabel) {
      assert.ok(!/<%=/.test(binding.replace), `${binding.find} is declared a relabel but binds an expression`);
      continue;
    }
    /* The replacement has to *read data*, which is the whole point of binding
       it — a swap of one literal for another is somebody binding the wrong
       half. A dotted path is what that looks like: a row-scoped binding reads
       `cr.cpl`, not a bare name.
     *
     * The path may sit inside a larger expression. Bindings started out
     * swapping one figure for one field, and now some of them render
     * conditionally — a play badge that becomes an image badge, a panel that
     * becomes a player — so requiring the *entire* tag to be nothing but a
     * dotted path rejected exactly the bindings that read the most data. What
     * matters is that data is read, not how plainly. */
    /* A binding may instead *remove* markup — the design draws controls that
       lead nowhere, and a dead affordance is a conversion concern in the same
       way a hardcoded figure is. It has to say so: `removes: true` and an empty
       replacement, so that deleting part of a screen is always deliberate and
       never a binding whose expression somebody forgot to write. */
    if (binding.removes) {
      assert.equal(binding.replace, '', `${binding.find} is marked as a removal but replaces with something`);
      continue;
    }

    assert.match(binding.replace, /<%=[^%]*[A-Za-z_$][\w.$]*/, `${binding.find} does not bind to an expression`);
  }
});

/* A re-labelled column whose value was left alone would be a mislabel — worse
   than the dead cell it replaced. There are two honest ways to move the value:
   rebind the expression to a different field, or keep the field and change what
   the projection puts in it. The second must name the field, so the pairing is
   checkable either way and neither can be forgotten. */
test('a relabelled column has its value moved too', () => {
  for (const binding of LITERAL_BINDINGS.filter((b) => b.relabel)) {
    const rebound = LITERAL_BINDINGS.find(
      (b) => b.screen === binding.screen && !b.relabel && b.pairedWith === binding.find
    );
    assert.ok(
      rebound || binding.valueFrom,
      `${binding.find} was relabelled but nothing says where its value now comes from`
    );
  }
});

/* The field a relabel names must actually be the one the view reads. */
test('a relabelled column names a field the view renders', () => {
  const view = (screen) => fs.readFileSync(
    path.join(__dirname, '..', 'views', 'screens', `${screen}.ejs`), 'utf8'
  );

  for (const binding of LITERAL_BINDINGS.filter((b) => b.relabel && b.valueFrom)) {
    assert.match(
      view(binding.screen),
      new RegExp(`<%=\\s*${binding.valueFrom.replace('.', '\\.')}\\s*%>`),
      `${binding.find} claims its value comes from ${binding.valueFrom}, which the view does not render`
    );
  }
});

/* ── the generated view is bound ────────────────────────────────────────── */

test('the attribution view holds no unbound Sankey literal', () => {
  const view = fs.readFileSync(VIEW, 'utf8');
  for (const binding of LITERAL_BINDINGS.filter((b) => b.screen === 'attribution')) {
    assert.ok(!view.includes(binding.find),
      `${binding.find} is still hardcoded — run: node tools/rebind.js`);
    assert.ok(view.includes(binding.replace), `${binding.replace} is missing from the view`);
  }
});

/* ── the data behind the expressions ────────────────────────────────────── */

test('the Sankey figure follows the model, and matches the table', () => {
  for (const key of attribution.ORDER) {
    const payload = screen.select({ model: key });
    const table = payload.attrChannels.find((c) => c.channel === 'Meta Ads').rev;
    assert.equal(payload.attrSankeyMeta, table,
      `under ${key} the Sankey says ${payload.attrSankeyMeta} while the table says ${table}`);
  }
});

test('switching model moves the Sankey figure', () => {
  /* The bug in one line: these used to be identical. */
  assert.notEqual(
    screen.select({ model: 'first' }).attrSankeyMeta,
    screen.select({ model: 'last' }).attrSankeyMeta
  );
  assert.equal(screen.select({ model: 'first' }).attrSankeyMeta, '₹24.1L');
  assert.equal(screen.select({ model: 'last' }).attrSankeyMeta, '₹14.1L');
});

test('a preview moves the Sankey too, or the diagram would contradict the preview bar', () => {
  const payload = screen.select({ model: 'datadriven', preview: 'last' });
  assert.equal(payload.attrSankeyMeta, '₹14.1L');
});

test('the booking node carries the total credited under the model in force', () => {
  for (const key of attribution.ORDER) {
    const payload = screen.select({ model: key });
    const total = attribution.total(attribution.MODELS[key]);
    assert.equal(payload.attrSankeyTotal, `₹${total.toFixed(1)}L`);
  }
});

/* A label that no longer describes its value is worse than an unbound one.
 *
 * The bar was relabelled WINNING SCORE -> HOLD RATE, that shipped, and the same
 * binding's `replace` was later changed to BEST OVERALL when the bar started
 * showing the composite score. Editing a `replace` after it has been applied
 * does nothing — the `find` is already gone — so the screen went on reading
 * "HOLD RATE 90" beside a hold-rate cell of 0.7%. Both halves were internally
 * consistent, so nothing caught it.
 *
 * This asserts the *rendered views* carry no label a binding has superseded. */
test('no view still carries a label a later binding replaced', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'views', 'screens');

  /* Every label any binding replaces something *with*, and every label some
     binding replaces *away from*. A label in both sets is a rename in flight. */
  const introduced = new Set();
  const superseded = new Set();
  for (const b of LITERAL_BINDINGS) {
    const asLabel = /^>[^<]+<$/;
    if (asLabel.test(b.replace)) introduced.add(`${b.screen}${b.replace}`);
    if (asLabel.test(b.find)) superseded.add(`${b.screen}${b.find}`);
  }

  for (const key of superseded) {
    const screen = key.slice(0, key.indexOf('>'));
    const label = key.slice(key.indexOf('>'));
    const file = path.join(dir, `${screen}.ejs`);
    if (!fs.existsSync(file)) continue;

    assert.ok(
      !fs.readFileSync(file, 'utf8').includes(label),
      `${screen}.ejs still shows ${label}, which a binding replaces — run npm run rebind, or add a migration binding from the label it currently carries`,
    );
  }
});
