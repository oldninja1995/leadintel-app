/* Marketing Dashboard. AUTHORED — see PHASES.md, Phase 1.
 * Platform totals reconcile to the dashboard's ₹10.9L spend and ₹52.3L revenue. */

const { UP, DOWN, WARN, NA, SRC, spark } = require('./_tokens');

module.exports = {
  mktHero: [
    { metric: 'ads.spend', label: 'Ad spend', value: '₹10.9L', delta: '+3.1%', deltaColor: NA, sub: '', tip: 'Total paid media in the period', icon: 'ph ph-megaphone', spark: spark([55, 58, 54, 60, 62, 59, 64, 63, 67, 66]), ...SRC.ads },
    /* Now derived. The old note was right at the time —  is every
       booking, paid or not, so pointing this card at it would have credited
       paid media with the whole direct and organic contribution. Leads carry a
       channel now and deals inherit it, so the question is answerable. */
    /* Both books, because paid media produces two kinds of booking here and
       the card was showing one. `revenue.attributed` — the CRM half alone —
       is still in the registry and is what the AI layer quotes when the
       question is specifically about tagged leads. */
    { metric: 'revenue.attributed_total', label: 'Attributed revenue', value: '₹32.5L', delta: '+18.2%', deltaColor: UP, sub: 'CRM-tagged leads + GA4 paid search', tip: 'Reservation value on leads the CRM tagged to a paid channel, plus what the booking engine took from paid-search sessions. Two books added, not reconciled — a website booking also entered into the CRM is counted twice.', icon: 'ph ph-currency-inr', spark: spark([40, 44, 47, 52, 51, 58, 62, 66, 71, 75]), ...SRC.blended },
    { metric: 'cost.per_lead', label: 'Blended CPL', value: '₹427', delta: '−18.0%', deltaColor: UP, sub: '', tip: 'Paid spend per lead — pick a channel above for that platform', icon: 'ph ph-user-focus', spark: spark([78, 74, 72, 68, 64, 61, 58, 54, 50, 47]), ...SRC.blended },
    /* Divided by the same spend as before, over a numerator that now holds
       both halves of the return. It read 1.3x while the platform table on the
       same screen credited Google 3.7x, because the table had folded GA4 in
       and this had not. */
    { metric: 'roas.attributed_total', label: 'ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP, sub: 'CRM-tagged + GA4 paid search ÷ ad spend', tip: 'Paid-tagged CRM reservation value plus GA4 paid-search revenue, over ad spend. Cancellations excluded; nothing else netted off. Still a floor — an untagged lead is outside the numerator while its spend stays in the denominator.', icon: 'ph ph-chart-line-up', spark: spark([48, 46, 52, 55, 54, 61, 63, 68, 73, 78]), ...SRC.blended },
  ],

  mktKpis: [
    { metric: 'ads.impressions', label: 'Impressions', value: '48.2L', delta: '+7.4%', deltaColor: NA, tip: 'Served impressions', ...SRC.ads },
    { metric: 'ads.clicks', label: 'Clicks', value: '1.42L', delta: '+11.8%', deltaColor: UP, tip: 'Link clicks', ...SRC.ads },
    { metric: 'ads.ctr', label: 'CTR', value: '2.94%', delta: '+0.21pt', deltaColor: UP, tip: 'Click-through rate', ...SRC.ads },
    { metric: 'ads.cpm', label: 'CPM', value: '₹226', delta: '−4.1%', deltaColor: UP, tip: 'Cost per thousand impressions', ...SRC.ads },
    /* Was 'Frequency: 2.4', authored, sitting in a row of measured figures with
       no way for a reader to tell. Account frequency is impressions over
       deduplicated reach and is genuinely not recoverable from a day-grained
       store — so the card is re-labelled to the narrower question the data
       does answer rather than left as a dash or filled with a guess. */
    { metric: 'ads.frequency_meta', label: 'Meta ad frequency', value: '2.4', delta: '+0.3', deltaColor: WARN, tip: 'How often a person who saw one of these ads saw that ad — Meta\u2019s own per-ad figure, weighted by impressions. A floor on account frequency, not the account figure: somebody who saw three different ads twice each reads as 2 here, not 6. Meta only; Google Ads reports no frequency.', ...SRC.ads },
    /* The count beside the value, on the same population the revenue card
       uses: a reservation figure and a revenue figure that disagree about who
       is in them is how two cards on one screen answer different questions in
       the same typeface. */
    { metric: 'bookings.attributed', label: 'Reservations (paid)', value: '312', delta: '—', deltaColor: NA, tip: 'Won CRM reservations whose lead was tagged to a paid channel, cancellations excluded. A floor — most reservations in this workspace carry no channel at all, and those are on the CRM and Sales screens.', ...SRC.crm },
    /* Was dividing ad spend by EVERY reservation the CRM holds, most of which
       no advertising paid for — ₹597 that looked like efficient advertising
       and was mostly walk-ins. Both halves are paid now. */
    { metric: 'cost.per_attributed_reservation', label: 'Cost per reservation', value: '₹3,480', delta: '−11.0%', deltaColor: UP, tip: 'Ad spend divided by paid-tagged CRM reservations. A ceiling: a reservation advertising produced but nobody tagged sits outside the denominator while its cost stays in the numerator.', ...SRC.blended },
    /* The GA4 half on its own, beside the total it is now part of. A figure
       folded into a headline and shown nowhere else cannot be checked, and
       this is the one somebody will want to check: it is the only measure of
       what a booking made on the website was worth. */
    { metric: 'revenue.paid_search', label: 'Paid search value (GA4)', value: '₹4.4L', delta: '—', deltaColor: NA, tip: 'What the booking engine took from sessions Google Analytics classified as Paid Search — GA4\u2019s attribution, not Google Ads\u2019 own. Included in Attributed revenue above.', ...SRC.blended },
  ],

  mktFunnel: [
    { label: 'Impressions', n: '48.2L', pct: '100%', w: '100%' },
    { label: 'Clicks', n: '1.42L', pct: '2.94%', w: '62%' },
    { label: 'Leads', n: '2,554', pct: '1.80%', w: '38%' },
    { label: 'Qualified', n: '1,187', pct: '46.5%', w: '24%' },
    { label: 'Bookings', n: '312', pct: '12.2%', w: '12%' },
  ],

  /* The spend-vs-revenue chart is data, so it is NOT authored here.
     Eight weeks of stacked bars and a rising revenue line were drawn straight
     into the SVG — fixed rectangles, fixed week labels reading W1 Jun through
     W4 Jul whatever range was selected, and a line that went up because it had
     been drawn going up. Nothing about it moved. The marketing projection
     builds it now; null here means the chart declines rather than draws
     something. */
  mktChart: null,

  platforms: [
    {
      name: 'Meta Ads', icon: 'ph ph-meta-logo', spend: '₹6.42L', rev: '₹19.8L', roas: '3.1x',
      netRoas: '4.6x', netColor: UP, mer: '3.0x', cpl: '₹352', cpa: '₹3,180', bookings: '202',
      rec: 'Scale — CPL falling with volume holding', recColor: UP, recBorder: 'var(--color-accent-800)',
      spark: spark([42, 46, 45, 52, 56, 55, 62, 66, 70, 74]),
    },
    {
      name: 'Google Ads', icon: 'ph ph-google-logo', spend: '₹4.48L', rev: '₹12.7L', roas: '2.8x',
      netRoas: '4.1x', netColor: UP, mer: '2.7x', cpl: '₹541', cpa: '₹4,190', bookings: '107',
      rec: 'Hold — brand search carries the average', recColor: NA, recBorder: 'var(--color-neutral-800)',
      spark: spark([50, 52, 48, 54, 53, 57, 55, 60, 62, 64]),
    },
    {
      name: 'Email / WhatsApp', icon: 'ph ph-whatsapp-logo', spend: '₹0.18L', rev: '₹4.2L', roas: '23.3x',
      netRoas: '21.8x', netColor: UP, mer: '—', cpl: '₹64', cpa: '₹410', bookings: '44',
      rec: 'Underfunded — highest return, lowest budget', recColor: WARN, recBorder: 'var(--color-neutral-800)',
      spark: spark([30, 36, 41, 48, 52, 60, 65, 70, 76, 82]),
    },
    {
      name: 'OTA & metasearch', icon: 'ph ph-globe-hemisphere-east', spend: '₹0.00L', rev: '₹8.4L', roas: '—',
      netRoas: '—', netColor: NA, mer: '—', cpl: '—', cpa: '₹0', bookings: '68',
      rec: 'Commission 18% — margin, not spend', recColor: DOWN, recBorder: 'var(--color-neutral-800)',
      spark: spark([58, 56, 60, 57, 62, 59, 63, 61, 64, 62]),
    },
  ],
};
