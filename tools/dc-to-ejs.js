#!/usr/bin/env node
/* Converts a Claude Design `.dc.html` file into the EJS views this app renders.
 *
 *   node tools/dc-to-ejs.js "path/to/LeadIntel App.dc.html"
 *
 * The design file is the source of truth; this script is deterministic, so
 * re-run it whenever the design changes rather than hand-editing the output.
 *
 * What it translates:
 *   <sc-for list="{{ xs }}" as="x">…</sc-for>  ->  <% (xs||[]).forEach(function(x){ %>…<% }); %>
 *   <sc-if value="{{ c }}">…</sc-if>           ->  <% if (c) { %>…<% } %>
 *   {{ expr }}                                 ->  <%= expr %>
 *   style-hover="…"                            ->  a generated class in hover.css
 *   onClick="{{ fn }}"                         ->  data-action="fn" (wire up later)
 *   hint-placeholder-*                         ->  dropped (authoring hints)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = process.argv[2];

if (!SRC) {
  console.error('usage: node tools/dc-to-ejs.js <path to .dc.html>');
  process.exit(1);
}

/* Top-level screen gates, in the order the design declares them.
   Key is the `sc-if` condition that wraps the screen. */
const SCREEN_GATES = {
  /* Overlays — siblings of the screens, not nested inside them. */
  wsOpen: 'overlay-workspace',
  crSelOpen: 'overlay-creative-detail',

  isDash: 'dashboard',
  isMkt: 'marketing',
  isCamp: 'campaigns',
  isCreative: 'creatives',
  isAud: 'audiences',
  isAttr: 'attribution',
  isWeb: 'website',
  isAI: 'ai',
  isReports: 'reports',
  isCrm: 'crm',
  isLeads: 'leads',
  isPipe: 'pipeline',
  isSales: 'sales',
};

/* Shared chrome — lives outside the screen gates, so it is extracted by
   explicit start/end markers rather than by an sc-if condition. */
const CHROME = [
  { name: 'sidebar', from: '<nav style="width: {{ sidebarWidth }}', to: '</nav>' },
  { name: 'topbar', from: '<!-- Top bar -->', to: '</header>' },
  { name: 'filterbar', from: '<!-- Global filter bar -->', to: '<!-- ============ CONTENT ============ -->' },
];

const src = fs.readFileSync(SRC, 'utf8');

/* ── 1. Locate each screen block ──────────────────────────────────────────
   Finds the `<sc-if value="{{ isX }}">` opener and its matching `</sc-if>`.
   Only sc-if tokens are counted: any sc-for nested inside is balanced and
   cannot affect sc-if depth in well-formed markup. */

function findScreenBlock(gate) {
  const open = new RegExp(`<sc-if value="\\{\\{ ${gate} \\}\\}"[^>]*>`);
  const m = open.exec(src);
  if (!m) return null;

  const bodyStart = m.index + m[0].length;
  const token = /<sc-if\b[^>]*>|<\/sc-if>/g;
  token.lastIndex = bodyStart;

  let depth = 1;
  let t;
  while ((t = token.exec(src))) {
    depth += t[0] === '</sc-if>' ? -1 : 1;
    if (depth === 0) return { body: src.slice(bodyStart, t.index), complete: true };
  }
  /* Ran off the end — the source was truncated inside this screen. */
  return { body: src.slice(bodyStart), complete: false };
}

/* ── 2. Hover styles → real CSS classes ───────────────────────────────────
   `style-hover` is a Claude Design authoring attribute, not valid HTML. Each
   unique declaration list becomes one class, shared by every element using it. */

const hoverClasses = new Map(); // declaration text -> class name

function hoverClassFor(decls) {
  const key = decls.trim().replace(/\s+/g, ' ');
  if (!hoverClasses.has(key)) hoverClasses.set(key, `hv-${hoverClasses.size + 1}`);
  return hoverClasses.get(key);
}

function extractHovers(html) {
  return html.replace(/<(\w[\w-]*)([^>]*?)\sstyle-hover="([^"]*)"([^>]*?)>/g,
    (_all, tag, before, decls, after) => {
      const cls = hoverClassFor(decls);
      let attrs = before + after;
      if (/\sclass="/.test(attrs)) {
        attrs = attrs.replace(/\sclass="([^"]*)"/, (_m, existing) => ` class="${existing} ${cls}"`);
      } else {
        attrs = ` class="${cls}"` + attrs;
      }
      return `<${tag}${attrs}>`;
    });
}

/* ── 3. Template tags → EJS ───────────────────────────────────────────────── */

/* Literal figures the design draws as text instead of `{{ }}` — see
   tools/literal-bindings.js. Shared with tools/rebind.js so the conversion and
   the patch of an already-generated view can never disagree. */
const { bindLiterals } = require('./literal-bindings');

function toEjs(html) {
  let out = html;

  out = extractHovers(out);

  /* Interaction handlers reference functions defined in the design's data
     script. Preserve the intent as a data attribute instead of emitting a
     broken inline handler. */
  out = out.replace(/\sonClick="\{\{\s*([^}]+?)\s*\}\}"/g, (_m, raw) => {
    const fn = raw.trim();
    /* A bare name (`toggleSidebar`) is a global handler, so keep the name. An
       item-scoped one (`it.go`) differs per row, so evaluate it — that lets the
       data supply a destination per item instead of every row emitting the
       identical literal "it.go". */
    return fn.includes('.') ? ` data-action="<%= ${fn} %>"` : ` data-action="${fn}"`;
  });

  out = out.replace(/\shint-placeholder-(?:count|val)="[^"]*"/g, '');

  out = out.replace(/<sc-for\s+list="\{\{\s*([^}]+?)\s*\}\}"\s+as="([\w$]+)"[^>]*>/g,
    (_m, list, as) => `<% (${list.trim()} || []).forEach(function (${as}) { %>`);
  out = out.replace(/<\/sc-for>/g, '<% }); %>');

  out = out.replace(/<sc-if\s+value="\{\{\s*([^}]+?)\s*\}\}"[^>]*>/g,
    (_m, cond) => `<% if (${cond.trim()}) { %>`);
  out = out.replace(/<\/sc-if>/g, '<% } %>');

  /* Everything left is an interpolation, in text or in an attribute value. */
  out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => `<%= ${expr.trim()} %>`);

  return out;
}

/* ── 4. Derive each screen's data shape from its markup ───────────────────
   Every `{{ … }}` reference tells us a key the data module must supply, and
   loop bodies tell us the fields of each item. Nothing is invented: this
   reports the shape the design demands, with values left empty. */

const JS_LITERAL = /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?)$/;

function deriveShape(rawBody) {
  const loops = [];   // { list, as, fields:Set }
  const scalars = new Set();
  const objects = new Map(); // root -> Set(field) for dotted refs outside any loop
  const actions = new Set();
  const loopStack = [];

  /* Placeholder hints and click handlers are not data the view reads — strip
     the hints outright, and record handlers separately so they don't show up
     as fields the data module is expected to supply. */
  const body = rawBody
    .replace(/\shint-placeholder-(?:count|val)="[^"]*"/g, '')
    .replace(/\sonClick="\{\{\s*([^}]+?)\s*\}\}"/g, (_m, fn) => {
      actions.add(fn.trim());
      return '';
    });

  /* Conditions gating an sc-if are booleans, not display strings. The design
     carries its own default for each in `hint-placeholder-val` — which sub-tab
     is open, which drawer is closed — so take the value from there rather than
     defaulting everything to false and rendering a blank screen. */
  const flags = new Map();
  for (const m of rawBody.matchAll(
    /<sc-if\s+value="\{\{\s*([\w$]+)\s*\}\}"(?:\s+hint-placeholder-val="\{\{\s*(true|false)\s*\}\}")?/g
  )) {
    if (JS_LITERAL.test(m[1])) continue;
    /* If a flag appears more than once, any `true` hint wins. */
    if (!flags.has(m[1]) || m[2] === 'true') flags.set(m[1], m[2] === 'true');
  }

  const token = /<sc-for\s+list="\{\{\s*([^}]+?)\s*\}\}"\s+as="([\w$]+)"[^>]*>|<\/sc-for>|\{\{\s*([^}]+?)\s*\}\}/g;
  let t;
  while ((t = token.exec(body))) {
    if (t[1]) {
      const list = t[1].trim();
      const loop = { list, as: t[2], fields: new Set() };
      loops.push(loop);
      loopStack.push(loop);
      /* `<sc-for list="{{ selLead.timeline }}">` means selLead has a timeline
         array — register it, since it never appears as an interpolation. */
      if (list.includes('.')) {
        const [root, ...rest] = list.split('.');
        const owned = loopStack.some((l) => l !== loop && l.as === root);
        if (!owned) {
          if (!objects.has(root)) objects.set(root, new Set());
          objects.get(root).add(rest.join('.'));
        }
      }
    } else if (t[0] === '</sc-for>') {
      loopStack.pop();
    } else if (t[3]) {
      const expr = t[3].trim();
      const owner = loopStack.find((l) => expr === l.as || expr.startsWith(l.as + '.'));
      if (owner) {
        if (expr.includes('.')) owner.fields.add(expr.slice(owner.as.length + 1));
      } else if (/^[\w$]+$/.test(expr) && !JS_LITERAL.test(expr)) {
        scalars.add(expr);
      } else if (/^[\w$]+\.[\w$.]+$/.test(expr)) {
        /* A dotted reference owned by no loop — the screen reads a selected
           record (selCr, selLead, …) that the data module must supply. */
        const [root, ...rest] = expr.split('.');
        if (!objects.has(root)) objects.set(root, new Set());
        objects.get(root).add(rest.join('.'));
      }
    }
  }
  return {
    loops,
    flags,
    scalars: [...scalars].sort(),
    objects: [...objects.entries()].map(([root, fields]) => ({ root, fields: [...fields].sort() })),
    actions: [...actions].sort(),
  };
}

function stubModule(name, shape, complete) {
  const lines = [
    `/* Data for the "${name}" screen.`,
    ` *`,
    ` * Shape derived from the design markup — these are the exact keys and fields`,
    ` * the view reads. Values are intentionally empty: the design file's data`,
    ` * block exceeded the MCP read cap and has not been transcribed yet.`,
  ];
  if (!complete) {
    lines.push(` *`, ` * NOTE: this screen's markup was cut off by the read cap and is incomplete.`);
  }
  lines.push(` */`, '', 'module.exports = {');

  for (const s of shape.scalars) {
    lines.push(`  ${s}: ${shape.flags.has(s) ? String(shape.flags.get(s)) : "''"},`);
  }

  /* A field that a loop iterates is an array, not a string. */
  const iterated = new Map(shape.loops.map((l) => [l.list, [...l.fields].sort()]));

  for (const obj of shape.objects) {
    lines.push(`  ${obj.root}: {`);
    for (const f of obj.fields) {
      const itemFields = iterated.get(`${obj.root}.${f}`);
      if (itemFields) {
        lines.push(`    /* each item: { ${itemFields.join(', ') || '—'} } */`);
        lines.push(`    ${f}: [],`);
      } else {
        lines.push(`    ${f}: '',`);
      }
    }
    lines.push('  },');
  }

  /* A loop over `grp.items` describes the shape of the parent loop's item,
     so fold it into that item's field list rather than dropping it. */
  const nestedByParent = new Map();
  for (const loop of shape.loops) {
    if (!loop.list.includes('.')) continue;
    const [root, ...rest] = loop.list.split('.');
    const parent = shape.loops.find((l) => l.as === root);
    if (!parent) continue;
    if (!nestedByParent.has(parent)) nestedByParent.set(parent, []);
    nestedByParent.get(parent).push({ field: rest.join('.'), fields: [...loop.fields].sort() });
  }

  const seen = new Set();
  for (const loop of shape.loops) {
    if (!/^[\w$]+$/.test(loop.list) || seen.has(loop.list)) continue;
    seen.add(loop.list);
    const fields = [...loop.fields].sort();
    lines.push(`  /* each item: { ${fields.join(', ') || '—'} } */`);
    for (const nested of nestedByParent.get(loop) || []) {
      lines.push(`  /*   .${nested.field}[] each: { ${nested.fields.join(', ') || '—'} } */`);
    }
    lines.push(`  ${loop.list}: [],`);
  }

  lines.push('};', '');

  if (shape.actions.length) {
    lines.push(
      '/* Click targets the design declares on this screen. They render as',
      ' * data-action attributes; wire them up when behaviour is specified.',
      ' *',
      ...shape.actions.map((a) => ` *   ${a}`),
      ' */',
      ''
    );
  }
  return lines.join('\n');
}

/* ── 5. Sub-views ─────────────────────────────────────────────────────────
   Several screens hold multiple views behind sibling sc-if flags — the AI
   screen's eight tabs, Reports' five, the campaign and lead drill-downs. Find
   them so the app can route to each one instead of only ever showing the
   default. Both the flag and its label come from the design: the label is the
   section comment the designer wrote above each block. */

/* A tab group is a run of sc-if blocks that are siblings — same parent, same
   nesting level — of which exactly one carries `hint-placeholder-val={{true}}`.
   That is the design saying "these are alternatives and this one is open".
   Detecting it structurally finds the groups nested inside a screen (the
   dashboard's tabs, the campaign table's tabs) that a depth-0 scan misses. */

function findSubviewGroups(body) {
  const nodes = [];
  const stack = [];
  const token = /<sc-if\b[^>]*>|<\/sc-if>|<sc-for\b[^>]*>|<\/sc-for>/g;
  let t;

  while ((t = token.exec(body))) {
    const isIf = t[0].startsWith('<sc-if');
    const isFor = t[0].startsWith('<sc-for');

    if (t[0] === '</sc-if>' || t[0] === '</sc-for>') {
      stack.pop();
      continue;
    }
    if (isIf) {
      const flag = /value="\{\{\s*([\w$]+)\s*\}\}"/.exec(t[0]);
      if (flag) {
        nodes.push({
          flag: flag[1],
          parent: stack.length ? stack[stack.length - 1] : 'root',
          at: t.index,
          isDefault: /hint-placeholder-val="\{\{\s*true\s*\}\}"/.test(t[0]),
        });
      }
    }
    if (isIf || isFor) stack.push(`${t[0]}@${t.index}`);
  }

  const byParent = new Map();
  for (const n of nodes) {
    if (!byParent.has(n.parent)) byParent.set(n.parent, []);
    byParent.get(n.parent).push(n);
  }

  const groups = [];
  for (const siblings of byParent.values()) {
    if (siblings.length < 2) continue;

    /* Siblings can mix alternatives with modifiers — the campaign screen puts a
       breadcrumb flag next to its list/detail pair. Alternatives in this design
       are consistently named off a shared stem (campTab*, webTab*, pipeIs*), so
       keep the members sharing the most common initial and drop the odd one out. */
    const tally = new Map();
    for (const s of siblings) tally.set(s.flag[0], (tally.get(s.flag[0]) || 0) + 1);
    const stem = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const members = siblings.filter((s) => s.flag[0] === stem);
    if (members.length < 2) continue;

    const defaults = members.filter((m) => m.isDefault);
    if (defaults.length > 1) continue;

    groups.push(members.map((m, i) => ({
      flag: m.flag,
      at: m.at,
      label: labelFor(m, body),
      /* Some groups ship with every tab closed; open the first so the screen
         is not blank. */
      default: defaults.length ? m.isDefault : i === 0,
    })));
  }
  return groups;
}

/* Prefer the designer's own words — the section comment above the block. Fall
   back to the flag name split into words, which is a guess about wording only,
   never about which views exist. */
function labelFor(node, body) {
  const before = body.slice(Math.max(0, node.at - 300), node.at);
  const comment = [...before.matchAll(/<!--\s*([^>]+?)\s*-->/g)].pop();
  if (comment) return sentenceCase(comment[1]);
  return sentenceCase(
    node.flag
      .replace(/^(is|d|ai|rep|camp|web|sales|pipe)(?=[A-Z])/, '')
      .replace(/^(Tab|Is)/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
  );
}

function sentenceCase(s) {
  const cleaned = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/* The strip that switches a group: the nearest loop before it whose items carry
   exactly the fields a tab needs. */
function findTabList(shape, group, body) {
  const groupStart = Math.min(...group.map((g) => g.at));
  let best = null;
  for (const loop of shape.loops) {
    if (!/^[\w$]+$/.test(loop.list)) continue;
    if ([...loop.fields].sort().join(',') !== 'border,color,label') continue;
    const at = body.indexOf(`{{ ${loop.list} }}`);
    if (at === -1 || at > groupStart) continue;
    if (!best || at > best.at) best = { list: loop.list, at };
  }
  return best ? best.list : null;
}

/* ── 6. Run ───────────────────────────────────────────────────────────────── */

const viewsDir = path.join(ROOT, 'views', 'screens');
const dataDir = path.join(ROOT, 'data', 'generated');
fs.mkdirSync(viewsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const report = [];
const subviews = {};

for (const [gate, name] of Object.entries(SCREEN_GATES)) {
  const block = findScreenBlock(gate);
  if (!block) {
    report.push({ screen: name, status: 'gate not found' });
    continue;
  }

  const shape = deriveShape(block.body);

  let view = toEjs(block.body).trim();
  if (!block.complete) {
    /* The source was cut mid-screen, so some blocks never closed. Balance the
       EJS (an unclosed forEach/if is a syntax error, not a layout glitch) and
       say plainly that the screen is partial. */
    const unclosed = (open, close) =>
      (block.body.match(open) || []).length - (block.body.match(close) || []).length;
    const openIfs = unclosed(/<sc-if\b[^>]*>/g, /<\/sc-if>/g);
    const openFors = unclosed(/<sc-for\b[^>]*>/g, /<\/sc-for>/g);

    view +=
      '\n' +
      '<% }); %>'.repeat(Math.max(0, openFors)) +
      '<% } %>'.repeat(Math.max(0, openIfs)) +
      '\n<div style="margin:18px 0; padding:12px 14px; border:1px solid var(--color-neutral-800);' +
      ' border-radius:9px; font-size:11.5px; color:var(--color-neutral-500); line-height:1.6;">' +
      '<i class="ph ph-scissors" style="font-size:13px;"></i> ' +
      'This screen is incomplete: the design file exceeded the 256 KiB read cap and was cut off here.' +
      '</div>';
  }
  fs.writeFileSync(path.join(viewsDir, `${name}.ejs`), bindLiterals(view, name) + '\n');
  fs.writeFileSync(path.join(dataDir, `${name}.js`), stubModule(name, shape, block.complete));

  const groups = findSubviewGroups(block.body);
  if (groups.length) {
    subviews[name] = groups.map((g) => ({
      tabList: findTabList(shape, g, block.body),
      views: g.map(({ flag, label, default: d }) => ({ flag, label, default: d })),
    }));
  }

  report.push({
    screen: name,
    status: block.complete ? 'complete' : 'TRUNCATED',
    lines: block.body.split('\n').length,
    lists: shape.loops.length,
    scalars: shape.scalars.length,
    subviews: groups.length ? groups.map((g) => g.length).join('+') : '',
  });
}

fs.writeFileSync(path.join(dataDir, '_subviews.json'), JSON.stringify(subviews, null, 2) + '\n');

/* ── Shared chrome ────────────────────────────────────────────────────────── */

const partialsDir = path.join(ROOT, 'views', 'partials');
fs.mkdirSync(partialsDir, { recursive: true });

const shellShape = { loops: [], flags: new Map(), scalars: new Set(), objects: new Map(), actions: new Set() };

for (const region of CHROME) {
  const start = src.indexOf(region.from);
  if (start === -1) {
    report.push({ screen: `chrome/${region.name}`, status: 'start marker not found' });
    continue;
  }
  const endAt = src.indexOf(region.to, start + region.from.length);
  if (endAt === -1) {
    report.push({ screen: `chrome/${region.name}`, status: 'end marker not found' });
    continue;
  }
  const body = src.slice(start, region.to.startsWith('<!--') ? endAt : endAt + region.to.length);

  const shape = deriveShape(body);
  shape.loops.forEach((l) => shellShape.loops.push(l));
  shape.scalars.forEach((s) => shellShape.scalars.add(s));
  shape.actions.forEach((a) => shellShape.actions.add(a));
  shape.objects.forEach((o) => {
    if (!shellShape.objects.has(o.root)) shellShape.objects.set(o.root, new Set());
    o.fields.forEach((f) => shellShape.objects.get(o.root).add(f));
  });
  for (const [k, v] of shape.flags) {
    if (!shellShape.flags.has(k) || v) shellShape.flags.set(k, v);
  }

  fs.writeFileSync(path.join(partialsDir, `${region.name}.ejs`), toEjs(body).trim() + '\n');
  report.push({ screen: `chrome/${region.name}`, status: 'complete', lines: body.split('\n').length, lists: shape.loops.length, scalars: shape.scalars.length });
}

fs.writeFileSync(
  path.join(dataDir, '_shell.js'),
  stubModule('shell (sidebar, top bar, filter bar)', {
    loops: shellShape.loops,
    flags: shellShape.flags,
    scalars: [...shellShape.scalars].sort(),
    objects: [...shellShape.objects.entries()].map(([root, fields]) => ({ root, fields: [...fields].sort() })),
    actions: [...shellShape.actions].sort(),
  }, true)
);

/* Hover classes, collected across every screen converted above. */
const css = [
  '/* Generated by tools/dc-to-ejs.js — do not edit.',
  '   Each class replaces a `style-hover` attribute from the design file. */',
  '',
  ...[...hoverClasses.entries()].map(([decls, cls]) => `.${cls}:hover { ${decls} }`),
  '',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'public', 'assets', 'hover.css'), css);

console.table(report);
console.log(`\nhover classes: ${hoverClasses.size} -> public/assets/hover.css`);
console.log(`views -> views/screens/*.ejs`);
console.log(`data shapes -> data/generated/*.js`);
