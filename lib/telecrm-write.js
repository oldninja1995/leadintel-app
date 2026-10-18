/* Creating a lead in TeleCRM, from Lead Intelligence's "New lead" form.
 *
 * TeleCRM's async API (docs.telecrm.in, "Telecrm Async APIs"): one endpoint,
 * `POST /enterprise/{enterpriseId}/autoupdatelead` on next-api.telecrm.in,
 * Bearer auth with a token of type Async, body `{ fields: {...} }`. It creates
 * the lead, or updates the one with the same phone — phone is the workspace's
 * unique identifier. Field keys are the workspace's own apiNames.
 *
 * The read connector's token cannot do this; the connection carries a second,
 * optional `writeKey` for it. */

const HOST = 'https://next-api.telecrm.in';

/* TeleCRM's examples write phones as country code + number, digits only. A
   ten-digit number is taken as Indian, which is this workspace's market. */
function phoneFor(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/* Only the fields the form offers, under the workspace's apiNames, and only
   when filled — an empty string would blank a field on an existing lead. */
function fieldsFrom(form) {
  const out = {};
  const put = (key, value) => { const v = String(value || '').trim(); if (v) out[key] = v; };
  put('name', form.name);
  out.phone = phoneFor(form.phone);
  put('email', form.email);
  put('source', form.source);
  put('check-in_date', form.checkIn);
  put('message', form.message);
  return out;
}

function validate(form) {
  const problems = [];
  if (!String(form.name || '').trim()) problems.push('a name');
  const phone = phoneFor(form.phone);
  if (phone.length < 11 || phone.length > 15) problems.push('a phone number with at least 10 digits');
  return problems;
}

async function createLead({ credentials, form, fetchImpl = fetch }) {
  if (!credentials || !credentials.enterpriseId) throw new Error('TeleCRM is not connected');
  if (!credentials.writeKey) {
    throw new Error('creating a lead needs a TeleCRM Async token — add one on the TeleCRM card in Connections ("Async token (to create leads)")');
  }
  const problems = validate(form);
  if (problems.length) throw new Error(`a new lead needs ${problems.join(' and ')}`);

  const res = await fetchImpl(`${HOST}/enterprise/${encodeURIComponent(credentials.enterpriseId)}/autoupdatelead`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credentials.writeKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: fieldsFrom(form) }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try { const j = JSON.parse(text); message = j.message || j.error || message; } catch (err) { /* not JSON */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`TeleCRM refused the Async token (HTTP ${res.status}${message ? `: ${message}` : ''}) — check it was created with type Async`);
    }
    throw new Error(`TeleCRM did not create the lead (HTTP ${res.status}${message ? `: ${message}` : ''})`);
  }
  return { ok: true, phone: fieldsFrom(form).phone };
}

module.exports = { createLead, fieldsFrom, phoneFor, validate, HOST };
