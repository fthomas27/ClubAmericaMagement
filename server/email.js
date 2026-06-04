// Email notifications via Resend (https://resend.com).
// Configure with env vars:
//   RESEND_API_KEY  - your Resend API key
//   MAIL_FROM       - verified sender, e.g. "Club America <noreply@yourdomain.org>"
//   APP_URL         - public URL of the app, used in links (optional)
// If RESEND_API_KEY is missing, sends are skipped gracefully (logged only),
// so the app runs fine without email configured.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Club America <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || '';

const enabled = !!RESEND_API_KEY;

// Escape user-supplied strings before inserting into HTML email bodies.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(title, bodyHtml) {
  const link = APP_URL
    ? `<p style="margin-top:20px"><a href="${APP_URL}" style="background:#CC1C2E;color:#F5F0E8;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open Club America</a></p>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#0A1628;color:#F5F0E8;padding:24px;border-radius:12px">
    <div style="font-size:22px;color:#C9A84C;font-weight:bold;margin-bottom:8px">Club America</div>
    <div style="font-size:18px;margin-bottom:8px">${title}</div>
    <div style="color:#cbd5e1;line-height:1.5">${bodyHtml}</div>${link}
  </div>`;
}

// Fire-and-forget: never throws into the caller; logs failures.
async function sendEmail(to, subject, title, bodyHtml) {
  if (!to) return;
  if (!enabled) {
    console.log(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html: wrap(title, bodyHtml) }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[email] Resend error ${res.status}: ${txt}`);
    }
  } catch (e) {
    console.error('[email] send failed:', e.message);
  }
}

function notify(to, subject, title, bodyHtml) {
  // Don't block the request; let it run in the background.
  sendEmail(to, subject, title, bodyHtml);
}

module.exports = { notify, emailEnabled: enabled, escHtml };
