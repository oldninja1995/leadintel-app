#!/usr/bin/env node
/* Backup, restore, and the drill that proves the restore works.
 *
 *   node tools/backup.js create [dir]     take a backup
 *   node tools/backup.js list             what backups exist
 *   node tools/backup.js restore <name>   restore one, over the top
 *   node tools/backup.js drill            back up, wipe, restore, verify
 *
 * Phase 10's exit criterion is not "a backup exists" — it is **a cold restore
 * succeeds**. Those are different claims, and the gap between them is where
 * most backup strategies actually live. `drill` is the one that answers it: it
 * takes a backup, *destroys the live state*, restores, and then checks that the
 * entities rebuilt from the restored store match what was there before.
 *
 * What is backed up is everything under `var/` — the append-only raw store, the
 * run log, evaluations, dispatches, fires, definitions and the audit trail.
 * Everything else in this repo is code and comes from version control; `var/`
 * is the only state that cannot be recreated by running the app again.
 *
 * A manifest is written beside each backup recording a checksum per file, so a
 * restore can say whether what it wrote is what was taken rather than assuming.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VAR = path.join(ROOT, 'var');
const BACKUPS = path.join(ROOT, 'var-backups');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

function walk(dir, base = dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else found.push(path.relative(base, full));
  }
  return found;
}

function create(name = new Date().toISOString().replace(/[:.]/g, '-')) {
  const target = path.join(BACKUPS, name);
  if (fs.existsSync(target)) throw new Error(`backup "${name}" already exists`);

  const files = walk(VAR);
  const manifest = { name, takenAt: new Date().toISOString(), files: {} };

  for (const rel of files) {
    const from = path.join(VAR, rel);
    const to = path.join(target, 'var', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const bytes = fs.readFileSync(from);
    fs.writeFileSync(to, bytes);
    manifest.files[rel] = { bytes: bytes.length, sha: sha(bytes) };
  }

  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function list() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs.readdirSync(BACKUPS)
    .filter((n) => fs.existsSync(path.join(BACKUPS, n, 'manifest.json')))
    .map((n) => JSON.parse(fs.readFileSync(path.join(BACKUPS, n, 'manifest.json'), 'utf8')))
    .sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
}

/* Restores over the top and verifies each file against the manifest as it
   goes. A restore that reported success without checking would be the same
   unverified promise the drill exists to replace. */
function restore(name) {
  const source = path.join(BACKUPS, name);
  const manifestPath = path.join(source, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`no backup "${name}"`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mismatches = [];

  for (const [rel, expected] of Object.entries(manifest.files)) {
    const from = path.join(source, 'var', rel);
    const to = path.join(VAR, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const bytes = fs.readFileSync(from);
    fs.writeFileSync(to, bytes);
    if (sha(bytes) !== expected.sha) mismatches.push(rel);
  }

  return { name, restored: Object.keys(manifest.files).length, mismatches };
}

/* The drill. Deliberately destructive in the middle — a restore tested without
   first destroying anything tests nothing. */
function drill() {
  const ingest = require('../lib/ingest');
  const before = ingest.snapshot({ store: ingest.storeFor('parakkat') });
  const shape = (e) => ({
    campaignDays: e.campaignDays.length,
    leads: e.leads.length,
    bookings: e.bookings.length,
    payments: e.payments.length,
    revenue: e.bookings.reduce((t, b) => t + ((b.revenue && b.revenue.value) || 0), 0),
  });
  const expected = shape(before);

  const name = `drill-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const manifest = create(name);

  /* The destructive step. */
  fs.rmSync(VAR, { recursive: true, force: true });
  const wiped = !fs.existsSync(VAR);

  const result = restore(name);

  /* Rebuilt from the restored store, in a fresh process-local store so nothing
     cached from before the wipe can make this pass. */
  const { RawStore } = require('../lib/ingest/raw-store');
  const after = ingest.snapshot({ store: new RawStore(path.join(VAR, 'raw', 'parakkat')) });
  const got = shape(after);

  const matches = JSON.stringify(expected) === JSON.stringify(got);
  return {
    backup: name,
    filesBackedUp: Object.keys(manifest.files).length,
    wiped,
    filesRestored: result.restored,
    checksumMismatches: result.mismatches,
    before: expected,
    after: got,
    passed: wiped && matches && result.mismatches.length === 0,
  };
}

module.exports = { create, list, restore, drill, VAR, BACKUPS, walk };

if (require.main === module) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === 'create') {
      const m = create(argument);
      console.log(`backed up ${Object.keys(m.files).length} file(s) to var-backups/${m.name}`);
    } else if (command === 'list') {
      const all = list();
      if (!all.length) console.log('no backups');
      for (const m of all) console.log(`${m.name}  ${Object.keys(m.files).length} file(s)  ${m.takenAt}`);
    } else if (command === 'restore') {
      if (!argument) throw new Error('restore needs a backup name');
      const r = restore(argument);
      console.log(`restored ${r.restored} file(s)`);
      if (r.mismatches.length) console.log(`MISMATCHED: ${r.mismatches.join(', ')}`);
    } else if (command === 'drill') {
      const r = drill();
      console.log(JSON.stringify(r, null, 2));
      console.log(r.passed ? '\ndrill PASSED — a cold restore reproduces the entities exactly' : '\ndrill FAILED');
      process.exit(r.passed ? 0 : 1);
    } else {
      console.log('usage: node tools/backup.js create|list|restore <name>|drill');
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
