/* Immutable storage of everything a connector has ever returned.
 *
 * Stage 1 requires raw payloads to be "stored immutably for replay". Append-
 * only JSONL under `var/raw/<source>/<kind>.jsonl`, one envelope per line:
 *
 *   { source, kind, externalId, checksum, fetchedAt, window, body }
 *
 * Two properties matter and both are load-bearing.
 *
 * **Idempotent.** The key is (source, kind, externalId, checksum). Re-pulling
 * an overlapping window re-appends nothing, because a payload that has not
 * changed hashes the same. A payload that *has* changed appends a new line
 * beside the old one rather than replacing it — the store never forgets, so a
 * restatement can be traced to the delivery that caused it.
 *
 * **Replayable.** `replay` hands back the payloads alone. `fetchedAt` is
 * recorded but nothing downstream may read it: it is the one field that
 * differs between an original run and a replay, so any use of it would make
 * identical output impossible. That is the whole reason it is quarantined here
 * rather than being passed on with the body.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fromDemo, retiresDemo } = require('./demo-origin');

const ROOT = path.join(__dirname, '..', '..', 'var', 'raw');

/* Keys are sorted before hashing so that two payloads differing only in key
   order hash the same — otherwise a source that serialises inconsistently
   would look like it had changed on every pull. */
function checksum(body) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(body))).digest('hex').slice(0, 16);
}

class RawStore {
  constructor(root = ROOT) {
    this.root = root;
  }

  _file(source, kind) {
    return path.join(this.root, source, `${kind}.jsonl`);
  }

  _read(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /* Returns what was actually written, which is not always what was offered —
     the caller needs the difference to report how much a sync brought in. */
  append(sourceId, records, { window = null, fetchedAt, transport = null } = {}) {
    const byKind = new Map();
    for (const record of records) {
      if (!byKind.has(record.kind)) byKind.set(record.kind, []);
      byKind.get(record.kind).push(record);
    }

    const written = [];
    for (const [kind, kindRecords] of byKind) {
      const file = this._file(sourceId, kind);
      fs.mkdirSync(path.dirname(file), { recursive: true });

      const seen = new Set(this._read(file).map((e) => `${e.externalId}:${e.checksum}`));
      const lines = [];

      for (const record of kindRecords) {
        const sum = checksum(record.body);
        const key = `${record.externalId}:${sum}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const envelope = {
          source: sourceId,
          kind,
          externalId: record.externalId,
          checksum: sum,
          fetchedAt: fetchedAt || new Date().toISOString(),
          window,
          /* Which transport produced this. Unlike `fetchedAt` this *is* readable
             downstream, and has to be: a payload read out of a fixture and a
             payload read off Meta are the same shape, and replay has no other
             way to tell an invented campaign from one that ran. Null on every
             envelope written before this field existed — see demo-origin.js for
             how those are classified. */
          transport,
          body: record.body,
        };
        lines.push(JSON.stringify(envelope));
        written.push(envelope);
      }

      if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n');
    }

    return written;
  }

  kinds(sourceId) {
    const dir = path.join(this.root, sourceId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
  }

  sources() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter((d) => fs.statSync(path.join(this.root, d)).isDirectory());
  }

  /* Every envelope for a source, or for one kind of it, in the order it
     arrived. */
  envelopes(sourceId, kind = null) {
    const kinds = kind ? [kind] : this.kinds(sourceId);
    return kinds.flatMap((k) => this._read(this._file(sourceId, k)));
  }

  /* The current state of the store: the latest version of each external id,
     which is what everything downstream actually wants. Supersessions stay on
     disk; they are simply not the current truth.

     Demo payloads are current truth only until real ones arrive. Once a
     (source, kind) holds a single record from a live transport, the fixture
     records for that same kind stop being replayed: a source that is really
     reporting has nothing to add by also reporting invented rows, and the two
     sitting in one table is worse than either alone — a reader cannot tell
     which campaigns ran. They are not deleted. The store still never forgets;
     `envelopes()` returns them, and a source that has never pulled for real
     replays its fixtures exactly as before, which is what demo mode is.

     `connected` names the sources somebody has stored a credential for, and it
     retires their demo rows whether or not a pull has yet succeeded. Waiting
     for real rows was not enough: Google Ads was connected and refused on every
     attempt, so it had none, and two invented campaigns stayed at the bottom of
     Campaign Analytics beside three real ones — under a banner explaining that
     Google was down. A connected source with no data has no data, and an empty
     table says so; invented rows say something false. */
  replay(sourceId = null, kind = null, { connected = null } = {}) {
    const ids = sourceId ? [sourceId] : this.sources();
    const latest = new Map();
    for (const id of ids) {
      const isConnected = Boolean(connected && connected.has(id));
      for (const k of (kind ? [kind] : this.kinds(id))) {
        const envelopes = this._read(this._file(id, k));
        const hasReal = isConnected || envelopes.some(retiresDemo);

        for (const e of envelopes) {
          if (hasReal && fromDemo(e)) continue;
          latest.set(`${e.source}:${e.kind}:${e.externalId}`, e);
        }
      }
    }
    /* fetchedAt is deliberately dropped — nothing downstream may depend on
       when a payload arrived, or replay could not reproduce its output. */
    return [...latest.values()].map(({ source, kind: k, externalId, checksum: c, body }) => ({
      source, kind: k, externalId, checksum: c, body,
    }));
  }

  clear(sourceId = null) {
    const target = sourceId ? path.join(this.root, sourceId) : this.root;
    fs.rmSync(target, { recursive: true, force: true });
  }
}

module.exports = { RawStore, checksum, ROOT };
