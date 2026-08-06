/* What a source is, and what a connector must do.
 *
 * Stage 1 of the Analytics Engine pipeline: "Connectors pull on schedule;
 * webhooks stream. Raw payloads stored immutably for replay." That sentence is
 * the whole of this file's remit — a connector acquires payloads and says what
 * they are. It does not normalise, does not merge, does not decide who wins a
 * disagreement, and does not know where the bytes came from.
 *
 * The last of those is deliberate. There are no credentials for any of these
 * systems yet, so the network call is a `transport` a connector is handed
 * rather than something it contains. Today the transport reads fixtures; the
 * day a token exists it makes an HTTP request, and nothing downstream can tell
 * the difference.
 *
 *   Source
 *     id        stable key, used in storage paths — never rename in place
 *     name      how it is written in the UI
 *     system    which of the precedence table's five systems it is
 *     cadence   { mode: 'poll' | 'stream', every: seconds, sla: string }
 *     kinds     the record kinds it emits
 *     wins      the precedence fields this system is authoritative for
 *
 *   Connector
 *     source                     the Source it reads
 *     pull(window, transport)    → RawRecord[]   scheduled read of [from, to)
 *     receive(event)             → RawRecord[]   one webhook delivery
 *
 *   RawRecord
 *     kind        one of the source's declared kinds
 *     externalId  the source's own id for this thing — the idempotency key
 *     body        the payload, untouched
 *
 * A connector that cannot stream still declares `receive`; it returns nothing.
 */

const METHODS = ['pull', 'receive'];

/* The six rules from the Analytics Engine page, verbatim. Kept here rather
   than in the merge code because they are a property of the sources — which
   system is authoritative for a field is the same fact as which fields a
   source wins. */
const PRECEDENCE = [
  { field: 'revenue', wins: 'pms', note: 'Folio is the settled figure; CRM deal value is the expectation' },
  { field: 'bookingStatus', wins: 'pms', note: 'Check-in and cancellation are operational facts' },
  { field: 'leadStage', wins: 'crm', note: 'Only the CRM knows the sales conversation' },
  { field: 'campaignIds', wins: 'crm', note: 'Captured at lead creation — survives ad deletion' },
  { field: 'spendDelivery', wins: 'ads', note: 'CTR, CPM, frequency have no CRM equivalent' },
  { field: 'payment', wins: 'gateway', note: 'Razorpay/Stripe settle; PMS reflects, does not define' },
];

function assertConnector(connector) {
  const { source } = connector;
  if (!source || !source.id) throw new Error('connector has no source');

  const missing = METHODS.filter((m) => typeof connector[m] !== 'function');
  if (missing.length) throw new Error(`connector "${source.id}" does not implement ${missing.join(', ')}`);

  /* A source claiming a field no rule assigns to its system would win merges it
     has no authority over, and the mistake would only surface as a wrong
     number months later. */
  for (const field of source.wins || []) {
    const rule = PRECEDENCE.find((r) => r.field === field);
    if (!rule) throw new Error(`source "${source.id}" claims unknown field "${field}"`);
    if (rule.wins !== source.system) {
      throw new Error(`source "${source.id}" is ${source.system} but "${field}" is won by ${rule.wins}`);
    }
  }

  return connector;
}

/* Every record a connector returns is checked before it reaches the store —
   a malformed record is a connector bug, and the store is append-only, so it
   is much cheaper to reject it here than to unpick it later. */
function assertRecords(source, records) {
  if (!Array.isArray(records)) throw new Error(`connector "${source.id}" did not return a list`);

  for (const record of records) {
    if (!record || typeof record !== 'object') throw new Error(`connector "${source.id}" returned ${record}`);
    if (!source.kinds.includes(record.kind)) {
      throw new Error(`connector "${source.id}" returned undeclared kind "${record.kind}"`);
    }
    if (!record.externalId) throw new Error(`connector "${source.id}" returned a ${record.kind} with no externalId`);
    if (record.body === undefined) throw new Error(`connector "${source.id}" returned a ${record.kind} with no body`);
  }

  return records;
}

module.exports = { METHODS, PRECEDENCE, assertConnector, assertRecords };
