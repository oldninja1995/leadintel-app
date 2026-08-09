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

test('a literal is replaced with the expression that re-credits it', () => {
  const html = '<text>₹18.9L</text>';
  assert.equal(bindLiterals(html, 'attribution'), '<text><%= attrSankeyMeta %></text>');
});

test('binding is idempotent — the literal is gone after the first pass', () => {
  const once = bindLiterals('<text>₹18.9L</text>', 'attribution');
  assert.equal(bindLiterals(once, 'attribution'), once);
});

test('a binding that would match twice is refused rather than guessing', () => {
  /* First-match-wins would bind the wrong node with nothing to show for it. */
  assert.throws(
    () => bindLiterals('<text>₹18.9L</text><text>₹18.9L</text>', 'attribution'),
    /appears 2 times — a binding must be unambiguous/
  );
});

test('bindings only apply to their own screen', () => {
  const html = '<text>₹18.9L</text>';
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
