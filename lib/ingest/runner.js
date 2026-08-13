/* Sub-phase 4.5 — when a source syncs, and whether it still is.
 *
 * Stage 1's SLA is "realtime – 15 min", which is a promise about how stale the
 * data may be, not about how often a job runs. So the runner is built around
 * the staleness rather than the schedule: a source is due when its last
 * successful sync is older than its cadence, and everything else — the ticking
 * loop, a manual run, a replay after downtime — is the same call at a
 * different moment.
 *
 * Every attempt is recorded, successes and failures alike. A connector that
 * has been failing for six hours and a connector that has never been asked
 * look identical from the store alone, and only one of them is an incident.
 *
 * The clock is injected. A scheduler that cannot be tested without waiting is
 * a scheduler that does not get tested.
 */

const fs = require('fs');
const path = require('path');

const sources = require('./sources');
const { sync } = require('./index');
const { RawStore } = require('./raw-store');
const { createTransport } = require('./transport');

const RUN_LOG = path.join(__dirname, '..', '..', 'var', 'runs.jsonl');

/* Health is a multiple of the source's own cadence rather than a fixed number
   of minutes: fifteen minutes of silence from a 15-minute poll is normal and
   from a realtime stream is not. */
const LAGGING_AT = 3;
const DOWN_AT = 6;

class RunLog {
  /* `backend` swaps the medium. `all()` stays synchronous — every derived read
     here and every method of SyncRunner is built on it, and making it async
     would have turned a storage change into a rewrite of the scheduler. The
     entries are pulled into memory by `hydrate()` instead, which the request
     edge calls once. */
  constructor(file = RUN_LOG, { backend = null } = {}) {
    this.file = file;
    this.backend = backend;
    this._entries = null;
    this._pending = null;
  }

  all() {
    if (this.backend) return this._entries || [];
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /* Deliberately a superset of any one read: the recent window plus the last
     successful run of every source. See PgLineLog.hydrate for why the second
     half is not optional — without it a source that has been failing for hours
     reports as never-synced rather than as down. */
  async hydrate() {
    if (!this.backend) return this;
    this._entries = await this.backend.hydrate({ limit: 500 });
    return this;
  }

  /* Undefined when nothing is pending, rather than a resolved promise. A
     caller that awaits is unaffected, but a caller that branches on whether it
     got one stays synchronous on the file path — which is what keeps the
     middleware that settles these writes from deferring when there was nothing
     to settle. */
  flush() {
    return this._pending;
  }

  append(run) {
    if (this.backend) {
      /* Appended in memory as well as issued, so a runner that logs several
         runs in one tick sees its own writes without re-reading. */
      this._entries = [...(this._entries || []), run];
      this._pending = this.backend.append(run, { tag: run.source, ok: Boolean(run.ok) });
      return run;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(run) + '\n');
    return run;
  }

  lastSuccess(sourceId) {
    return this.all().filter((r) => r.source === sourceId && r.ok).pop() || null;
  }

  recent(sourceId, limit = 20) {
    return this.all().filter((r) => r.source === sourceId).slice(-limit);
  }

  clear() {
    if (this.backend) {
      this._entries = [];
      this._pending = this.backend.clear();
      return;
    }
    fs.rmSync(this.file, { force: true });
  }
}

class SyncRunner {
  /* `transportFor` resolves the transport **per source**, which is what lets
     one connected source pull for real while the other four keep reading
     fixtures. A single transport for all five was right while none of them
     could be pulled; it would now mean connecting Meta Ads either changed
     nothing or broke the other four.

     It defaults to the single transport, so every existing caller — and every
     test — behaves exactly as before. */
  constructor({
    store = new RawStore(),
    transport = createTransport(),
    transportFor = null,
    log = new RunLog(),
    clock = () => new Date(),
    window = null,
    onWrite = null,
  } = {}) {
    this.onWrite = onWrite;
    this.store = store;
    this.transport = transport;
    this.transportFor = transportFor || (() => this.transport);
    this.log = log;
    this.clock = clock;
    this.window = window;
    this.timer = null;
  }

  _now() {
    return this.clock();
  }

  /* Seconds since the last successful sync, or null if there has never been
     one — which is not the same as zero lag and must not be reported as it. */
  lag(sourceId, now = this._now()) {
    const last = this.log.lastSuccess(sourceId);
    if (!last) return null;
    return Math.max(0, Math.round((now - new Date(last.finishedAt)) / 1000));
  }

  health(sourceId, now = this._now()) {
    const source = sources.get(sourceId);
    const lag = this.lag(sourceId, now);
    if (lag === null) return 'never-synced';
    if (lag > source.cadence.every * DOWN_AT) return 'down';
    if (lag > source.cadence.every * LAGGING_AT) return 'lagging';
    return 'ok';
  }

  due(now = this._now()) {
    return sources.list().filter((s) => {
      const lag = this.lag(s.id, now);
      return lag === null || lag >= s.cadence.every;
    });
  }

  async runOne(sourceId, now = this._now()) {
    const startedAt = now.toISOString();
    try {
      const result = await sync(sourceId, {
        store: this.store,
        transport: this.transportFor(sourceId),
        /* Resolved per run, not once at boot. A fixed window in a process that
           stays up for weeks keeps asking for the same weeks — it would stop
           including today the day after it started, and nothing would say so. */
        /* The source is passed so a window can differ per source — a first pull
           needs history, a refresh does not. See syncWindow in server.js. */
        window: typeof this.window === 'function' ? this.window(now, sourceId) : this.window,
        fetchedAt: startedAt,
      });
      /* A sync that writes records nothing can read is a sync that did not
         happen. The repository snapshots the raw store once and caches it, so
         without this the screens keep serving whatever was in the store at boot
         — deployed, syncing, green, and showing yesterday. */
      if (typeof this.onWrite === 'function' && result.written) {
        try { this.onWrite(sourceId, result); } catch (err) {
          console.warn('sync: post-write hook failed —', err.message);
        }
      }

      /* A run where some kinds failed is still `ok` — the source fed, and
         marking it down would be the bug that isolation exists to prevent. But
         it is not clean either, and recording only the two states left a kind
         that fails for ever indistinguishable from one that never fails.
         Written only when non-empty so existing log lines keep their shape. */
      const partial = result.failures && result.failures.length ? result.failures : null;
      return this.log.append({
        source: sourceId, startedAt, finishedAt: this._now().toISOString(),
        ok: true, pulled: result.pulled, written: result.written, transport: result.transport,
        ...(partial ? { partialFailures: partial } : {}),
      });
    } catch (err) {
      /* A failed sync is recorded, not thrown. One source being down must not
         stop the other four, and the failure has to be visible afterwards or
         the lag metric is the only evidence it happened. */
      return this.log.append({
        source: sourceId, startedAt, finishedAt: this._now().toISOString(),
        ok: false, pulled: 0, written: 0, error: err.message,
      });
    }
  }

  async runDue(now = this._now()) {
    const runs = [];
    for (const source of this.due(now)) runs.push(await this.runOne(source.id, now));
    return runs;
  }

  /* What the "Connector down" alert of Phase 8 reads, and what a status page
     would show. */
  status(now = this._now()) {
    return sources.list().map((s) => {
      const last = this.log.lastSuccess(s.id);
      const recent = this.log.recent(s.id);
      const failures = recent.filter((r) => !r.ok);
      const latest = recent.length ? recent[recent.length - 1] : null;
      return {
        source: s.id,
        name: s.name,
        cadence: s.cadence,
        lastSuccessAt: last ? last.finishedAt : null,
        /* What that success actually carried. A sync can succeed and return
           nothing, which is the difference between a connector that works and
           a source that is feeding — the Connections screen draws that
           distinction and had no field to read it from. `pulled` is what the
           vendor returned; `written` is what was new, and is legitimately 0 on
           a poll that found nothing since the last one. */
        lastPulled: last ? (last.pulled || 0) : null,
        lastWritten: last ? (last.written || 0) : null,
        lagSeconds: this.lag(s.id, now),
        health: this.health(s.id, now),
        due: this.due(now).some((d) => d.id === s.id),
        /* Per source, because they no longer share one. This is the field that
           answers "is this figure real or a fixture", which nothing else on the
           status page can tell you. */
        transport: (() => {
          try { return this.transportFor(s.id).name; } catch (err) { return 'unavailable'; }
        })(),
        recentFailures: failures.length,
        /* The error of the *latest* run, not the latest error in the window.
         *
         * These differ exactly when a source has recovered, and reporting the
         * old one then is how a working connector goes on describing itself as
         * broken. Meta pulled 684 rows successfully and still advertised
         * "every kind failed — no credential stored for Meta Ads" from a run
         * that predated the credential being saved, because that was the most
         * recent *failure* within the last twenty runs. It read as the sync
         * being broken when the sync was fine.
         *
         * The history is not lost: `recentFailures` still counts the window and
         * `lastErrorAt` says when the last one was, so a flapping source is
         * still visible as one. */
        lastError: latest && !latest.ok ? latest.error : null,
        lastErrorAt: failures.length ? failures[failures.length - 1].finishedAt : null,
        priorError: latest && latest.ok && failures.length
          ? failures[failures.length - 1].error
          : null,
        /* Which kinds failed on the most recent attempt, whether or not that
           attempt succeeded overall. Read from the latest run rather than the
           latest *successful* one: "as of now" is the question this answers,
           and a source that has since started failing wholesale should not
           still be reporting the partial state of an older good run. */
        partialFailures: (latest && latest.partialFailures) || [],
      };
    });
  }

  /* The loop ticks faster than any cadence and lets `due` decide — otherwise a
     source polled every 15 minutes would drift by up to a tick every cycle. */
  start({ tickSeconds = 60 } = {}) {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.runDue().catch((err) => console.error('sync tick failed:', err.message));
    }, tickSeconds * 1000);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }
}

module.exports = { SyncRunner, RunLog, RUN_LOG, LAGGING_AT, DOWN_AT };
