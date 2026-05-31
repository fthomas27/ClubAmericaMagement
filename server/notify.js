// Notifications — Slack first (just needs a webhook), email optional.
//
// Env vars:
//   SLACK_WEBHOOK_URL  - a Slack Incoming Webhook; messages post to its channel.
//   RESEND_API_KEY     - (optional) also email the relevant person via Resend.
//   MAIL_FROM          - sender for emails (default: Resend test sender).
//   APP_URL            - public app URL, appended to messages when set.
//
// Everything is fire-and-forget and degrades gracefully: if nothing is
// configured, notifications are simply logged and skipped.

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Club America <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || '';

const slackEnabled = !!SLACK_WEBHOOK_URL;
const emailEnabled = !!RESEND_API_KEY;

async function postSlack(text) {
  if (!slackEnabled) return;
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: APP_URL ? `${text}\n${APP_URL}` : text }),
    });
    if (!res.ok) console.error(`[notify] Slack error ${res.status}: ${await res.text().catch(() => '')}`);
  } catch (e) {
    console.error('[notify] Slack failed:', e.message);
  }
}

async function sendEmail(to, subject, html) {
  if (!emailEnabled || !to) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
    if (!res.ok) console.error(`[notify] Resend error ${res.status}: ${await res.text().catch(() => '')}`);
  } catch (e) {
    console.error('[notify] email failed:', e.message);
  }
}

function emailBody(title, body) {
  return `<div style="font-family:Arial,sans-serif"><h2 style="color:#CC1C2E">${title}</h2><p>${body}</p>${APP_URL ? `<p><a href="${APP_URL}">Open Club America</a></p>` : ''}</div>`;
}

// One channel post per event; optional emails to the listed addresses.
function dispatch(slackText, { subject, title, body, emails = [] } = {}) {
  if (!slackEnabled && !emailEnabled) {
    console.log(`[notify skipped — nothing configured] ${slackText}`);
    return;
  }
  postSlack(slackText);
  if (subject) for (const e of emails) sendEmail(e, subject, emailBody(title || subject, body || ''));
}

// ---- Semantic events --------------------------------------------------------
function taskAssigned({ assigneeName, assigneeEmail, assignerName, taskName }) {
  dispatch(`:clipboard: *${assigneeName}* was assigned a task by ${assignerName}: *${taskName}*`,
    { subject: 'New task assigned to you', title: 'You have a new task',
      body: `${assignerName} assigned you the task <b>${taskName}</b>.`, emails: [assigneeEmail] });
}

function taskNeedsApproval({ approverName, approverEmail, requesterName, ownerName, taskName }) {
  dispatch(`:hourglass_flowing_sand: ${requesterName} wants to assign *${ownerName}* the task *${taskName}* — needs approval${approverName ? ` from ${approverName}` : ''}.`,
    { subject: 'A task needs your approval', title: 'Task awaiting your approval',
      body: `${requesterName} wants to assign <b>${ownerName}</b> the task <b>${taskName}</b>. Approve it in Pending Approvals.`, emails: [approverEmail] });
}

function newSubmission({ type, name, grade, email, message, recipientEmails = [] }) {
  const label = type === 'board' ? 'board application' : 'club-join request';
  dispatch(`:wave: New ${label}: *${name}*${grade ? ` (grade ${grade})` : ''} — ${email}${message ? ` — “${message}”` : ''}`,
    { subject: `New ${label}`, title: `New ${label}`,
      body: `<b>${name}</b>${grade ? ` (grade ${grade})` : ''} submitted a ${label}.<br/>Email: ${email}${message ? `<br/>Message: ${message}` : ''}<br/><br/>See it in the Get Involved inbox.`,
      emails: recipientEmails });
}

module.exports = { taskAssigned, taskNeedsApproval, newSubmission, slackEnabled, emailEnabled };
