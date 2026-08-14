/* TeleCRM — the request shape for a real pull.
 *
 * Written from `https://docs.telecrm.in/sync` ("Telecrm Public APIs"), which is
 * a **different document** from the one at `https://docs.telecrm.in/` with no
 * path. That one is titled "Telecrm Async APIs", declares exactly one endpoint
 * — `POST /enterprise/{id}/autoupdatelead` — and it *writes*. Five sessions
 * concluded from it that TeleCRM publishes no read API. It publishes a full
 * one; the page is simply not linked from the async page and does not surface
 * in search. If this file ever looks wrong, re-read `/sync` and not `/`.
 *
 * **The Sync API is on a different host and carries a path prefix:**
 *
 *   https://next.telecrm.in/autoupdate/v2      <- reads (this file)
 *   https://next-api.telecrm.in                <- the async write endpoint
 *
 * That matters more than it looks. A correct Sync token aimed at the async host
 * fails, and the failure is indistinguishable from a bad key — which is exactly
 * the state this connection was in. `baseFrom` therefore treats a stored async
 * host as the misconfiguration it is rather than obeying it.
 *
 * Three things shape this differently from the ad connectors:
 *
 * 1. *Search is a POST with a JSON body*, not a GET with query parameters —
 *    including for what is plainly a read. Windowing goes in
 *    `fields.created_on`, and paging in the query string beside it.
 *
 * 2. *Actions hang off a lead.* There is no account-wide action endpoint: the
 *    only way to read them is `/lead/{leadId}/action/search`, one lead at a
 *    time. So `lead_event` walks the leads in the window, threading its
 *    position through the paging cursor. It is N+1 by the API's design, and
 *    `maxPages` in the transport is what bounds it.
 *
 * 3. *There are no deals.* TeleCRM models leads, actions and a lead-stage
 *    pipeline. `deal` is derived from a lead's status against that pipeline,
 *    where every stage declares `stageType: OPEN | WON | LOST` — so "won" is
 *    read from the workspace's own configuration rather than guessed from
 *    status names. A workspace that has renamed its stages still works.
 */

/* The documented production server for the Sync API. */
const BASE = 'https://next.telecrm.in/autoupdate/v2';

/* The async host, which is what the Connections form used to hint and what a
   credential entered before this file existed is likely to carry. */
const ASYNC_HOST = /(^|\/\/)next-api\.telecrm\.in/i;

const PAGE = 100;
const MIN_PAGE = 25;

/* Lead-stage pipelines, keyed by enterprise. A pull asks for three kinds and
   `deal` needs the pipeline for every page of every one of them; fetching it
   per page would triple the request count for a document that changes when
   somebody edits their workspace. Cleared by tests rather than left to leak. */
const pipelineCache = new Map();
const clearPipelineCache = () => pipelineCache.clear();

/* Where the read API lives.
 *
 * A stored base URL is honoured — a self-hosted or regional deployment is a
 * real thing — with one exception: the async host cannot serve any of these
 * paths, so pointing at it is never what the operator meant. Silently
 * correcting it is the lesser evil against failing with an auth-shaped error
 * that sends them back to re-copy a token that was fine all along. */
function baseFrom(credentials = {}) {
  const stored = String(credentials.baseUrl || '').trim().replace(/\/+$/, '');
  if (!stored || ASYNC_HOST.test(stored)) return BASE;
  /* A base that names the host but not the API prefix is the other easy
     mistake, and it fails as a 404 of HTML rather than as anything readable. */
  if (/next\.telecrm\.in$/i.test(stored)) return `${stored}/autoupdate/v2`;
  return stored;
}

function enterprisePath(credentials = {}) {
  const id = String(credentials.enterpriseId || '').trim();
  if (!id) throw new Error('TeleCRM needs an enterprise id');
  return encodeURIComponent(id);
}

/* Unix milliseconds, deliberately.
 *
 * The API accepts "a Unix timestamp or a date-time in the workspace-defined
 * format", and the spec's own examples disagree with each other about what that
 * format is — `1/1/2001` in one place, `01/01/2023 10:30:00` in another, with a
 * note that values in other formats are interpreted differently. A workspace
 * set to MM/DD/YYYY would silently read 03/04 as March 4th where we meant April
 * 3rd, and a date window that is wrong by weeks looks like missing data rather
 * than a bug. Epoch milliseconds have no such ambiguity. */
function stamp(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/* The half-open window this codebase uses, as TeleCRM's inclusive range.
 *
 * `to` is exclusive here and inclusive there, so a millisecond is taken off
 * rather than a day: these are timestamps, not dates, and stepping back a whole
 * day — the correction Meta and Google need — would drop the last day of every
 * pull. */
function createdOn(window) {
  if (!window || !window.from || !window.to) return null;
  const from = stamp(window.from);
  const to = stamp(window.to);
  if (from === null || to === null) return null;
  return { from, to: to - 1 };
}

/* TeleCRM's own identity rule, applied here.
 *
 * The async documentation states leads are identified by "the unique identifier
 * field set up in the workspace (default: phone)", and the search response's
 * documented shape carries only `fields` — no id at all. Live responses do
 * carry one, under a name the spec does not fix, so every plausible spelling is
 * tried before falling back to the identity TeleCRM itself defaults to.
 *
 * Falling back to phone is not a guess: it is the documented default. A lead
 * with neither an id nor a phone has no identity we could dedupe on, and is
 * rejected rather than stored under a synthetic key that would duplicate it on
 * the next pull. */
function leadIdOf(row = {}) {
  const fields = row.fields || {};
  return row.id || row._id || row.leadId || row.lead_id
    || fields.phone || null;
}

const firstOf = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
};

/* Milliseconds, seconds and ISO strings all appear in this API depending on the
   field. Normalised to ISO so `transport.within` and canonical read one thing. */
function isoFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    /* Ten digits is seconds, thirteen is milliseconds. Guessing wrong puts a
       lead in 1970 or in the year 55000, and both read as a windowing bug. */
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/* A lead, flattened into the spelling `canonical.js` reads for `telecrm.lead`.
 *
 * The whole original row travels under `raw` as well. The raw store keeps what
 * it is given verbatim, and a custom field this app has never heard of is
 * exactly the thing somebody will need next month — dropping it here would make
 * it unrecoverable without a re-pull. */
function leadBody(row = {}) {
  const f = row.fields || {};
  return {
    lead_id: leadIdOf(row),
    name: firstOf(f, 'name'),
    phone: firstOf(f, 'phone'),
    email: firstOf(f, 'email'),
    stage: firstOf(f, 'status'),
    owner: firstOf(f, 'assignee'),
    rating: firstOf(f, 'rating'),
    created_at: isoFrom(firstOf(row, 'created_on', 'createdOn', 'creationTimestamp')
      || firstOf(f, 'created_on', 'createdOn')),
    /* What joins a lead to the ad that produced it. TeleCRM has no fixed name
       for these — they are workspace custom fields — so the spellings a Meta or
       Google lead form would have written are all accepted. Absent is null, and
       a null here is why a lead shows as unattributed rather than a bug. */
    utm_campaign: firstOf(f, 'utm_campaign', 'utmCampaign', 'campaign', 'Campaign'),
    ad_id: firstOf(f, 'ad_id', 'adId', 'ad', 'adset_id'),
    property: firstOf(f, 'property', 'Property', 'location'),
    raw: row,
  };
}

function actionBody(row = {}, leadId = null) {
  return {
    event_id: firstOf(row, 'id', '_id', 'actionId', 'action_id')
      || (leadId && row.type ? `${leadId}:${row.type}:${firstOf(row, 'created_on', 'createdOn') || ''}` : null),
    lead_id: leadId,
    type: firstOf(row, 'type', 'actionType'),
    at: isoFrom(firstOf(row, 'created_on', 'createdOn', 'performed_at', 'creationTimestamp')),
    performed_by: firstOf(row, 'performed_by', 'performedBy'),
    raw: row,
  };
}

/* The pipeline, fetched once per enterprise per process.
 *
 * `stageType` is an enum of OPEN / WON / LOST on every stage, and each stage
 * carries the statuses that belong to it. So the set of "won" statuses is read
 * from the workspace rather than pattern-matched against words like "Booked" —
 * which would break the first time somebody renames a stage, and break silently,
 * by reporting no deals rather than an error. */
async function pipelineFor(credentials, fetchImpl) {
  const key = `${baseFrom(credentials)}|${credentials.enterpriseId}`;
  if (pipelineCache.has(key)) return pipelineCache.get(key);

  const url = `${baseFrom(credentials)}/enterprise/${enterprisePath(credentials)}/lead-stage-pipeline`;
  const response = await fetchImpl(url, { headers: authHeaders(credentials), method: 'GET' });

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`TeleCRM returned a body that is not JSON for the lead stage pipeline (HTTP ${response.status})`);
  }
  checkForError(payload, response);

  const byStatus = new Map();
  for (const stage of payload.leadStages || []) {
    const type = String(stage.stageType || '').toUpperCase();
    const statuses = [...(stage.activeStatuses || []), ...(stage.archivedStatuses || [])];
    for (const status of statuses) {
      if (status && status.label) byStatus.set(String(status.label).toLowerCase(), type);
    }
  }

  pipelineCache.set(key, byStatus);
  return byStatus;
}

const authHeaders = (credentials) => ({
  authorization: `Bearer ${credentials.apiKey}`,
  'content-type': 'application/json',
});

/* Where a page starts. The response echoes `skip` and `limit` back but the spec
   documents neither as an input, so they are sent as query parameters — the
   only place they can go on a POST whose body is already the filter — and
   paging is driven by counting what came back rather than by trusting the echo.
   If the API ignores them entirely the first page returns everything, the count
   matches, and the loop stops rather than spinning. */
function searchUrl(credentials, { skip = 0, limit = PAGE } = {}) {
  return `${baseFrom(credentials)}/enterprise/${enterprisePath(credentials)}/lead/search`
    + `?limit=${limit}&skip=${skip}`;
}

function actionUrl(credentials, leadId, { skip = 0, limit = PAGE } = {}) {
  return `${baseFrom(credentials)}/enterprise/${enterprisePath(credentials)}/lead/${encodeURIComponent(leadId)}/action/search`
    + `?limit=${limit}&skip=${skip}`;
}

/* One request. `cursor` carries the paging position, and for `lead_event` also
   carries which lead is being walked — see the header note about N+1. */
async function request({
  kind, window, credentials, cursor = null, fetchImpl, pageSize = PAGE,
}) {
  const limit = pageSize || PAGE;
  const range = createdOn(window);
  const fields = range ? { created_on: range } : {};

  if (kind === 'lead' || kind === 'deal') {
    /* `deal` searches the same leads: a deal *is* a lead that reached a WON or
       LOST stage, and there is no second collection to read. The filtering
       happens in `extract`, where the pipeline is known. */
    if (kind === 'deal') await pipelineFor(credentials, fetchImpl);
    return {
      url: searchUrl(credentials, { skip: (cursor && cursor.skip) || 0, limit }),
      method: 'POST',
      headers: authHeaders(credentials),
      body: JSON.stringify({ fields }),
    };
  }

  if (kind === 'lead_event') {
    /* First call: fetch the leads in the window. Their actions are read one
       lead at a time on the calls that follow. */
    if (!cursor) {
      return {
        url: searchUrl(credentials, { skip: 0, limit }),
        method: 'POST',
        headers: authHeaders(credentials),
        body: JSON.stringify({ fields }),
      };
    }
    const leadId = cursor.leads[cursor.at];
    return {
      url: actionUrl(credentials, leadId, { skip: cursor.skip || 0, limit }),
      method: 'POST',
      headers: authHeaders(credentials),
      body: JSON.stringify(range ? { created_on: range } : {}),
    };
  }

  throw new Error(`TeleCRM has no request shape for "${kind}"`);
}

/* TeleCRM answers errors as a body with a message, and the HTTP status is not
   always the whole story — so both are read. A 401 in particular has to say
   which credential is being refused, because this source has two (the token and
   the enterprise id) and only one of them is secret. */
function checkForError(payload, response) {
  const status = response && response.status;
  const message = payload && (payload.message || payload.error
    || (payload.errors && payload.errors[0] && payload.errors[0].message));

  if (status === 401 || status === 403) {
    throw new Error(
      `TeleCRM refused the credential (HTTP ${status}${message ? `: ${message}` : ''}). `
      + 'A token created as "Async" cannot read — the Sync API needs a token created with type Sync.'
    );
  }
  if (status === 404) {
    throw new Error(
      `TeleCRM answered 404${message ? `: ${message}` : ''} — check the enterprise id, `
      + `and that the API base URL is ${BASE} rather than the async host.`
    );
  }
  if (status && status >= 400) throw new Error(`TeleCRM refused the request (HTTP ${status}${message ? `: ${message}` : ''})`);
  if (payload && payload.error) throw new Error(`TeleCRM: ${message}`);
}

/* Rows out, and where the next page starts.
 *
 * `cursor` is read as well as written, which is what lets `lead_event` walk one
 * lead at a time: the position it is at cannot be recovered from the payload,
 * because an action page looks the same whichever lead it belongs to. */
function extract(payload, { kind, cursor = null } = {}) {
  const data = (payload && payload.data) || [];
  const total = payload && Number(payload.total_count);
  const seen = ((cursor && cursor.skip) || 0) + data.length;
  const more = Number.isFinite(total) && seen < total && data.length > 0;

  if (kind === 'lead') {
    return {
      rows: data.map(leadBody).filter((b) => b.lead_id),
      nextCursor: more ? { skip: seen } : null,
    };
  }

  if (kind === 'deal') {
    /* Only leads that have left the OPEN stages. An open lead is not a deal
       that happens to be worth nothing — it is not a deal yet, and emitting one
       would put a zero into every conversion figure that reads this kind. */
    const byStatus = pipelineFromCache();
    const rows = [];
    for (const row of data) {
      const body = leadBody(row);
      if (!body.lead_id) continue;
      const type = byStatus ? byStatus.get(String(body.stage || '').toLowerCase()) : null;
      if (type !== 'WON' && type !== 'LOST') continue;
      rows.push({
        deal_id: body.lead_id,
        lead_id: body.lead_id,
        stage: body.stage,
        /* `won` and `lost` are the words the rest of the app uses; the stage
           label is kept beside it because it is what the operator sees. */
        outcome: type === 'WON' ? 'won' : 'lost',
        updated_at: body.created_at,
        /* No money: TeleCRM's lead has no value field in the documented schema,
           and the PMS folio is the authority on revenue anyway (the precedence
           table gives it `revenue`). A deal that invented an amount here would
           outrank nothing and mislead everything. */
        value: null,
        currency: null,
        raw: row,
      });
    }
    return { rows, nextCursor: more ? { skip: seen } : null };
  }

  if (kind === 'lead_event') {
    /* The first payload is the lead search, not actions. It produces no rows —
       it produces the itinerary. */
    if (!cursor) {
      const leads = data.map(leadIdOf).filter(Boolean);
      return { rows: [], nextCursor: leads.length ? { leads, at: 0, skip: 0 } : null };
    }

    const leadId = cursor.leads[cursor.at];
    const rows = data.map((row) => actionBody(row, leadId)).filter((b) => b.event_id);

    /* More actions for this lead, then the next lead, then done. */
    if (more) return { rows, nextCursor: { ...cursor, skip: seen } };
    const at = cursor.at + 1;
    if (at < cursor.leads.length) return { rows, nextCursor: { leads: cursor.leads, at, skip: 0 } };
    return { rows, nextCursor: null };
  }

  return { rows: [], nextCursor: null };
}

/* The pipeline the current pull loaded. `extract` is synchronous and cannot
   fetch, so `request` warms the cache before the first `deal` page and this
   reads it back. One workspace syncs per runner, so a single entry is the
   normal case; more than one means two enterprises share a process and there is
   no way to tell from a payload which is which — so it declines rather than
   picking, and `extract` then emits no deals instead of the wrong ones. */
function pipelineFromCache() {
  const values = [...pipelineCache.values()];
  return values.length === 1 ? values[0] : null;
}

const pageSizeFor = () => PAGE;

module.exports = {
  id: 'telecrm',
  /* `baseUrl` is deliberately absent: it defaults to the documented host, so a
     connection that predates this file works without being re-entered. */
  requires: ['enterpriseId', 'apiKey'],
  request,
  extract,
  checkForError,
  pageSizeFor,
  baseFrom,
  createdOn,
  leadIdOf,
  leadBody,
  actionBody,
  isoFrom,
  pipelineFor,
  clearPipelineCache,
  BASE,
  PAGE,
  MIN_PAGE,
};
