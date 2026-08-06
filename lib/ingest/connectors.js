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
const EXTERNAL_ID = {
  campaign_day: (b) => `${b.campaign_id}:${b.date}`,
  adset_day: (b) => `${b.adset_id}:${b.date}`,
  ad_day: (b) => `${b.ad_id}:${b.date}`,
  adgroup_day: (b) => `${b.adgroup_id}:${b.date}`,
  keyword_day: (b) => `${b.keyword_id}:${b.date}`,
  inventory_day: (b) => `${b.property_id}:${b.date}`,
  creative: (b) => b.creative_id,
  lead: (b) => b.lead_id,
  lead_event: (b) => b.event_id,
  deal: (b) => b.deal_id,
  booking: (b) => b.booking_id,
  folio: (b) => b.folio_id,
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

    async pull(window, transport) {
      const records = [];
      for (const kind of source.kinds) {
        const bodies = await transport.fetch({ source, kind, window });
        for (const body of bodies) records.push(nameRecord(kind, body));
      }
      return assertRecords(source, records);
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

module.exports = { CONNECTORS, list, get, makeConnector };
