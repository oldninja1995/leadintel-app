/* Sending reports by email — Reports' "Email now" and the Scorecard's "Send".
 *
 * Through the workspace's own Gmail (or Google Workspace) account over SMTP,
 * with an App password stored on the Connections page like every other
 * credential. Nothing here invents a sender: with no Email connection the
 * error says exactly what to add.
 */

const nodemailer = require('nodemailer');

const DEFAULT_HOST = 'smtp.gmail.com';
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const MAX_RECIPIENTS = 20;

/* "a@x.com, b@y.com; c@z.com" → a list, each checked. */
function recipients(raw) {
  const list = String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((a) => !ADDRESS.test(a));
  if (!list.length) throw new Error('add at least one recipient');
  if (bad.length) throw new Error(`not an email address: ${bad.slice(0, 3).join(', ')}`);
  if (list.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} recipients at a time`);
  return [...new Set(list.map((a) => a.toLowerCase()))];
}

/* Gmail's errors are SMTP codes; the two people actually hit are a wrong or
   missing App password and an account without 2-Step Verification. */
function explain(err) {
  const msg = String((err && (err.response || err.message)) || err);
  if (/535|Username and Password not accepted|BadCredentials/i.test(msg)) {
    return 'Gmail refused the login — check the address and that the App password is a 16-letter App password (Google Account → Security → App passwords), not the normal account password';
  }
  if (/534|Application-specific password required/i.test(msg)) {
    return 'Gmail needs an App password for this account — turn on 2-Step Verification, then create one under Google Account → Security → App passwords';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNECTION/i.test(msg)) return `could not reach the mail server (${msg.slice(0, 120)})`;
  return `the mail server refused the message: ${msg.slice(0, 200)}`;
}

async function send({ credentials, to, subject, html, text, attachments = [] }, { transportFor = nodemailer.createTransport } = {}) {
  if (!credentials || !credentials.address || !credentials.appPassword) {
    throw new Error('no email account is connected — add your Gmail address and App password on the Email card in Connections');
  }
  const host = credentials.host || DEFAULT_HOST;
  const transport = transportFor({
    host,
    port: 465,
    secure: true,
    auth: { user: credentials.address, pass: String(credentials.appPassword).replace(/\s+/g, '') },
  });
  const from = credentials.fromName ? `"${String(credentials.fromName).replace(/"/g, '')}" <${credentials.address}>` : credentials.address;
  try {
    const info = await transport.sendMail({ from, to, subject, html, text, attachments });
    return { ok: true, id: info && info.messageId, accepted: (info && info.accepted) || to };
  } catch (err) {
    throw new Error(explain(err));
  }
}

/* ── the message ────────────────────────────────────────────────────────── */

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Email HTML is table-and-inline-style, because most mail clients ignore a
   <style> block and every layout primitive newer than tables. */
function reportEmail(data, { note = '', by = '', link = '' } = {}) {
  const kpiCells = data.kpis.map((k) => `<td style="padding:10px 12px;border:1px solid #e1def2;border-radius:6px;vertical-align:top;width:25%;">`
    + `<div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#6b7180;">${esc(k.label)}</div>`
    + `<div style="font-size:19px;font-weight:600;color:#1f2330;margin-top:2px;">${esc(k.value)}</div>`
    + `${k.delta ? `<div style="font-size:11px;color:#6d5bd0;">${esc(k.delta)}</div>` : ''}</td>`);
  const kpiRows = [];
  for (let i = 0; i < kpiCells.length; i += 4) kpiRows.push(`<tr>${kpiCells.slice(i, i + 4).join('')}</tr>`);
  const items = (list) => list.map((t) => `<p style="margin:0 0 8px;"><strong>${esc(t.name)}</strong><br><span style="color:#6b7180;">${esc(t.val)}</span></p>`).join('');
  const camps = data.campaigns.slice(0, 12).map((c) => `<tr><td style="padding:5px 8px;border-bottom:1px solid #eee;">${esc(c.name)}</td><td style="padding:5px 8px;border-bottom:1px solid #eee;">${esc(c.platform)}</td><td style="padding:5px 8px;border-bottom:1px solid #eee;">${esc(c.spend)}</td><td style="padding:5px 8px;border-bottom:1px solid #eee;">${esc(c.leads)}</td><td style="padding:5px 8px;border-bottom:1px solid #eee;">${esc(c.bookings)}</td><td style="padding:5px 8px;border-bottom:1px solid #eee;">${esc(c.roas)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5fb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#1f2330;">
<tr><td style="padding:22px 24px 8px;border-bottom:2px solid #6d5bd0;"><div style="font-size:21px;font-weight:700;">${esc(data.title)}</div><div style="color:#6d5bd0;font-weight:600;">${esc(data.period)}</div></td></tr>
${note ? `<tr><td style="padding:14px 24px 0;"><div style="background:#f4f3fa;border-left:3px solid #6d5bd0;padding:10px 12px;">${esc(note).replace(/\n/g, '<br>')}${by ? `<div style="color:#6b7180;font-size:11px;margin-top:4px;">— ${esc(by)}</div>` : ''}</div></td></tr>` : ''}
${kpiRows.length ? `<tr><td style="padding:16px 24px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="6">${kpiRows.join('')}</table></td></tr>` : ''}
${data.summary ? `<tr><td style="padding:10px 24px;"><div style="font-weight:700;color:#3b2f8f;margin-bottom:4px;">Summary</div>${esc(data.summary)}</td></tr>` : ''}
${data.top.length || data.worst.length ? `<tr><td style="padding:10px 24px;"><table role="presentation" width="100%"><tr><td valign="top" width="50%" style="padding-right:10px;"><div style="font-weight:700;color:#1f8f4e;margin-bottom:6px;">Top performers</div>${items(data.top)}</td><td valign="top" width="50%"><div style="font-weight:700;color:#c0392b;margin-bottom:6px;">Needs attention</div>${items(data.worst)}</td></tr></table></td></tr>` : ''}
${data.recs.length ? `<tr><td style="padding:10px 24px;"><div style="font-weight:700;color:#3b2f8f;margin-bottom:4px;">Recommendations</div><ul style="margin:0;padding-left:18px;">${data.recs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></td></tr>` : ''}
${camps ? `<tr><td style="padding:10px 24px;"><div style="font-weight:700;color:#3b2f8f;margin-bottom:4px;">Campaigns</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;"><tr style="color:#6b7180;"><td style="padding:5px 8px;">Campaign</td><td style="padding:5px 8px;">Platform</td><td style="padding:5px 8px;">Spend</td><td style="padding:5px 8px;">Leads</td><td style="padding:5px 8px;">Bookings</td><td style="padding:5px 8px;">ROAS</td></tr>${camps}</table></td></tr>` : ''}
<tr><td style="padding:14px 24px 22px;color:#6b7180;font-size:11px;">Sent from LeadIntel · generated ${esc(data.generated)}${link ? ` · <a href="${esc(link)}" style="color:#6d5bd0;">open it live</a>` : ''}. The Excel file attached carries every figure.</td></tr>
</table></td></tr></table></body></html>`;
  const textLines = [data.title, data.period, '', ...(note ? [note, by ? `— ${by}` : '', ''] : []),
    ...data.kpis.map((k) => `${k.label}: ${k.value}${k.delta ? ` (${k.delta})` : ''}`), '',
    ...(data.summary ? ['Summary', data.summary, ''] : []),
    ...(data.top.length ? ['Top performers', ...data.top.map((t) => `- ${t.name}: ${t.val}`), ''] : []),
    ...(data.worst.length ? ['Needs attention', ...data.worst.map((t) => `- ${t.name}: ${t.val}`), ''] : []),
    ...(data.recs.length ? ['Recommendations', ...data.recs.map((r) => `- ${r}`), ''] : []),
    `Sent from LeadIntel · ${data.generated}${link ? ` · ${link}` : ''}`];
  return { subject: `${data.title} · ${data.period}`, html, text: textLines.join('\n') };
}

module.exports = { send, recipients, reportEmail, explain, DEFAULT_HOST };
