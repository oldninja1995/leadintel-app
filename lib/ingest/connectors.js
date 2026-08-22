/* The five connectors.
 *
 * Every one of them does the same two things — ask the transport for each kind
 * it declares, and name each record — so they are built from one factory
 * rather than written out five times. What differs between systems is only
 * which field carries the record's own id, and that is a table.
 *
 * Nothing here interprets a payload. `body` reaches the raw store exactly as
 * the source sent it, because stage 1 stores payloads "immutably for replay"
 * and a connector that tidied them up on the way in would make replay a lie.
 */

const { assertConnector, assertRecords } = require('./contract');
const sources = require('./sources');

/* The source's own identifier for a record, per kind. Composite where the
   thing is a per-day fact rather than an object: the same campaign on two days
   is two records, and re-pulling an overlapping window must land on the same
   key both times or the store would fill with duplicates. */
/* Payloads reach the store exactly as the source sent them, so the same fact
   genuinely arrives spelled three ways — the fixtures use flat snake_case
   (`campaign_id`, `date`), Meta uses flat with its own names (`date_start`),
   and Google's REST reporting nests everything in lowerCamelCase
   (`campaign.id`, `segments.date`).
 *
 * The id has to be stable across all of them: a live pull and a fixture replay
 * of the same day must land on the same key, or re-pulling a window would
 * duplicate rows instead of overwriting them. Reading several spellings is
 * therefore part of what this table is *for*, not a workaround around it. */
function first(body, ...paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), body);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const day = (b) => first(b, 'date', 'date_start', 'segments.date');

const EXTERNAL_ID = {
  campaign_day: (b) => `${first(b, 'campaign_id', 'campaign.id')}:${day(b)}`,
  adset_day: (b) => `${first(b, 'adset_id', 'adset.id')}:${day(b)}`,
  /* Google's ad id lives under `adGroupAd`, and reading only Meta's spelling
     cost this kind almost every row it ever pulled — see the note on
     keyword_day below, which is the same bug found the same afternoon. */
  ad_day: (b) => `${first(b, 'ad_id', 'ad.id', 'ad_group_ad.ad.id', 'adGroupAd.ad.id')}:${day(b)}`,
  adgroup_day: (b) => `${first(b, 'adgroup_id', 'ad_group.id', 'adGroup.id')}:${day(b)}`,
  /* **The camelCase path is not optional, and leaving it out is silent.**
   *
   * Google's REST reporting nests in lowerCamelCase — `adGroupCriterion.criterionId` —
   * and this line read only the fixture's flat name and the snake-case path
   * nothing sends. `first` returned undefined, every keyword row of a day was
   * therefore named `undefined:2026-08-21`, and the store did what it is built
   * to do: it upserted them onto each other. An account with 220 keywords and
   * ₹98,000 of search spend held **four** keyword rows for the year, one per
   * day that happened to be pulled, each holding whichever keyword was written
   * last. Nothing failed. The sync reported ok, /ingest/status reported ok, and
   * the screens reported dashes.
   *
   * The identity of a keyword-day is the criterion and the date, so it must be
   * readable in every spelling the record can arrive in — which is the whole
   * point of the table this sits in. */
  keyword_day: (b) => `${first(b, 'keyword_id', 'ad_group_criterion.criterion_id', 'adGroupCriterion.criterionId')}:${day(b)}`,
  /* No date in the key: this is the criterion itself, not a day of it, so a
     later pull supersedes the earlier row rather than appending a second. */
  keyword: (b) => `${first(b, 'keyword_id', 'ad_group_criterion.criterion_id', 'adGroupCriterion.criterionId')}`,

  /* A search term is not an entity Google gives an id to — the string *is* the
     identity. Scoped by ad group because the same phrase matched in two ad
     groups is two rows of spend, exactly as the same creative in two ads was
     two rows for Meta. */
  search_term_day: (b) => `${first(b, 'search_term', 'search_term_view.search_term', 'searchTermView.searchTerm')}`
    + `:${first(b, 'adgroup_id', 'ad_group.id', 'adGroup.id')}:${day(b)}`,

  /* Keyed by the conversion action's name and the campaign it credited, which
     is the grain the segmented query returns. Without the action in the key
     every action of a campaign-day would collapse onto one row and the split
     this kind exists to make would be undone by its own identity rule. */
  conversion_day: (b) => `${first(b, 'conversion_action', 'segments.conversion_action_name', 'segments.conversionActionName')}`
    + `:${first(b, 'campaign_id', 'campaign.id')}:${day(b)}`,
  inventory_day: (b) => `${b.property_id}:${day(b)}`,

  /* Google Analytics reports one row per day per dimension combination, and the
     dimensions *are* the identity — there is no id to key on. A day alone for
     the undimensioned report, and the dimension values beside it for the two
     that cut by channel and by source/medium. */
  session_day: (b) => `${day(b)}`,
  channel_day: (b) => `${b.sessionDefaultChannelGroup || '(none)'}:${day(b)}`,
  /* Same identity rule as channel_day — same grain, different measurements.
     Kept as its own entry rather than aliased so that renaming one kind cannot
     silently repoint the other at the wrong rows. */
  channel_revenue_day: (b) => `${b.sessionDefaultChannelGroup || '(none)'}:${day(b)}`,
  source_medium_day: (b) => `${b.sessionSource || '(none)'}/${b.sessionMedium || '(none)'}:${day(b)}`,
  /* Same rule again: the dimension value plus the day is the identity. A path
     is long and arbitrary and that is fine — it is a key, not a label. */
  page_day: (b) => `${b.pagePath || '(none)'}:${day(b)}`,
  city_day: (b) => `${b.city || '(none)'}:${day(b)}`,
  /* The two breakdown values plus the day ARE the identity — there is no id on
     a demographic row any more than there is on a GA4 one. */
  demographic_day: (b) => `${b.age || '(none)'}:${b.gender || '(none)'}:${day(b)}`,
  city_revenue_day: (b) => `${b.city || '(none)'}:${day(b)}`,
  landing_page_day: (b) => `${b.landingPage || '(none)'}:${day(b)}`,
  /* Keyed by the **ad**, because that is the unit a creative is measured in:
     the same creative running in two ads has two spends and two click-through
     rates, and collapsing them would average away the thing the screen is for.
     Meta's ads edge names it plainly `id`. */
  creative: (b) => b.creative_id || b.id,
  /* Configuration, not measurement: one row per ad set and per audience, with
     no day in the key. Re-pulling replaces the row rather than adding a second
     one for today — an ad set's targeting is its current state, and keeping a
     history of it would be answering a question nothing asks. */
  adset: (b) => b.adset_id || b.id,
  audience: (b) => b.audience_id || b.id,
  lead: (b) => b.lead_id,
  lead_event: (b) => b.event_id,
  deal: (b) => b.deal_id,
  booking: (b) => b.booking_id,
  folio: (b) => b.folio_id,
  /* An OTA reservation is identified by the number printed on the guest's
     confirmation, which is the one string a human can also look up in the
     channel's extranet. Each channel numbers its own, and the raw store is
     partitioned per source, so two channels cannot collide. */
  reservation: (b) => b.reservation_id || b.confirmation_number || b.id,
  payment: (b) => b.payment_id,
  refund: (b) => b.refund_id,
};

function makeConnector(source) {
  const nameRecord = (kind, body) => {
    const externalId = EXTERNAL_ID[kind] && EXTERNAL_ID[kind](body);
    if (!externalId) throw new Error(`${source.id}: a ${kind} record has no identifier`);
    return { kind, externalId, body };
  };

  return assertConnector({
    source,

    /* **One kind failing must not lose the others.**
     *
     * This awaited every kind in a bare loop, so a single refusal threw the
     * whole pull away — and the kinds are not equally important. Meta's
     * `customaudiences` edge needs a wider permission than the insights edges
     * do, so a token scoped to read performance can fetch every day of spend
     * and still be refused the audience list. Under the old loop that refusal
     * cost the account *all* of its data, and the screen showed a fortnight-old
     * store while the sync log filled with one permission error.
     *
     * A kind that fails is now dropped with its reason and the rest are kept.
     * The consequence is graceful: losing `adset` or `audience` costs the
     * funnel its targeting signal, and lib/creative-funnel.js falls back to the
     * ad set's name — a weaker answer, clearly labelled as such, rather than no
     * screen at all.
     *
     * Failures are attached to the returned array rather than thrown, so the
     * runner can log them without a caller having to catch anything. */
    async pull(window, transport) {
      const records = [];
      const failures = [];

      for (const kind of source.kinds) {
        try {
          const bodies = await transport.fetch({ source, kind, window });
          for (const body of bodies) records.push(nameRecord(kind, body));
        } catch (err) {
          failures.push({ kind, reason: err.message });
        }
      }

      /* Every kind failing is a real failure — a token that reads nothing is
         not a quiet account — and is raised rather than reported as an empty
         but successful sync. */
      if (failures.length === source.kinds.length) {
        throw new Error(`${source.id}: every kind failed — ${failures.map((f) => `${f.kind}: ${f.reason}`).join('; ')}`);
      }

      const out = assertRecords(source, records);
      if (failures.length) Object.defineProperty(out, 'failures', { value: failures, enumerable: false });
      return out;
    },

    /* A webhook delivery names its own kind; a source that cannot stream will
       never be called here, and returns nothing if it is. */
    async receive(event) {
      if (source.cadence.mode !== 'stream') return [];
      if (!event || !event.kind) throw new Error(`${source.id}: webhook delivery with no kind`);
      const bodies = Array.isArray(event.body) ? event.body : [event.body];
      return assertRecords(source, bodies.map((body) => nameRecord(event.kind, body)));
    },
  });
}

const CONNECTORS = Object.fromEntries(sources.list().map((s) => [s.id, makeConnector(s)]));

const list = () => Object.values(CONNECTORS);
const get = (id) => CONNECTORS[id] || null;

/* EXTERNAL_ID is exported for demo-origin.js, which has to work out what a
   fixture payload *would* have been stored as. Naming it the same way the
   connector does is the whole point — a second implementation of these keys
   would drift, and the classification would quietly stop matching. */
module.exports = { CONNECTORS, list, get, makeConnector, EXTERNAL_ID };
