/* Sales Pipeline — kanban and list. AUTHORED — see PHASES.md, Phase 1.
 * Stage totals match the CRM screen's stage bars. */

const { UP, DOWN, WARN, NA } = require('./_tokens');

/* The owner avatar is a 16-pixel circle set in 7-pixel type: it holds initials,
   the way every other avatar in this product does (`init: 'AS'` on the
   reservations table). This module was handing it whole names, and a whole name
   does not fit in sixteen pixels — it overflowed the circle and printed on top
   of the age beside it, so every card on the board read "Vishnu Joseph" and
   "2 days" as one smear, and an unassigned lead read "Unassignedtouched 3h".
   Two initials at most: three-part names are common here and a third letter
   puts the overflow back. */
const initials = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  /* Nobody's initials. A lead with no owner is the one a sales manager most
     needs to see, so the circle stays and says it is empty. */
  if (!words.length || name === 'Unassigned') return '—';
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
};

/* Names stay written out above, where they are read by a person editing this
   file; the shortening happens on the way to the screen. */
const shortenOwners = (stages) => stages.map((stage) => ({
  ...stage,
  cards: (stage.cards || []).map((card) => ({ ...card, own: initials(card.own) })),
}));

module.exports = {
  pipeKanbanBg: 'var(--color-accent-900)',
  pipeKanbanColor: 'var(--color-accent-300)',
  pipeListBg: 'transparent',
  pipeListColor: 'var(--color-neutral-500)',

  pipeStages: shortenOwners([
    {
      name: 'New', n: '412', rev: '₹12.8L', conv: '77%', time: '0.4 days', drop: '23% lost', dropColor: NA,
      cards: [
        { name: 'Rahul Menon', val: '₹31,000', own: 'Unassigned', chan: 'Meta', what: 'Monsoon package · 2BR houseboat', age: 'Untouched 3h', ageColor: DOWN },
        { name: 'Anjali Nambiar', val: '₹19,400', own: 'Tara George', chan: 'Google', what: 'Kumarakom · lakeview 2N', age: '1h ago', ageColor: NA },
        { name: 'Vivek Suresh', val: '₹24,800', own: 'Arun Kurian', chan: 'Meta', what: 'Alleppey weekend', age: '4h ago', ageColor: NA },
      ],
    },
    {
      name: 'Contacted', n: '318', rev: '₹9.9L', conv: '67%', time: '1.1 days', drop: '33% lost', dropColor: NA,
      cards: [
        { name: 'Priya Varghese', val: '₹22,100', own: 'Vishnu Joseph', chan: 'Google', what: 'Ayurveda retreat · 5N', age: '2 days', ageColor: NA },
        { name: 'Joseph Alex', val: '₹17,600', own: 'Sneha Nair', chan: 'Meta', what: 'Munnar · garden cottage', age: '1 day', ageColor: NA },
      ],
    },
    {
      name: 'Qualified', n: '214', rev: '₹7.4L', conv: '60%', time: '1.8 days', drop: '40% lost', dropColor: WARN,
      cards: [
        { name: 'Sonia Mathew', val: '₹36,500', own: 'Tara George', chan: 'Google', what: 'Ayurveda suite · Sep 02', age: '3 days', ageColor: NA },
        { name: 'Naveen Kumar', val: '₹28,900', own: 'Reshma Menon', chan: 'Meta', what: 'Munnar · cliff-view villa', age: '2 days', ageColor: NA },
      ],
    },
    {
      name: 'Quoted', n: '128', rev: '₹5.1L', conv: '55%', time: '2.4 days', drop: '45% lost', dropColor: WARN,
      cards: [
        { name: 'Ananya Sharma', val: '₹42,800', own: 'Reshma Menon', chan: 'Meta', what: 'Honeymoon suite · Aug 12', age: 'Overdue 2d', ageColor: DOWN },
        { name: 'Meera Pillai', val: '₹18,600', own: 'Sneha Nair', chan: 'Google', what: 'Premium double · Aug 15', age: 'Payment due', ageColor: WARN },
      ],
    },
    {
      name: 'Negotiation', n: '70', rev: '₹3.2L', conv: '71%', time: '1.6 days', drop: '29% lost', dropColor: UP,
      cards: [
        { name: 'Karthik Iyer', val: '₹28,400', own: 'Arun Kurian', chan: 'Meta', what: 'Lake villa · call after 6pm', age: 'Today', ageColor: WARN },
      ],
    },
    {
      name: 'Booked', n: '312', rev: '₹9.8L', conv: '100%', time: '—', drop: '3.4% cancel', dropColor: DOWN,
      cards: [
        { name: 'Daniel Thomas', val: '₹54,200', own: 'Reshma Menon', chan: 'Meta', what: 'Honeymoon suite · Aug 21', age: 'Confirmed', ageColor: UP },
        { name: 'Lakshmi Iyer', val: '₹33,100', own: 'Arun Kurian', chan: 'Direct', what: 'Lake villa · Aug 09', age: 'Confirmed', ageColor: UP },
      ],
    },
  ]),
};
