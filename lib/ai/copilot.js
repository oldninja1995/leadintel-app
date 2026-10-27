/* The Copilot tab: a typed question, answered by a language model over the
 * figures this workspace already shows.
 *
 * The model is handed a brief, not the store. The brief is assembled from the
 * same places the screens read — the AI screen's own derivation, the metric
 * registry's values for the selected window (and the one before it, when the
 * store spans it), and a few tables rolled up from the window's rows — so an
 * answer can only cite a figure some screen would also show. What the brief
 * does not hold, the model is told to say it cannot see, rather than guess.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';
const MAX_HISTORY = 12;
const MAX_QUESTION = 2000;

const SYSTEM = `You are the analyst inside LeadIntel, a revenue dashboard for a hospitality business in India (resorts; leads from Meta and Google ads into the TeleCRM CRM; reservations booked as won deals).

Answer the user's question using ONLY the workspace brief in the latest user turn. Rules:
- Every figure you state must appear in, or be directly computed from, the brief. Name the window it covers.
- If the brief cannot answer the question, say plainly what is missing (e.g. "the brief has no per-ad-set figures") and point to the LeadIntel screen most likely to hold it. Never invent numbers, names, causes or forecasts.
- Attribution is partial: many leads carry no channel, so attributed revenue and ROAS are floors. Mention this when it changes the answer.
- Money is in Indian rupees; keep the brief's formatting (₹, L for lakh, Cr for crore).
- Be direct and short: lead with the answer, then at most a few bullets of support. Plain text or simple markdown (bullets, bold). No tables unless asked.`;

const money = (paise) => {
  const rupees = (paise || 0) / 100;
  if (Math.abs(rupees) >= 1e7) return `₹${(rupees / 1e7).toFixed(2)}Cr`;
  if (Math.abs(rupees) >= 1e5) return `₹${(rupees / 1e5).toFixed(2)}L`;
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`;
};

function rollup(rows, keyOf, fields) {
  const out = new Map();
  for (const row of rows || []) {
    const key = keyOf(row);
    if (!key) continue;
    const acc = out.get(key) || Object.fromEntries([['key', key], ...fields.map((f) => [f, 0])]);
    for (const f of fields) acc[f] += Number(row[f]) || 0;
    out.set(key, acc);
  }
  return [...out.values()];
}

/* Tables from the window's rows, kept small: the model reads a brief, and a
   brief with every campaign in a year is a dump. */
function tables(entities, leadById = new Map()) {
  const days = entities.campaignDays || [];
  const leads = entities.leads || [];
  /* A deal names its lead, not its owner; the lead carries owner and campaign.
     Looked up across the whole store, because a booking won this week is often
     on a lead created months ago. */
  const won = (entities.deals || [])
    .filter((d) => d.outcome === 'won' && !/cancel/i.test(String(d.bookingStatus || '')))
    .map((d) => {
      const lead = leadById.get(String(d.leadId || '').replace(/#.*$/, '')) || {};
      return { ...d, campaign: d.campaign || lead.campaign, owner: lead.owner };
    });

  const leadsByCampaign = new Map();
  for (const l of leads) if (l.campaign) leadsByCampaign.set(l.campaign, (leadsByCampaign.get(l.campaign) || 0) + 1);
  const wonByCampaign = new Map();
  for (const d of won) {
    if (!d.campaign) continue;
    const acc = wonByCampaign.get(d.campaign) || { n: 0, revenue: 0 };
    acc.n += 1; acc.revenue += d.revenue || 0;
    wonByCampaign.set(d.campaign, acc);
  }

  const campaigns = rollup(days, (d) => d.campaign && `${d.campaign} [${d.platform || '?'}]`, ['spend', 'impressions', 'clicks', 'conversions'])
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 25)
    .map((c) => {
      const name = c.key.replace(/ \[[^\]]*\]$/, '');
      const w = wonByCampaign.get(name) || { n: 0, revenue: 0 };
      const crmLeads = leadsByCampaign.get(name) || 0;
      return `- ${c.key}: spend ${money(c.spend)}, ${c.impressions} impr, ${c.clicks} clicks, CTR ${c.impressions ? ((c.clicks / c.impressions) * 100).toFixed(2) : '—'}%, platform conversions ${Math.round(c.conversions)}, CRM leads ${crmLeads}${crmLeads && c.spend ? ` (CPL ${money(c.spend / crmLeads)})` : ''}, won bookings ${w.n} worth ${money(w.revenue)}`;
    });

  const channels = rollup(leads, (l) => l.channel || 'untagged', [])
    .map((c) => c.key)
    .map((ch) => {
      const n = leads.filter((l) => (l.channel || 'untagged') === ch).length;
      const w = won.filter((d) => (d.channel || 'untagged') === ch);
      return `- ${ch}: ${n} leads, ${w.length} won bookings worth ${money(w.reduce((t, d) => t + (d.revenue || 0), 0))}`;
    });

  const stages = rollup(leads, (l) => l.stage || 'unknown', [])
    .map((s) => [s.key, leads.filter((l) => (l.stage || 'unknown') === s.key).length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, n]) => `- ${k}: ${n}`);

  const owners = new Map();
  for (const l of leads) {
    const who = String(l.owner || '').replace(/@.*$/, '');
    if (!who) continue;
    const acc = owners.get(who) || { leads: 0, won: 0, revenue: 0 };
    acc.leads += 1;
    owners.set(who, acc);
  }
  for (const d of won) {
    const who = String(d.owner || '').replace(/@.*$/, '');
    if (!who) continue;
    const acc = owners.get(who) || { leads: 0, won: 0, revenue: 0 };
    acc.won += 1; acc.revenue += d.revenue || 0;
    owners.set(who, acc);
  }
  const team = [...owners.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 15)
    .map(([who, o]) => `- ${who}: ${o.leads} leads assigned, ${o.won} won worth ${money(o.revenue)}`);

  const topBookings = won.slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 10)
    .map((d) => `- ${String(d.closedAt || '').slice(0, 10)} ${money(d.revenue)} · channel ${d.channel || 'untagged'}${d.campaign ? ` · ${d.campaign}` : ''}`);

  return { campaigns, channels, stages, team, topBookings };
}

/* The brief: everything the model may cite, as plain labelled text. */
function brief({ range, payload = {}, values = null, previous = null, registry = null, format = null, entities = {}, allLeads = [] }) {
  const parts = [`WINDOW: ${range || 'the selected range'}`];
  if (payload.sumNarrative) parts.push(`SUMMARY (computed by LeadIntel):\n${payload.sumNarrative}`);
  const list = (title, rows, fn) => { if (rows && rows.length) parts.push(`${title}:\n${rows.map(fn).join('\n')}`); };
  list('HEADLINE FIGURES', payload.sumKpis, (k) => `- ${k.label}: ${k.value}${k.delta && k.delta !== '·' ? ` (${k.delta})` : ''}`);
  list('RISKS', payload.aiRisks, (r) => `- ${r.text} — ${r.meta}`);
  list('OPPORTUNITIES', payload.aiOpps, (o) => `- ${o.text} — ${o.meta}`);
  list('ANOMALIES (most extreme day per series)', payload.anomalies, (a) => `- ${a.title} · ${a.scope}: ${a.dev} on ${a.when} (${a.status})`);
  list('GOALS (target from each metric definition)', payload.goals, (g) => `- ${g.name}: ${g.cur} vs target ${g.target} — ${g.pace}`);

  if (values && registry && format) {
    const rows = [];
    for (const m of registry.list()) {
      const v = values[m.id];
      if (v === null || v === undefined) continue;
      const p = previous ? previous[m.id] : null;
      rows.push(`- ${m.name || m.id}: ${format(m, v)}${p !== null && p !== undefined ? ` (previous window ${format(m, p)})` : ''}`);
    }
    if (rows.length) parts.push(`METRICS (registry, this window${previous ? ' and the one before it' : ''}):\n${rows.join('\n')}`);
  }

  const t = tables(entities, new Map((allLeads || []).map((l) => [String(l.id), l])));
  if (t.campaigns.length) parts.push(`CAMPAIGNS BY SPEND (top 25):\n${t.campaigns.join('\n')}`);
  if (t.channels.length) parts.push(`LEADS AND WON BOOKINGS BY CHANNEL:\n${t.channels.join('\n')}`);
  if (t.stages.length) parts.push(`LEADS BY CRM STATUS:\n${t.stages.join('\n')}`);
  if (t.team.length) parts.push(`SALES TEAM:\n${t.team.join('\n')}`);
  if (t.topBookings.length) parts.push(`LARGEST WON BOOKINGS:\n${t.topBookings.join('\n')}`);
  return parts.join('\n\n');
}

/* History arrives from the browser, so it is shaped and capped here rather
   than trusted: alternating user/assistant text, newest kept. */
function cleanHistory(history) {
  const out = [];
  for (const turn of Array.isArray(history) ? history : []) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
    const text = String(turn.text || '').slice(0, 6000).trim();
    if (!text) continue;
    if (out.length && out[out.length - 1].role === turn.role) continue;
    out.push({ role: turn.role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  const kept = out.slice(-MAX_HISTORY);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  if (kept.length && kept[kept.length - 1].role === 'user') kept.pop();
  return kept;
}

async function ask({ apiKey, question, history = [], context }, { client = null } = {}) {
  if (!apiKey) throw new Error('no AI assistant is connected — add an Anthropic API key on the "AI assistant (Claude)" card in Connections');
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) throw new Error('type a question first');

  const anthropic = client || new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  const messages = [
    ...cleanHistory(history),
    { role: 'user', content: `<workspace_brief>\n${context}\n</workspace_brief>\n\nQuestion: ${q}` },
  ];

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages,
    });
    if (response.stop_reason === 'refusal') throw new Error('the assistant declined to answer that question');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new Error('the assistant returned no answer — try rephrasing');
    return { answer: text, model: response.model, usage: response.usage };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('the Anthropic API key was rejected — check it on the AI assistant card in Connections');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('this Anthropic key is not allowed to use the model — check the key\'s workspace and billing');
    if (err instanceof Anthropic.RateLimitError) throw new Error('the assistant is rate-limited right now — wait a moment and ask again');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('could not reach the Anthropic API — try again');
    if (err instanceof Anthropic.APIError) throw new Error(`the assistant failed (${err.status}): ${err.message}`);
    throw err;
  }
}

module.exports = { ask, brief, cleanHistory, MODEL };
