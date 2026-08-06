/* Schema loading and payload checking.
 *
 * `schemas/<resource>.json` is derived from the generated shapes by
 * tools/derive-schemas.js — it states, per resource, the keys a view reads and
 * the fields every row of every list carries. Checking payloads against it is
 * what makes the repository swap safe: a database-backed implementation that
 * returns a differently-shaped row is caught here rather than rendering as a
 * blank cell.
 *
 * Checks run in development only. In production the cost is not worth paying
 * for a shape that CI should already have proven.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'schemas');

const cache = new Map();

function loadSchema(resource) {
  if (cache.has(resource)) return cache.get(resource);
  const file = path.join(DIR, `${resource}.json`);
  const schema = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  cache.set(resource, schema);
  return schema;
}

function resourceNames() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/* One element of a list: either a plain value the view prints directly, or a
   row that must carry every declared field. Returns an issue or null. */
function checkRow(spec, row, at) {
  if (spec.scalar) {
    return typeof row === 'string' || typeof row === 'number'
      ? null
      : `${at} — expected a value, got ${describe(row)}`;
  }
  if (row === null || typeof row !== 'object') {
    return `${at} — expected a row object, got ${describe(row)}`;
  }
  const missing = (spec.item || []).filter((f) => !(f in row));
  return missing.length ? `${at} — row is missing ${missing.join(', ')}` : null;
}

/* Only the first offending row is named — a list whose shape is wrong is
   usually wrong in every row, and 200 identical lines would bury the next
   problem. */
function checkList(field, value, at, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${at} — expected a list, got ${describe(value)}`);
    return;
  }
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    const issue = checkRow(field, row, `${at}[${i}]`);
    if (issue) {
      issues.push(issue);
      return;
    }
    for (const [subPath, subSpec] of Object.entries(field.nested || {})) {
      const sub = row[subPath];
      if (!Array.isArray(sub)) {
        issues.push(`${at}[${i}].${subPath} — expected a list, got ${describe(sub)}`);
        return;
      }
      for (let j = 0; j < sub.length; j += 1) {
        const subIssue = checkRow(subSpec, sub[j], `${at}[${i}].${subPath}[${j}]`);
        if (subIssue) {
          issues.push(subIssue);
          return;
        }
      }
    }
  }
}

function describe(value) {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

/* `requireAll` distinguishes the two places a payload is checked. A repository
   read is allowed to omit keys the route supplies itself (sub-view flags, edit
   mode, sidebar width); the payload handed to a view is not — anything missing
   there renders as blank. */
function checkFields(fields, payload, { requireAll }, at, issues) {
  for (const [key, field] of Object.entries(fields)) {
    const present = payload !== null && typeof payload === 'object' && key in payload;
    const where = at ? `${at}.${key}` : key;

    if (!present) {
      if (requireAll) issues.push(`${where} — nothing supplies it`);
      continue;
    }

    const value = payload[key];

    if (field.kind === 'list') {
      checkList(field, value, where, issues);
    } else if (field.kind === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.push(`${where} — expected an object, got ${describe(value)}`);
      } else {
        checkFields(field.fields, value, { requireAll }, where, issues);
      }
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') issues.push(`${where} — expected a boolean, got ${describe(value)}`);
    } else if (typeof value !== 'string' && typeof value !== 'number') {
      issues.push(`${where} — expected a value, got ${describe(value)}`);
    }
  }
}

function validate(resource, payload, { requireAll = false } = {}) {
  const schema = loadSchema(resource);
  if (!schema) return [];
  const issues = [];
  checkFields(schema.fields, payload || {}, { requireAll }, '', issues);
  return issues;
}

const enabled = process.env.NODE_ENV !== 'production' && process.env.LEADINTEL_SCHEMA_CHECK !== 'off';
const reported = new Set();

/* Reported once per resource per process. A shape problem is a property of the
   code, not of the request, so repeating it on every page load only makes the
   log harder to read. */
function audit(resource, payload, { requireAll = false, label = resource } = {}) {
  if (!enabled) return [];
  /* A development-time check must never be the reason a page fails to render,
     so a fault in the checker itself is reported and swallowed. */
  let issues;
  try {
    issues = validate(resource, payload, { requireAll });
  } catch (err) {
    console.warn(`schema: check of ${label} could not run — ${err.message}`);
    return [];
  }
  const key = `${label}:${requireAll}`;
  if (issues.length && !reported.has(key)) {
    reported.add(key);
    console.warn(`\nschema: ${label} does not match schemas/${resource}.json`);
    for (const issue of issues) console.warn(`  · ${issue}`);
  }
  return issues;
}

module.exports = { loadSchema, resourceNames, validate, audit, enabled };
