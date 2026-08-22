/* The app's screens.
 *
 * `view` matches views/screens/<view>.ejs and data/generated/<view>.js, both
 * produced by tools/dc-to-ejs.js. `gate` is the sc-if condition that wraps the
 * screen in the design file — kept so the mapping back to the source is
 * traceable. `name` is the screen's own <h1> text.
 *
 * AUTHORED — `group` and `icon` are not derivable from the markup. The design
 * supplies the sidebar through a `navGroups` structure that sat past the
 * 256 KiB read cap, and Phase 1 was closed on 2026-08-06 with that file never
 * exported. These are stand-ins chosen to match each screen's title, and they
 * are now permanent rather than pending. They are a reasonable guess at the
 * design's grouping, not a transcription of it.
 *
 * If the design file ever lands, `navGroups` replaces them — see PHASES.md,
 * Phase 1.
 */

const SCREENS = [
  { slug: '',            view: 'dashboard',   gate: 'isDash',     name: 'Executive Dashboard',  icon: 'ph ph-squares-four',      group: 'Overview' },
  { slug: 'marketing',   view: 'marketing',   gate: 'isMkt',      name: 'Marketing Dashboard',  icon: 'ph ph-megaphone',         group: 'Marketing' },
  { slug: 'campaigns',   view: 'campaigns',   gate: 'isCamp',     name: 'Meta Ads Analytics',   icon: 'ph ph-chart-line-up',     group: 'Marketing' },
  /* Directly after Meta's, because the two are read together: same question,
     different platform. Google's hierarchy is campaign -> ad group -> ad with
     keywords beneath, which is why it is a screen of its own rather than a tab. */
  { slug: 'google-ads',  view: 'google-ads',  gate: null, app: 'google-ads', name: 'Google Ads Analytics', icon: 'ph ph-google-logo', group: 'Marketing' },
  /* Keyword Analytics is Google Ads Analytics' other half, split off rather
     than nested as a tab: the account's search terms are five thousand rows and
     they were loading beneath the six campaigns somebody opens that screen to
     read. Both render from one payload — see googleAdsPayload in server.js. */
  { slug: 'google-ads/keywords', view: 'google-ads-keywords', gate: null, app: 'google-ads-keywords', parent: 'google-ads', name: 'Keyword Analytics', icon: 'ph ph-magnifying-glass', group: 'Marketing' },
  /* The ads themselves, segmented by the surface they ran on. Google Ads
     Analytics lists ads in one table under its campaigns; this is that table
     given room, with the channel split the account is actually read by. */
  { slug: 'google-ads/ads', view: 'google-ads-ads', gate: null, app: 'google-ads-ads', parent: 'google-ads', name: 'Ad Analytics', icon: 'ph ph-image-square', group: 'Marketing' },
  { slug: 'creatives',   view: 'creatives',   gate: 'isCreative', name: 'Creative Intelligence', icon: 'ph ph-film-strip',       group: 'Marketing' },
  { slug: 'audiences',   view: 'audiences',   gate: 'isAud',      name: 'Audience Analytics',   icon: 'ph ph-users',             group: 'Marketing' },
  { slug: 'attribution', view: 'attribution', gate: 'isAttr',     name: 'Attribution',          icon: 'ph ph-tree-structure',    group: 'Marketing' },
  { slug: 'website',     view: 'website',     gate: 'isWeb',      name: 'Website Analytics',    icon: 'ph ph-globe',             group: 'Marketing' },

  { slug: 'ai',          view: 'ai',          gate: 'isAI',       name: 'AI Command Center',    icon: 'ph-fill ph-sparkle',      group: 'Intelligence' },
  { slug: 'reports',     view: 'reports',     gate: 'isReports',  name: 'Reports & Dashboards', icon: 'ph ph-files',             group: 'Intelligence' },

  { slug: 'crm',         view: 'crm',         gate: 'isCrm',      name: 'CRM Dashboard',        icon: 'ph ph-address-book',      group: 'Sales' },
  { slug: 'leads',       view: 'leads',       gate: 'isLeads',    name: 'Lead Intelligence',    icon: 'ph ph-user-circle',       group: 'Sales' },
  { slug: 'pipeline',    view: 'pipeline',    gate: 'isPipe',     name: 'Sales Pipeline',       icon: 'ph ph-funnel',            group: 'Sales' },
  { slug: 'sales',       view: 'sales',       gate: 'isSales',    name: 'Sales Analytics',      icon: 'ph ph-handshake',         group: 'Sales' },

  /* NOT FROM THE DESIGN, like Connections below. The design draws no
     distribution screen, and channel production is the half of hospitality
     revenue the ad platforms cannot see. Grouped under Sales because it is a
     revenue question, not a marketing one. */
  { slug: 'ota',         view: 'ota',         gate: null, app: 'ota', name: 'OTA Analytics',    icon: 'ph ph-bed',               group: 'Sales' },
  /* NOT FROM THE DESIGN. Every screen above is converted from
     `LeadIntel App.dc.html`; this one is ours. The design draws no way to
     connect a source, so credentials had nowhere to go and every connector
     read fixtures. `app` points at views/app/ rather than views/screens/,
     which the converter owns — see views/layout.ejs. */
  { slug: 'connections', view: 'connections', gate: null, app: 'connections', name: 'Connections', icon: 'ph ph-plugs-connected', group: 'Settings' },
];

/* Sidebar groups, derived so SCREENS stays the single source of truth.
 *
 * A screen naming a `parent` is nested under it rather than listed beside it,
 * and the parent carries a caret that folds it away. Flat indentation said
 * "related"; a fold says "this belongs to that, and you can put it back" —
 * which is what a reader who never touches keywords actually wants.
 *
 * The fold starts open when the reader is on the parent or on one of its
 * children, because collapsing the branch somebody is standing in hides where
 * they are. Every other state is theirs to choose and is remembered in the
 * browser; see public/assets/actions.js.
 */
function navGroups(activeSlug) {
  const order = [];
  const byGroup = new Map();
  const items = new Map();

  const decorate = (s) => {
    const active = s.slug === activeSlug;
    /* Field names match what the design's sidebar markup reads. */
    return {
      ...s,
      go: '/' + s.slug,
      /* The design pairs a badge with a flag that gates it; no screen carries
         a count yet, so the badge is empty and the flag is off. */
      showBadge: false,
      badge: '',
      pinned: false,
      color: active ? 'var(--color-accent-200)' : 'var(--color-neutral-400)',
      bg: active ? 'var(--color-accent-900)' : 'transparent',
      rail: active ? 'var(--color-accent-400)' : 'transparent',
      children: [],
      open: false,
    };
  };

  for (const s of SCREENS) items.set(s.slug, decorate(s));

  for (const s of SCREENS) {
    const item = items.get(s.slug);
    const parent = s.parent && items.get(s.parent);
    if (parent) {
      parent.children.push(item);
      /* Standing on the child, or on the parent, opens the fold. */
      if (s.slug === activeSlug || s.parent === activeSlug) parent.open = true;
      continue;
    }
    if (!byGroup.has(s.group)) {
      byGroup.set(s.group, []);
      order.push(s.group);
    }
    byGroup.get(s.group).push(item);
  }

  return order.map((label) => ({ label, showLabel: true, items: byGroup.get(label) }));
}

module.exports = { SCREENS, navGroups };
