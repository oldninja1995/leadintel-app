/* The extra infographics on the Marketing dashboard: repeat customers first,
 * then spend, value, ads, owners, speed and weekdays.
 *
 * Same rules as lib/dashboard-charts.js, which calls this: leads count on the
 * day they arrived, bookings on the day they were won, cancellations are out,
 * money is in paise, and a booking is a repeat customer's by `repeatRule`
 * (the CRM's Re-enquiry mark, the same phone enquiring before, or a second
 * won booking on one lead) — the rule the reservations-by-month bars and the
 * Repeat-customer value card already use, so the three never disagree.
 *
 * The topbar Channel chip narrows every chart here; with no chip they cover
 * every channel, organic included, because a returning guest is a returning
 * guest whichever door they came back through.
 */

const { channelKey } = require('./filters');
const { bucketOf } = require('./funnel-analytics');

const NONE = '—';
const DAY = 86400000;
const IST_MS = 330 * 60000;
const W = 640;
const BASE = 180;
const TALL = 150;
const SHORT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

const COLOUR = { meta: 'var(--color-accent-500)', google: 'var(--c-google)', organic: 'var(--color-neutral-600)' };
const LABEL = { meta: 'Meta Ads', google: 'Google Ads', organic: 'Organic / untagged' };
const FIRST = 'var(--color-accent-600)';
const REPEAT = 'var(--color-accent-300)';
const CANCELLED = /cancel/i;

function money(paise) {
  if (paise == null || Number.isNaN(paise)) return NONE;
  const n = paise / 100;
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
const count = (n) => (n == null ? NONE : Math.round(n).toLocaleString('en-IN'));
const pct = (r) => (r == null || !Number.isFinite(r) ? NONE : `${(r * 100).toFixed(r < 0.1 && r > 0 ? 1 : 0)}%`);
const dateText = (s) => (s ? LONG.format(new Date(`${String(s).slice(0, 10)}T00:00:00Z`)) : NONE);
const pop = (title, rows, go = null, goText = null) => ({ title, rows: rows.filter((r) => r && r[1] != null), go, goText });
const width = (v, top, min = 1.5) => `${(top > 0 && v > 0 ? Math.max(min, (v / top) * 100) : 0).toFixed(1)}%`;
const chKey = (v) => {
  const k = channelKey(v);
  return k === 'meta' || k === 'google' ? k : 'organic';
};

function bucketLabel(key, grain) {
  if (grain === 'month') return MONTH.format(new Date(`${key}-01T00:00:00Z`));
  const d = SHORT.format(new Date(`${key}T00:00:00Z`));
  return grain === 'week' ? `w/c ${d}` : d;
}
function axisLabels(keys, grain, xOf) {
  const every = Math.max(1, Math.ceil(keys.length / 7));
  return keys.map((k, i) => ({ k, i })).filter(({ i }) => i % every === 0).map(({ k, i }) => ({ x: xOf(i), text: bucketLabel(k, grain) }));
}
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const daysText = (d) => (d == null ? NONE : d < 1 ? 'same day' : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`);

/* Won and standing, each reservation once (the larger value where two deals
   point at one booking reference), as funnel-analytics counts them. */
function wonOnce(deals) {
  const byKey = new Map();
  for (const d of deals || []) {
    if (d.outcome !== 'won' || CANCELLED.test(String(d.bookingStatus || '')) || !d.closedAt) continue;
    const key = d.bookingRef ? `ref:${d.bookingRef}` : `deal:${d.id}`;
    const seen = byKey.get(key);
    if (!seen || (d.revenue || 0) > (seen.revenue || 0)) byKey.set(key, d);
  }
  return [...byKey.values()];
}

/* Why a booking counts as a repeat customer's — the first reason that holds. */
function repeatReason(d) {
  if (d.reEnquiry === true) return 'CRM Re-enquiry mark';
  if (d.repeat === true) return 'Same phone enquired before';
  return 'Second booking on one lead';
}

const ownerName = (o) => {
  const s = String(o || '').trim();
  if (!s) return 'Unassigned';
  const local = s.includes('@') ? s.split('@')[0] : s;
  return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

/* ── repeat customers ───────────────────────────────────────────────────── */

function repeatSplit(won, isRepeat) {
  if (!won.length) return { empty: true, reason: 'No won bookings in this range.' };
  const t = { fn: 0, fv: 0, rn: 0, rv: 0 };
  const reasons = new Map();
  for (const d of won) {
    if (isRepeat(d)) {
      t.rn += 1; t.rv += d.revenue || 0;
      const r = repeatReason(d);
      reasons.set(r, (reasons.get(r) || 0) + 1);
    } else { t.fn += 1; t.fv += d.revenue || 0; }
  }
  const n = t.fn + t.rn;
  const C = 2 * Math.PI * 54;
  const slices = [
    { label: 'First-time', colour: FIRST, n: t.fn, v: t.fv },
    { label: 'Repeat', colour: REPEAT, n: t.rn, v: t.rv },
  ];
  let offset = 0;
  const out = slices.map((s) => {
    const dash = (s.n / n) * C;
    const row = {
      ...s, nText: count(s.n), vText: money(s.v), share: pct(s.n / n), avg: s.n ? money(s.v / s.n) : NONE,
      dash: `${dash.toFixed(1)} ${C.toFixed(1)}`, offset: (-offset).toFixed(1),
      pop: pop(`${s.label} customers`, [['Bookings', count(s.n)], ['Share of bookings', pct(s.n / n)], ['Booking value', money(s.v)],
        ['Share of value', t.fv + t.rv ? pct(s.v / (t.fv + t.rv)) : NONE], ['Average booking', s.n ? money(s.v / s.n) : NONE]]),
    };
    offset += dash;
    return row;
  });
  const avgF = t.fn ? t.fv / t.fn : null;
  const avgR = t.rn ? t.rv / t.rn : null;
  const top = Math.max(avgF || 0, avgR || 0);
  return {
    empty: false,
    total: count(n),
    repeatShare: pct(t.rn / n),
    valueShare: t.fv + t.rv ? pct(t.rv / (t.fv + t.rv)) : NONE,
    slices: out,
    avg: [
      { label: 'First-time', colour: FIRST, text: money(avgF), w: width(avgF || 0, top) },
      { label: 'Repeat', colour: REPEAT, text: money(avgR), w: width(avgR || 0, top) },
    ],
    lift: avgF && avgR ? `${avgR >= avgF ? '+' : '−'}${pct(Math.abs(avgR / avgF - 1))}` : null,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([label, k]) => ({ label, n: count(k), share: pct(k / t.rn) })),
  };
}

function repeatTrend(won, isRepeat, keys, grain) {
  if (!won.length || !keys.length) return { empty: true, reason: 'No won bookings in this range.' };
  const rows = new Map(keys.map((k) => [k, { fn: 0, rn: 0, fv: 0, rv: 0 }]));
  for (const d of won) {
    const r = rows.get(bucketOf(d.closedAt, grain));
    if (!r) continue;
    if (isRepeat(d)) { r.rn += 1; r.rv += d.revenue || 0; } else { r.fn += 1; r.fv += d.revenue || 0; }
  }
  const list = keys.map((key) => ({ key, ...rows.get(key) }));
  const top = Math.max(1, ...list.map((r) => r.fn + r.rn));
  const slot = W / list.length;
  const barW = Math.max(3, Math.min(24, slot * 0.6));
  const xOf = (i) => slot * i + slot / 2;
  return {
    empty: false,
    topText: count(top),
    bars: list.map((r, i) => {
      const hf = (r.fn / top) * TALL;
      const hr = (r.rn / top) * TALL;
      const total = r.fn + r.rn;
      return {
        x: xOf(i) - barW / 2, w: barW, fy: BASE - hf, fh: hf, ry: BASE - hf - hr, rh: hr,
        tip: `${bucketLabel(r.key, grain)} · ${count(r.fn)} first-time · ${count(r.rn)} repeat`,
        pop: pop(bucketLabel(r.key, grain), [
          ['First-time bookings', `${count(r.fn)} · ${money(r.fv)}`], ['Repeat bookings', `${count(r.rn)} · ${money(r.rv)}`],
          ['Repeat share', total ? pct(r.rn / total) : NONE],
        ]),
      };
    }),
    axis: axisLabels(keys, grain, xOf),
  };
}

function repeatByChannel(won, isRepeat) {
  const by = new Map(['meta', 'google', 'organic'].map((c) => [c, { n: 0, rn: 0, v: 0, rv: 0 }]));
  for (const d of won) {
    const r = by.get(chKey(d.channel));
    r.n += 1; r.v += d.revenue || 0;
    if (isRepeat(d)) { r.rn += 1; r.rv += d.revenue || 0; }
  }
  const rows = [...by.entries()].filter(([, r]) => r.n > 0);
  if (!rows.length) return { empty: true, reason: 'No won bookings in this range.' };
  const top = Math.max(...rows.map(([, r]) => r.rn / r.n));
  return {
    empty: false,
    rows: rows.map(([c, r]) => ({
      label: LABEL[c], colour: COLOUR[c], value: pct(r.rn / r.n), sub: `${count(r.rn)} of ${count(r.n)} bookings · ${money(r.rv)}`,
      w: width(r.rn / r.n, top),
      pop: pop(`${LABEL[c]} · repeat customers`, [['Repeat bookings', count(r.rn)], ['All bookings', count(r.n)],
        ['Repeat share', pct(r.rn / r.n)], ['Repeat value', money(r.rv)], ['Share of channel value', r.v ? pct(r.rv / r.v) : NONE]]),
    })),
  };
}

function returningLeads(leads, keys, grain) {
  if (!leads.length || !keys.length) return { empty: true, reason: 'No leads arrived in this range.' };
  const rows = new Map(keys.map((k) => [k, { n: 0, r: 0 }]));
  let total = 0; let back = 0;
  for (const l of leads) {
    const ret = l.repeat === true || l.reEnquiry === true;
    total += 1; if (ret) back += 1;
    const row = rows.get(bucketOf(l.createdAt, grain));
    if (row) { row.n += 1; if (ret) row.r += 1; }
  }
  const list = keys.map((key) => ({ key, ...rows.get(key) }));
  const top = Math.max(1, ...list.map((r) => r.n));
  const slot = W / list.length;
  const barW = Math.max(3, Math.min(24, slot * 0.6));
  const xOf = (i) => slot * i + slot / 2;
  return {
    empty: false,
    total: count(total), returning: count(back), rate: pct(back / total), topText: count(top),
    bars: list.map((r, i) => {
      const hn = ((r.n - r.r) / top) * TALL;
      const hr = (r.r / top) * TALL;
      return {
        x: xOf(i) - barW / 2, w: barW, fy: BASE - hn, fh: hn, ry: BASE - hn - hr, rh: hr,
        tip: `${bucketLabel(r.key, grain)} · ${count(r.n - r.r)} new · ${count(r.r)} returning`,
        pop: pop(bucketLabel(r.key, grain), [['New enquirers', count(r.n - r.r)], ['Returning enquirers', count(r.r)],
          ['Returning share', r.n ? pct(r.r / r.n) : NONE]]),
      };
    }),
    axis: axisLabels(keys, grain, xOf),
  };
}

/* Lifetime, from the whole snapshot: people with two or more won bookings. A
   person is the CRM phone/email key withCustomers stamps on every lead. */
function people(allWon, leadById) {
  const by = new Map();
  for (const d of allWon) {
    const lead = leadById.get(String(d.leadId));
    const person = lead && lead.customer ? String(lead.customer).replace(/#\d+$/, '') : `lead:${d.leadId}`;
    if (!by.has(person)) by.set(person, { name: (lead && lead.name) || `Lead ${d.leadId}`, bookings: [] });
    by.get(person).bookings.push(d);
  }
  for (const p of by.values()) p.bookings.sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  return [...by.values()];
}

function topRepeatCustomers(persons) {
  const repeaters = persons.filter((p) => p.bookings.length >= 2);
  if (!repeaters.length) return { empty: true, reason: 'No customer has two won bookings in the stored CRM history yet.' };
  const val = (p) => p.bookings.reduce((s, d) => s + (d.revenue || 0), 0);
  repeaters.sort((a, b) => b.bookings.length - a.bookings.length || val(b) - val(a));
  const shown = repeaters.slice(0, 8);
  const top = Math.max(...shown.map(val), 1);
  const totalValue = repeaters.reduce((s, p) => s + val(p), 0);
  const everyone = persons.reduce((s, p) => s + val(p), 0);
  return {
    empty: false,
    customers: count(repeaters.length),
    rate: pct(repeaters.length / persons.length),
    value: money(totalValue),
    valueShare: everyone ? pct(totalValue / everyone) : NONE,
    rows: shown.map((p) => ({
      label: p.name, value: money(val(p)), badge: `${p.bookings.length}×`,
      sub: `last ${dateText(p.bookings[p.bookings.length - 1].closedAt)}`,
      w: width(val(p), top),
      pop: pop(p.name, [
        ['Won bookings', count(p.bookings.length)], ['Lifetime value', money(val(p))], ['Average booking', money(val(p) / p.bookings.length)],
        ...p.bookings.slice(-8).reverse().map((d) => [`${dateText(d.closedAt)} · ${LABEL[chKey(d.channel)]}`, money(d.revenue || 0)]),
      ], `/leads?${new URLSearchParams({ q: p.name })}`, 'Find in Lead Intelligence'),
    })),
  };
}

const GAP_BANDS = [[7, 'Under a week'], [30, '1–4 weeks'], [90, '1–3 months'], [180, '3–6 months'], [365, '6–12 months'], [Infinity, 'Over a year']];
function rebookGap(persons) {
  const gaps = [];
  for (const p of persons) {
    for (let i = 1; i < p.bookings.length; i += 1) {
      const g = (Date.parse(p.bookings[i].closedAt) - Date.parse(p.bookings[i - 1].closedAt)) / DAY;
      if (Number.isFinite(g) && g >= 0) gaps.push(g);
    }
  }
  if (!gaps.length) return { empty: true, reason: 'No customer has booked twice yet, so there is no gap to measure.' };
  const counts = GAP_BANDS.map(([max, label], i) => ({
    label, n: gaps.filter((g) => g < max && g >= (i ? GAP_BANDS[i - 1][0] : 0)).length,
  }));
  const top = Math.max(...counts.map((c) => c.n));
  return {
    empty: false,
    n: count(gaps.length),
    median: daysText(median(gaps)),
    rows: counts.map((c) => ({
      label: c.label, value: count(c.n), sub: pct(c.n / gaps.length), w: width(c.n, top), colour: REPEAT,
      pop: pop(`Came back ${c.label.toLowerCase()}`, [['Return bookings', count(c.n)], ['Share of returns', pct(c.n / gaps.length)]]),
    })),
  };
}

/* ── marketing ──────────────────────────────────────────────────────────── */

function paidPeriods(runs, keys, channels) {
  return keys.map((key) => {
    const r = { key, spend: 0, revenue: 0, bookings: 0 };
    for (const c of channels) {
      const p = runs[c].periods.find((x) => x.key === key);
      if (p) { r.spend += p.spend || 0; r.revenue += p.revenue || 0; r.bookings += p.bookings || 0; }
    }
    return r;
  });
}

function spendVsRevenue(runs, keys, grain, channels) {
  if (!channels.length) return { empty: true, reason: 'Ad spend against ad revenue — pick All, Meta Ads or Google Ads.' };
  const rows = paidPeriods(runs, keys, channels);
  if (!rows.some((r) => r.spend || r.revenue)) return { empty: true, reason: 'No ad spend or ad-won bookings in this range.' };
  const sTop = Math.max(1, ...rows.map((r) => r.spend));
  const rTop = Math.max(1, ...rows.map((r) => r.revenue));
  const slot = W / rows.length;
  const barW = Math.max(3, Math.min(22, slot * 0.6));
  const xOf = (i) => slot * i + slot / 2;
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const revenue = rows.reduce((s, r) => s + r.revenue, 0);
  return {
    empty: false,
    spend: money(spend), revenue: money(revenue), roas: spend ? `${(revenue / spend).toFixed(1)}x` : NONE,
    sTop: money(sTop), rTop: money(rTop),
    bars: rows.map((r, i) => {
      const h = (r.spend / sTop) * TALL;
      return {
        x: xOf(i) - barW / 2, w: barW, y: BASE - h, h,
        tip: `${bucketLabel(r.key, grain)} · ${money(r.spend)} spend · ${money(r.revenue)} booked`,
        pop: pop(bucketLabel(r.key, grain), [['Ad spend', money(r.spend)], ['Booking value', money(r.revenue)], ['Bookings', count(r.bookings)],
          ['ROAS', r.spend ? `${(r.revenue / r.spend).toFixed(1)}x` : NONE]]),
      };
    }),
    line: rows.map((r, i) => `${xOf(i).toFixed(1)},${(BASE - (r.revenue / rTop) * TALL).toFixed(1)}`).join(' '),
    dots: rows.map((r, i) => ({ cx: xOf(i), cy: BASE - (r.revenue / rTop) * TALL, show: r.revenue > 0 })),
    axis: axisLabels(keys, grain, xOf),
  };
}

function pacing(runs, keys, grain, channels) {
  if (!channels.length) return { empty: true, reason: 'Ad spend against ad revenue — pick All, Meta Ads or Google Ads.' };
  const rows = paidPeriods(runs, keys, channels);
  let s = 0; let v = 0;
  const cum = rows.map((r) => { s += r.spend; v += r.revenue; return { key: r.key, s, v }; });
  if (!s && !v) return { empty: true, reason: 'No ad spend or ad-won bookings in this range.' };
  const top = Math.max(1, s, v);
  const slot = W / rows.length;
  const xOf = (i) => slot * i + slot / 2;
  const yOf = (n) => BASE - (n / top) * TALL;
  const path = (f) => cum.map((r, i) => `${xOf(i).toFixed(1)},${yOf(f(r)).toFixed(1)}`).join(' ');
  return {
    empty: false,
    revenue: money(v), spend: money(s), roas: s ? `${(v / s).toFixed(1)}x` : NONE, topText: money(top),
    revenueLine: path((r) => r.v),
    revenueArea: `${xOf(0).toFixed(1)},${BASE} ${path((r) => r.v)} ${xOf(cum.length - 1).toFixed(1)},${BASE}`,
    spendLine: path((r) => r.s),
    marks: cum.map((r, i) => ({
      x: xOf(i) - slot / 2, w: slot,
      tip: `To ${bucketLabel(r.key, grain)} · ${money(r.v)} booked · ${money(r.s)} spent`,
      pop: pop(`Running total to ${bucketLabel(r.key, grain)}`, [['Booking value so far', money(r.v)], ['Ad spend so far', money(r.s)],
        ['ROAS so far', r.s ? `${(r.v / r.s).toFixed(1)}x` : NONE]]),
    })),
    axis: axisLabels(keys, grain, xOf),
  };
}

const VALUE_BANDS = [[1, 'No value entered'], [1000000, 'Under ₹10k'], [2500000, '₹10k–25k'], [5000000, '₹25k–50k'], [10000000, '₹50k–1L'], [20000000, '₹1L–2L'], [Infinity, '₹2L and over']];
function valueBands(won) {
  if (!won.length) return { empty: true, reason: 'No won bookings in this range.' };
  const rows = VALUE_BANDS.map(([max, label], i) => {
    const min = i ? VALUE_BANDS[i - 1][0] : -Infinity;
    const hit = won.filter((d) => (d.revenue || 0) < max && (d.revenue || 0) >= min);
    return { label, n: hit.length, v: hit.reduce((s, d) => s + (d.revenue || 0), 0), blank: i === 0 };
  }).filter((r) => r.n > 0 || !r.blank);
  const top = Math.max(...rows.map((r) => r.n));
  const total = won.reduce((s, d) => s + (d.revenue || 0), 0);
  const valued = won.filter((d) => d.revenue > 0);
  return {
    empty: false,
    average: valued.length ? money(total / valued.length) : NONE,
    median: valued.length ? money(median(valued.map((d) => d.revenue))) : NONE,
    rows: rows.map((r) => ({
      label: r.label, value: count(r.n), sub: r.blank ? 'fill in TeleCRM' : money(r.v), w: width(r.n, top),
      colour: r.blank ? 'var(--c-warn)' : 'var(--color-accent-500)',
      pop: pop(r.label, [['Bookings', count(r.n)], ['Share of bookings', pct(r.n / won.length)], ['Value', money(r.v)],
        ['Share of value', total ? pct(r.v / total) : NONE]]),
    })),
  };
}

function topAds(won, leads, leadById) {
  const by = new Map();
  const row = (name) => {
    if (!by.has(name)) by.set(name, { name, leads: 0, n: 0, v: 0 });
    return by.get(name);
  };
  for (const l of leads) if (l.adName) row(String(l.adName)).leads += 1;
  for (const d of won) {
    const lead = leadById.get(String(d.leadId));
    if (!lead || !lead.adName) continue;
    const r = row(String(lead.adName));
    r.n += 1; r.v += d.revenue || 0;
  }
  const list = [...by.values()].filter((r) => r.n > 0).sort((a, b) => b.v - a.v || b.n - a.n);
  if (!list.length) return { empty: true, reason: 'No booking in this range came from a lead the CRM tied to an ad name.' };
  const shown = list.slice(0, 8);
  const top = Math.max(1, ...shown.map((r) => r.v));
  return {
    empty: false,
    ads: count(list.length),
    rows: shown.map((r) => ({
      label: r.name, value: money(r.v), sub: `${count(r.n)} booking${r.n === 1 ? '' : 's'} · ${count(r.leads)} leads in range`,
      w: width(r.v, top), colour: 'var(--color-accent-500)',
      pop: pop(r.name, [['Booking value', money(r.v)], ['Bookings', count(r.n)], ['Leads in range', count(r.leads)],
        ['Average booking', money(r.v / r.n)]], '/creatives', 'Open Creative Intelligence'),
    })),
  };
}

function owners(won, leads, leadById) {
  const by = new Map();
  const row = (o) => {
    const k = ownerName(o);
    if (!by.has(k)) by.set(k, { name: k, leads: 0, n: 0, v: 0 });
    return by.get(k);
  };
  for (const l of leads) row(l.owner).leads += 1;
  for (const d of won) {
    const lead = leadById.get(String(d.leadId));
    const r = row(lead && lead.owner);
    r.n += 1; r.v += d.revenue || 0;
  }
  const list = [...by.values()].filter((r) => r.n > 0 || r.leads > 0).sort((a, b) => b.v - a.v || b.n - a.n || b.leads - a.leads);
  if (!list.length) return { empty: true, reason: 'No leads or bookings in this range.' };
  const shown = list.slice(0, 8);
  const top = Math.max(1, ...shown.map((r) => r.v));
  return {
    empty: false,
    rows: shown.map((r) => ({
      label: r.name, value: money(r.v),
      sub: `${count(r.n)} booked · ${count(r.leads)} leads${r.leads ? ` · ${pct(r.n / r.leads)}` : ''}`,
      w: width(r.v, top), colour: 'var(--color-accent-400)',
      pop: pop(r.name, [['Booking value', money(r.v)], ['Bookings won', count(r.n)], ['Leads that arrived', count(r.leads)],
        ['Bookings per lead', r.leads ? pct(r.n / r.leads) : NONE], ['Average booking', r.n ? money(r.v / r.n) : NONE]],
      '/sales', 'Open Sales'),
    })),
  };
}

const SPEED_BANDS = [[1, 'Same day'], [4, '1–3 days'], [8, '4–7 days'], [15, '8–14 days'], [31, '15–30 days'], [91, '1–3 months'], [Infinity, 'Over 3 months']];
function leadToBooking(won, isRepeat, leadById) {
  const days = [];
  for (const d of won) {
    if (isRepeat(d)) continue;
    const lead = leadById.get(String(d.leadId));
    if (!lead || !lead.createdAt) continue;
    const g = (Date.parse(d.closedAt) - Date.parse(lead.createdAt)) / DAY;
    if (Number.isFinite(g)) days.push(Math.max(0, g));
  }
  if (!days.length) return { empty: true, reason: 'No first-time booking in this range has its lead in the CRM history.' };
  const rows = SPEED_BANDS.map(([max, label], i) => ({ label, n: days.filter((g) => g < max && g >= (i ? SPEED_BANDS[i - 1][0] : 0)).length }));
  const top = Math.max(...rows.map((r) => r.n));
  const week = days.filter((g) => g < 8).length;
  return {
    empty: false,
    n: count(days.length), median: daysText(median(days)), inWeek: pct(week / days.length),
    rows: rows.map((r) => ({
      label: r.label, value: count(r.n), sub: pct(r.n / days.length), w: width(r.n, top), colour: 'var(--color-accent-500)',
      pop: pop(`Booked ${r.label.toLowerCase()} after enquiring`, [['First-time bookings', count(r.n)], ['Share', pct(r.n / days.length)]]),
    })),
  };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const istDay = (s) => {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return (new Date(t + IST_MS).getUTCDay() + 6) % 7;
};
function weekdays(won, leads) {
  if (!won.length && !leads.length) return { empty: true, reason: 'No leads or bookings in this range.' };
  const rows = WEEKDAYS.map((day) => ({ day, leads: 0, n: 0, v: 0 }));
  for (const l of leads) { const d = istDay(l.createdAt); if (d != null) rows[d].leads += 1; }
  for (const b of won) { const d = istDay(b.closedAt); if (d != null) { rows[d].n += 1; rows[d].v += b.revenue || 0; } }
  const lTop = Math.max(1, ...rows.map((r) => r.leads));
  const bTop = Math.max(1, ...rows.map((r) => r.n));
  const slot = W / 7;
  const barW = Math.min(30, slot * 0.3);
  const best = rows.reduce((a, b) => (b.n > a.n ? b : a));
  const busy = rows.reduce((a, b) => (b.leads > a.leads ? b : a));
  return {
    empty: false,
    best: best.n ? best.day : NONE,
    busy: busy.leads ? busy.day : NONE,
    groups: rows.map((r, i) => {
      const cx = slot * i + slot / 2;
      const hl = (r.leads / lTop) * TALL;
      const hb = (r.n / bTop) * TALL;
      return {
        cx, lx: cx - barW - 1, bx: cx + 1, w: barW, ly: BASE - hl, lh: hl, by: BASE - hb, bh: hb, day: r.day,
        tip: `${r.day} · ${count(r.leads)} leads · ${count(r.n)} bookings · ${money(r.v)}`,
        pop: pop(r.day, [['Leads arrived', count(r.leads)], ['Bookings won', count(r.n)], ['Booking value', money(r.v)],
          ['Bookings per lead', r.leads ? pct(r.n / r.leads) : NONE]]),
      };
    }),
  };
}

/* ── entry ──────────────────────────────────────────────────────────────── */

function build({ input, grain, runs, keys, whole, params, repeatRule, adChannels }) {
  const chip = params.f_channel || params.channel;
  const wanted = chip ? chKey(chip) : null;
  const inChip = (x) => !wanted || chKey(x.channel) === wanted;

  const allWon = wonOnce(whole.deals || []);
  const isRepeat = repeatRule(whole.deals || []);
  const won = wonOnce(input.deals).filter(inChip);
  const leads = (input.leads || []).filter(inChip);
  const leadById = new Map((whole.leads || input.allLeads || []).map((l) => [String(l.id), l]));
  const persons = people(allWon.filter(inChip), leadById);

  return {
    repeatSplit: repeatSplit(won, isRepeat),
    repeatTrend: repeatTrend(won, isRepeat, keys, grain),
    repeatByChannel: repeatByChannel(won, isRepeat),
    returningLeads: returningLeads(leads, keys, grain),
    topRepeatCustomers: topRepeatCustomers(persons),
    rebookGap: rebookGap(persons),
    spendVsRevenue: spendVsRevenue(runs, keys, grain, adChannels),
    pacing: pacing(runs, keys, grain, adChannels),
    valueBands: valueBands(won),
    topAds: topAds(won, leads, leadById),
    owners: owners(won, leads, leadById),
    leadToBooking: leadToBooking(won, isRepeat, leadById),
    weekdays: weekdays(won, leads),
  };
}

module.exports = { build, wonOnce, repeatReason };
