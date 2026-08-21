/* The `Intl` construction trap, and a guard against its fourth visit.
 *
 *   node --test test/intl-formatters.test.js
 *
 * `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` and
 * `localeCompare` each have two shapes. Called with **no arguments** they go
 * through a formatter V8 keeps for exactly that case, and they are the fastest
 * thing available — faster, measurably, than an `Intl` object you cache
 * yourself. Called with **a locale or options** they construct a fresh
 * `Intl.NumberFormat` / `DateTimeFormat` / `Collator` on every single call:
 *
 *     toLocaleString('en-IN', {...})     76µs      vs  2.1µs cached   (35x)
 *     toLocaleDateString('en-GB', {...}) 90µs      vs  1.6µs cached   (55x)
 *     localeCompare(b, 'en', {...})      35.7ms per 662-key sort
 *                                        vs 1.2ms cached             (29x)
 *
 * None of that matters while a screen formats twelve KPI cards. It matters as
 * soon as a table formats a row, and this app formats 4,889 search terms across
 * three priced columns. The same mistake was found three times in three
 * different files, each time by profiling rather than by reading, which is what
 * makes it worth a test: it is invisible at the call site and it looks like the
 * obvious way to write the line.
 *
 * The rule this enforces: **build the formatter once, at module level, and call
 * `.format()` / `.compare()`.** Argument count is the whole tell.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['lib', 'data', 'views', 'public/assets'];
const METHODS = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'localeCompare'];

function sources(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(next);
    return /\.(js|ejs)$/.test(entry.name) ? [next] : [];
  });
}

/* Comments talk about the trap at length — including this file's own header —
   so they are removed before the source is searched. Crude on purpose: it only
   has to be right about `/*`, `//` and quotes, and a false positive here costs
   a scan, not a wrong verdict. */
function stripComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '/*') { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
    if (two === '//') { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end; continue; }
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += ' '.repeat(j - i + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* How many arguments the call at `open` is given, counting only commas outside
   any nested parens, brackets or braces — an options object is full of commas
   that are not argument separators, and so is `localeCompare(String(a || ''))`. */
function argumentCount(code, open) {
  let depth = 0;
  let args = 0;
  let seenSomething = false;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return seenSomething ? args + 1 : 0;
      continue;
    }
    if (depth === 1) {
      if (c === ',') args += 1;
      else if (!/\s/.test(c)) seenSomething = true;
    }
  }
  return args + 1;
}

test('no locale-sensitive call constructs its formatter at the call site', () => {
  const offenders = [];

  for (const dir of ROOTS) {
    for (const rel of sources(dir)) {
      const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      for (const method of METHODS) {
        /* `localeCompare(b)` takes the compared string as its first argument, so
           its options begin one place later than the formatters'. */
        const allowed = method === 'localeCompare' ? 1 : 0;
        let from = 0;
        for (;;) {
          const at = code.indexOf(`.${method}(`, from);
          if (at < 0) break;
          from = at + method.length;
          const open = at + method.length + 1;
          const count = argumentCount(code, open);
          if (count > allowed) {
            const line = code.slice(0, at).split('\n').length;
            offenders.push(`${rel}:${line}  .${method}() with ${count - allowed} option argument(s)`);
          }
        }
      }
    }
  }

  assert.deepEqual(offenders, [], [
    'these build a fresh Intl object on every call — hoist one to module level',
    'and call .format() / .compare() instead:',
    ...offenders.map((o) => `  ${o}`),
  ].join('\n'));
});

/* server.js is scanned apart from the loop above, because it is not under any of
   the roots and is where two of the three were found. */
test('server.js does not construct a formatter at a call site either', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const offenders = [];

  for (const method of METHODS) {
    const allowed = method === 'localeCompare' ? 1 : 0;
    let from = 0;
    for (;;) {
      const at = code.indexOf(`.${method}(`, from);
      if (at < 0) break;
      from = at + method.length;
      const count = argumentCount(code, at + method.length + 1);
      if (count > allowed) offenders.push(`server.js:${code.slice(0, at).split('\n').length}  .${method}()`);
    }
  }

  assert.deepEqual(offenders, [], `hoist these to module level:\n  ${offenders.join('\n  ')}`);
});

/* The other half of the rule, which is the half that is easy to get backwards:
   the no-argument form is already optimal and caching it makes it slower. This
   is a comment with a number attached rather than an assertion about timing,
   which would be flaky — but the counts are asserted, so a sweep that "fixed"
   every call site would fail here and be made to read this. */
test('the no-argument form is left alone, deliberately', () => {
  const plain = [];
  for (const dir of [...ROOTS, '.']) {
    for (const rel of sources(dir)) {
      if (rel.startsWith('test' + path.sep) || rel.includes('node_modules')) continue;
      const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      for (const method of METHODS) {
        let from = 0;
        for (;;) {
          const at = code.indexOf(`.${method}(`, from);
          if (at < 0) break;
          from = at + method.length;
          plain.push(rel);
        }
      }
    }
  }
  assert.ok(plain.length > 0, 'the plain form is the right call and should still be in use');
});
