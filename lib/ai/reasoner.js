/* Where explanations come from.
 *
 * Two reasoners, the same shape, chosen by `LEADINTEL_REASONER` — deliberately
 * the same arrangement as `lib/ingest/transport.js`, and for the same reason.
 *
 *   registry   deterministic analysis over the metric registry
 *   model      a language model, which cannot be written yet
 *
 * The second is a stub on purpose. There is no API key, no prompt anyone has
 * reviewed, and no evaluation of whether a model's output would satisfy the
 * six-step contract the Analytics Engine page specifies. Writing a speculative
 * client for that would be a guess dressed as progress, so it throws with its
 * reason instead — and everything upstream of it is real and finished.
 *
 * What matters is that the *contract* is the registry reasoner's, not the
 * model's. A model-backed implementation would have to produce the same six
 * steps, carry the same provenance on every claim, and pass the same
 * `assertSourced` check. It gets to be more fluent; it does not get to be less
 * accountable.
 */

const explain = require('./explain');

function registryReasoner() {
  return {
    name: 'registry',
    explain(metricId, context) {
      const explanation = explain.explain(metricId, context);

      /* The exit criterion is "no unsourced assertion", so the check runs on
         every explanation rather than in a test. An explanation that cannot
         name its metric and window is withheld, not shipped with a warning. */
      const unsourced = explain.assertSourced(explanation);
      if (unsourced.length) {
        throw new Error(
          `explanation for "${metricId}" has unsourced claims: `
          + unsourced.map((u) => `${u.claim} (no ${u.missing})`).join(', ')
        );
      }
      return { ...explanation, reasoner: 'registry' };
    },
  };
}

function modelReasoner() {
  return {
    name: 'model',
    explain() {
      throw new Error(
        'no model-backed reasoner: there is no API key, no reviewed prompt, and no evaluation '
        + 'that a generated explanation would satisfy the six-step contract. The registry '
        + 'reasoner answers today; a model would have to meet the same provenance rules.'
      );
    },
  };
}

const REASONERS = { registry: registryReasoner, model: modelReasoner };

function createReasoner(name = process.env.LEADINTEL_REASONER || 'registry') {
  const make = REASONERS[name];
  if (!make) throw new Error(`unknown reasoner "${name}" — have ${Object.keys(REASONERS).join(', ')}`);
  return make();
}

module.exports = { createReasoner, registryReasoner, modelReasoner, REASONERS };
