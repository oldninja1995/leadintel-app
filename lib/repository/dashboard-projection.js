/* The Executive Dashboard, derived.
 *
 * Every card on this screen except the KPI tiles was authored: a reservation
 * funnel ending at "Checked in · 398", six named campaigns, three properties
 * with occupancy and ADR, four sales reps with cancellation rates, three AI
 * recommendations, four alerts and five lines of recent activity. All of it
 * invented, and none of it marked as such — the front page of the product was
 * the least trustworthy screen in it.
 *
 * This replaces the values and keeps the structure, which is the rule the whole
 * ingested driver follows: a projection returns the collections it can answer
 * and leaves the rest of the payload alone.
 *
 * **The discipline that matters here is declining.** Three of these cards ask
 * for things no connected system knows — occupancy and ADR need a PMS, a
 * cancellation rate per salesperson needs cancellations the CRM does not
 * record, creative fatigue needs the scoring engine's own window. Where a
 * figure cannot be derived it is `NONE`, never carried over from the fixture
 * underneath. The driver spreads this object over the authored payload, so a
 * field left undefined silently renders the invented value — which is how a
 * screen ends up half measured and half fiction with nothing marking the seam.
 */

const { INTERESTED, UNTOUCHED } = require('../metrics/registry');

const NONE = '—';
const PLATFORM = { meta_ads: 'Meta', google_ads: 'Google' };

/* Built once. `toLocaleDateString(locale, options)` constructs a fresh
   `Intl.DateTimeFormat` on every call — ~90µs against ~1.6µs to format through
   one already built — which is the same trap as `toLocaleString` with options
   and `localeCompare` with a locale. test/intl-formatters.test.js is the guard
   that stops it coming back a fourth time. */
const PEAK_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const sum = (rows, field) => rows.reduce((t, r) => t + (r[field] || 0), 0);
const isWon = (d) => d.outcome === 'won' && !/cancel/i.test(String(d.bookingStatus || ''));

function money(paise) {
  if (paise == null || Number.isNaN(paise)) return NONE;
  const n = paise / 100;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (n >= 1000) return `₹${Math.round(n).toLocaleString('en-IN')}`;
  return `₹${Math.round(n)}`;
}

const count = (n) => (n == null || Number.isNaN(n) ? NONE : n.toLocaleString('en-IN'));
const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(1)}%` : NONE);
const width = (num, den) => (den ? `${Math.max(2, Math.round((num / den) * 100))}%` : '0%');

/* ── the funnel ─────────────────────────────────────────────────────────────
 *
 * Five stages the CRM can actually answer, against the authored six. "Checked
 * in" is dropped to a declined row rather than filled with the booking count:
 * arriving is a PMS fact, and reusing the won count for it would draw a funnel
 * whose last two stages are the same number and claim every booked guest
 * turned up. */
function funnel(entities) {
  const leads = entities.leads || [];
  const deals = entities.deals || [];

  const total = leads.length;
  /* Worked, not replied to — the same rule `leads.responded` uses. A lead with
     no stage at all is not counted as contacted. */
  const contacted = leads.filter((l) => l.stage && !UNTOUCHED.test(String(l.stage))).length;
  const qualified = leads.filter((l) => INTERESTED.test(String(l.stage || ''))).length;
  const booked = deals.filter(isWon).length;

  const stage = (label, n, of) => ({
    label,
    n: n ? count(n) : NONE,
    pct: n && of ? pct(n, of) : NONE,
    w: n && of ? width(n, of) : '0%',
  });

  return [
    { label: 'Leads', n: total ? count(total) : NONE, pct: total ? '100%' : NONE, w: total ? '100%' : '0%' },
    stage('Contacted', contacted, total),
    stage('Qualified', qualified, total),
    stage('Booked', booked, total),
    /* Declined on purpose. Nothing connected knows who arrived. */
    { label: 'Checked in', n: NONE, pct: NONE, w: '0%' },
  ];
}

/* ── top campaigns ──────────────────────────────────────────────────────────
 *
 * Ranked by spend, because that is what the reader is deciding about. ROAS is
 * the CRM's reservation value for leads that campaign produced, over that
 * campaign's spend — both sides narrowed to the same campaign, unlike the
 * blended figure on the tiles above. */
function campaigns(entities) {
  const days = entities.campaignDays || [];
  if (!days.length) return [];

  const byCampaign = new Map();
  for (const day of days) {
    if (!day.campaign) continue;
    const row = byCampaign.get(day.campaign)
      || { name: day.label || day.campaign, platform: day.platform, spend: 0 };
    row.spend += day.spend || 0;
    /* A campaign that ran on one platform keeps its name; one that somehow
       appears under two is marked rather than silently attributed to whichever
       row was written last. */
    if (row.platform !== day.platform) row.platform = null;
    byCampaign.set(day.campaign, row);
  }

  const leadsBy = new Map();
  for (const lead of entities.leads || []) {
    if (!lead.campaign) continue;
    leadsBy.set(lead.campaign, (leadsBy.get(lead.campaign) || 0) + 1);
  }

  const wonBy = new Map();
  const valueBy = new Map();
  for (const deal of entities.deals || []) {
    if (!deal.campaign || !isWon(deal)) continue;
    wonBy.set(deal.campaign, (wonBy.get(deal.campaign) || 0) + 1);
    valueBy.set(deal.campaign, (valueBy.get(deal.campaign) || 0) + (deal.revenue || 0));
  }

  return [...byCampaign.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, 6)
    .map(([id, row]) => {
      const leads = leadsBy.get(id) || 0;
      const won = wonBy.get(id) || 0;
      const revenue = valueBy.get(id) || 0;
      /* No leads tagged to the campaign is not a CPL of infinity and not zero
         bookings — it is an attribution gap, and every derived column declines
         so the spend is not read as wasted. */
      const roasValue = row.spend && revenue ? revenue / row.spend : null;
      return {
        name: row.name,
        platform: row.platform ? (PLATFORM[row.platform] || row.platform) : NONE,
        spend: money(row.spend),
        leads: leads || NONE,
        cpl: leads ? money(row.spend / leads) : NONE,
        bookings: leads ? won : NONE,
        roas: roasValue === null ? NONE : `${roasValue.toFixed(1)}x`,
        roasColor: roasValue === null ? 'var(--color-neutral-500)'
          : (roasValue >= 1 ? 'var(--c-up)' : 'var(--c-down)'),
      };
    });
}

/* ── properties ─────────────────────────────────────────────────────────────
 *
 * Ranked by the reservation value of the leads that named them. Occupancy and
 * ADR are the PMS's and are declined in the meta line rather than estimated —
 * they are the two figures a GM would act on hardest and there is no honest
 * way to derive either from a CRM. */
function properties(entities) {
  const leads = entities.leads || [];
  const property = new Map(leads.map((l) => [l.id, l.property]));

  const rows = new Map();
  const bump = (name, key, by) => {
    if (!name) return;
    const row = rows.get(name) || { name, leads: 0, won: 0, revenue: 0 };
    row[key] += by;
    rows.set(name, row);
  };

  for (const lead of leads) bump(lead.property, 'leads', 1);
  for (const deal of entities.deals || []) {
    if (!isWon(deal)) continue;
    const name = property.get(deal.leadId);
    bump(name, 'won', 1);
    bump(name, 'revenue', deal.revenue || 0);
  }
  if (!rows.size) return [];

  return [...rows.values()]
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads)
    .slice(0, 3)
    .map((row, i) => ({
      rank: String(i + 1),
      name: row.name,
      /* Occupancy and ADR belong to a system nobody has connected. */
      meta: `${count(row.leads)} leads · ${row.won ? count(row.won) : NONE} reservations · occ ${NONE} · ADR ${NONE}`,
      rev: row.revenue ? money(row.revenue) : NONE,
    }));
}

/* ── sales leaderboard ──────────────────────────────────────────────────────
 *
 * The owner comes from the lead, since a deal has none. The cancellation rate
 * the authored card showed is declined: a cancelled reservation is recorded on
 * the booking, and attributing it to the person who sold it needs a link the
 * CRM does not expose. */
function reps(entities) {
  const owner = new Map((entities.leads || []).map((l) => [l.id, l.owner]));

  const rows = new Map();
  for (const deal of entities.deals || []) {
    if (!isWon(deal)) continue;
    const name = owner.get(deal.leadId);
    if (!name) continue;
    const row = rows.get(name) || { name, won: 0, revenue: 0 };
    row.won += 1;
    row.revenue += deal.revenue || 0;
    rows.set(name, row);
  }
  if (!rows.size) return [];

  const initials = (name) => String(name).split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '—';

  return [...rows.values()]
    .sort((a, b) => b.revenue - a.revenue || b.won - a.won)
    .slice(0, 4)
    .map((row) => ({
      init: initials(row.name),
      name: row.name,
      meta: `${count(row.won)} reservations · cancel ${NONE}`,
      rev: row.revenue ? money(row.revenue) : NONE,
    }));
}

/* ── recommendations ────────────────────────────────────────────────────────
 *
 * Rules over the same rows the cards above show, in the spirit of `verdict()`
 * on the marketing screen: a rule that can be checked, not a sentence that
 * sounds like analysis. Each one names the figure it fired on, so it can be
 * disagreed with.
 *
 * `impact` is only ever money already spent or already earned. An authored
 * "+₹2.8L/mo" is a forecast, and forecasting the result of a change nobody has
 * made is the one thing this screen must not do. */
function recs(entities) {
  const out = [];
  const rows = campaigns(entities).filter((c) => c.leads !== NONE);

  /* Spend reaching no tagged lead at all. The most actionable thing on the
     screen, and it is a *measurement* problem before it is a media one. */
  const untagged = campaigns(entities).filter((c) => c.leads === NONE);
  if (untagged.length) {
    out.push({
      icon: 'ph ph-warning',
      text: `${untagged.length} campaign(s) carry spend with no lead tagged to them — `
        + `${untagged.map((c) => c.name).slice(0, 2).join(', ')}. Their cost per lead and ROAS cannot be `
        + 'computed at all, so they are invisible to every decision on this page. Check the lead form\'s '
        + 'campaign field before judging their performance.',
      impact: `${untagged.map((c) => c.spend).slice(0, 1)} unattributed`,
      action: 'Check',
    });
  }

  /* The CPL spread, stated rather than acted on: the cheapest and dearest
     campaign by cost per lead, both named. */
  const byCpl = rows
    .map((c) => ({ name: c.name, cpl: c.cpl, raw: Number(String(c.cpl).replace(/[^\d.]/g, '')) }))
    .filter((c) => Number.isFinite(c.raw) && c.raw > 0)
    .sort((a, b) => a.raw - b.raw);
  if (byCpl.length >= 2) {
    const best = byCpl[0];
    const worst = byCpl[byCpl.length - 1];
    if (worst.raw >= best.raw * 1.5) {
      out.push({
        icon: 'ph ph-trend-up',
        text: `${worst.name} costs ${(worst.raw / best.raw).toFixed(1)}x more per lead than ${best.name} `
          + `(${worst.cpl} against ${best.cpl}). Worth reading beside their close rates before moving budget — `
          + 'a dearer lead that books is not a worse lead.',
        impact: `${worst.cpl} vs ${best.cpl}`,
        action: 'Review',
      });
    }
  }

  /* Leads nobody has touched. A count, and the share it represents. */
  const leads = entities.leads || [];
  const untouched = leads.filter((l) => !l.stage || UNTOUCHED.test(String(l.stage))).length;
  if (untouched && leads.length) {
    out.push({
      icon: 'ph ph-clock-countdown',
      text: `${count(untouched)} of ${count(leads.length)} leads (${pct(untouched, leads.length)}) are still `
        + 'at their first status with nobody recorded as having worked them.',
      impact: `${pct(untouched, leads.length)} untouched`,
      action: 'Assign',
    });
  }

  /* Never an empty card. Saying no rule fired is information; three fictional
     recommendations are not. */
  if (!out.length) {
    out.push({
      icon: 'ph ph-check-circle',
      text: 'No rule fired against the current window. These are checks over the campaigns, leads and '
        + 'reservations on this screen — not a model, and not an opinion about anything they cannot see.',
      impact: NONE,
      action: NONE,
    });
  }
  return out.slice(0, 3);
}

/* ── alerts ─────────────────────────────────────────────────────────────────
 *
 * Conditions that are true right now, each carrying the evidence. `when` is the
 * date the condition is measured over rather than an invented "2h ago" —
 * nothing here is an event with a timestamp, and dressing a standing condition
 * as a fresh one is how an alert panel stops being read. */
function alerts(entities, params = {}) {
  const out = [];
  const over = params.over || {};
  const when = over.from ? `since ${String(over.from).slice(0, 10)}` : 'all time';

  const days = entities.campaignDays || [];
  const spend = sum(days, 'spend');
  const leads = entities.leads || [];
  const deals = entities.deals || [];
  const won = deals.filter(isWon);

  if (spend && !leads.length) {
    out.push({
      dot: 'var(--c-down)',
      text: `${money(spend)} of ad spend and no leads recorded in this window at all`,
      when,
    });
  }

  const cancelled = deals.filter((d) => /cancel/i.test(String(d.bookingStatus || ''))).length;
  if (deals.length && cancelled) {
    out.push({
      dot: cancelled / deals.length > 0.05 ? 'var(--c-down)' : 'var(--c-warn)',
      text: `${count(cancelled)} of ${count(deals.length)} reservations cancelled (${pct(cancelled, deals.length)})`,
      when,
    });
  }

  /* Reservations with no value typed in. It silently drags every revenue and
     ROAS figure on the page downward, and nothing else on screen shows it. */
  const valueless = won.filter((d) => !d.revenue).length;
  if (valueless) {
    out.push({
      dot: 'var(--c-warn)',
      text: `${count(valueless)} of ${count(won.length)} won reservations have no value entered — `
        + 'every revenue and ROAS figure here is short by whatever they are worth',
      when,
    });
  }

  /* Untagged leads, which is what makes the blended figures misleading. */
  const untagged = leads.filter((l) => !l.channel).length;
  if (leads.length && untagged / leads.length > 0.5) {
    out.push({
      dot: 'var(--c-warn)',
      text: `${pct(untagged, leads.length)} of leads carry no channel, so per-channel figures cover `
        + `only ${count(leads.length - untagged)} of ${count(leads.length)}`,
      when,
    });
  }

  if (!out.length) {
    out.push({ dot: 'var(--color-neutral-400)', text: 'No alert condition is true in this window', when });
  }
  return out.slice(0, 4);
}

/* ── recent activity ────────────────────────────────────────────────────────
 *
 * The newest real things that happened: reservations won and leads arriving,
 * newest first, with their own timestamps. The authored version listed a sync
 * completing and a report being sent — both real events, both recorded outside
 * the entity snapshot, and neither reachable from here. They are dropped rather
 * than imitated. */
function activity(entities, params = {}) {
  const now = params.now ? Date.parse(params.now) : Date.now();
  const ago = (stamp) => {
    const t = Date.parse(stamp);
    if (!Number.isFinite(t)) return NONE;
    const mins = Math.round((now - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : `${days}d ago`;
  };

  const owner = new Map((entities.leads || []).map((l) => [l.id, l.owner]));
  const events = [];

  for (const deal of entities.deals || []) {
    if (!isWon(deal) || !deal.updatedAt) continue;
    const who = owner.get(deal.leadId);
    events.push({
      at: deal.updatedAt,
      icon: 'ph ph-user-plus',
      text: `${who ? `${who} converted` : 'A lead converted'}`
        + `${deal.campaign ? ` a ${deal.campaign} lead` : ''}`
        + `${deal.revenue ? ` — ${money(deal.revenue)}` : ' — no value entered'}`,
    });
  }

  for (const lead of entities.leads || []) {
    if (!lead.createdAt) continue;
    events.push({
      at: lead.createdAt,
      icon: 'ph ph-chat-circle-dots',
      text: `New lead${lead.channel ? ` from ${lead.channel === 'meta' ? 'Meta' : 'Google'}` : ''}`
        + `${lead.campaign ? ` · ${lead.campaign}` : ''}`
        + `${lead.property ? ` · ${lead.property}` : ''}`,
    });
  }

  if (!events.length) return [{ icon: 'ph ph-clock', text: 'Nothing recorded in this window', when: NONE }];

  return events
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 5)
    .map((e) => ({ icon: e.icon, text: e.text, when: ago(e.at) }));
}

/* ── revenue against ad spend, daily ────────────────────────────────────────
 *
 * The chart was fifteen hardcoded SVG coordinates and a tooltip reading
 * "Sat, Jul 26 · ₹3.4L rev · ₹41K spend". It is now the two series it claims
 * to be, drawn to the same 640x210 viewbox the design uses.
 *
 * **Both lines share one y-axis and that is a deliberate distortion**, because
 * they are the same unit and the comparison is the point: spend sitting far
 * under revenue is the shape a reader wants to see. A second axis would let
 * ₹40k of spend and ₹4L of revenue draw as the same height, which is the chart
 * lying politely.
 *
 * Revenue is dated by when the deal moved, which is the rule `period.FIELD`
 * already applies to deals — a lead from March that converted in August is
 * August's revenue. Spend is dated by the campaign day. So the two series
 * answer slightly different questions on the same axis, and the subtitle says
 * "CRM revenue" rather than pretending otherwise.
 */
function revenueVsSpend(entities) {
  const W = 640;
  const H = 210;

  const byDay = new Map();
  const put = (date, key, by) => {
    if (!date) return;
    const day = String(date).slice(0, 10);
    const row = byDay.get(day) || { day, revenue: 0, spend: 0 };
    row[key] += by;
    byDay.set(day, row);
  };

  for (const d of entities.campaignDays || []) put(d.date, 'spend', d.spend || 0);
  for (const deal of entities.deals || []) {
    if (isWon(deal)) put(deal.updatedAt, 'revenue', deal.revenue || 0);
  }

  const points = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  /* One point cannot be a line. Declined rather than drawn as a dot the eye
     reads as a trend. */
  if (points.length < 2) {
    return { empty: true, reason: points.length ? 'only one day in this window' : 'no revenue or spend in this window' };
  }

  const top = Math.max(...points.map((p) => Math.max(p.revenue, p.spend))) || 1;
  const x = (i) => (i / (points.length - 1)) * W;
  const y = (v) => H - (v / top) * (H - 24) - 8;

  const path = (key) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const revPath = path('revenue');

  const peakIndex = points.reduce((best, p, i) => (p.revenue > points[best].revenue ? i : best), 0);
  const peak = points[peakIndex];
  const label = (day) => PEAK_FORMAT.format(new Date(`${day}T00:00:00.000Z`));

  return {
    empty: false,
    revPath,
    spendPath: path('spend'),
    areaPath: `${revPath} L${W},${H} L0,${H} Z`,
    peak: {
      x: x(peakIndex).toFixed(1),
      y: y(peak.revenue).toFixed(1),
      /* Kept inside the viewbox at both ends — a tooltip anchored to a peak on
         day one would hang off the left edge. */
      boxX: Math.min(Math.max(x(peakIndex) - 75, 4), W - 154).toFixed(1),
      date: label(peak.day),
      text: `${money(peak.revenue)} rev · ${money(peak.spend)} spend`,
    },
    axis: [0, 0.25, 0.5, 0.75, 1]
      .map((f) => points[Math.min(points.length - 1, Math.round(f * (points.length - 1)))])
      .map((p) => label(p.day)),
    days: points.length,
  };
}

/* ── the three panels under the tiles ─────────────────────────────────────────
 *
 * All three were drawn into the template, and all three were on the screen this
 * app opens on.
 *
 *   Revenue by source   a donut whose four arc lengths were fixed
 *                       `stroke-dasharray` values, ₹52.3L in the middle and a
 *                       38/27/19/16 legend beside it
 *   Occupancy trend     twelve bars of fixed pixel heights, "78%", and a dashed
 *                       "target 82%" line
 *   AI forecast         ₹61.0L, "+16.6% projected", a confidence band of
 *                       ₹55.2L – ₹66.9L, and a rising hand-drawn curve
 *
 * One of the three is a question the rows can answer. The other two are not,
 * and a chart is the most persuasive thing on a page — a reader checks a number
 * and trusts a shape.
 */

/* Where reservation value came from, as the rows have it.
 *
 * Paid channels come from the CRM's own channel tag on the won deal; everything
 * won without one is its own slice rather than being folded into direct, which
 * would claim the untagged majority as a channel result. GA4's paid-search
 * revenue is deliberately **not** added: the AI screen's paragraph explains why
 * — a guest who enquired and also booked online is in both books, and nothing
 * can separate them without a PMS folio. This panel is the CRM's account of
 * itself, and says so. */
function revenueBySource(entities) {
  const won = (entities.deals || []).filter(isWon);
  const total = sum(won, 'revenue');
  if (!won.length || !total) return { total: NONE, slices: [], note: 'No won reservation value in range.' };

  const COLOURS = ['var(--color-accent-400)', 'var(--color-accent-600)', 'var(--color-accent-800)', 'var(--color-neutral-700)'];
  const LABEL = { meta: 'Meta Ads', google: 'Google Ads', direct: 'Direct / booking engine' };

  const by = new Map();
  for (const deal of won) {
    const channel = deal.channel || null;
    const key = channel || 'untagged';
    by.set(key, (by.get(key) || 0) + (deal.revenue || 0));
  }

  const ordered = [...by.entries()]
    .map(([key, value]) => ({
      key,
      label: key === 'untagged' ? 'No channel recorded' : (LABEL[key] || key),
      value,
      share: value / total,
    }))
    /* Untagged last however large, because it is an absence rather than a
       source, and first in a ranked list it reads as the biggest channel. */
    .sort((a, b) => (a.key === 'untagged' ? 1 : b.key === 'untagged' ? -1 : b.value - a.value));

  /* The donut is drawn from these: circumference at r=54 is 2πr. */
  const CIRCUMFERENCE = 2 * Math.PI * 54;
  let offset = 0;
  const slices = ordered.map((slice, i) => {
    const dash = slice.share * CIRCUMFERENCE;
    const row = {
      ...slice,
      colour: slice.key === 'untagged' ? 'var(--color-neutral-800)' : COLOURS[i % COLOURS.length],
      pct: `${(slice.share * 100).toFixed(0)}%`,
      valueText: money(slice.value),
      dash: `${dash.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`,
      offset: `${(-offset).toFixed(1)}`,
    };
    offset += dash;
    return row;
  });

  const untagged = ordered.find((s) => s.key === 'untagged');
  return {
    total: money(total),
    slices,
    note: untagged
      ? `CRM won reservation value. ${(untagged.share * 100).toFixed(0)}% carries no channel, so every paid share here is a floor.`
      : 'CRM won reservation value, by the channel recorded on the deal.',
  };
}

function dashboard(entities, params = {}, base = {}) {
  const out = {
    funnel: funnel(entities),
    recs: recs(entities),
    alerts: alerts(entities, params),
    activity: activity(entities, params),
    revSpend: revenueVsSpend(entities),
  };

  /* Only replace a collection when there is something to replace it WITH.
     Returning an empty array would blank the card; leaving the key off keeps
     the authored rows, which is worse. So each of these three declines to a
     single explicit row instead. */
  const rows = campaigns(entities);
  out.campaigns = rows.length ? rows : [];
  const props = properties(entities);
  out.properties = props.length ? props : [];
  const people = reps(entities);
  out.reps = people.length ? people : [];

  /* Exactly one tile on this screen names no registry metric, and so nothing
   * ever filled it: MER, which sat there reading **4.8x, +0.5x** — the figure
   * it was authored with, drawn identically to the twenty-four measured tiles
   * around it.
   *
   * The MER column on the Marketing screen has always declined, and the note
   * beside it (projections.js, `mer: NONE`) gives the reason: MER is revenue
   * over *total marketing cost*, which no connected system reports. The tile
   * and the column were answering the same question, one honestly.
   *
   * Blanked by the absence of a metric binding rather than by matching the
   * label, so a second unbindable tile is caught the day it is added instead of
   * quietly showing whatever it was authored with. */
  out.revenueBySource = revenueBySource(entities);

  const unbound = (base.miniKpis || []).filter((card) => !card.metric);
  if (unbound.length) {
    out.miniKpis = (base.miniKpis || []).map((card) => (card.metric ? card : {
      ...card,
      value: NONE,
      delta: 'no definition to measure it by',
      deltaColor: 'var(--color-neutral-500)',
    }));
  }

  return out;
}

module.exports = {
  dashboard, funnel, campaigns, properties, reps, recs, alerts, activity, revenueVsSpend, revenueBySource, NONE,
};
