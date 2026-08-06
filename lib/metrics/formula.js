/* Formula evaluation for the metric registry.
 *
 * Sub-phase 6.1. The page is explicit about what a formula is allowed to be:
 * "Expression over other registry metrics — **never raw SQL in the UI**". So
 * this evaluates arithmetic over metric ids and nothing else. There is no
 * `eval`, no `new Function`, and no escape hatch to a query — a formula that
 * could reach past the registry would make the registry advisory, and the whole
 * point of stage 5 is that it is not.
 *
 * The grammar is deliberately small:
 *
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := number | metric.id | '(' expression ')' | '-' factor
 *
 * Division by zero returns null rather than Infinity. A ROAS with no spend is
 * not infinitely good; it is unknown, and every format and threshold downstream
 * has to be able to tell those apart.
 */

const IDENTIFIER = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/* Longest-match first so `>=` never lexes as `>` — kept even though the current
   grammar has no comparisons, because the next person to add one will not
   think to reorder this. */
const OPERATORS = ['+', '-', '*', '/'];

function tokenise(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === '(' || ch === ')') { tokens.push({ type: ch }); i += 1; continue; }

    if (OPERATORS.includes(ch)) { tokens.push({ type: 'op', value: ch }); i += 1; continue; }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      const raw = source.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`"${raw}" is not a number`);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }

    if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < source.length && /[a-z0-9_.]/i.test(source[j])) j += 1;
      const name = source.slice(i, j);
      if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a metric id`);
      tokens.push({ type: 'metric', value: name });
      i = j;
      continue;
    }

    /* Anything else is very likely someone reaching for SQL. Saying so is more
       use than "unexpected character". */
    throw new Error(`unexpected "${ch}" — a formula is arithmetic over metric ids, not a query`);
  }

  return tokens;
}

/* Recursive descent. Small enough to read in one sitting, which matters more
   here than generality: this is the only thing standing between a definition
   and a number somebody reports to a board. */
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  function expression() {
    let left = term();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = eat().value;
      left = { kind: 'binary', op, left, right: term() };
    }
    return left;
  }

  function term() {
    let left = factor();
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = eat().value;
      left = { kind: 'binary', op, left, right: factor() };
    }
    return left;
  }

  function factor() {
    const token = peek();
    if (!token) throw new Error('formula ends where a value was expected');

    if (token.type === 'op' && token.value === '-') {
      eat();
      return { kind: 'negate', operand: factor() };
    }

    if (token.type === 'number') { eat(); return { kind: 'number', value: token.value }; }
    if (token.type === 'metric') { eat(); return { kind: 'metric', id: token.value }; }

    if (token.type === '(') {
      eat();
      const inner = expression();
      if (!peek() || peek().type !== ')') throw new Error('unclosed (');
      eat();
      return inner;
    }

    throw new Error(`unexpected ${token.value || token.type} where a value was expected`);
  }

  const tree = expression();
  if (pos < tokens.length) {
    const extra = tokens[pos];
    throw new Error(`unexpected ${extra.value || extra.type} after the end of the expression`);
  }
  return tree;
}

const compile = (source) => parse(tokenise(source));

/* Every metric id a formula mentions, in the order it mentions them. This is
   what `dependencies` is checked against, so a definition cannot claim a
   dependency list that disagrees with its own formula. */
function references(tree, found = []) {
  if (!tree) return found;
  if (tree.kind === 'metric' && !found.includes(tree.id)) found.push(tree.id);
  if (tree.kind === 'binary') { references(tree.left, found); references(tree.right, found); }
  if (tree.kind === 'negate') references(tree.operand, found);
  return found;
}

/* `values` maps metric id -> number or null. A null input makes the whole
   expression null: a metric computed from an unknown is unknown, and carrying
   a zero through instead would silently turn "we do not know" into "it is
   nothing". */
function evaluate(tree, values) {
  if (tree.kind === 'number') return tree.value;

  if (tree.kind === 'metric') {
    if (!Object.prototype.hasOwnProperty.call(values, tree.id)) {
      throw new Error(`formula refers to "${tree.id}", which the registry does not define`);
    }
    return values[tree.id];
  }

  if (tree.kind === 'negate') {
    const operand = evaluate(tree.operand, values);
    return operand === null ? null : -operand;
  }

  const left = evaluate(tree.left, values);
  const right = evaluate(tree.right, values);
  if (left === null || right === null) return null;

  switch (tree.op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/':
      /* Unknown, not infinite — see the note at the top. */
      return right === 0 ? null : left / right;
    default: throw new Error(`unknown operator ${tree.op}`);
  }
}

const run = (source, values) => evaluate(compile(source), values);

module.exports = { tokenise, parse, compile, references, evaluate, run };
