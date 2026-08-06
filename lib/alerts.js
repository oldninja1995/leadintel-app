/* What the notification panel shows.
 *
 * The design has no markup for a notification panel, so the panel itself is
 * mine (Phase 2). Its *contents* are not invented: every alert here is computed
 * from something the app actually observes right now.
 *
 * Two sources, both real:
 *
 *   connector health   from the 4.5 sync runner's own run log — a source that
 *                      has stopped syncing is a fact about this process, not a
 *                      story about a hotel.
 *   ingest problems    normalisation failures collected rather than dropped in
 *                      4.3. A value the pipeline could not read is exactly the
 *                      kind of thing a revenue manager should be told about.
 *
 * The business alert rules the Analytics Engine page specifies — pace, ROAS
 * decay, response-time breach — are Phase 8, and deliberately absent. An empty
 * panel is the honest state when nothing is wrong; a panel padded with sample
 * notifications would make the real ones unfindable the day they matter.
 */

const SEVERITY = { critical: 0, warning: 1, info: 2 };

/* Matches the run log's own vocabulary: `health` comes straight off the runner
   rather than being re-derived here, so the panel and /ingest/status can never
   disagree about whether a connector is down. */
const CONNECTOR = {
  down: { severity: 'critical', icon: 'ph-fill ph-plugs', verb: 'has stopped syncing' },
  lagging: { severity: 'warning', icon: 'ph ph-clock-countdown', verb: 'is falling behind' },
  'never-synced': { severity: 'info', icon: 'ph ph-plug', verb: 'has never synced' },
};

function ago(seconds) {
  if (seconds == null) return 'never';
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function connectorAlerts(status = []) {
  return status
    .filter((s) => CONNECTOR[s.health])
    .map((s) => {
      const kind = CONNECTOR[s.health];
      const every = `expected every ${Math.round(s.cadence.every / 60)}m`;

      /* "Last successful sync never" is not a sentence, and it repeats what the
         meta line already says. A source with no history gets its own phrasing. */
      const body = s.lastError
        ? s.lastError
        : s.health === 'never-synced'
          ? `Nothing received yet · ${every}`
          : `Last successful sync ${ago(s.lagSeconds)} · ${every}`;

      return {
        id: `connector:${s.source}`,
        severity: kind.severity,
        icon: kind.icon,
        title: `${s.name} ${kind.verb}`,
        body,
        meta: s.health === 'never-synced' ? 'no successful sync on record' : ago(s.lagSeconds),
        go: '/ingest/status',
      };
    });
}

/* One alert per source, not per bad row: five hundred unreadable rows from one
   system is one incident with that system, and five hundred lines would bury
   everything else in the panel. */
function problemAlerts(problems = []) {
  const bySource = {};
  for (const p of problems) (bySource[p.source] = bySource[p.source] || []).push(p);

  return Object.entries(bySource).map(([source, list]) => ({
    id: `problems:${source}`,
    severity: 'warning',
    icon: 'ph ph-warning-diamond',
    title: `${list.length} value${list.length === 1 ? '' : 's'} from ${source} could not be read`,
    body: list.slice(0, 3).map((p) => `${p.field}: ${JSON.stringify(p.raw)}`).join(' · '),
    meta: `${new Set(list.map((p) => p.field)).size} field(s) affected`,
    go: '/ingest/status',
  }));
}

/* Unresolved bookings, from stage 3. The Analytics Engine files match rate
   under operational health beside sync lag, which is the right place for it:
   a booking no campaign can be credited with is revenue missing from every
   ROAS on every screen, and nothing else in the product would say so. */
function matchAlerts(match, unattributed = 0) {
  if (!match || !match.unresolved) return [];

  const money = unattributed ? ` · ₹${Math.round(unattributed / 100).toLocaleString('en-IN')} uncredited` : '';
  return [{
    id: 'match:unresolved',
    severity: 'warning',
    icon: 'ph ph-git-merge',
    title: `${match.unresolved} booking${match.unresolved === 1 ? '' : 's'} could not be matched to a campaign`,
    body: match.unresolvedDetail.slice(0, 3).map((u) => `${u.booking}: ${u.reason}`).join(' · '),
    meta: `match rate ${match.pct} (${match.matched}/${match.total})${money}`,
    go: '/ingest/status',
  }];
}

/* A sent report whose figures have since moved (5.3). This is the one alert
   here with a person on the other end of it: somebody has a number in their
   inbox that the product no longer agrees with. Data moving and a definition
   moving are separated, because one calls for a reissue and the other for an
   explanation. */
function restatementAlerts(restatements = []) {
  return restatements.map((r) => {
    const data = r.dataMoved.length;
    const defs = r.definitionMoved.length;
    const parts = [];
    if (data) parts.push(`${data} figure${data === 1 ? '' : 's'} restated at source`);
    if (defs) parts.push(`${defs} definition${defs === 1 ? '' : 's'} changed since`);
    if (r.unreproducible.length) parts.push(`${r.unreproducible.length} no longer defined`);

    return {
      id: `restated:${r.dispatch}`,
      /* Data moving under a sent report is the serious one: the recipient is
         holding a figure that was wrong, not one that means something else. */
      severity: data ? 'critical' : 'warning',
      icon: 'ph ph-paper-plane-tilt',
      title: `“${r.report}” was sent with figures that have changed`,
      body: r.moved.slice(0, 3).map((m) => `${m.metric}: ${m.sent} → ${m.now}`).join(' · '),
      meta: `${parts.join(' · ')} · sent ${String(r.sentAt).slice(0, 10)}`,
      go: '/reports',
    };
  });
}

/* A fired alert rule (Phase 8). The panel is the one channel that always
   works, so a rule that fires reaches somebody here even when the email and
   Slack it was configured for cannot be reached. */
function ruleAlerts(fired = []) {
  return fired.map((f) => {
    const undelivered = (f.delivery || []).filter((d) => !d.delivered).map((d) => d.channel);
    return {
      id: `rule:${f.id}`,
      severity: f.severity === 'critical' ? 'critical' : 'warning',
      icon: 'ph ph-bell-ringing',
      title: f.name,
      body: f.reason,
      meta: [
        `to ${f.to.join(', ')}`,
        undelivered.length ? `${undelivered.join(' and ')} not configured` : null,
      ].filter(Boolean).join(' · '),
      go: '/reports',
    };
  });
}

/* Everything is passed in rather than read here: the runner owns one source,
   the raw store owns another, and a panel that reached into all of them would
   sync on every page render. */
function build({ status = [], problems = [], match = null, unattributed = 0, restatements = [], fired = [] } = {}) {
  const alerts = [
    ...connectorAlerts(status),
    ...ruleAlerts(fired),
    ...restatementAlerts(restatements),
    ...matchAlerts(match, unattributed),
    ...problemAlerts(problems),
  ].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);

  return {
    alerts,
    count: alerts.length,
    critical: alerts.filter((a) => a.severity === 'critical').length,
    /* What the panel says when there is nothing to say. */
    empty: alerts.length === 0,
  };
}

module.exports = { build, connectorAlerts, problemAlerts, matchAlerts, restatementAlerts, ruleAlerts, SEVERITY, ago };
