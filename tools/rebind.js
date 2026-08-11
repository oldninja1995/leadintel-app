#!/usr/bin/env node
/* Applies the converter's literal bindings to views that were already generated.
 *
 *   node tools/rebind.js            # apply
 *   node tools/rebind.js --check    # report only, exit 1 if anything is unbound
 *
 * `tools/dc-to-ejs.js` binds these during conversion, but the views in this
 * repo were generated before the bindings existed and the design file needed to
 * regenerate them is not on disk (see PHASES.md, Phase 1). Rather than hand-edit
 * `views/screens/`, which the project forbids for good reason, this runs the
 * converter's own `bindLiterals` over the existing output — so the change is
 * made by the same code that would make it during a full re-run, and a later
 * re-run reproduces it rather than reverting it.
 *
 * Idempotent: once a literal is bound it is gone, so a second run finds nothing.
 */

const fs = require('fs');
const path = require('path');

const { LITERAL_BINDINGS, bindLiterals } = require('./literal-bindings');

/* Screens *and* partials. The converter generates both and the project forbids
   hand-editing either, but this only ever looked in `views/screens/` — so a
   literal in the filter bar or the topbar had no way to be bound at all, and
   the only ways left were to edit generated markup or to leave the control
   broken. A binding names the file; where it lives is this file's problem. */
const ROOTS = [
  path.join(__dirname, '..', 'views', 'screens'),
  path.join(__dirname, '..', 'views', 'partials'),
];

const locate = (screen) => ROOTS
  .map((root) => path.join(root, `${screen}.ejs`))
  .find((file) => fs.existsSync(file));

const check = process.argv.includes('--check');

const screens = [...new Set(LITERAL_BINDINGS.map((b) => b.screen))];
let bound = 0;
let unbound = 0;

for (const screen of screens) {
  const file = locate(screen);
  if (!file) {
    console.warn(`skipped ${screen}: no generated view for it under views/`);
    continue;
  }

  const before = fs.readFileSync(file, 'utf8');
  const applied = [];
  const after = bindLiterals(before, screen, { onBind: (b) => applied.push(b) });

  if (!applied.length) continue;

  for (const binding of applied) {
    console.log(`${check ? 'would bind' : 'bound'}  ${screen}: ${binding.find} -> ${binding.replace}  (${binding.why})`);
  }

  if (check) { unbound += applied.length; continue; }
  fs.writeFileSync(file, after);
  bound += applied.length;
}

if (check) {
  console.log(unbound ? `\n${unbound} literal(s) still unbound — run: node tools/rebind.js` : '\nall literals bound');
  process.exit(unbound ? 1 : 0);
}

console.log(bound ? `\n${bound} literal(s) bound` : '\nnothing to bind — every literal is already a template expression');
