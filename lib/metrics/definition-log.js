/* Per-metric definition versions, and the history of how they changed.
 *
 * Sub-phase 6.3. Phase 6's exit criterion asks that *changing a definition
 * creates a new version and leaves existing reports rendering on theirs*. The
 * second half arrived with 5.3 — a dispatch freezes the definitions it was sent
 * under. This is the first half, and the design's governance panel says what it
 * should look like: `Version: v3 · edited 2 days ago`.
 *
 * Definitions live in code, so a change happens when somebody edits
 * `registry.js`. The log therefore works by **reconciliation** rather than by
 * being told: on demand it compares the definitions in force against the last
 * recorded ones and mints a new version for each metric that moved, recording
 * which fields moved.
 *
 * **On authorship.** The app cannot see who edited a source file, and inventing
 * an author would be worse than having none — a governance record naming the
 * wrong person is actively misleading. So `author` is recorded when a caller
 * supplies one and is `null` otherwise, and `null` renders as "unattributed"
 * rather than as anybody. Wiring it to a real identity is Phase 9's job, since
 * that is where users start existing.
 *
 * A version is per metric, not global: editing the ROAS formula should not
 * advance the version of every other metric in the registry.
 */

const fs = require('fs');
const path = require('path');

const registry = require('./registry');
const { definitions, definitionOf, checksum } = require('./versions');

const FILE = path.join(__dirname, '..', '..', 'var', 'definitions.json');

/* Which fields of a definition differ. Reporting the fields rather than just
   "changed" is what makes the history worth keeping: a moved threshold and a
   rewritten formula are not the same event. */
function changedFields(before, after) {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const moved = [];
  for (const field of fields) {
    if (field === 'id') continue;
    if (checksum(before ? before[field] : null) !== checksum(after ? after[field] : null)) moved.push(field);
  }
  return moved.sort();
}

class DefinitionLog {
  /* See lib/connections.js for why `state()` stays synchronous and hydration
     happens at the request edge instead. */
  constructor(file = FILE, { backend = null, docKey = 'definitions' } = {}) {
    this.file = file;
    this.backend = backend;
    this.docKey = docKey;
    this._pending = null;
    this._state = null;
  }

  state() {
    if (this._state) return this._state;
    if (this.backend) {
      this._state = { metrics: {}, history: [] };
      return this._state;
    }
    try {
      this._state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this._state = { metrics: {}, history: [] };
    }
    return this._state;
  }

  async hydrate(value = undefined) {
    if (!this.backend) return this;
    this._state = (value === undefined ? await this.backend.get(this.docKey) : value) || { metrics: {}, history: [] };
    return this;
  }

  flush() {
    return this._pending || Promise.resolve();
  }

  _save() {
    if (this.backend) {
      this._pending = this.backend.put(this.docKey, this._state);
      return this._pending;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this._state, null, 2) + '\n');
    return undefined;
  }

  /* Compare what is in force against what was last recorded, and mint versions
     for anything that moved. Returns the changes, so a caller can report them
     rather than having to diff the log itself.

     Idempotent: reconciling twice in a row mints nothing the second time. */
  reconcile({ at = new Date().toISOString(), author = null, note = null } = {}) {
    const state = this.state();
    const current = definitions();
    const changes = [];

    for (const definition of current) {
      const known = state.metrics[definition.id];
      const fingerprint = checksum(definition);

      if (!known) {
        /* First sighting. v1 is where a metric starts, not a change — the
           history entry says `added` so nobody reads it as an edit. */
        state.metrics[definition.id] = { version: 1, since: at, fingerprint, author };
        changes.push({ metric: definition.id, change: 'added', version: 1, at, author, fields: [] });
        continue;
      }

      if (known.fingerprint === fingerprint) continue;

      const fields = changedFields(known.definition || null, definition);
      const version = known.version + 1;
      state.metrics[definition.id] = { version, since: at, fingerprint, author };
      changes.push({ metric: definition.id, change: 'redefined', version, from: known.version, at, author, fields, note });
    }

    /* A metric that has left the registry keeps its history — a report sent
       under it still needs explaining. */
    for (const id of Object.keys(state.metrics)) {
      if (registry.get(id)) continue;
      if (state.metrics[id].retired) continue;
      state.metrics[id].retired = at;
      changes.push({ metric: id, change: 'retired', version: state.metrics[id].version, at, author });
    }

    /* The definition itself is stored beside the fingerprint so the next
       reconcile can say *which fields* moved rather than only that something
       did. */
    for (const definition of current) {
      state.metrics[definition.id].definition = definition;
    }

    if (changes.length) {
      state.history = [...changes, ...state.history].slice(0, 500);
      this._save();
    }
    return changes;
  }

  versionOf(id) {
    const known = this.state().metrics[id];
    return known ? known.version : null;
  }

  /* Newest first, for one metric or all of them. */
  historyOf(id = null) {
    const history = this.state().history;
    return id ? history.filter((h) => h.metric === id) : history;
  }

  /* The governance line the design shows: `v3 · edited <when>`. */
  governance(id) {
    const known = this.state().metrics[id];
    if (!known) return null;
    return {
      metric: id,
      version: `v${known.version}`,
      since: known.since,
      author: known.author || 'unattributed',
      retired: known.retired || null,
      edits: this.historyOf(id).filter((h) => h.change === 'redefined').length,
    };
  }

  reload() { this._state = null; return this; }
}

module.exports = { DefinitionLog, FILE, changedFields, definitionOf };
