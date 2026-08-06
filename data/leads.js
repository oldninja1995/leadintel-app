/* Lead Intelligence — list and profile. AUTHORED — see PHASES.md, Phase 1.
 * The profile is the ₹42,800 Munnar Honeymoon booking whose journey the
 * Attribution screen traces. */

const { UP, DOWN, WARN, NA } = require('./_tokens');

module.exports = {
  warn: WARN,

  leadRows: [
    { go: '/leads?v=leadProfile', name: 'Ananya Sharma', phone: '+91 98450 12234', property: 'Munnar Hillside', room: 'Honeymoon suite', campaign: 'Munnar Honeymoon', platform: 'Meta', score: '92', scoreColor: UP, stage: 'Quoted', stageColor: 'var(--color-accent-300)', value: '₹42,800', prob: '78%', owner: 'Reshma Menon', check: 'Aug 12', checkColor: NA, followup: 'Overdue 2d', fuColor: DOWN },
    { go: '/leads?v=leadProfile', name: 'Karthik Iyer', phone: '+91 99001 44821', property: 'Alleppey Lake Villas', room: 'Lake villa', campaign: 'Alleppey Houseboat Weekend', platform: 'Meta', score: '84', scoreColor: UP, stage: 'Negotiation', stageColor: 'var(--color-accent-300)', value: '₹28,400', prob: '64%', owner: 'Arun Kurian', check: 'Aug 08', checkColor: NA, followup: 'Today', fuColor: WARN },
    { go: '/leads?v=leadProfile', name: 'Meera Pillai', phone: '+91 94470 88190', property: 'Munnar Hillside', room: 'Premium double', campaign: 'Brand search', platform: 'Google', score: '71', scoreColor: NA, stage: 'Quoted', stageColor: 'var(--color-accent-300)', value: '₹18,600', prob: '52%', owner: 'Sneha Nair', check: 'Aug 15', checkColor: NA, followup: 'Today', fuColor: WARN },
    { go: '/leads?v=leadProfile', name: 'Daniel Thomas', phone: '+91 97440 30115', property: 'Munnar Hillside', room: 'Honeymoon suite', campaign: 'Munnar Honeymoon', platform: 'Meta', score: '88', scoreColor: UP, stage: 'Booked', stageColor: UP, value: '₹54,200', prob: '100%', owner: 'Reshma Menon', check: 'Aug 21', checkColor: NA, followup: 'Tomorrow', fuColor: NA },
    { go: '/leads?v=leadProfile', name: 'Priya Varghese', phone: '+91 90480 61277', property: 'Kumarakom Retreat', room: 'Lakeview room', campaign: 'Kumarakom Ayurveda Retreat', platform: 'Google', score: '64', scoreColor: NA, stage: 'Contacted', stageColor: NA, value: '₹22,100', prob: '38%', owner: 'Vishnu Joseph', check: '—', checkColor: NA, followup: 'Aug 03', fuColor: NA },
    { go: '/leads?v=leadProfile', name: 'Rahul Menon', phone: '+91 98860 71042', property: 'Alleppey Lake Villas', room: 'Houseboat 2BR', campaign: 'Monsoon Package · Kerala', platform: 'Meta', score: '46', scoreColor: WARN, stage: 'New', stageColor: NA, value: '₹31,000', prob: '18%', owner: 'Unassigned', check: '—', checkColor: NA, followup: 'Untouched 3h', fuColor: DOWN },
    { go: '/leads?v=leadProfile', name: 'Sonia Mathew', phone: '+91 99620 55813', property: 'Kumarakom Retreat', room: 'Ayurveda suite', campaign: 'Kumarakom Ayurveda Retreat', platform: 'Google', score: '77', scoreColor: NA, stage: 'Qualified', stageColor: 'var(--color-accent-300)', value: '₹36,500', prob: '48%', owner: 'Tara George', check: 'Sep 02', checkColor: NA, followup: 'Aug 04', fuColor: NA },
  ],

  selLead: {
    name: 'Ananya Sharma', init: 'AS',
    phone: '+91 98450 12234', email: 'ananya.sharma@gmail.com',
    location: 'Bengaluru, Karnataka', device: 'iPhone · Instagram in-app',
    stage: 'Quoted', stageColor: 'var(--color-accent-300)',
    score: '92', scoreColor: UP,
    value: '₹42,800', prob: '78%',
    owner: 'Reshma Menon',

    intent: [
      { k: 'Trip type', v: 'Honeymoon · 2 adults' },
      { k: 'Dates', v: 'Aug 12 – Aug 15 (3 nights)' },
      { k: 'Property', v: 'Munnar Hillside' },
      { k: 'Room', v: 'Honeymoon suite' },
      { k: 'Package', v: 'Honeymoon 3N/4D + candlelight' },
      { k: 'Budget signal', v: 'Asked about suite upgrade' },
    ],

    attribution: [
      { k: 'First touch', v: 'Meta · UGC video 03' },
      { k: 'Last touch', v: 'WhatsApp · reservations' },
      { k: 'Touchpoints', v: '5 across 6 days' },
      { k: 'Credited to', v: 'Munnar Honeymoon (45%)' },
      { k: 'Model', v: 'Data driven' },
      { k: 'Confidence', v: '94%' },
    ],

    timeline: [
      { label: 'Saw UGC video 03', who: 'Meta Ads', when: 'Jul 24 · 21:14', icon: 'ph ph-meta-logo', tag: 'IMPRESSION', tagColor: NA, ring: 'var(--color-neutral-800)', bg: 'transparent', color: NA },
      { label: 'Submitted enquiry form', who: 'Munnar landing page', when: 'Jul 24 · 21:19', icon: 'ph ph-cursor-click', tag: 'LEAD', tagColor: 'var(--color-accent-300)', ring: 'var(--color-accent-800)', bg: 'var(--color-accent-900)', color: 'var(--color-accent-300)' },
      { label: 'First call — 21 minutes later', who: 'Reshma Menon', when: 'Jul 24 · 21:40', icon: 'ph ph-phone-call', tag: 'CONTACTED', tagColor: NA, ring: 'var(--color-neutral-800)', bg: 'transparent', color: NA },
      { label: 'Branded search, returned direct', who: 'Google', when: 'Jul 27 · 10:02', icon: 'ph ph-magnifying-glass', tag: 'TOUCH', tagColor: NA, ring: 'var(--color-neutral-800)', bg: 'transparent', color: NA },
      { label: 'Quote sent — ₹42,800', who: 'Reshma Menon', when: 'Jul 28 · 16:31', icon: 'ph ph-file-text', tag: 'QUOTED', tagColor: 'var(--color-accent-300)', ring: 'var(--color-accent-800)', bg: 'var(--color-accent-900)', color: 'var(--color-accent-300)' },
      { label: 'No reply — follow-up overdue', who: 'System', when: 'Jul 30 · 09:00', icon: 'ph ph-warning-circle', tag: 'AT RISK', tagColor: DOWN, ring: 'var(--color-neutral-800)', bg: 'transparent', color: DOWN },
    ],
  },
};
