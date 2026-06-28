// SMS notifications via Twilio.
// Configure with env vars:
//   TWILIO_ACCOUNT_SID  - your Twilio Account SID
//   TWILIO_AUTH_TOKEN   - your Twilio Auth Token
//   TWILIO_FROM_NUMBER  - your Twilio phone number, e.g. "+15550001234"
// If any are missing, sends are skipped gracefully (logged only),
// so the app runs fine without SMS configured.

const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID  || '';
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN   || '';
const TWILIO_FROM_NUMBER  = process.env.TWILIO_FROM_NUMBER  || '';

const enabled = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 10) return '+' + digits;
  return null;
}

// Fire-and-forget: never throws into the caller; logs failures.
async function sendSms(toRaw, body) {
  if (!toRaw || !body) return;
  const to = normalizePhone(toRaw);
  if (!to) return;
  if (!enabled) {
    console.log(`[sms skipped — no Twilio config] to=${to} body="${body.slice(0, 60)}"`);
    return;
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ From: TWILIO_FROM_NUMBER, To: to, Body: body });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
      body: params.toString(),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[sms] Twilio error ${res.status}: ${txt}`);
    }
  } catch (e) {
    console.error('[sms] send failed:', e.message);
  }
}

function notifySms(toRaw, body) {
  sendSms(toRaw, body);
}

module.exports = { notifySms, smsEnabled: enabled };
