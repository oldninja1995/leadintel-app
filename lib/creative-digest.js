/* Creative Intelligence — a plain-language summary of the creatives that ran in
 * the selected period, for the top of the screen.
 *
 * Built only from the rows the screen already shows, so it cannot disagree with
 * the cards below it. A sentence whose figures are missing is left out rather
 * than printed as zero: per-creative reservations are 0–2 a month on this
 * account, and a "₹0 revenue" line would read as a judgement it is not.
 */

const sum = (rows, f) => rows.reduce((t, r) => t + (Number.isFinite(f(r)) ? f(r) : 0), 0);
const known = (rows, f) => rows.some((r) => f(r) !== null && f(r) !== undefined);

/**
 * Meta creatives.
 * @param {object[]} items  { name, spend (paise), impressions, clicks, leads, interested, bookings, revenue (paise), action, fatiguing }
 * @param {object} fmt  { money, count, pct, x }
 * @returns {{ headline: string, points: { tone: 'good'|'bad'|'info', text: string }[] }}
 */
function metaDigest(items, fmt) {
  const rows = items.filter((r) => (r.spend || 0) > 0 || (r.impressions || 0) > 0);
  const points = [];
  if (!rows.length) return { headline: 'No Meta creative delivered in this period.', points };

  const spend = sum(rows, (r) => r.spend);
  const impressions = sum(rows, (r) => r.impressions);
  const clicks = sum(rows, (r) => r.clicks);
  const leads = sum(rows, (r) => r.leads);
  const hasInterest = known(rows, (r) => r.interested);
  const interested = sum(rows, (r) => r.interested);
  const hasBookings = known(rows, (r) => r.bookings);
  const bookings = sum(rows, (r) => r.bookings);
  const revenue = sum(rows, (r) => r.revenue);

  const parts = [`${rows.length} creative${rows.length === 1 ? '' : 's'} spent ${fmt.money(spend)}`];
  if (impressions) parts.push(`${fmt.count(impressions)} impressions (${fmt.pct(clicks / impressions)} CTR)`);
  if (leads) parts.push(`${fmt.count(leads)} leads at ${fmt.money(spend / leads)}`);
  if (hasInterest && interested) parts.push(`${fmt.count(interested)} interested at ${fmt.money(spend / interested)} each`);
  if (hasBookings && bookings) parts.push(`${fmt.count(bookings)} reservation${bookings === 1 ? '' : 's'} worth ${fmt.money(revenue)} (ROAS ${fmt.x(revenue / spend)})`);
  const headline = parts.join(' → ');

  /* Cost per interested lead is the earliest honest signal here; ask for five leads before naming a winner. */
  const cpil = rows.filter((r) => r.leads >= 5 && r.interested > 0).map((r) => ({ r, v: r.spend / r.interested })).sort((a, b) => a.v - b.v);
  if (cpil.length >= 2) points.push({ tone: 'good', text: `Cheapest interested leads: “${cpil[0].r.name}” at ${fmt.money(cpil[0].v)} each (${fmt.count(cpil[0].r.interested)} of ${fmt.count(cpil[0].r.leads)} leads interested).` });

  const roas = rows.filter((r) => r.bookings > 0 && r.spend > 0).map((r) => ({ r, v: r.revenue / r.spend })).sort((a, b) => b.v - a.v);
  if (roas.length) points.push({ tone: 'good', text: `Best return: “${roas[0].r.name}” — ${fmt.count(roas[0].r.bookings)} reservation${roas[0].r.bookings === 1 ? '' : 's'}, ${fmt.money(roas[0].r.revenue)} from ${fmt.money(roas[0].r.spend)} (ROAS ${fmt.x(roas[0].v)}).` });

  /* Money that has not produced a single interested lead, biggest first. */
  if (hasInterest) {
    const idle = rows.filter((r) => r.interested === 0 && r.spend > 0).sort((a, b) => b.spend - a.spend);
    const idleSpend = sum(idle, (r) => r.spend);
    if (idle.length && idleSpend >= spend * 0.05) {
      points.push({ tone: 'bad', text: `${fmt.money(idleSpend)} (${fmt.pct(idleSpend / spend)} of spend) went to ${idle.length} creative${idle.length === 1 ? '' : 's'} with no interested lead yet — the largest is “${idle[0].name}” at ${fmt.money(idle[0].spend)}.` });
    }
  }

  /* The recommendations on the cards, counted. */
  const tally = {};
  for (const r of rows) if (r.action) tally[r.action] = (tally[r.action] || 0) + 1;
  const said = [['scale', 'to scale'], ['continue', 'to keep running'], ['reduce', 'to reduce'], ['pause', 'to pause']].filter(([a]) => tally[a]).map(([a, l]) => `${tally[a]} ${l}`);
  if (said.length) points.push({ tone: 'info', text: `Recommendations: ${said.join(', ')}.` });

  const tired = rows.filter((r) => r.fatiguing).length;
  if (tired) points.push({ tone: 'bad', text: `${tired} creative${tired === 1 ? ' is' : 's are'} declining or fatiguing week on week — plan replacements.` });

  if (tally.insufficient) points.push({ tone: 'info', text: `${tally.insufficient} of ${rows.length} creatives have too little data to judge yet; reservation counts per creative are small, so read their verdicts as early.` });

  return { headline, points };
}

/**
 * Google creatives (video, display, demand gen — not search).
 * @param {object[]} items  { name, spend (paise), impressions, clicks, conversions, thin }
 */
function googleDigest(items, fmt) {
  const rows = items.filter((r) => (r.spend || 0) > 0 || (r.impressions || 0) > 0);
  const points = [];
  if (!rows.length) return { headline: 'No Google creative delivered in this period.', points };
  const spend = sum(rows, (r) => r.spend);
  const impressions = sum(rows, (r) => r.impressions);
  const clicks = sum(rows, (r) => r.clicks);
  const conversions = sum(rows, (r) => r.conversions);
  const parts = [`${rows.length} creative${rows.length === 1 ? '' : 's'} spent ${fmt.money(spend)}`];
  if (impressions) parts.push(`${fmt.count(impressions)} impressions (${fmt.pct(clicks / impressions)} CTR)`);
  if (conversions) parts.push(`${fmt.count(conversions)} Google conversions at ${fmt.money(spend / conversions)}`);
  const headline = parts.join(' → ');

  const solid = rows.filter((r) => !r.thin && r.conversions > 0).map((r) => ({ r, v: r.spend / r.conversions })).sort((a, b) => a.v - b.v);
  if (solid.length >= 2) points.push({ tone: 'good', text: `Cheapest conversions: “${solid[0].r.name}” at ${fmt.money(solid[0].v)} each.` });
  const idle = rows.filter((r) => !r.conversions && r.spend > 0).sort((a, b) => b.spend - a.spend);
  const idleSpend = sum(idle, (r) => r.spend);
  if (idle.length && idleSpend >= spend * 0.05) points.push({ tone: 'bad', text: `${fmt.money(idleSpend)} went to ${idle.length} creative${idle.length === 1 ? '' : 's'} with no Google conversion — the largest is “${idle[0].name}” at ${fmt.money(idle[0].spend)}.` });
  const thin = rows.filter((r) => r.thin).length;
  if (thin) points.push({ tone: 'info', text: `${thin} of ${rows.length} have under 1,000 impressions — too few to judge.` });
  points.push({ tone: 'info', text: 'Google’s conversion count sums every action the account defines (an enquiry and a phone click alike), so it is not a lead or booking count.' });
  return { headline, points };
}

module.exports = { metaDigest, googleDigest };
