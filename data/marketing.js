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
    { metric: 'revenue.attributed', label: 'Attributed revenue', value: '₹32.5L', delta: '+18.2%', deltaColor: UP, sub: 'leads tagged to a paid channel only', tip: 'Revenue credited to paid media on the workspace model', icon: 'ph ph-currency-inr', spark: spark([40, 44, 47, 52, 51, 58, 62, 66, 71, 75]), ...SRC.blended },
    { metric: 'cost.per_lead', label: 'Blended CPL', value: '₹427', delta: '−18.0%', deltaColor: UP, sub: '', tip: 'Paid spend per lead — pick a channel above for that platform', icon: 'ph ph-user-focus', spark: spark([78, 74, 72, 68, 64, 61, 58, 54, 50, 47]), ...SRC.blended },
    { metric: 'roas.reservations', label: 'ROAS', value: '4.8x', delta: '+0.6x', deltaColor: UP, sub: 'CRM reservation value ÷ ad spend', tip: 'Net of cancellations and commissions', icon: 'ph ph-chart-line-up', spark: spark([48, 46, 52, 55, 54, 61, 63, 68, 73, 78]), ...SRC.blended },
  ],

  mktKpis: [
    { metric: 'ads.impressions', label: 'Impressions', value: '48.2L', delta: '+7.4%', deltaColor: NA, tip: 'Served impressions', ...SRC.ads },
    { metric: 'ads.clicks', label: 'Clicks', value: '1.42L', delta: '+11.8%', deltaColor: UP, tip: 'Link clicks', ...SRC.ads },
    { metric: 'ads.ctr', label: 'CTR', value: '2.94%', delta: '+0.21pt', deltaColor: UP, tip: 'Click-through rate', ...SRC.ads },
    { metric: 'ads.cpm', label: 'CPM', value: '₹226', delta: '−4.1%', deltaColor: UP, tip: 'Cost per thousand impressions', ...SRC.ads },
    /* Frequency needs impressions per *person*, and reach is not a field either
       platform's campaign_day payload carries. No registry entry, and no
       invented formula to make the coverage figure look better. */
    { label: 'Frequency', value: '2.4', delta: '+0.3', deltaColor: WARN, tip: 'Average impressions per person', ...SRC.ads },
    { metric: 'cost.per_reservation', label: 'Cost per reservation', value: '₹3,480', delta: '−11.0%', deltaColor: UP, tip: 'Paid spend per CRM-won reservation', ...SRC.blended },
  ],

  mktFunnel: [
    { label: 'Impressions', n: '48.2L', pct: '100%', w: '100%' },
    { label: 'Clicks', n: '1.42L', pct: '2.94%', w: '62%' },
    { label: 'Leads', n: '2,554', pct: '1.80%', w: '38%' },
    { label: 'Qualified', n: '1,187', pct: '46.5%', w: '24%' },
    { label: 'Bookings', n: '312', pct: '12.2%', w: '12%' },
  ],

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
