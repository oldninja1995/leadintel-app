/* Data for the "ai" screen.
 *
 * Shape derived from the design markup — these are the exact keys and fields
 * the view reads. Values are intentionally empty: the design file's data
 * block exceeded the MCP read cap and has not been transcribed yet.
 */

module.exports = {
  aiAnom: false,
  aiChat: false,
  aiCommand: true,
  aiForecast: false,
  aiGoals: false,
  aiHealth: false,
  aiRecsTab: false,
  aiSim: false,
  benchCol1: '',
  benchCol2: '',
  benchCol3: '',
  down: '',
  fcConf: '',
  fcLabel: '',
  fcNote: '',
  simNote: '',
  simScenario: '',
  sumNarrative: '',
  sumTitle: '',
  up: '',
  warn: '',
  /* each item: { border, color, label } */
  aiTabs: [],
  /* each item: { bg, color, label } */
  sumRanges: [],
  /* each item: { delta, deltaColor, label, value } */
  sumKpis: [],
  /* each item: { dot, meta, text } */
  aiRisks: [],
  /* each item: { meta, text } */
  aiOpps: [],
  /* each item: { btn, meta, text } */
  aiActions: [],
  /* each item: { color, name, score, w } */
  /*   .chips[] each: { — } */
  healthMinis: [],
  /* each item: { — } */
  aiCaps: [],
  /* each item: { bench, color, dash, icon, name, reason, rec, risk, riskColor, score, trend, trendColor } */
  healthCards: [],
  /* each item: { bg, color, label } */
  fcRanges: [],
  /* each item: { delta, deltaColor, label, range, value } */
  fcKpis: [],
  /* each item: { dev, devColor, dot, scope, status, statusColor, title, when } */
  anomalies: [],
  /* each item: { evidence, line, n, text } */
  rootChain: [],
  /* each item: { bg, color, label } */
  simMetaOpts: [],
  /* each item: { bg, color, label } */
  simAdrOpts: [],
  /* each item: { bg, color, label } */
  simCancelOpts: [],
  /* each item: { delta, deltaColor, label, value } */
  simOut: [],
  /* each item: { barColor, cur, name, pace, paceColor, target, w } */
  goals: [],
  /* each item: { bg, color, label } */
  benchModes: [],
  /* each item: { barColor, cur, delta, deltaColor, metric, prev, w } */
  benchRows: [],
  /* each item: { action, body, cat, color, icon, title } */
  /*   .chips[] each: { — } */
  aiFeed: [],
};

/* Click targets the design declares on this screen. They render as
 * data-action attributes; wire them up when behaviour is specified.
 *
 *   aiGoHealth
 *   m.go
 *   o.go
 *   r.go
 *   t.go
 *   toggleAi
 */
