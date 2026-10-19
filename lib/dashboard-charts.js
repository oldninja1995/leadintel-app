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
const { channelKey } = require('./filters');

const NONE = '—';
const MS_PER_DAY = 86400000;
const SHORT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

const COLOUR = {
  meta: 'var(--color-accent-500)',
  google: 'var(--c-google)',
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

/* The inclusive day range a bucket covers, for a link that opens it. */
function bucketSpan(key, grain) {
  if (grain === 'month') {
    const [y, m] = key.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: `${key}-01`, to: last };
  }
  if (grain === 'week') {
    return { from: key, to: new Date(Date.parse(key) + 6 * MS_PER_DAY).toISOString().slice(0, 10) };
  }
  return { from: key, to: key };
}

/* What a click on a mark shows: a title, label/value rows and, where a screen
   can answer the follow-up question, a link to it. A link with no from/to is
   given the page's current range by app-ui.js. */
const pop = (title, rows, go = null, goText = null) => ({ title, rows: rows.filter((r) => r && r[1] != null), go, goText });
/* Every channel, so a bar that counts every channel opens a list that does. */
const leadsLink = (span) => `/leads?${new URLSearchParams({ from: span.from, to: span.to })}`;
const funnelLink = (channel, span, stage) => {
  const q = new URLSearchParams({ channel });
  if (span) { q.set('from', span.from); q.set('to', span.to); q.set('grain', 'day'); }
  if (stage) q.set('stage', stage);
  return `/funnel-analytics?${q}`;
};

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
      pop: pop(bucketLabel(r.key, grain), [
        ['Leads arrived', count(r.leads)], ['Bookings closed', count(r.bookings)], ['Revenue', money(r.revenue)],
        ['Bookings per lead', r.leads ? pct(r.bookings / r.leads) : NONE],
      ], leadsLink(bucketSpan(r.key, grain)), 'Open these leads'),
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
      pop: pop(r.label, [['Bookings', count(r.bookings)], ['Share of bookings', pct(share)], ['Revenue', money(r.revenue)],
        ['Average booking', r.bookings ? money(r.revenue / r.bookings) : NONE]],
      funnelLink(r.key, null, 'booked'), `See ${r.label} bookings`),
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
    rows: rows.map(([status, n]) => ({
      status, n: count(n), share: pct(n / total), w: `${Math.max(1.5, (n / top) * 100).toFixed(1)}%`, colour: tone(status),
      pop: pop(status, [['Leads', count(n)], ['Share of leads in range', pct(n / total)],
        ...CHANNELS.map((c) => {
          const hit = runs[c].stageMap.find((x) => x.status === status);
          return hit ? [LABEL[c], count(hit.n)] : null;
        })], '/leads', 'Open Lead Intelligence'),
    })),
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
        pop: pop(`${DAYS[day]} ${hourText(hour)}–${hourText((hour + 1) % 24)}`, [
          ['Leads in this hour', count(v)], ['Share of all leads', pct(v / n)],
          ['Busiest hour that day', `${hourText(row.indexOf(Math.max(...row)))}`],
        ]),
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
        pop: (() => {
          const p = runs[s.key].periods.find((x) => x.key === keys[i]) || {};
          return pop(`${s.label} · ${bucketLabel(keys[i], grain)}`, [
            ['Cost per lead', money(v)], ['Spend', money(p.spend)], ['CRM leads', count(p.leads)],
            ['Clicks', count(p.clicks)], ['Bookings closed', count(p.bookings)],
          ], funnelLink(s.key, bucketSpan(keys[i], grain)), 'Open this period in Funnel Analytics');
        })(),
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
        /* Booked is a share of CRM leads, not of the step above: bookings
           count when they close, so a range holds bookings from leads that
           were qualified months earlier and "of qualified" ran past 100%. */
        const leads = (stages.find((x) => x.key === 'leads') || {}).n;
        const step = key === 'booked'
          ? (n != null && leads ? `${pct(n / leads)} of leads` : null)
          : (prev && n != null ? pct(n / prev) : null);
        const drill = { leads: 'leads', qualified: 'qualified', booked: 'booked' }[key] || null;
        const row = {
          label, n: count(n), w: `${w.toFixed(1)}%`, step,
          pop: pop(`${LABEL[c]} · ${label}`, [[label, count(n)], ['Step rate', step], ['Of impressions', n != null && top ? (n / top < 0.001 ? '<0.1%' : pct(n / top)) : null]],
            funnelLink(c, null, drill), drill ? `List these ${label.toLowerCase()}` : 'Open Funnel Analytics'),
        };
        prev = n || prev;
        return row;
      }),
    };
  });
  if (!cols.some((c) => c.stages[0].n !== NONE && c.stages[0].n !== '0')) return { empty: true, reason: 'No paid impressions in this range.' };
  return { empty: false, cols };
}

/* Bookings a channel won with no campaign on the lead — Google's website
   enquiries arrive in TeleCRM as source "Google Ads" and nothing else — are
   shared across that channel's campaigns by the platform's own conversion
   split (clicks if it reported none). Proportional credit is a model, not a
   measurement, so every row it touches is marked "est." and the note says how. */
function allocateOrphans(runs, c, rows) {
  const orphan = runs[c].campaigns.find((x) => !x.matched && x.bookings > 0 && /^\(no campaign/.test(x.key));
  if (!orphan) return null;
  const mine = rows.filter((r) => r.channel === c);
  const by = mine.some((r) => r.platformLeads > 0) ? 'platformLeads' : 'clicks';
  const total = mine.reduce((s, r) => s + (r[by] || 0), 0);
  if (!total) {
    return `${LABEL[c]}: ${count(orphan.bookings)} booking(s) (${money(orphan.revenue)}) carry no campaign name and could not be shared out, so its campaigns read low.`;
  }
  for (const r of mine) {
    const share = (r[by] || 0) / total;
    if (!share) continue;
    r.revenue += orphan.revenue * share;
    r.estBookings = (r.estBookings || 0) + orphan.bookings * share;
    r.roas = r.spend ? r.revenue / r.spend : null;
    r.estimated = true;
  }
  return `${LABEL[c]}: ${count(orphan.bookings)} booking(s) (${money(orphan.revenue)}) arrived with no campaign name and are shared across its campaigns by ${by === 'platformLeads' ? `${LABEL[c]}' own conversion` : 'click'} split — marked est.`;
}

function roasByCampaign(runs, campaignIds = new Map()) {
  const rows = ['meta', 'google'].flatMap((c) => runs[c].campaigns
    .filter((x) => x.matched && x.spend > 0)
    .map((x) => ({ ...x, channel: c })));
  const orphans = ['meta', 'google'].map((c) => allocateOrphans(runs, c, rows)).filter(Boolean);
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
    orphans,
    hidden: material.length - shown.length,
    rows: shown.map((r) => ({
      label: r.label,
      colour: COLOUR[r.channel],
      platform: LABEL[r.channel],
      roas: `${(r.roas || 0).toFixed(2)}x${r.estimated ? ' est.' : ''}`,
      w: `${Math.max(0.8, ((r.roas || 0) / top) * 100).toFixed(1)}%`,
      estimated: r.estimated === true,
      tip: `${r.label} · ${LABEL[r.channel]} · ${money(r.spend)} spend · ${count(r.bookings)} named booking(s)`
        + `${r.estBookings ? ` + ${r.estBookings.toFixed(1)} shared` : ''} · ${money(r.revenue)}${r.estimated ? ' (includes estimated share)' : ''}`,
      zero: !r.roas,
      pop: pop(r.label, [
        ['Platform', LABEL[r.channel]], ['Spend', money(r.spend)], ['ROAS', `${(r.roas || 0).toFixed(2)}x${r.estimated ? ' (est.)' : ''}`],
        ['Bookings named to it', count(r.bookings)], r.estBookings ? ['Shared bookings (est.)', r.estBookings.toFixed(1)] : null,
        ['Revenue', money(r.revenue)], ['CRM leads', count(r.leads)], ['Cost per lead', money(r.cpl)],
      ], r.channel === 'meta' ? `/campaigns?v=campDetail&campaign=${encodeURIComponent(r.key)}`
        : (campaignIds.get(r.key) ? `/google-ads?campaign=${encodeURIComponent(campaignIds.get(r.key))}` : '/google-ads'),
      'Open campaign'),
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
        pop: pop(bucketLabel(r.key, grain), [
          ...CHANNELS.map((c) => [LABEL[c], `${count(r[c])}${r.total ? ` (${pct(r[c] / r.total)})` : ''}`]), ['Total', count(r.total)],
        ], leadsLink(bucketSpan(r.key, grain)), 'Open these leads'),
      };
    }),
    axis: axisLabels(keys, grain, xOf),
  };
}

/* ── Reservation value, month by month ────────────────────────────────────
 *
 * Ad-won reservations only: deals whose lead the CRM tagged Meta or Google,
 * under the rule `revenue.reservations` uses — won, cancellations excluded,
 * dated by when the booking was won (whatever the lead's age, repeats'+N+' * included) — cut by calendar month. Read from the whole
 * snapshot, not the range: month by month over a 30-day window is two bars,
 * so this is always the twelve months up to the current one.
 */
const CANCELLED = /cancel/i;
const MONTH_LONG = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function reservationsByMonth(deals, now = new Date(), leads = [], spendDays = [], channels = ['meta', 'google']) {
  const wanted = new Set(channels);
  const keys = [];
  for (let i = 11; i >= 0; i -= 1) {
    keys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  const rows = new Map(keys.map((k) => [k, { value: 0, n: 0, deals: [], spend: 0 }]));
  for (const d of deals) {
    if (d.outcome !== 'won' || !wanted.has(channelKey(d.channel)) || CANCELLED.test(String(d.bookingStatus || ''))) continue;
    const row = rows.get(String(d.closedAt || '').slice(0, 7));
    if (!row) continue;
    row.value += d.revenue || 0;
    row.n += 1;
    row.deals.push(d);
  }
  /* Meta + Google spend in the same months, so a bar of bookings stands next
     to what was paid for it. */
  for (const day of spendDays) {
    if (!wanted.has(channelKey(day.platform))) continue;
    const row = rows.get(String(day.date || '').slice(0, 7));
    if (row) row.spend += day.spend || 0;
  }
  const list = keys.map((key) => ({ key, ...rows.get(key) }));
  const total = list.reduce((s, r) => s + r.value, 0);
  const spent = list.reduce((s, r) => s + r.spend, 0);
  if (!total && !spent) return { empty: true, reason: wanted.size ? 'No ad spend or ad-won reservations in the last twelve months.' : 'This chart is ad bookings against ad spend — pick All, Meta Ads or Google Ads.' };

  const nameOf = new Map(leads.map((l) => [String(l.id), l.name]));
  const top = Math.max(1, ...list.map((r) => Math.max(r.value, r.spend)));
  const slot = W / list.length;
  const barW = Math.min(18, slot * 0.32);
  const current = keys[keys.length - 1];
  const bars = list.map((r, i) => {
    const h = (r.value / top) * TALL;
    const hs = (r.spend / top) * TALL;
    const x = slot * i + slot / 2;
    const name = MONTH_LONG.format(new Date(`${r.key}-01T00:00:00Z`)) + (r.key === current ? ' (to date)' : '');
    return {
      x: x - barW - 1, w: barW, y: BASE - h, h, cx: x,
      sx: x + 1, sy: BASE - hs, sh: hs,
      label: bucketLabel(r.key, 'month'),
      valueText: r.value ? money(r.value) : '',
      current: r.key === current,
      tip: `${name} · ${money(r.value)} · ${count(r.n)} reservations · ${money(r.spend)} ad spend`,
      /* The month's largest bookings, so a high bar answers its own question:
         one group booking reads as one row here, not as a mystery. */
      pop: pop(name, [
        ['Reservation value', money(r.value)], ['Reservations', count(r.n)],
        ['Average value', r.n ? money(r.value / r.n) : NONE],
        ['Ad spend', money(r.spend)],
        ['ROAS', r.spend ? `${(r.value / r.spend).toFixed(1)}x` : NONE],
        ...[...r.deals].sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 5)
          .map((d) => [`${nameOf.get(String(d.leadId)) || 'Lead ' + d.leadId} · ${SHORT.format(new Date(String(d.closedAt).slice(0, 10) + 'T00:00:00Z'))}`, money(d.revenue)]),
      ]),
    };
  });
  const best = list.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    empty: false,
    bars,
    total: money(total),
    channelText: channels.length === 1 ? (channels[0] === 'meta' ? 'Meta' : 'Google') : 'Meta + Google',
    spend: money(spent),
    roas: spent ? `${(total / spent).toFixed(1)}x` : NONE,
    won: count(list.reduce((n, r) => n + r.n, 0)),
    average: money(total / list.length),
    best: `${bucketLabel(best.key, 'month')} · ${money(best.value)}`,
  };
}

/* Meta, Google, both (no chip), or neither (the non-ad channel). */
function adChannelsFor(chip) {
  if (!chip) return ['meta', 'google'];
  const key = channelKey(chip);
  return key === 'meta' || key === 'google' ? [key] : [];
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

/* Computed once per snapshot, range and filter rather than per page view.
   `params.whole` is the cached entity snapshot — the same object until a sync
   rebuilds it — so a WeakMap on it drops every entry the moment the data
   changes. Three funnel walks over the range's leads were a visible share of
   each dashboard request's CPU. */
const memo = new WeakMap();
const FILTER_KEYS = ['property', 'channel', 'campaign', 'room'];
function cached(kind, entities, params, build) {
  const owner = params.whole;
  if (!owner || typeof owner !== 'object') return build();
  if (!memo.has(owner)) memo.set(owner, new Map());
  const store = memo.get(owner);
  const key = JSON.stringify([kind, params.over ? params.over.label || [params.over.from, params.over.to] : null,
    FILTER_KEYS.map((k) => params[k] ?? null)]);
  if (!store.has(key)) {
    if (store.size > 40) store.clear();
    store.set(key, build());
  }
  return store.get(key);
}

function executive(entities, params = {}) {
  return cached('exec', entities, params, () => buildExecutive(entities, params));
}

function marketing(entities, params = {}) {
  return cached('mkt', entities, params, () => buildMarketing(entities, params));
}

function buildExecutive(entities, params = {}) {
  const { input, grain, runs, keys } = prepare(entities, params);
  return {
    grain: GRAIN_TEXT[grain],
    leadsVsBookings: leadsVsBookings(runs, keys, grain),
    bookingsByChannel: bookingsByChannel(runs),
    leadStatus: leadStatus(runs),
    arrivals: arrivalHeatmap(input.leads),
  };
}

function buildMarketing(entities, params = {}) {
  const { input, grain, runs, keys } = prepare(entities, params);
  const campaignIds = new Map(input.campaignDays.filter((d) => d.campaignId).map((d) => [d.campaign, d.campaignId]));
  return {
    grain: GRAIN_TEXT[grain],
    cplTrend: cplTrend(runs, keys, grain),
    platformFunnel: platformFunnel(runs),
    roasByCampaign: roasByCampaign(runs, campaignIds),
    leadMix: leadMix(runs, keys, grain),
    /* The channel chip picks the platform; All (no chip) is both. The chart
       reads the whole snapshot, so it applies the chip itself. */
    reservationsByMonth: reservationsByMonth((params.whole || entities).deals || [], new Date(), (params.whole || entities).leads || [],
      (params.whole || entities).campaignDays || [], adChannelsFor(params.channel)),
  };
}

module.exports = { executive, marketing, grainFor, bucketRange, reservationsByMonth };
