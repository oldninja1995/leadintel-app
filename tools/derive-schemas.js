#!/usr/bin/env node
/* Derive a schema per resource from the generated shapes.
 *
 * `data/generated/<view>.js` is the exact inventory of what a screen's view
 * reads — emitted by tools/dc-to-ejs.js straight from the design markup. It
 * states the top-level keys and, in a comment above each array key, the fields
 * every item carries:
 *
 *     // each item: { label, showLabel }
 *     //   .items[] each: { badge, bg, color, ... }
 *     navGroups: [],
 *
 * That is the read contract. This tool turns it into `schemas/<resource>.json`
 * so it can be checked at runtime rather than trusted, which is what lets the
 * static repository be swapped for a database-backed one without touching a
 * view: the replacement either satisfies the schema or fails loudly.
 *
 * Regenerate after every converter run:  npm run schemas
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GENERATED = path.join(ROOT, 'data', 'generated');
const OUT = path.join(ROOT, 'schemas');

const KEY = /^(\s*)([A-Za-z_$][\w$]*): *(\{)?/;
const ITEM = /^\s*\/\* each item: \{ (.*) \} \*\/$/;
const NESTED = /^\s*\/\* +\.([\w.[\]]+)\[\] each: \{ (.*) \} \*\/$/;
const CLOSE = /^\s*\},?$/;

/* The converter writes `{ — }` for a list whose items are plain values rather
   than objects — a row of chips, a list of icon classes. */
const SCALAR = '—';

const fields = (list) => list.split(',').map((f) => f.trim()).filter(Boolean);
const shape = (list) => (list.trim() === SCALAR ? { scalar: true } : { item: fields(list) });

/* Walks one object literal's worth of lines, recursing into nested ones. The
   generated file is machine-written, so its indentation is reliable enough to
   parse structurally — but every key is checked against the required module,
   so a mis-parse cannot pass silently. */
function walk(lines, cursor, values) {
  const schema = {};
  let item = null;
  let nested = {};

  while (cursor.i < lines.length) {
    const line = lines[cursor.i];

    if (CLOSE.test(line)) {
      cursor.i += 1;
      return schema;
    }

    const asItem = ITEM.exec(line);
    if (asItem) {
      item = shape(asItem[1]);
      cursor.i += 1;
      continue;
    }

    const asNested = NESTED.exec(line);
    if (asNested) {
      nested[asNested[1]] = shape(asNested[2]);
      cursor.i += 1;
      continue;
    }

    const asKey = KEY.exec(line);
    if (!asKey) {
      cursor.i += 1;
      continue;
    }

    const [, , key, opensObject] = asKey;
    cursor.i += 1;

    if (!(key in values)) {
      throw new Error(`key "${key}" parsed from source but absent from the module`);
    }

    if (opensObject) {
      schema[key] = { kind: 'object', fields: walk(lines, cursor, values[key]) };
    } else if (Array.isArray(values[key])) {
      schema[key] = { kind: 'list', ...(item || { item: [] }) };
      if (Object.keys(nested).length) schema[key].nested = nested;
    } else {
      schema[key] = { kind: 'value', type: typeof values[key] };
    }
    item = null;
    nested = {};
  }

  return schema;
}

function assertComplete(resource, schema, values, at = '') {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'function') continue;
    const field = schema[key];
    /* A key the converter emitted but whose line we failed to match would be a
       silent hole in the contract — refuse rather than ship a partial schema. */
    if (!field) throw new Error(`${resource}: could not place key ${at}${key}`);
    if (field.kind === 'object') assertComplete(resource, field.fields, value, `${at}${key}.`);
  }
}

function deriveOne(resource) {
  const file = path.join(GENERATED, `${resource}.js`);
  const values = require(file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  const start = lines.findIndex((l) => l.startsWith('module.exports = {'));
  if (start === -1) throw new Error(`${resource}: no module.exports literal found`);

  const schema = walk(lines, { i: start + 1 }, values);
  assertComplete(resource, schema, values);

  return { resource, generatedFrom: `data/generated/${resource}.js`, fields: schema };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const resources = fs
    .readdirSync(GENERATED)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''));

  for (const resource of resources) {
    const schema = deriveOne(resource);
    fs.writeFileSync(
      path.join(OUT, `${resource}.json`),
      JSON.stringify(schema, null, 2) + '\n'
    );
    const lists = Object.values(schema.fields).filter((f) => f.kind === 'list').length;
    console.log(`${resource}: ${Object.keys(schema.fields).length} fields (${lists} lists)`);
  }

  console.log(`\n${resources.length} schemas written to schemas/`);
}

main();
