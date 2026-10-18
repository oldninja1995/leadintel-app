/* Annotations — dated notes the team leaves on campaigns ("raised budget",
 * "new creative live", "festival week"), shown on Campaign Analytics.
 *
 * Shared across the workspace, unlike Layouts, which are per person: a note
 * explains a figure for whoever reads it next. Stored the way Layouts are — one
 * document in the docs backend, hydrated at the request edge, a file locally —
 * and written with `put`, whose promise the route awaits before answering.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE = path.join(__dirname, '..', 'var', 'annotations.json');
const DOC_KEY = 'annotations';
const MAX_TEXT = 500;
const MAX_PER_WORKSPACE = 2000;

class Annotations {
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
      this._state = {};
    }
    return this._state;
  }

  /* Newest first. `campaign` narrows to one campaign's notes. */
  list(workspace, { campaign = null } = {}) {
    const all = Array.isArray(this.state()[workspace]) ? this.state()[workspace] : [];
    return all
      .filter((n) => !campaign || n.campaign === campaign)
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at).localeCompare(String(a.at)));
  }

  add(workspace, { campaign, date, text, by }, { now = new Date() } = {}) {
    const clean = String(text || '').trim().slice(0, MAX_TEXT);
    if (!workspace) throw new Error('an annotation needs a workspace');
    if (!clean) throw new Error('an annotation needs some text');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : now.toISOString().slice(0, 10);
    const note = {
      id: crypto.randomBytes(6).toString('hex'),
      campaign: campaign ? String(campaign).slice(0, 200) : null,
      date: day,
      text: clean,
      by: by || null,
      at: now.toISOString(),
    };
    const state = { ...this.state() };
    state[workspace] = [note, ...(Array.isArray(state[workspace]) ? state[workspace] : [])].slice(0, MAX_PER_WORKSPACE);
    this._state = state;
    this._write();
    return note;
  }

  /* The author may delete their own note; anyone allowed `allowAny` (the
     owner) may delete any. Returns whether a note was removed. */
  remove(workspace, id, { by = null, allowAny = false } = {}) {
    const list = Array.isArray(this.state()[workspace]) ? this.state()[workspace] : [];
    const target = list.find((n) => n.id === id);
    if (!target) return false;
    if (!allowAny && target.by !== by) throw new Error('only the person who wrote a note, or the owner, can delete it');
    this._state = { ...this.state(), [workspace]: list.filter((n) => n.id !== id) };
    this._write();
    return true;
  }

  _write() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n');
  }
}

module.exports = { Annotations, DOC_KEY };
