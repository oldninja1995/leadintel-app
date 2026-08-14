/* Which cards a person keeps on a screen.
 *
 * "Edit layout" has been on the dashboard since the design was drawn and did
 * nothing: clicking it flipped `?edit=1`, the server set an `editing` flag, and
 * the only thing that flag reached was a drag-handle icon with no drag behind
 * it. A control that changes the URL and nothing else is worse than one that is
 * visibly absent — it invites the reader to conclude the app is broken, which
 * is exactly what happened.
 *
 * What it does now is the smallest honest version of the promise: **choose
 * which cards are on the screen.** Not drag-to-reorder — the grid is a CSS
 * grid the design specifies, and re-ordering it would mean persisting positions
 * for a layout that is responsive and reflows anyway. Hiding is the part people
 * actually want (a dashboard with nine tiles they read and five they do not)
 * and it is the part that can be stored as a fact rather than a guess.
 *
 * **Stored per person, not per workspace.** Two people looking at the same
 * business want different dashboards, and one of them tidying theirs must not
 * rearrange the other's. That also makes it safe: nothing here can change a
 * number, only whether somebody sees it.
 *
 * Hidden is stored, not visible. A card added to a screen later then appears
 * for everybody by default, which is the right way round — the alternative
 * silently withholds new cards from every existing user.
 */

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'var', 'layouts.json');

/* One document for every user's every screen, because they are read together:
   the request edge hydrates once and the render asks for one screen. */
const DOC_KEY = 'layouts';

const keyFor = (workspace, user, screen) => `${workspace}:${user}:${screen}`;

class Layouts {
  constructor(file = STORE, { backend = null, docKey = DOC_KEY } = {}) {
    this.file = file;
    this.backend = backend;
    this.docKey = docKey;
    this._state = null;
    this._pending = null;
  }

  async hydrate(value = undefined) {
    if (!this.backend) return this;
    const stored = value === undefined ? await this.backend.get(this.docKey) : value;
    this._state = stored && typeof stored === 'object' ? stored : {};
    return this;
  }

  /* Undefined when nothing is pending — see lib/attribution.js for why that
     matters to the middleware that settles these writes. */
  flush() {
    return this._pending;
  }

  state() {
    if (this._state) return this._state;
    if (this.backend) {
      this._state = {};
      return this._state;
    }
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      /* No file yet is the ordinary case; a corrupt one must not stop a screen
         from rendering, and an empty layout is the same as no preference. */
      this._state = {};
    }
    return this._state;
  }

  /* The card ids this person has hidden on this screen. */
  hidden(workspace, user, screen) {
    if (!workspace || !user || !screen) return [];
    const stored = this.state()[keyFor(workspace, user, screen)];
    return Array.isArray(stored) ? stored : [];
  }

  /* `visible` is what the form submitted; everything offered and not ticked is
     hidden. Taking the complement here rather than in the route is deliberate —
     an unchecked box submits nothing, so "what was offered" is the only way to
     tell "unticked" from "not on the form at all". */
  set(workspace, user, screen, { offered = [], visible = [] } = {}) {
    const keep = new Set(visible.map(String));
    const hide = offered.map(String).filter((id) => !keep.has(id));

    const state = { ...this.state() };
    const key = keyFor(workspace, user, screen);
    if (hide.length) state[key] = hide;
    else delete state[key];

    this._state = state;
    this._write();
    return hide;
  }

  _write() {
    if (this.backend) {
      /* `put`, not `set` — the docs backend's writer is named for the document
         it replaces rather than for the field it sets. Calling the wrong one
         throws inside an async route, and Express 4 answers a rejected route
         handler by never answering at all: the save hung for sixty seconds
         rather than failing. */
      this._pending = this.backend.put(this.docKey, this._state);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2));
  }
}

module.exports = { Layouts, keyFor, STORE, DOC_KEY };
