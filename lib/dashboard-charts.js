/* The infographics on the Executive and Marketing dashboards.
 *
 * Every figure comes out of `funnel-analytics.analyse` — run once per channel
 * (Meta, Google, Organic) over the same window — so a chart here and the Full
 * Funnel Analytics page can never disagree about what a lead, a booking or a
 * cost per lead is. Leads count on the day they arrived, bookings on the day
 * they closed, exactly as there.
 *
 * Geometry is computed here, as spendVsRevenue does in projections.js, so the
 * views only place what they are handed. Money is in paise throughout.
 */

const funnelAnalytics = require('./funnel-analytics');

const NONE = '—';
const MS_PER_DAY = 86400000;
const SHORT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

const COLOUR = {
  meta: 'var(--color-accent-500)',
  google: 'var(--color-accent-2-500)',
  organic: 'var(--color-neutral-600)',
};
const LABEL = { meta: 'Meta Ads', google: 'Google Ads', organic: 'Organic / untagged' };
const CHANNELS = ['meta', 'google', 'organic'];

function money(paise) {
  if (paise == null || Number.isNaN(paise)) return NONE;
  const n = paise / 100;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
const count = (n) => (n == null ? NONE : Math.round(n).toLocaleString('en-IN'));
const pct = (r) => (r == null ? NONE : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);

/* Day buckets up to a month, weeks up to half a year, months beyond — so a bar
   chart never has more than ~30 bars and never just one. */
function grainFor(leads, deals, days) {
  const stamps = [
    ...leads.map((l) => l.createdAt), ...deals.map((d) => d.closedAt || d.updatedAt), ...days.map((d) => d.date),
  ].filter(Boolean).map((s) => Date.parse(String(s).slice(0, 10))).filter(Number.isFinite);
  if (!stamps.length) return 'day';
  const span = (Math.max(...stamps) - Math.min(...stamps)) / MS_PER_DAY + 1;
  return span <= 35 ? 'day' : span <= 190 ? 'week' : 'month';
}

/* Every bucket from the first to the last, so a quiet day is a zero on the
   axis rather than a gap the eye closes. */
function bucketRange(keys, grain) {
  const sorted = [...new Set(keys)].filter(Boolean).sort();
  if (!sorted.length) return [];
  if (grain === 'month') {
    const out = [];
    let [y, m] = sorted[0].split('-').map(Number);
    const [ly, lm] = sorted[sorted.length - 1].split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  const step = grain === 'week' ? 7 : 1;
  const out = [];
  for (let t = Date.parse(sorted[0]); t <= Date.parse(sorted[sorted.length - 1]); t += step * MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function bucketLabel(key, grain) {
  if (grain === 'month') return MONTH.format(new Date(`${key}-01T00:00:00Z`));
  const d = SHORT.format(new Date(`${key}T00:00:00Z`));
  return grain === 'week' ? `w/c ${d}` : d;
}

/* At most ~7 axis labels, evenly spaced, so thirty days do not overprint. */
function axisLabels(keys, grain, xOf) {
  const every = Math.max(1, Math.ceil(keys.length / 7));
  return keys.map((k, i) => ({ k, i })).filter(({ i }) => i % every === 0)
    .map(({ k, i }) => ({ x: xOf(i), text: bucketLabel(k, grain) }));
}

function run(input, grain) {
  const out = {};
  for (const channel of CHANNELS) out[channel] = funnelAnalytics.analyse(input, { channel, grain });
  return out;
}

const W = 640;
const BASE = 180;
const TALL = 150;

/* ── Executive ──────────────────────────────────────────────────────────── */

function leadsVsBookings(runs, keys, grain) {
  if (!keys.length) return { empty: true, reason: 'No leads or bookings in this range.' };
  const rows = keys.map((key) => {
    let leads = 0; let bookings = 0; let revenue = 0;
    for (const c of CHANNELS) {
      const p = runs[c].periods.find((x) => x.key === key);
      if (p) { leads += p.leads; bookings += p.bookings; revenue += p.revenue; }
    }
    return { key, leads, bookings, revenue };
  });
  const leadTop = Math.max(1, ...rows.map((r) => r.leads));
  const bookTop = Math.max(1, ...rows.map((r) => r.bookings));
  const slot = W / rows.length;
  const barW = Math.max(3, Math.min(22, slot * 0.6));
  const xOf = (i) => slot * i + slot / 2;
  const bars = rows.map((r, i) => {
    const h = (r.leads / leadTop) * TALL;
    return {
      x: xOf(i) - barW / 2, w: barW, y: BASE - h, h,
      tip: `${bucketLabel(r.key, grain)} · ${count(r.leads)} leads · ${count(r.bookings)} bookings · ${money(r.revenue)}`,
    };
  });
  const line = rows.map((r, i) => `${xOf(i).toFixed(1)},${(BASE - (r.bookings / bookTop) * TALL).toFixed(1)}`).join(' ');
  const totalLeads = rows.reduce((s, r) => s + r.leads, 0);
  const totalBookings = rows.reduce((s, r) => s + r.bookings, 0);
  return {
    empty: false,
    bars,
    line,
    dots: rows.map((r, i) => ({ cx: xOf(i), cy: BASE - (r.bookings / bookTop) * TALL, show: r.bookings > 0 })),
    axis: axisLabels(keys, grain, xOf),
    leadTop: count(leadTop),
    bookTop: count(bookTop),
    totals: { leads: count(totalLeads), bookings: count(totalBookings), conversion: totalLeads ? pct(totalBookings / totalLeads) : NONE },
  };
}

function bookingsByChannel(runs) {
  const rows = CHANNELS.map((c) => ({
    key: c, label: LABEL[c], colour: COLOUR[c],
    bookings: runs[c].summary.bookings, revenue: runs[c].summary.revenue,
  }));
  const total = rows.reduce((s, r) => s + r.bookings, 0);
  if (!total) return { empty: true, reason: 'No won bookings closed in this range.' };
  const C = 2 * Math.PI * 54;
  let offset = 0;
  const slices = rows.filter((r) => r.bookings > 0).map((r) => {
    const share = r.bookings / total;
    const dash = share * C;
    const s = {
      ...r, pct: pct(share), countText: count(r.bookings), revenueText: money(r.revenue),
      dash: `${dash.toFixed(1)} ${C.toFixed(1)}`, offset: (-offset).toFixed(1),
    };
    offset += dash;
    return s;
  });
  return { empty: false, total: count(total), revenue: money(rows.reduce((s, r) => s + r.revenue, 0)), slices };
}

function leadStatus(runs) {
  const by = new Map();
  for (const c of CHANNELS) {
    for (const s of runs[c].stageMap) by.set(s.status, (by.get(s.status) || 0) + s.n);
  }
  const all = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const total = all.reduce((s, [, n]) => s + n, 0);
  if (!total) return { empty: true, reason: 'No leads arrived in this range.' };
  const SHOWN = 8;
  const rows = all.slice(0, SHOWN);
  const rest = all.slice(SHOWN).reduce((s, [, n]) => s + n, 0);
  if (rest) rows.push([`${all.length - SHOWN} other statuses`, rest]);
  const top = Math.max(...rows.map(([, n]) => n));
  const tone = (status) => (/not\s*interest|lost|junk|invalid|wrong|dnd|cancel/i.test(status) ? 'var(--color-neutral-600)'
    : /won|convert|book/i.test(status) ? 'var(--color-accent-400)'
      : 'var(--color-accent-700)');
  return {
    empty: false,
    total: count(total),
    rows: rows.map(([status, n]) => ({ status, n: count(n), share: pct(n / total), w: `${Math.max(1.5, (n / top) * 100).toFixed(1)}%`, colour: tone(status) })),
  };
}

/* When enquiries arrive, in India time — the team works IST, and a UTC grid
   would put the evening rush in the afternoon. */
const IST_MS = 330 * 60000;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function arrivalHeatmap(leads) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let n = 0;
  for (const lead of leads) {
    const t = Date.parse(lead.createdAt);
    if (!Number.isFinite(t) || !/T\d\d:/.test(String(lead.createdAt))) continue;
    const d = new Date(t + IST_MS);
    grid[(d.getUTCDay() + 6) % 7][d.getUTCHours()] += 1;
    n += 1;
  }
  if (!n) return { empty: true, reason: 'No lead in this range carries an arrival time.' };
  const top = Math.max(...grid.flat());
  let peak = { day: 0, hour: 0, v: -1 };
  grid.forEach((row, day) => row.forEach((v, hour) => { if (v > peak.v) peak = { day, hour, v }; }));
  const hourText = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
  return {
    empty: false,
    total: count(n),
    peak: `${DAYS[peak.day]} ${hourText(peak.hour)}–${hourText((peak.hour + 1) % 24)}`,
    rows: grid.map((row, day) => ({
      day: DAYS[day],
      cells: row.map((v, hour) => ({
        v, op: v ? (0.15 + 0.85 * (v / top)).toFixed(2) : '0',
        tip: `${DAYS[day]} ${hourText(hour)} · ${count(v)} lead${v === 1 ? '' : 's'}`,
      })),
    })),
    hours: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({ h, text: hourText(h) })),
  };
}

/* ── Marketing ──────────────────────────────────────────────────────────── */

function cplTrend(runs, keys, grain) {
  const series = ['meta', 'google'].map((c) => ({
    key: c, label: LABEL[c], colour: COLOUR[c],
    points: keys.map((k) => {
      const p = runs[c].periods.find((x) => x.key === k);
      return p && p.cpl != null ? p.cpl : null;
    }),
    overall: runs[c].summary.cpl,
  }));
  const values = series.flatMap((s) => s.points).filter((v) => v != null);
  if (!values.length) return { empty: true, reason: 'No paid spend with CRM leads in this range.' };
  /* Capped at the 95th percentile so one day with ₹4,000 spend and a single
     lead does not flatten every other point onto the baseline. */
  const sorted = [...values].sort((a, b) => a - b);
  const top = Math.max(1, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
  const slot = W / keys.length;
  const xOf = (i) => slot * i + slot / 2;
  const yOf = (v) => BASE - (Math.min(v, top) / top) * TALL;
  return {
    empty: false,
    series: series.map((s) => ({
      ...s,
      overallText: money(s.overall),
      /* Broken at a period with no cost per lead rather than drawn through it. */
      paths: s.points.reduce((acc, v, i) => {
        if (v == null) { acc.push([]); return acc; }
        acc[acc.length - 1].push(`${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
        return acc;
      }, [[]]).filter((seg) => seg.length).map((seg) => seg.join(' ')),
      dots: s.points.map((v, i) => (v == null ? null : {
        cx: xOf(i), cy: yOf(v), capped: v > top, tip: `${s.label} · ${bucketLabel(keys[i], grain)} · ${money(v)} per lead`,
      })).filter(Boolean),
    })),
    topText: money(top),
    axis: axisLabels(keys, grain, xOf),
  };
}

function platformFunnel(runs) {
  const KEYS = [['impressions', 'Impressions'], ['clicks', 'Clicks'], ['leads', 'CRM leads'], ['qualified', 'Qualified'], ['booked', 'Booked']];
  const cols = ['meta', 'google'].map((c) => {
    const stages = runs[c].stages;
    const top = (stages.find((s) => s.key === 'impressions') || {}).n || 0;
    let prev = null;
    return {
      key: c, label: LABEL[c], colour: COLOUR[c],
      spend: money(runs[c].summary.spend), roas: runs[c].summary.roas == null ? NONE : `${runs[c].summary.roas.toFixed(2)}x`,
      stages: KEYS.map(([key, label]) => {
        const s = stages.find((x) => x.key === key) || {};
        const n = s.n == null ? null : s.n;
        /* Log width, as the Marketing funnel above it does: impressions are
           thousands of times bookings, and a linear bar would make every stage
           after clicks invisible. The exact figures sit beside each bar. */
        const w = n && top > 1 ? Math.max(2, (Math.log(Math.max(n, 1)) / Math.log(top)) * 100) : 0;
        const row = { label, n: count(n), w: `${w.toFixed(1)}%`, step: prev && n != null ? pct(n / prev) : null };
        prev = n || prev;
        return row;
      }),
    };
  });
  if (!cols.some((c) => c.stages[0].n !== NONE && c.stages[0].n !== '0')) return { empty: true, reason: 'No paid impressions in this range.' };
  return { empty: false, cols };
}

function roasByCampaign(runs) {
  const rows = ['meta', 'google'].flatMap((c) => runs[c].campaigns
    .filter((x) => x.matched && x.spend > 0)
    .map((x) => ({ ...x, channel: c })));
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  /* Campaigns that spent at least 2% of the paid budget — below that a single
     booking swings ROAS to absurd figures and the chart is about noise. */
  const material = rows.filter((r) => r.spend >= spend * 0.02);
  if (!material.length) return { empty: true, reason: 'No campaign spent in this range.' };
  material.sort((a, b) => (b.roas || 0) - (a.roas || 0) || b.spend - a.spend);
  const shown = material.length > 10 ? [...material.slice(0, 5), ...material.slice(-5)] : material;
  const top = Math.max(0.01, ...shown.map((r) => r.roas || 0));
  return {
    empty: false,
    hidden: material.length - shown.length,
    rows: shown.map((r) => ({
      label: r.label,
      colour: COLOUR[r.channel],
      platform: LABEL[r.channel],
      roas: `${(r.roas || 0).toFixed(2)}x`,
      w: `${Math.max(0.8, ((r.roas || 0) / top) * 100).toFixed(1)}%`,
      tip: `${r.label} · ${LABEL[r.channel]} · ${money(r.spend)} spend · ${count(r.bookings)} bookings · ${money(r.revenue)}`,
      zero: !r.roas,
    })),
  };
}

function leadMix(runs, keys, grain) {
  if (!keys.length) return { empty: true, reason: 'No leads in this range.' };
  const rows = keys.map((k) => {
    const v = {};
    for (const c of CHANNELS) v[c] = (runs[c].periods.find((x) => x.key === k) || { leads: 0 }).leads;
    return { key: k, ...v, total: v.meta + v.google + v.organic };
  });
  const top = Math.max(1, ...rows.map((r) => r.total));
  const slot = W / rows.length;
  const barW = Math.max(3, Math.min(26, slot * 0.6));
  const xOf = (i) => slot * i + slot / 2;
  const totals = Object.fromEntries(CHANNELS.map((c) => [c, rows.reduce((s, r) => s + r[c], 0)]));
  const all = totals.meta + totals.google + totals.organic;
  return {
    empty: false,
    topText: count(top),
    legend: CHANNELS.map((c) => ({ label: LABEL[c], colour: COLOUR[c], n: count(totals[c]), share: all ? pct(totals[c] / all) : NONE })),
    bars: rows.map((r, i) => {
      let y = BASE;
      const segs = CHANNELS.map((c) => {
        const h = (r[c] / top) * TALL;
        y -= h;
        return { colour: COLOUR[c], y, h };
      }).filter((s) => s.h > 0);
      return {
        x: xOf(i) - barW / 2, w: barW, segs,
        tip: `${bucketLabel(r.key, grain)} · Meta ${r.meta} · Google ${r.google} · Organic ${r.organic}`,
      };
    }),
    axis: axisLabels(keys, grain, xOf),
  };
}

/* ── entry points ───────────────────────────────────────────────────────── */

function inputs(entities, params) {
  const whole = params.whole || entities;
  return {
    leads: entities.leads || [],
    deals: entities.deals || [],
    allLeads: whole.leads || entities.leads || [],
    campaignDays: entities.campaignDays || [],
    googleConversions: entities.googleConversions || [],
  };
}

function prepare(entities, params) {
  const input = inputs(entities, params);
  const grain = grainFor(input.leads, input.deals, input.campaignDays);
  const runs = run(input, grain);
  const keys = bucketRange(CHANNELS.flatMap((c) => runs[c].periods.map((p) => p.key)), grain);
  return { input, grain, runs, keys };
}

const GRAIN_TEXT = { day: 'daily', week: 'weekly', month: 'monthly' };

function executive(entities, params = {}) {
  const { input, grain, runs, keys } = prepare(entities, params);
  return {
    grain: GRAIN_TEXT[grain],
    leadsVsBookings: leadsVsBookings(runs, keys, grain),
    bookingsByChannel: bookingsByChannel(runs),
    leadStatus: leadStatus(runs),
    arrivals: arrivalHeatmap(input.leads),
  };
}

function marketing(entities, params = {}) {
  const { grain, runs, keys } = prepare(entities, params);
  return {
    grain: GRAIN_TEXT[grain],
    cplTrend: cplTrend(runs, keys, grain),
    platformFunnel: platformFunnel(runs),
    roasByCampaign: roasByCampaign(runs),
    leadMix: leadMix(runs, keys, grain),
  };
}

module.exports = { executive, marketing, grainFor, bucketRange };
