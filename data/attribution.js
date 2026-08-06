/* Attribution.
 *
 * The seven models' channel credit is NOT authored — it is the impact-preview
 * table from the Analytics Engine page (`leadintel-analytics-engine`), which is
 * reviewed design content. It moved to `lib/attribution.js` in sub-phase 5.2,
 * because the model became a workspace-level parameter on every revenue read
 * rather than a control belonging to this screen. This module renders it; it no
 * longer owns it.
 *
 * The spread between first and last click is the honest measure of how much
 * channels assist, which is why the model selector previews before it applies.
 *
 * Everything else on this screen is authored — see PHASES.md, Phase 1. */

const { seg } = require('./_tokens');
const { MODELS, ORDER, CHANNELS, DEFAULT, isModel } = require('../lib/attribution');

/* Per-channel behaviour that does not vary with the model — touchpoint counts,
   conversion rates and time-to-book are properties of the channel, not of how
   credit is apportioned. Authored. */
const CHANNEL_META = {
  meta: { channel: 'Meta Ads', bookings: '202', conv: '7.9%', tp: '3.4', time: '5.8 days' },
  google: { channel: 'Google Ads', bookings: '107', conv: '5.4%', tp: '2.9', time: '6.4 days' },
  direct: { channel: 'Direct / booking engine', bookings: '96', conv: '11.2%', tp: '1.6', time: '2.1 days' },
  organic: { channel: 'Organic search', bookings: '48', conv: '4.1%', tp: '2.4', time: '8.9 days' },
  email: { channel: 'Email / WhatsApp', bookings: '44', conv: '14.8%', tp: '2.1', time: '3.2 days' },
};

module.exports = {
  journey: [
    { icon: 'ph ph-meta-logo', label: 'Meta — UGC video 03 impression', when: 'Day 0' },
    { icon: 'ph ph-cursor-click', label: 'Clicked to Munnar landing page', when: 'Day 0' },
    { icon: 'ph ph-magnifying-glass', label: 'Google branded search', when: 'Day 3' },
    { icon: 'ph ph-envelope-simple', label: 'Opened rate-drop email', when: 'Day 5' },
    { icon: 'ph ph-whatsapp-logo', label: 'WhatsApp reply to reservations', when: 'Day 6' },
    { icon: 'ph ph-calendar-check', label: 'Booking confirmed — ₹42,800', when: 'Day 6' },
  ],

  /* `params.model` is the workspace setting, injected by the route — not a
     URL choice. `params.preview` is a candidate the user is looking at but has
     not applied, so the screen shows the candidate's numbers while the
     workspace is still crediting revenue the old way. The preview bar in the
     shell is what keeps those two facts from being confused. */
  select(params) {
    const active = isModel(params.model) ? params.model : DEFAULT;
    const previewing = isModel(params.preview) && params.preview !== active ? params.preview : null;
    const shown = previewing || active;

    const m = MODELS[shown];
    const total = CHANNELS.reduce((t, c) => t + m[c], 0);

    return {
      attrModelName: m.name,
      attrModelCharacter: m.character,
      attrMetaRoas: m.roas,
      attrMetaRoasColor: m.roasColor,

      /* The Sankey's node labels. The design types these into its SVG as
         literal text, so they used to read ₹18.9L whatever model was selected
         while the table below re-credited correctly — the diagram contradicting
         the table on the same screen. `tools/literal-bindings.js` turns them
         into these two expressions during conversion. */
      attrSankeyMeta: `₹${m.meta.toFixed(1)}L`,
      attrSankeyTotal: `₹${total.toFixed(1)}L`,

      attrModels: ORDER.map((k) => ({
        label: MODELS[k].name,
        /* Selecting previews; applying is a separate, deliberate act. */
        go: k === active ? '/attribution' : `/attribution?preview=${k}`,
        ...seg(k === shown),
      })),

      attrChannels: CHANNELS.map((c) => ({
        ...CHANNEL_META[c],
        rev: `₹${m[c].toFixed(1)}L`,
        share: `${((m[c] / total) * 100).toFixed(1)}%`,
      })),
    };
  },
};
