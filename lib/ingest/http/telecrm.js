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

/* 100 is TeleCRM's documented-by-refusal maximum: asking for 500 returns
   `BAD_REQUEST — Limit should be between 1 and 100`. The spec does not mention
   limit as an input at all, so this is knowledge that only exists here.

   That ceiling is why a wide backfill must be chunked rather than asked for in
   one call: this account creates ~260 leads a day, so thirty days is 78 round
   trips for `lead` and 78 more for `deal`, well past a 60-second invocation.
   `/cron/sync?from=&to=` exists for that. */
const PAGE = 100;
const MIN_PAGE = 25;

/* Whether to walk leads one at a time collecting their actions. Off, for the
   reasons set out where `lead_event` is handled — the walk is written and
   tested, and turning this on is what a smaller account or an account-wide
   action endpoint would need. It is a constant rather than an option because
   nothing should be able to enable it per request and time a sync out. */
const ACTION_WALK = false;

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
    /* **Top level, not inside `fields`.** The spec puts `status` in LeadFields
       and the live API does not: every lead came back with a null stage, which
       silently emptied the deal derivation as well, since that reads status.
       `fields.status` is kept as a fallback because the spec is not wrong for
       every workspace — but the response is the authority. */
    stage: firstOf(row, 'status') || firstOf(f, 'status'),
    owner: firstOf(f, 'assignee') || firstOf(row, 'employeeid'),
    rating: firstOf(row, 'rating') || firstOf(f, 'rating'),
    created_at: isoFrom(firstOf(row, 'created_on', 'createdOn', 'creationTimestamp')
      || firstOf(f, 'created_on', 'createdOn')),
    /* What joins a lead to the ad that produced it.
     *
     * These are workspace *custom* fields, so there is no documented name and
     * no way to know them without looking: this account's Meta lead forms write
     * `facebook_campaign`, and the generic `utm_*` spellings the connector
     * guessed first do not appear on a single one of 779 leads. The guesses
     * stay behind it — another workspace will spell them differently, and a
     * connector that only knows one account is not a connector. */
    utm_campaign: firstOf(f, 'facebook_campaign', 'utm_campaign', 'utmCampaign', 'campaign', 'Campaign'),
    /* Deliberately NOT `facebook_ad_set_id`.
     *
     * The `ad_id` rung matches against Meta's *ad* ids, and an ad set id is a
     * different entity — filling this with one would either never match, or
     * match the wrong thing the day an id collided. `facebook_ad` is a name
     * ("Ad 1"), not an id, so it cannot serve either. Left null, attribution
     * falls to campaign name and phone, which are the rungs that do work. */
    ad_id: firstOf(f, 'facebook_ad_id', 'ad_id', 'adId'),
    adset_id: firstOf(f, 'facebook_ad_set_id'),
    adset_name: firstOf(f, 'facebook_ad_set_name'),
    ad_name: firstOf(f, 'facebook_ad'),
    /* Meta's own id for the lead-form submission. Not our identity — TeleCRM's
       is — but it is the join to Meta's lead records if that is ever pulled. */
    external_lead_id: firstOf(f, 'facebook_lead_id') || firstOf(row, 'leadfbid'),
    property: firstOf(f, 'property', 'Property', 'location'),
    source: firstOf(f, 'source'),
    channel: channelOf(f),
    raw: row,
  };
}

/* Which channel produced a lead, so paid cost can be divided by the leads that
 * paid for it rather than by every lead in the CRM.
 *
 * The CRM holds organic and referral leads beside the paid ones, so a blended
 * CPL of spend ÷ all-leads is not a cost per lead at all — it is a number that
 * falls whenever the website has a good week, which reads as advertising
 * getting cheaper.
 *
 * **An untagged lead is `null`, never "organic".** Nothing here can tell a lead
 * that arrived organically from one whose campaign field was never filled in,
 * and calling the second one organic would quietly credit paid demand to the
 * website. `null` keeps it out of both numerators and visible as unattributed,
 * which is a question somebody can answer; "organic" is an answer nobody
 * checked. */
function channelOf(f = {}) {
  if (f.facebook_campaign || f.facebook_lead_id || f.facebook_ad_set_id) return 'meta';
  const source = String(f.source || '').toLowerCase();
  if (!source) return null;
  if (source.includes('google')) return 'google';
  if (source.includes('facebook') || source.includes('instagram') || source.includes('meta')) return 'meta';
  return 'other';
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

  /* Two shapes, because the documented one is not the one this API returns.
   *
   * The spec describes `leadStages[]`, each with a `stageType` of
   * OPEN/WON/LOST and the statuses nested inside it. The live response has
   * top-level `statuses` and `lostReasons` and no stages at all — so the
   * grouping the spec puts one level up must be read off each status instead.
   * Both are handled: the documented shape is not wrong for every workspace,
   * and this connector should not stop working if they ship it. */
  const record = (label, type) => {
    if (label && type) byStatus.set(String(label).toLowerCase(), String(type).toUpperCase());
  };

  for (const stage of payload.leadStages || payload.stages || []) {
    const type = stage.stageType || stage.type;
    for (const status of [...(stage.activeStatuses || []), ...(stage.archivedStatuses || [])]) {
      record(status && (status.label || status.name), type);
    }
  }

  for (const status of payload.statuses || []) {
    record(
      status && (status.label || status.name || status.status),
      status && (status.stageType || status.type || status.stage || status.category)
    );
  }

  /* A lost reason exists only on a lost lead, so a status that carries one is
     LOST whatever it is called — the fallback for a workspace whose statuses
     do not name their own type. */
  for (const reason of payload.lostReasons || []) {
    record(reason && (reason.label || reason.name), 'LOST');
  }

  /* An empty map is a failure, not an empty pipeline.
   *
   * It used to be cached and returned, and `extract` then found no status in it
   * and emitted no deals — so a pull reported `ok` with zero deals written and
   * nothing anywhere said why. Every won lead in the workspace was invisible
   * and the run log looked clean. The payload's own keys go in the message
   * because the shape is the thing in doubt. */
  if (!byStatus.size) {
    const sample = (payload.statuses || payload.leadStages || payload.stages || [])[0];
    throw new Error(
      'TeleCRM returned a lead stage pipeline with no statuses in it, so no lead can be '
      + `classified won or lost. Payload keys: ${Object.keys(payload || {}).join(', ') || '(none)'}`
      + `; first entry: ${sample ? JSON.stringify(sample).slice(0, 250) : '(none)'}`
    );
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
    /* Declined, and this is a statement about the API rather than about effort.
     *
     * There is no account-wide action endpoint: actions exist only under
     * `/lead/{leadId}/action/search`, one lead at a time. The `actions` key on
     * a searched lead comes back empty on all 779 of this account's leads, so
     * it is not a shortcut. That leaves one request per lead, and this account
     * creates roughly 260 leads a day — a thirty-day window is ~7,800 requests,
     * against a 60-second function ceiling. It does not nearly fit, and the
     * honest failure is here rather than a timeout that takes `lead` and `deal`
     * down with it.
     *
     * Actions arrive by webhook instead (lib/auth/webhooks.js), which is the
     * right shape for them anyway: a first-response time is a fact about a
     * moment, and polling for it a day later measures the poll.
     *
     * If this is ever revisited: it becomes feasible the moment TeleCRM adds an
     * account-wide action search, or if the walk is restricted to leads whose
     * first response is still unknown — which needs the store consulted from
     * inside a pull, and nothing here can do that today. */
    if (!ACTION_WALK) {
      throw new Error(
        'TeleCRM has no account-wide endpoint for actions — they can only be read one lead at a '
        + 'time, which does not fit a sync at this lead volume. Lead events arrive by webhook '
        + 'instead; see the push intake on the Connections screen.'
      );
    }

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
/* The vendor's own words, whatever shape they arrive in.
 *
 * TeleCRM answers a 401 with an *object* under `error`, and reading it as a
 * string printed "[object Object]" — which discards the one piece of
 * information the operator needs and leaves an error that could mean anything.
 * Google's refusals taught the same lesson twice (the message nested in
 * `error.details[].errors[]`); the general rule is that an error body is
 * unstructured until proven otherwise, so anything non-string is serialised
 * rather than concatenated. */
function messageIn(payload) {
  if (!payload) return null;
  const found = payload.message || payload.error
    || (payload.errors && payload.errors[0] && (payload.errors[0].message || payload.errors[0]));
  if (found === null || found === undefined) return null;
  if (typeof found === 'string') return found;
  try {
    return JSON.stringify(found).slice(0, 300);
  } catch (err) {
    return String(found);
  }
}

function checkForError(payload, response) {
  const status = response && response.status;
  const message = messageIn(payload);

  if (status === 401 || status === 403) {
    /* TeleCRM returns ONE code, `NOT_AUTHORIZED`, for two unrelated mistakes —
       a bad token and an enterprise id it cannot find — and its message names
       which. Guessing wrong here is expensive in a specific way: a message
       blaming the token sends somebody to regenerate a credential that was
       always fine, and they can do that three times before TeleCRM stops
       issuing them. So the hint is chosen from what the vendor actually said,
       and when it says neither, it says neither. */
    const namesEnterprise = /enterprise with id/i.test(message || '');
    const hint = namesEnterprise
      ? 'TeleCRM did not recognise the enterprise id — it is the id in your integration URL '
        + '(a short hex string), not the API token and not the two joined together. The token goes in its own field.'
      : 'If the token is right, check it was created with type **Sync**: an "Async" token can only write leads in, never read them out.';

    throw new Error(`TeleCRM refused the credential (HTTP ${status}${message ? `: ${message}` : ''}). ${hint}`);
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
      const f = row.fields || {};
      rows.push({
        deal_id: body.lead_id,
        lead_id: body.lead_id,
        stage: body.stage,
        /* `won` and `lost` are the words the rest of the app uses; the stage
           label is kept beside it because it is what the operator sees. */
        outcome: type === 'WON' ? 'won' : 'lost',
        updated_at: isoFrom(firstOf(f, 'modified_on')) || body.created_at,
        booking_ref: firstOf(f, 'booking_id', 'booking_ref'),
        /* Money, after all.
         *
         * This returned null on the grounds that TeleCRM's documented lead has
         * no value field — true of the spec and false of the workspace, which
         * carries `reservation_value` on every booked lead. Declining a figure
         * the source actually reports is the same failure as inventing one.
         *
         * It is still not the *folio*: the precedence table gives settled
         * revenue to the PMS, so the day one is connected this loses and should.
         * Until then it is the only revenue anyone has, and a deal is exactly
         * the entity meant to carry it. */
        value: firstOf(f, 'reservation_value', 'deal_value', 'value'),
        /* Not read from a field because none carries it. Stated as the
           assumption it is: this account bills in rupees, every other figure on
           every screen is INR, and a currency guessed differently per row would
           be worse than one guessed consistently. */
        currency: 'INR',
        booking_status: firstOf(f, 'booking_status'),
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
