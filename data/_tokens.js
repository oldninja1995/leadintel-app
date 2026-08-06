/* Shared display tokens for the data modules.
 *
 * The colour values resolve to the CSS custom properties declared in
 * public/assets/app.css, so semantics live in one place rather than being
 * repeated as literals on every row the way the design file does it. */

const UP = 'var(--c-up)';
const DOWN = 'var(--c-down)';
const WARN = 'var(--c-warn)';
const NA = 'var(--color-neutral-400)';
const MUTED = 'var(--color-neutral-500)';

/* Source badges — which system a number came from. The design uses these to
 * make provenance visible on every KPI. */
const SRC = {
  crm: { src: 'CRM', srcColor: 'var(--color-accent-300)', srcBorder: 'var(--color-accent-800)' },
  pms: { src: 'PMS', srcColor: 'var(--color-accent-2-300)', srcBorder: 'var(--color-accent-2-800)' },
  ads: { src: 'ADS', srcColor: 'var(--color-neutral-400)', srcBorder: 'var(--color-neutral-800)' },
  ai: { src: 'AI', srcColor: WARN, srcBorder: 'var(--color-neutral-800)' },
  blended: { src: 'BLND', srcColor: 'var(--color-accent-300)', srcBorder: 'var(--color-accent-800)' },
};

/* Tab strips and segmented controls: selected vs not. */
const seg = (active) => ({
  color: active ? 'var(--color-accent-300)' : MUTED,
  bg: active ? 'var(--color-accent-900)' : 'transparent',
});

/* A sparkline path for the small inline charts, in the 0–100 × 0–30 viewbox the
 * design's KPI cards use. */
const spark = (points) =>
  points.map((y, i) => `${(i / (points.length - 1)) * 100},${30 - y * 0.28}`).join(' ');

module.exports = { UP, DOWN, WARN, NA, MUTED, SRC, seg, spark };
