// The MCP SDK's Streamable HTTP transport (server/mcp.js) calls the Web
// Crypto API as a bare global (`crypto.randomUUID()`), not `require('crypto')`.
// That global is auto-populated on newer Node runtimes but NOT on older ones
// (e.g. Node 18 without --experimental-global-webcrypto) — on those it throws
// `ReferenceError: crypto is not defined`, which broke every MCP tool call in
// production. Polyfill it from Node's own crypto module before anything else
// loads, so it's always defined regardless of the exact Node version the host
// runs. Guarded so it's a no-op where the global already exists.
if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const geoip = require('geoip-lite');

// Keep a single stray error from taking the whole process down (which makes the
// host restart the app — the "crash then reboot and load" loop). We log it and
// stay up; Express request errors are already handled per-route below.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// APP_URL must be a full origin ("https://example.org"). A bare hostname is an
// easy misconfig that breaks Stripe checkout ("Invalid URL: An explicit scheme
// … must be provided") and email links, so normalize it before any module
// (notably ./email) reads it.
if (process.env.APP_URL && !/^https?:\/\//i.test(process.env.APP_URL)) {
  process.env.APP_URL = 'https://' + process.env.APP_URL.replace(/^\/+/, '');
}

const Stripe = require('stripe');
const { db, init, seed } = require('./db');
const { fetchUpcoming, clearCache } = require('./calendar');
const { notify, escHtml } = require('./email');
const { analyzeTeamHealth, chatWithAI, chatWithHowTo, aiEnabled } = require('./ai');
const { registerMcpEndpoint } = require('./mcp');
const {
  signToken,
  publicUser,
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  JWT_SECRET,
} = require('./auth');

init();
const seeded = seed();

// ---- Stripe (merch shop payments) -------------------------------------------
// Configure with STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY. When unset, the
// shop catalog still browses but no orders can be placed — all payment goes
// through Stripe-hosted Checkout.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
// Test-mode keys decline every real card ("Your card was declined") — only
// Stripe's fake test numbers work. Surface that loudly so a test key never
// masquerades as a broken shop in production.
const STRIPE_TEST_MODE = /^(sk|rk)_test_/.test(STRIPE_SECRET_KEY);
if (STRIPE_TEST_MODE) {
  console.warn('[stripe] TEST-mode key configured — real cards will be DECLINED. Use live keys (sk_live_…) in production.');
}
const STUDENT_EMAIL_RE = /^[^@\s]+@pcstudents\.us$/i;

// ---- Telegram DM notifications ----------------------------------------------
// Board members can link their Telegram to their account (Profile → Connect
// Telegram) and then receive a private DM for every in-app notification —
// tasks assigned to them, orders placed, forms submitted, and so on. Set up
// via BotFather: create a bot, then configure these three env vars. When
// TELEGRAM_BOT_TOKEN is unset the whole feature quietly disables itself and
// the "Connect" UI shows a "not set up yet" note instead.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
// Guards the public webhook URL so only Telegram (which knows the secret path)
// can post updates. Falls back to a token-derived value if not set explicitly.
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ||
  (TELEGRAM_BOT_TOKEN ? crypto.createHash('sha256').update('tg-webhook:' + TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 32) : '');
const telegramEnabled = () => !!TELEGRAM_BOT_TOKEN;

// Fire-and-forget send of a Telegram message. Never throws, never blocks the
// request that triggered it.
function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId || !text) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  }).then((r) => { if (!r.ok) return r.text().then((t) => console.warn('[telegram] send failed:', r.status, t.slice(0, 200))); })
    .catch((e) => console.warn('[telegram] send error:', e.message));
}

// Same send, but resolves to the sent message's id (or '' on any failure).
// Asking a question needs that id: a Telegram reply carries the id of the
// message it answers, which is what tells a bare "yes" which sign-up it means
// when several are awaiting an answer at once.
async function sendTelegramAsking(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId || !text) return '';
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!r.ok) {
      console.warn('[telegram] ask failed:', r.status, (await r.text()).slice(0, 200));
      return '';
    }
    const j = await r.json();
    return String((j && j.result && j.result.message_id) || '');
  } catch (e) {
    console.warn('[telegram] ask error:', e.message);
    return '';
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway's proxy

// Security headers (no helmet dependency needed).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Download-Options', 'noopen');
  res.set('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

// CORS: derive the allowed origin from the actual Host header so Railway's
// dynamic URLs work without APP_URL needing to be exactly right.
// Modern browsers send Origin even on same-origin fetch, so we need this.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next(); // same-origin or server-to-server, no header needed

  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.secure ? 'https' : 'http');
  const selfOrigin = req.headers.host ? `${proto}://${req.headers.host}` : null;

  const norm = (u) => (u || '').replace(/\/$/, '');
  const allowed = new Set(['http://localhost:3000', 'http://localhost:8080']);
  if (selfOrigin) allowed.add(norm(selfOrigin));
  if (process.env.APP_URL) allowed.add(norm(process.env.APP_URL));

  if (allowed.has(norm(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } else {
    console.warn(`[CORS] blocked origin: ${origin}`);
  }
  next();
});
// Stripe webhook — MUST be mounted before the JSON body parser so it receives
// the raw request body for signature verification. This is the source of truth
// for payment success: it finalizes any paid order the buyer's browser didn't
// manage to record (e.g. they closed the tab right after paying).
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
app.post('/api/shop/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).end();
  if (!STRIPE_WEBHOOK_SECRET) {
    // Never trust an unsigned event — refuse until the signing secret is set.
    console.warn('[stripe webhook] STRIPE_WEBHOOK_SECRET not set; rejecting event.');
    return res.status(400).end();
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[stripe webhook] signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    // checkout.session.completed is the source of truth for a hosted-Checkout
    // sale: it carries the buyer contact + shipping Stripe collected. Re-retrieve
    // the session so contact/address fields are fully populated, then record the
    // order (idempotent — a no-op if the browser's confirm-checkout beat us).
    // async_payment_succeeded covers delayed-notification methods (e.g. bank
    // debits): their 'completed' event arrives while payment_status is still
    // 'unpaid', so the order is only recordable once this second event fires.
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const full = await stripe.checkout.sessions.retrieve(event.data.object.id);
      recordCheckoutSession(full);
    } else if (event.type === 'checkout.session.async_payment_failed') {
      console.warn('[stripe webhook] async payment failed for session', event.data.object.id, '— no order recorded.');
    }
  } catch (e) {
    console.error('[stripe webhook] handler error:', e.message);
    return res.status(500).end(); // let Stripe retry
  }
  res.json({ received: true });
});

// Keep the global body limit small (photo uploads get a larger parser).
app.use((req, res, next) => {
  const isProfilePhoto = req.method === 'PUT' && req.path === '/api/me/profile';
  const isEventPhoto = req.method === 'POST' && req.path === '/api/event-photos';
  const isIgHighlight = req.method === 'POST' && req.path === '/api/instagram-highlights';
  const isTestimonial = (req.method === 'POST' || req.method === 'PATCH') &&
    (req.path === '/api/admin/testimonials' || req.path.startsWith('/api/admin/testimonials/') ||
     req.path === '/api/public/testimonial-submit' || req.path.startsWith('/api/public/testimonial-submit/'));
  const isMerchItem = (req.method === 'POST' || req.method === 'PATCH') &&
    (req.path === '/api/shop/admin/items' || /^\/api\/shop\/admin\/items\/\d+$/.test(req.path));
  // Speaker applications can carry a completed PDF form as a base64 data URL
  // (5 MB file ≈ 7 MB of JSON once base64-encoded).
  const isSpeakerApply = req.method === 'POST' && req.path === '/api/public/speaker-apply';
  // MCP tool calls (remote Claude connector) carry JSON-RPC bodies that can
  // exceed the tight default — task batches, long descriptions, etc.
  const isMcp = req.path.startsWith('/mcp/');
  const limit = isSpeakerApply ? '8mb'
    : isProfilePhoto || isEventPhoto || isIgHighlight || isTestimonial || isMerchItem ? '6mb'
    : isMcp ? '2mb' : '50kb';
  express.json({ limit })(req, res, next);
});

// Pre-computed bcrypt hash used to spend ~the same time on logins for unknown
// usernames as for real ones, so timing can't be used to enumerate accounts.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('club-america-dummy-password', 10);

const STATUSES = ['Not Started', 'In Progress', 'Complete'];
const ROLES = ['admin', 'manager', 'member'];
const GRADES = ['9', '10', '11', '12'];

// Allowed roster pipeline transitions. A member may move forward, be declined,
// or be reactivated back to Prospect — but cannot skip straight from Prospect to
// Onboarded without being contacted first.
//
// 'Pending' is the entry state for self-service submissions (someone filled out
// the public /join form themselves). Nothing reaches the live pipeline until a
// roster manager approves it, at which point it moves to Onboarded (or is routed
// back to Prospect / Declined).
const ROSTER_TRANSITIONS = {
  Pending:   ['Onboarded', 'Prospect', 'Declined'],
  Prospect:  ['Contacted', 'Declined'],
  Contacted: ['Onboarded', 'Declined', 'Prospect'],
  Onboarded: ['Contacted', 'Declined', 'Inactive'],
  Declined:  ['Prospect', 'Contacted'],
  // Inactive members sit in a 30-day grace window; they can be reactivated
  // (back to Onboarded, e.g. when marked present again) or auto-purged.
  Inactive:  ['Onboarded', 'Declined'],
};
function isValidRosterTransition(from, to) {
  if (from === to) return true;
  return !!(ROSTER_TRANSITIONS[from] && ROSTER_TRANSITIONS[from].includes(to));
}

// ---- in-app notifications ---------------------------------------------------
// Delivered in the app's notification bell, independent of email — so members
// always find out about new tasks/approvals even when RESEND_API_KEY is unset.
function pushNotification(userId, message, link = '', type = 'info') {
  if (!userId || !message) return;
  try {
    db.prepare('INSERT INTO notifications (userId, message, link, type) VALUES (?, ?, ?, ?)')
      .run(userId, String(message).slice(0, 500), String(link || '').slice(0, 200), type);
  } catch (e) {
    console.error('[notification] insert failed:', e.message);
  }
  // Mirror to Telegram for members who've linked their account. Guarded so a
  // Telegram outage can never affect the in-app notification above.
  if (telegramEnabled()) {
    try {
      const row = db.prepare("SELECT telegramChatId FROM users WHERE id = ?").get(userId);
      if (row && row.telegramChatId) {
        const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
        sendTelegram(row.telegramChatId, `🔔 ${message}${appUrl ? `\n\nOpen the portal: ${appUrl}` : ''}`);
      }
    } catch (e) { console.warn('[telegram] notify lookup failed:', e.message); }
  }
}

// ---- approval / review audit log --------------------------------------------
function logApproval(entityType, entityId, action, actor, detail = '') {
  try {
    db.prepare(`INSERT INTO approval_log (entityType, entityId, action, actorId, actorName, detail)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(entityType, Number(entityId), action,
           actor ? actor.id : null, actor ? actor.displayName : '',
           String(detail || '').slice(0, 500));
  } catch (e) {
    console.error('[approval-log] insert failed:', e.message);
  }
}

// ---- weekly check-in window -------------------------------------------------
// Check-ins are due every Friday. The "week" runs Saturday→Friday and is keyed
// by that Friday's date, so everyone is expected to submit one each Friday.
function currentCheckinWeek(d = new Date()) {
  const day = d.getUTCDay();            // 0 = Sun … 6 = Sat (UTC)
  const offset = (5 - day + 7) % 7;    // days until this week's Friday
  const friday = new Date(d);
  friday.setUTCDate(d.getUTCDate() + offset);
  return friday.toISOString().slice(0, 10);
}

// ---- simple in-memory rate limiter (per IP) ---------------------------------
const rateBuckets = new Map();
function rateLimit({ windowMs, max, name = '' }) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = name + '|' + ip;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      const retry = Math.ceil((bucket.reset - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}
// Periodically drop expired buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
}, 10 * 60 * 1000).unref?.();

// ---- helpers ----------------------------------------------------------------
// Accept only safe raster image data URLs for stored photos. Anything else
// (notably image/svg+xml, which renders as an active document) is dropped to ''
// so it can never be persisted and later served/embedded.
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif);base64,/;
function cleanPhotoDataUrl(photo) {
  const p = String(photo || '').trim();
  if (!p) return '';
  return SAFE_IMAGE_DATA_URL.test(p) ? p.slice(0, 8 * 1024 * 1024) : '';
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function directReports(managerId) {
  return db.prepare('SELECT * FROM users WHERE managerId = ? ORDER BY displayName').all(managerId);
}
function isManagerOf(viewer, targetId) {
  const target = getUser(targetId);
  return target && target.managerId === viewer.id;
}
// Who can view (and assign to) a given user's task page.
function canViewTasksOf(viewer, targetId) {
  if (viewer.id === targetId) return true;
  if (viewer.role === 'admin') return true;
  return isManagerOf(viewer, targetId);
}
// Re-derive role: anyone with reports is at least a manager (admins stay admin).
function refreshRole(userId) {
  const u = getUser(userId);
  if (!u || u.role === 'admin') return;
  const reports = directReports(userId).length;
  const newRole = reports > 0 ? 'manager' : 'member';
  if (newRole !== u.role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, userId);
  }
}

function taskWithNames(t) {
  if (!t) return null;
  const owner = t.userId ? getUser(t.userId) : null;
  const assigner = t.assignedById ? getUser(t.assignedById) : null;
  return {
    ...t,
    ownerName: owner ? owner.displayName : null,
    assignedByName: assigner ? assigner.displayName : 'System',
  };
}

// Drop an auto-generated to-do onto a user's task page — used when a public
// submission or internal request is routed to someone (e.g. a grade rep gets
// "Reach out to new member ___"). Lands pre-approved with no assigner, so it
// shows up immediately as "Assigned by System".
function createAutoTask(userId, name, description) {
  try {
    db.prepare(`INSERT INTO tasks (userId, name, description, status, assignedById, approvalStatus)
                VALUES (?, ?, ?, 'Not Started', NULL, 'approved')`)
      .run(userId, String(name).trim().slice(0, 300), String(description || '').trim().slice(0, 5000));
  } catch (e) {
    console.error('[auto-task] insert failed:', e.message);
  }
}

function getPageSettings(userId) {
  const row = db.prepare('SELECT * FROM user_page_settings WHERE userId = ?').get(userId);
  if (!row) return {
    userId,
    bannerEnabled: false, bannerTitle: '', bannerUrl: '', bannerLinks: [],
    formEnabled: false, formTitle: '', formFields: [],
    announcementEnabled: false, announcementText: '',
    bioEnabled: false, bioText: '',
  };
  let formFields = [];
  try { formFields = JSON.parse(row.formFields || '[]'); } catch (_) {}
  let bannerLinks = [];
  try { bannerLinks = JSON.parse(row.bannerLinks || '[]'); } catch (_) {}
  if (!Array.isArray(bannerLinks)) bannerLinks = [];
  bannerLinks = bannerLinks
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({ title: String(l.title || ''), url: String(l.url || '') }));
  // Backward compatibility: promote a legacy single banner (bannerTitle/bannerUrl)
  // into the multi-link array when no links have been configured yet.
  if (bannerLinks.length === 0 && (row.bannerTitle || row.bannerUrl)) {
    bannerLinks = [{ title: row.bannerTitle || '', url: row.bannerUrl || '' }];
  }
  return {
    ...row,
    bannerEnabled: !!row.bannerEnabled,
    formEnabled: !!row.formEnabled,
    announcementEnabled: !!row.announcementEnabled,
    bioEnabled: !!row.bioEnabled,
    formFields,
    bannerLinks,
  };
}

// ---- Auth -------------------------------------------------------------------
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 40, name: 'login' }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase().trim());
  // Always run a bcrypt comparison, even when the user is unknown, so response
  // timing doesn't reveal whether a username exists (enumeration defense).
  const hashToCheck = user ? user.passwordHash : DUMMY_PASSWORD_HASH;
  const passwordOk = bcrypt.compareSync(String(password), hashToCheck);
  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  try {
    // req.ip is derived from the trusted proxy hop; the raw X-Forwarded-For
    // header is client-controlled and easily spoofed, so don't log it directly.
    const ip = String(req.ip || '').trim();
    db.prepare('INSERT INTO login_logs (userId, username, ipAddress) VALUES (?, ?, ?)').run(user.id, user.username, ip);
  } catch (_) {}
  // Remember this browser's site-visit id as belonging to a board member so
  // Site Activity can exclude its traffic — including views it logged in the
  // past, before the browser was ever marked.
  try {
    const vid = String((req.body || {}).visitorId || '').trim().slice(0, 64);
    if (vid) db.prepare('INSERT OR IGNORE INTO internal_visitors (visitorId, userId) VALUES (?, ?)').run(vid, user.id);
  } catch (_) {}
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/change-password', authenticate, rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'change-password' }), (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (newPassword === req.user.username) {
    return res.status(400).json({ error: 'New password cannot be the same as your default (username)' });
  }
  const hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare('UPDATE users SET passwordHash = ?, firstLogin = 0 WHERE id = ?').run(hash, req.user.id);
  const updatedUser = getUser(req.user.id);
  res.json({ ok: true, user: publicUser(updatedUser), token: signToken(updatedUser) });
});

app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: publicUser(getUser(req.user.id)) });
});

// ---- Public homepage content (no auth) --------------------------------------
function getHome() {
  const row = db.prepare('SELECT meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, donationUrl, instagramPosts, aboutText, homeAnnouncement, homeAnnouncementEnabled, announcementPostedAt, updatedAt FROM site_settings WHERE id = 1').get();
  // Auto-expire the announcement after 7 days.
  let announcementEnabled = !!row.homeAnnouncementEnabled;
  if (announcementEnabled && row.announcementPostedAt) {
    const ageMs = Date.now() - new Date(row.announcementPostedAt + 'Z').getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      announcementEnabled = false;
      db.prepare("UPDATE site_settings SET homeAnnouncementEnabled = 0 WHERE id = 1").run();
    }
  }
  let instagramPosts = [];
  try { instagramPosts = JSON.parse(row.instagramPosts || '[]'); } catch (_) {}
  return { ...row, podcastEnabled: !!row.podcastEnabled, homeAnnouncementEnabled: announcementEnabled, instagramPosts };
}
app.get('/api/home', async (req, res) => {
  const home = getHome();
  let events = [];
  try { events = await fetchUpcoming(home.calendarUrl, 3); } catch (_) {}
  // Don't leak the raw calendar URL to the public payload.
  const { calendarUrl, ...publicHome } = home;
  // Attach upcoming volunteer events (enabled, future) with per-role signup counts.
  const volunteerEvents = db.prepare(`
    SELECT ve.id, ve.icalUid, ve.title, ve.startDate,
      (SELECT COUNT(*) FROM volunteer_signups vs WHERE vs.eventId = ve.id AND vs.status = 'confirmed') AS confirmedCount,
      (SELECT COALESCE(SUM(vr2.cap),0) FROM volunteer_roles vr2 WHERE vr2.eventId = ve.id) AS totalCap
    FROM volunteer_events ve
    WHERE ve.volunteersEnabled = 1 AND ve.startDate >= strftime('%Y-%m-%dT%H:%M', 'now', '-1 hour')
    ORDER BY ve.startDate ASC
  `).all();
  const memberCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  res.json({ home: { ...publicHome, calendarConfigured: !!calendarUrl, memberCount }, events, volunteerEvents });
});

// Public board roster for the "Meet the Board" page (no private info, no auth).
// Filtered to bigBoard users so only actual board leaders appear publicly.
// Returns hasPhoto (boolean) instead of the full base64 blob to keep the payload small.
app.get('/api/board', (req, res) => {
  const members = db
    .prepare("SELECT id, displayName, title, role, grade, managerId, bio, bigBoard, photo FROM users WHERE username != 'logistics' ORDER BY displayName")
    .all()
    .map(({ photo, ...m }) => ({ ...m, bigBoard: !!m.bigBoard, hasPhoto: !!photo }));
  res.json({ members });
});

// Serves a single user's profile photo. Every board member now appears on the
// public "Meet the Board" org chart, so their photos are served with no auth.
// The hidden 'logistics' system account is never a real board member, so its
// photo (if any) still requires a valid session.
app.get('/api/users/:id/photo', (req, res) => {
  const row = db.prepare('SELECT photo, username FROM users WHERE id = ?').get(Number(req.params.id));
  if (!row || !row.photo) return res.status(404).end();
  if (row.username === 'logistics') {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    let valid = false;
    if (token) { try { jwt.verify(token, JWT_SECRET); valid = true; } catch (_) {} }
    if (!valid) return res.status(401).end();
  }
  // photo is stored as a data URL: "data:image/jpeg;base64,..."
  // Only serve safe raster types — never echo a stored MIME like image/svg+xml,
  // which the browser would render as an active document (script execution).
  const m = String(row.photo).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(m[2], 'base64'));
});

// Public "Get Involved" submission (club-join or board application). No auth.
app.post('/api/submissions', rateLimit({ windowMs: 60 * 60 * 1000, max: 25, name: 'submissions' }), (req, res) => {
  let { type, name, email, grade, message } = req.body || {};
  type = type === 'board' ? 'board' : 'club';
  name = String(name || '').trim().slice(0, 120);
  email = String(email || '').trim().slice(0, 200);
  grade = String(grade || '').trim().slice(0, 40);
  message = String(message || '').trim().slice(0, 2000);
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (grade && !GRADES.includes(grade)) return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  const info = db.prepare('INSERT INTO submissions (type, name, email, grade, message) VALUES (?, ?, ?, ?, ?)')
    .run(type, name, email, grade, message);

  // Notify the board members this submission is routed to:
  //  - club-join → the Secretary + that grade's grade reps (the people who
  //    review it and do the outreach). The President and VP are deliberately
  //    left out: nobody is alerted that someone joined unless it's their job
  //    to act on it or they referred them.
  //  - board application → admins only (an application isn't a club join)
  const adminRows = () => db.prepare("SELECT id, email, role, grade FROM users WHERE role = 'admin'").all();
  let gradeReps = [];
  let recipients;
  if (type === 'club') {
    gradeReps = gradeRepsFor(grade);
    const seen = new Set();
    recipients = [...secretaryTargets(), ...gradeReps].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  } else {
    recipients = adminRows();
  }
  const label = type === 'board' ? 'board application' : 'club-join request';
  for (const r of recipients) {
    notify(r.email, `New ${label}`,
      `New ${label}`,
      `<b>${escHtml(name)}</b>${grade ? ' (grade ' + escHtml(grade) + ')' : ''} submitted a ${label}.<br/>Email: ${escHtml(email)}${message ? '<br/>Message: ' + escHtml(message) : ''}<br/><br/>See it in the Get Involved inbox.`);
    pushNotification(r.id, `New ${label} from ${name}${grade ? ' (grade ' + grade + ')' : ''}`, 'submissions', 'submission');
  }

  // Put the submission on the right person's to-do page, not just their inbox:
  //  - club-join → that grade's grade reps get "Reach out to new member ___"
  //    (falls back to admins if that grade has no rep, so nothing is dropped)
  //  - board application → admins get "Review board application from ___"
  const taskOwners = type === 'club' && gradeReps.length ? gradeReps : adminRows();
  const taskName = type === 'board'
    ? `Review board application from ${name}`
    : `Reach out to new member ${name}`;
  const taskDesc =
    `${name}${grade ? ' (grade ' + grade + ')' : ''} submitted a ${label} on the public site.\n` +
    `Email: ${email}` +
    (message ? `\nMessage: ${message}` : '') +
    `\n\nFull details are in the Get Involved inbox.`;
  for (const r of taskOwners) createAutoTask(r.id, taskName, taskDesc);

  res.status(201).json({ ok: true });
});

// Public interest survey — no auth required.
app.post('/api/roster/survey', rateLimit({ windowMs: 60 * 60 * 1000, max: 25, name: 'survey' }), (req, res) => {
  const { firstName, lastName, phone, email, gender } = req.body || {};
  if (!firstName || !String(firstName).trim()) return res.status(400).json({ error: 'First name required' });
  const info = db.prepare(`INSERT INTO roster_members (firstName, lastName, phone, email, gender)
    VALUES (?, ?, ?, ?, ?)`).run(
    String(firstName).trim(), String(lastName || '').trim(),
    String(phone || '').trim(), String(email || '').trim(), String(gender || '').trim()
  );
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Resolves the board member behind a personal referral link (/join/:username)
// so the public sign-up page can show "Referred by …". No auth: the same
// names and titles are already public on /api/board. Returns 404 only when
// the username isn't a real member, so a working link never silently stops
// crediting — there is no site-wide switch in front of this any more.
app.get('/api/join/referrer/:username', (req, res) => {
  const member = findReferrerByUsername(req.params.username);
  if (!member) return res.status(404).json({ error: 'Unknown referral link' });
  res.json({ member });
});

// Look up a referral-link owner by username (case-insensitive — links get
// typed by hand and shared in chats that capitalize the first letter). The
// hidden 'logistics' system account is never a board member.
function findReferrerByUsername(username) {
  if (!username || typeof username !== 'string') return null;
  return db.prepare(
    "SELECT id, username, displayName, title FROM users WHERE lower(username) = lower(?) AND username != 'logistics'"
  ).get(username.trim()) || null;
}

// Public self-service member sign-up (shown at /join and at each board
// member's personal link, /join/:username) — no auth required. The
// secretary shares one link and members fill in their own details; the entry
// lands as 'Pending' so nothing reaches the live roster until it's approved.
// Limit is generous because this also powers a shared club-day sign-up kiosk,
// where many real submissions come from one device/IP in a short window —
// each still lands as Pending, so abuse just means more to review, not risk.
app.post('/api/roster/self-submit', rateLimit({ windowMs: 60 * 60 * 1000, max: 300, name: 'self-submit' }), (req, res) => {
  const { firstName, lastName, phone, email, grade, gender, notes, referredByUsername } = req.body || {};
  if (!firstName || !String(firstName).trim()) return res.status(400).json({ error: 'First name required' });
  if (grade != null && grade !== '' && !GRADES.includes(String(grade))) {
    return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email' });
  }
  // Credit comes from the personal referral link the member arrived through
  // (/join/:username) — the plain /join form has no referral field at all.
  // Only credited if the username names a real member. Approving the
  // submission later awards the point.
  let referrer = null;
  if (referredByUsername) {
    referrer = findReferrerByUsername(referredByUsername);
  }
  const info = db.prepare(`INSERT INTO roster_members (firstName, lastName, phone, email, grade, gender, notes, status, referredByUserId, referralStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`).run(
    String(firstName).trim().slice(0, 100), String(lastName || '').trim().slice(0, 100),
    String(phone || '').trim().slice(0, 30), String(email || '').trim().slice(0, 200),
    grade ? Number(grade) : null, String(gender || '').trim().slice(0, 30),
    String(notes || '').trim().slice(0, 2000),
    referrer ? referrer.id : null, referrer ? 'pending' : '',
  );
  const name = `${String(firstName).trim()} ${String(lastName || '').trim()}`.trim();
  const suffix = referrer ? ` (referred by ${referrer.displayName})` : '';
  // One sign-up is one ping to any given person, so each group checks what the
  // groups before it already covered.
  const alerted = new Set(notifySecretary(`${name} submitted their info${suffix} — review it in the roster.`, 'roster', 'submission'));
  // That grade's reps hear about their own students, matching how a Get Involved
  // request reaches them. Alert only — a /join entry waits in the roster pipeline
  // for the Secretary to approve, so there's no outreach task to hand out yet.
  if (grade) {
    for (const rep of gradeRepsFor(grade)) {
      if (alerted.has(rep.id)) continue;
      pushNotification(rep.id, `${name} (grade ${grade}) signed up — that's your grade.`, 'roster', 'submission');
      alerted.add(rep.id);
    }
  }
  // The member whose link they came through hears about it too — that referral
  // is theirs.
  if (referrer && !alerted.has(referrer.id)) {
    pushNotification(referrer.id,
      `${name} signed up through your referral link — it counts once the Secretary approves it.`,
      'referrals', 'info');
  }
  // Ask the President and VP to approve it over Telegram, duplicates flagged.
  // Deliberately not awaited: a slow or failing Telegram API must never make the
  // student's sign-up appear to fail — the entry is already saved and still
  // reviewable on the roster screen either way.
  askApproversOverTelegram(Number(info.lastInsertRowid))
    .catch((e) => console.warn('[signup] telegram approval request failed:', e.message));
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// DM each approver the new sign-up with any duplicate flags, and remember the
// message we sent so their reply can be matched back to this person.
async function askApproversOverTelegram(rosterId) {
  if (!telegramEnabled()) return;
  const m = db.prepare('SELECT * FROM roster_members WHERE id = ?').get(rosterId);
  if (!m || m.status !== 'Pending') return;

  const flags = duplicateFlagsFor({
    firstName: m.firstName, lastName: m.lastName, phone: m.phone, email: m.email, excludeId: m.id,
  });
  const who = `${m.firstName || ''} ${m.lastName || ''}`.trim() || 'Someone';
  const referrer = m.referredByUserId ? getUser(m.referredByUserId) : null;

  const lines = [`🆕 New sign-up: ${who}`];
  if (m.grade) lines.push(`Grade ${m.grade}`);
  if (m.phone) lines.push(`Phone: ${m.phone}`);
  if (m.email) lines.push(`Email: ${m.email}`);
  if (referrer) lines.push(`Referred by: ${referrer.displayName}`);
  if (m.notes) lines.push(`Notes: ${String(m.notes).slice(0, 300)}`);
  if (flags.length) {
    lines.push('', `⚠️ ${flags.length} possible duplicate${flags.length > 1 ? 's' : ''}:`);
    for (const f of flags.slice(0, 6)) lines.push(`• ${f.message}`);
  } else {
    lines.push('', '✅ No duplicates found.');
  }
  lines.push('', `Approve them? Reply "yes" or "no" (or "yes ${m.id}" / "no ${m.id}").`);
  const text = lines.join('\n');

  const record = db.prepare(`INSERT INTO roster_approval_requests (rosterId, userId, chatId, messageId)
    VALUES (?, ?, ?, ?)`);
  for (const a of signupApprovers()) {
    if (!a.telegramChatId) continue;
    const messageId = await sendTelegramAsking(a.telegramChatId, text);
    try { record.run(rosterId, a.id, String(a.telegramChatId), messageId); }
    catch (e) { console.warn('[signup] recording approval request failed:', e.message); }
  }
}

// Public click tracking — no auth required (visitors haven't logged in).
app.post('/api/track', rateLimit({ windowMs: 60 * 1000, max: 120, name: 'track' }), (req, res) => {
  const { event, label } = req.body || {};
  if (!event || typeof event !== 'string') return res.status(400).json({ error: 'event required' });
  db.prepare('INSERT INTO page_events (event, label) VALUES (?, ?)')
    .run(String(event).slice(0, 80), String(label || '').slice(0, 200));
  res.json({ ok: true });
});

// Lightweight user-agent parsing — enough for a device/browser breakdown
// without pulling in a heavyweight dependency.
// Crawlers must be detected before the device checks — Googlebot's smartphone
// UA contains "Android … Mobile" and would otherwise be classed as a real
// mobile visitor. An empty UA is treated as a bot too: real browsers always
// send one, scripts and monitors often don't.
function isBotUserAgent(ua) {
  const s = String(ua || '');
  if (!s.trim()) return true;
  return /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|facebookexternalhit|python|curl\/|wget\/|axios\/|go-http-client|node-fetch|okhttp/i.test(s);
}

function parseUserAgent(ua) {
  const s = String(ua || '');
  let deviceType = 'Desktop';
  if (isBotUserAgent(s)) deviceType = 'Bot';
  else if (/\b(iPad|Tablet)\b|Android(?!.*Mobile)/i.test(s)) deviceType = 'Tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(s)) deviceType = 'Mobile';

  let browser = 'Other';
  if (isBotUserAgent(s)) browser = 'Bot';
  else if (/Edg[eiOS]?\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/CriOS/i.test(s)) browser = 'Chrome';
  else if (/FxiOS/i.test(s)) browser = 'Firefox';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Version\/.*Safari/i.test(s)) browser = 'Safari';
  return { deviceType, browser };
}

// Resolve the visitor's true public IP behind Railway's edge. Railway proxies
// requests through Envoy, which records the real external client in
// `x-envoy-external-address` — the most reliable source. Fall back to the
// left-most X-Forwarded-For entry (the original client), then Express's
// req.ip. Strip the IPv4-mapped-IPv6 prefix and brackets so the value is a
// clean address the geoIP database can match — otherwise a proxy hop or a
// mangled address geolocates to the wrong country.
function clientIp(req) {
  let ip = req.headers['x-envoy-external-address'];
  if (Array.isArray(ip)) ip = ip[0];
  ip = String(ip || '').split(',')[0].trim();
  if (!ip) ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!ip) ip = req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^\[/, '').replace(/\]$/, '').replace(/^::ffff:/i, '').trim();
}

// Country for a request. Prefer an edge-provided country header when the host
// supplies one (authoritative and always current), otherwise fall back to the
// offline geoIP database. Region/city always come from geoIP.
function geoFor(req, ip) {
  const hdr = String(
    req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] || req.headers['x-geo-country'] || ''
  ).toUpperCase();
  const geo = geoip.lookup(ip) || {};
  const country = (hdr && hdr !== 'XX' && /^[A-Z]{2}$/.test(hdr)) ? hdr : (geo.country || '');
  return { country, region: geo.region || '', city: geo.city || '' };
}

// Public site-visit tracking — records a page view on the public marketing
// site (path, referrer, rough geo from IP, device/browser). No auth required.
app.post('/api/site-visit', rateLimit({ windowMs: 60 * 1000, max: 120, name: 'site-visit' }), (req, res) => {
  const { visitorId, path: visitPath, referrer } = req.body || {};
  // Crawlers that execute JS (Googlebot, link previewers, uptime monitors)
  // would otherwise register as real views and — since their storage never
  // persists — as a brand-new visitor on every single hit. Don't log them.
  if (isBotUserAgent(req.headers['user-agent'])) return res.json({ ok: true, id: null });
  const ip = clientIp(req);
  const geo = geoFor(req, ip);
  const { deviceType, browser } = parseUserAgent(req.headers['user-agent']);
  // A missing/empty visitorId (blocked storage, malformed request) must never
  // collapse into a shared '' bucket — that would undercount distinct
  // visitors and skew new-vs-returning. Fall back to a one-off random id so
  // it still counts as its own visitor instead of merging with everyone else.
  const cleanVisitorId = String(visitorId || '').trim().slice(0, 64) || crypto.randomUUID();
  const info = db.prepare(`
    INSERT INTO site_visits (visitorId, path, referrer, ipAddress, country, region, city, userAgent, deviceType, browser)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanVisitorId,
    String(visitPath || '/').slice(0, 200),
    String(referrer || '').slice(0, 300),
    ip,
    geo.country || '',
    (geo.region || ''),
    geo.city || '',
    String(req.headers['user-agent'] || '').slice(0, 300),
    deviceType,
    browser
  );
  res.json({ ok: true, id: info.lastInsertRowid });
});

// Beacon-friendly duration update for a previously logged site visit — sent
// via navigator.sendBeacon on page change / unload, so it must accept a POST.
app.post('/api/site-visit/:id/duration', rateLimit({ windowMs: 60 * 1000, max: 120, name: 'site-visit-duration' }), (req, res) => {
  const id = Number(req.params.id);
  const durationSec = Math.max(0, Math.min(21600, Number(req.body?.durationSec) || 0));
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  db.prepare('UPDATE site_visits SET durationSec = ? WHERE id = ?').run(durationSec, id);
  res.json({ ok: true });
});

// ---- Event photos (public submit + public approved gallery) -----------------
// Anyone can submit a photo from the homepage, but it stays 'pending' until a
// board member approves it — so unvetted images never show on the public page.
app.post('/api/event-photos', rateLimit({ windowMs: 60 * 60 * 1000, max: 12, name: 'event-photos' }), (req, res) => {
  let { photo, caption, submitterName } = req.body || {};
  photo = typeof photo === 'string' ? photo : '';
  caption = String(caption || '').trim().slice(0, 280);
  submitterName = String(submitterName || '').trim().slice(0, 80);
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: 'Please choose an image file (JPG, PNG, or WEBP).' });
  }
  if (photo.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'That image is too large — please pick a smaller one.' });
  db.prepare('INSERT INTO event_photos (photo, caption, submitterName, status) VALUES (?, ?, ?, ?)')
    .run(photo, caption, submitterName, 'pending');

  // Let the photo moderators know something is waiting for review.
  const moderators = db.prepare("SELECT id, email FROM users WHERE role = 'admin' OR canEditHome = 1 OR canManageSocial = 1").all();
  for (const m of moderators) {
    pushNotification(m.id, `New event photo${submitterName ? ' from ' + submitterName : ''} awaiting approval`, 'photos', 'submission');
  }
  res.status(201).json({ ok: true });
});

// Public gallery — only approved photos, metadata only (image bytes come from
// the per-photo route below to keep this payload small).
app.get('/api/event-photos', (req, res) => {
  const photos = db.prepare(
    "SELECT id, caption, submitterName, createdAt FROM event_photos WHERE status = 'approved' ORDER BY createdAt DESC LIMIT 60"
  ).all();
  res.json({ photos });
});

// Serve a single approved photo's image bytes (public).
app.get('/api/event-photos/:id/image', (req, res) => {
  const row = db.prepare("SELECT photo, status FROM event_photos WHERE id = ?").get(Number(req.params.id));
  if (!row || row.status !== 'approved') return res.status(404).end();
  const m = String(row.photo).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(m[2], 'base64'));
});

// ---- Instagram highlights (public slideshow) --------------------------------
app.get('/api/instagram-highlights', (req, res) => {
  const items = db.prepare(
    'SELECT id, link, caption FROM instagram_highlights ORDER BY sortOrder ASC, createdAt DESC LIMIT 30'
  ).all();
  res.json({ items });
});

app.get('/api/instagram-highlights/:id/image', (req, res) => {
  const row = db.prepare('SELECT image FROM instagram_highlights WHERE id = ?').get(Number(req.params.id));
  if (!row || !row.image) return res.status(404).end();
  const m = String(row.image).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(m[2], 'base64'));
});

// ---- Public volunteer sign-up routes (NO auth required) ----------------------
const volunteerSignupRL = rateLimit({ windowMs: 60 * 1000, max: 30, name: 'vsignup' });

app.get('/api/public/volunteer/:id', (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare('SELECT id, title, location, startDate FROM volunteer_events WHERE id = ? AND volunteersEnabled = 1').get(id);
  if (!event) return res.status(404).json({ error: 'Event not found or sign-ups are closed' });
  const roles = db.prepare('SELECT id, roleName, cap FROM volunteer_roles WHERE eventId = ? ORDER BY id').all(id);
  const rolesWithCounts = roles.map((r) => {
    const confirmed = db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'confirmed'").get(r.id).n;
    const waitlisted = db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'waitlisted'").get(r.id).n;
    return { ...r, confirmed, waitlisted };
  });
  res.json({ event, roles: rolesWithCounts });
});

app.post('/api/public/volunteer/:id/signup', volunteerSignupRL, (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT id FROM volunteer_events WHERE id = ? AND volunteersEnabled = 1').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found or sign-ups are closed' });
  let { roleId, name, phone, email, grade } = req.body || {};
  name  = String(name  || '').trim().slice(0, 120);
  phone = String(phone || '').trim().slice(0, 30);
  email = String(email || '').trim().slice(0, 200);
  grade = String(grade || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });
  const dup = db.prepare('SELECT id FROM volunteer_signups WHERE eventId = ? AND lower(name) = lower(?)').get(eventId, name);
  if (dup) return res.status(409).json({ error: "Looks like you're already signed up for this event" });
  roleId = roleId ? Number(roleId) : null;
  // General sign-ups (no role) are always confirmed; capped roles waitlist once full.
  let status = 'confirmed';
  if (roleId) {
    const role = db.prepare('SELECT id, cap FROM volunteer_roles WHERE id = ? AND eventId = ?').get(roleId, eventId);
    if (!role) return res.status(400).json({ error: 'Invalid role' });
    if (role.cap > 0) {
      const confirmed = db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'confirmed'").get(roleId).n;
      if (confirmed >= role.cap) status = 'waitlisted';
    }
  }
  // 1. Cross-reference phone against the roster, ignoring formatting differences
  // like "(555) 111-2222" vs "5551112222".
  let matchedRosterId = null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (digits.length >= 7) {
    const hit = db.prepare("SELECT id, phone FROM roster_members WHERE phone != ''").all()
      .find((r) => String(r.phone).replace(/\D/g, '').slice(-10) === digits);
    if (hit) matchedRosterId = hit.id;
  }
  // 2. If phone didn't match, fall back to email match.
  if (!matchedRosterId && email) {
    const emailHit = db.prepare("SELECT id FROM roster_members WHERE email != '' AND lower(email) = lower(?)").get(email);
    if (emailHit) matchedRosterId = emailHit.id;
  }
  // 3. Flag for manual review when neither phone nor email matched a roster member.
  const needsReview = matchedRosterId ? 0 : 1;
  const info = db.prepare(
    'INSERT INTO volunteer_signups (eventId, roleId, name, phone, email, grade, status, matchedRosterId, needsReview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(eventId, roleId, name, phone, email, grade, status, matchedRosterId, needsReview);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, status });
});

// ---- Public testimonials & newsletter ---------------------------------------
// These must stay above the auth gate below so anonymous homepage visitors can
// read approved testimonials, submit their own, and sign up for the newsletter.
// (notifyAdmins / newsletterEnroll are hoisted function declarations defined
// alongside the admin routes further down.)

// Public: approved testimonials only.
app.get('/api/testimonials', (req, res) => {
  const rows = db.prepare(
    "SELECT id, name, role, photo, text, sortOrder FROM testimonials WHERE status = 'approved' ORDER BY sortOrder ASC, createdAt DESC"
  ).all();
  res.json({ testimonials: rows });
});

// Public: universal submit form — anyone can go to /testimonial-submit and submit.
// No token required; all submissions go to pending for admin review.
app.post('/api/public/testimonial-submit',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 15, name: 'testimonial-submit-universal' }),
  (req, res) => {
    let { name, role, photo, text } = req.body || {};
    name  = String(name  || '').trim().slice(0, 120);
    role  = String(role  || '').trim().slice(0, 120);
    photo = cleanPhotoDataUrl(photo);
    text  = String(text  || '').trim().slice(0, 5000);
    if (!name || !text) return res.status(400).json({ error: 'Name and testimonial text are required.' });
    db.prepare(
      "INSERT INTO testimonials (name, role, photo, text, status) VALUES (?, ?, ?, ?, 'pending')"
    ).run(name, role, photo, text);
    notifyAdmins(`New testimonial submitted by ${name}`, '', 'info');
    res.json({ ok: true });
  }
);

// Public: get pre-fill info for a token-based (pre-assigned) submit link.
app.get('/api/public/testimonial-submit/:token', (req, res) => {
  const token = String(req.params.token).replace(/[^a-zA-Z0-9]/g, '');
  const row = db.prepare("SELECT id, name, role FROM testimonials WHERE submitToken = ? AND status = 'pending'").get(token);
  if (!row) return res.status(404).json({ error: 'This link is no longer valid or has already been used.' });
  res.json({ name: row.name, role: row.role });
});

// Public: submit via a pre-assigned token link (clears the token on use).
app.post('/api/public/testimonial-submit/:token',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: 'testimonial-submit-token' }),
  (req, res) => {
    const token = String(req.params.token).replace(/[^a-zA-Z0-9]/g, '');
    const row = db.prepare("SELECT id FROM testimonials WHERE submitToken = ? AND status = 'pending'").get(token);
    if (!row) return res.status(404).json({ error: 'This link is no longer valid or has already been used.' });
    let { name, role, photo, text } = req.body || {};
    name  = String(name  || '').trim().slice(0, 120);
    role  = String(role  || '').trim().slice(0, 120);
    photo = cleanPhotoDataUrl(photo);
    text  = String(text  || '').trim().slice(0, 5000);
    if (!name || !text) return res.status(400).json({ error: 'Name and testimonial text are required.' });
    db.prepare(
      "UPDATE testimonials SET name=?, role=?, photo=?, text=?, submitToken=NULL, updatedAt=datetime('now') WHERE id=?"
    ).run(name, role, photo, text, row.id);
    notifyAdmins(`New testimonial submitted by ${name}`, '', 'info');
    res.json({ ok: true });
  }
);

// Public: sign up for the newsletter.
app.post('/api/newsletter/subscribe',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'newsletter' }),
  (req, res) => {
    let { email, name } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    name  = String(name  || '').trim().slice(0, 120);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    const existing = db.prepare("SELECT id, active FROM newsletter_subscribers WHERE lower(email) = ?").get(email);
    if (existing) {
      if (!existing.active) {
        db.prepare("UPDATE newsletter_subscribers SET active=1, name=?, subscribedAt=datetime('now') WHERE id=?")
          .run(name || existing.name, existing.id);
      }
      return res.json({ ok: true, alreadySubscribed: !existing.active });
    }
    db.prepare("INSERT INTO newsletter_subscribers (email, name, source) VALUES (?, ?, 'signup')").run(email, name);
    res.json({ ok: true });
  }
);

// ---- Merch shop (public) -----------------------------------------------------
// Who may manage the shop (products, inventory, orders): admins and the
// secretary (canManageRoster — the shop is her responsibility). Promo codes are
// managed in the Stripe Dashboard and applied on Stripe's hosted checkout page.
function canManageShop(user) {
  return user.role === 'admin' || !!user.canManageRoster;
}

// Ensures a merch item has a matching Stripe Product and returns its id (or ''
// when Stripe is off or the call fails). A persistent Product is required for
// promotion codes restricted to "specific products" — Stripe can only apply
// such a coupon to a line item that references that Product. The id is cached
// on the row; a stale id (product deleted, or created in the other test/live
// mode) is transparently recreated. Best-effort: on failure we return '' and
// checkout falls back to an ad-hoc product, which still works for order-wide
// promo codes.
async function ensureStripeProduct(item) {
  if (!stripe || !item || !item.id) return '';
  if (item.stripeProductId) {
    try {
      const existing = await stripe.products.retrieve(item.stripeProductId);
      if (existing && existing.deleted !== true && existing.active) return existing.id;
    } catch (e) { /* stale id — fall through and recreate */ }
  }
  try {
    const created = await stripe.products.create({
      name: item.name || 'Club America merch',
      ...(item.description ? { description: String(item.description).slice(0, 500) } : {}),
      metadata: { merchItemId: String(item.id) },
    });
    db.prepare('UPDATE merch_items SET stripeProductId = ? WHERE id = ?').run(created.id, item.id);
    return created.id;
  } catch (e) {
    console.error('[stripe] ensure product failed for item', item.id, '—', e.message);
    return '';
  }
}

// Prices a cart from our own catalog (never trusts a client-sent total).
// Discounts are handled by Stripe promotion codes on the hosted checkout page,
// so pricing here is simply unit price × quantity. Returns { error } or a
// pricing breakdown. Pass ignoreStock once a payment has already succeeded, so
// a sold-out item is recorded as needs_review rather than rejected.
function computeOrderPricing({ itemId, variantId, quantity, amount, ignoreStock }) {
  const item = db.prepare('SELECT * FROM merch_items WHERE id = ? AND active = 1').get(Number(itemId));
  if (!item) return { error: 'Item not found.' };

  // Donation / pay-what-you-want: the buyer names the amount, subject to the
  // item's minimum (kept in the price column). No variants, no inventory, and
  // always "in stock". Post-payment re-reads (ignoreStock) trust whatever
  // Stripe already charged, so they skip the minimum check.
  if (item.isDonation) {
    const min = Math.max(50, item.price || 0);
    const amt = Math.round(Number(amount) || 0);
    if (!ignoreStock && (!amt || amt < min)) {
      return { error: `Please enter at least $${(min / 100).toFixed(2)}.` };
    }
    const total = amt || min;
    return { item, variant: null, qty: 1, unitPrice: total, subtotal: total, total, isDonation: true };
  }

  let variant = null;
  if (item.hasVariants) {
    variant = db.prepare('SELECT * FROM merch_variants WHERE id = ? AND itemId = ?').get(Number(variantId), item.id);
    if (!variant) return { error: 'Please choose an option.' };
  }
  const requested = Math.max(1, Math.round(Number(quantity) || 1));
  // Pre-payment, an over-limit request is told no; post-payment (ignoreStock,
  // re-reading our own ≤20 metadata) stays lenient rather than reject a sale.
  if (!ignoreStock && requested > 20) return { error: 'Orders are limited to 20 per item — contact us for bulk orders.' };
  const qty = Math.min(20, requested);
  const unitPrice = variant && variant.priceOverride != null ? variant.priceOverride : item.price;
  const inventory = variant ? variant.inventory : item.inventory;
  if (!ignoreStock && inventory < qty) return { error: 'Not enough in stock.' };
  const subtotal = unitPrice * qty;
  return { item, variant, qty, unitPrice, subtotal, total: subtotal };
}

app.get('/api/shop/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    stripeEnabled: !!stripe,
    stripeTestMode: STRIPE_TEST_MODE,
  });
});

app.get('/api/shop/items', (req, res) => {
  const items = db.prepare('SELECT * FROM merch_items WHERE active = 1 ORDER BY name').all().map((item) => {
    const { photo, createdById, ...rest } = item;
    return {
      ...rest,
      hasVariants: !!item.hasVariants,
      active: !!item.active,
      hasPhoto: !!photo,
      isDonation: !!item.isDonation,
      variants: item.hasVariants
        ? db.prepare('SELECT id, label, inventory, priceOverride FROM merch_variants WHERE itemId = ? ORDER BY id').all(item.id)
        : [],
    };
  });
  res.json({ items });
});

app.get('/api/shop/items/:id/photo', (req, res) => {
  const row = db.prepare('SELECT photo FROM merch_items WHERE id = ?').get(Number(req.params.id));
  if (!row || !row.photo) return res.status(404).end();
  const m = String(row.photo).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(m[2], 'base64'));
});


function notifyManagersOfOrder(order) {
  const managers = db.prepare("SELECT id, email FROM users WHERE role = 'admin' OR canManageRoster = 1").all();
  const label = order.fulfillmentStatus === 'needs_review' ? ' (needs review)' : '';
  for (const m of managers) {
    pushNotification(m.id, `New merch order${label}: ${order.itemName}${order.variantLabel ? ' (' + order.variantLabel + ')' : ''} from ${order.buyerName}`, 'shop', 'submission');
    notify(m.email, 'New merch shop order', 'New merch shop order',
      `${escHtml(order.buyerName)} ordered <b>${escHtml(order.itemName)}</b>${order.variantLabel ? ' (' + escHtml(order.variantLabel) + ')' : ''} — ${order.deliveryMethod === 'ship' ? 'ship to buyer' : 'student pickup'}.<br/>Total: $${(order.total / 100).toFixed(2)}${label ? '<br/><b>Heads up: this order needs manual review (stock/promo overrun).</b>' : ''}`);
  }
}

// Idempotently record a paid Stripe order. Called by both /api/shop/confirm-checkout
// (the browser) and the webhook (Stripe) — whichever arrives first creates the
// row; the other becomes a no-op. Keyed on the session id (unique index).
// Cart metadata we stash on the Checkout Session (and its PaymentIntent) — the
// item/variant/qty and pickup info Stripe doesn't know. Buyer contact and
// shipping address are collected by Stripe on its page, not stored here.
function cartMetadata(p, deliveryMethod, studentEmail) {
  return {
    kind: 'merch',
    itemId: String(p.item.id),
    itemName: p.item.name.slice(0, 120),
    variantId: p.variant ? String(p.variant.id) : '',
    variantLabel: p.variant ? p.variant.label.slice(0, 80) : '',
    quantity: String(p.qty),
    deliveryMethod,
    studentEmail: studentEmail || '',
  };
}

// Reads a paid Checkout Session and records the order exactly once (keyed on the
// session id via the unique index). Shared by the return-trip confirmation and
// the webhook, so whichever arrives first creates the row and the other is a
// no-op. Buyer name/email/phone and shipping address come from what Stripe
// collected on its hosted page; item/variant/qty come from our metadata.
function recordCheckoutSession(session) {
  if (!session || (session.metadata || {}).kind !== 'merch') return null;
  // 'paid' for card orders; 'no_payment_required' when a 100%-off promo zeroed it.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return null;
  const ref = session.id;
  const existing = db.prepare('SELECT * FROM merch_orders WHERE stripePaymentIntentId = ?').get(ref);
  if (existing) {
    if (existing.paymentStatus !== 'paid' && existing.paymentStatus !== 'free') {
      db.prepare("UPDATE merch_orders SET paymentStatus = 'paid' WHERE id = ?").run(existing.id);
    }
    return db.prepare('SELECT * FROM merch_orders WHERE id = ?').get(existing.id);
  }

  const md = session.metadata || {};
  const cd = session.customer_details || {};
  const shipInfo = (session.collected_information && session.collected_information.shipping_details)
    || session.shipping_details || null;
  const a = shipInfo && shipInfo.address ? shipInfo.address : null;
  const address = a ? {
    street: [a.line1, a.line2].filter(Boolean).join(', ').slice(0, 250),
    city: (a.city || '').slice(0, 100),
    state: (a.state || '').slice(0, 50),
    zip: (a.postal_code || '').slice(0, 20),
  } : null;
  const deliveryMethod = md.deliveryMethod === 'pickup' ? 'pickup'
    : md.deliveryMethod === 'digital' ? 'digital' : 'ship';
  const amount = Number(session.amount_total) || 0;                 // charged after any promo
  const discount = Number((session.total_details || {}).amount_discount) || 0;
  const paymentStatus = amount === 0 ? 'free' : 'paid';
  // Re-price from our catalog for item linkage + inventory. ignoreStock: the
  // payment already happened, so a sold-out item is flagged, never rejected.
  const priced = computeOrderPricing({ itemId: md.itemId, variantId: md.variantId || undefined, quantity: md.quantity, ignoreStock: true });

  const tx = db.transaction(() => {
    let fulfillmentStatus = 'pending';
    let itemId = md.itemId ? Number(md.itemId) : null;
    let variantId = null;
    let itemName = md.itemName || 'Merch order';
    let variantLabel = md.variantLabel || '';
    let qty = Number(md.quantity) || 1;
    if (!priced.error) {
      itemId = priced.item.id; itemName = priced.item.name;
      variantId = priced.variant ? priced.variant.id : null;
      variantLabel = priced.variant ? priced.variant.label : '';
      qty = priced.qty;
      if (!priced.isDonation) {
        // Donations carry no inventory; everything else decrements stock.
        let upd;
        if (priced.variant) upd = db.prepare('UPDATE merch_variants SET inventory = inventory - ? WHERE id = ? AND inventory >= ?').run(qty, priced.variant.id, qty);
        else upd = db.prepare('UPDATE merch_items SET inventory = inventory - ? WHERE id = ? AND inventory >= ?').run(qty, priced.item.id, qty);
        if (upd.changes === 0) fulfillmentStatus = 'needs_review'; // sold out after payment
      }
    } else {
      fulfillmentStatus = 'needs_review'; // item changed/removed since checkout
    }
    return db.prepare(`INSERT INTO merch_orders (
      itemId, variantId, itemName, variantLabel, quantity,
      buyerName, buyerEmail, buyerPhone, deliveryMethod, shippingAddress, studentEmail,
      discountAmount, subtotal, total, paymentMethod, paymentStatus, fulfillmentStatus, stripePaymentIntentId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe', ?, ?, ?)`).run(
      itemId, variantId, itemName, variantLabel, qty,
      (cd.name || '').slice(0, 120), (cd.email || '').slice(0, 200), (cd.phone || '').slice(0, 30),
      deliveryMethod, address ? JSON.stringify(address) : '', (md.studentEmail || '').slice(0, 200),
      discount, amount + discount, amount, paymentStatus, fulfillmentStatus, ref,
    );
  });

  let info;
  try { info = tx(); }
  catch (e) {
    if (/UNIQUE|constraint/i.test(e.message)) {
      const row = db.prepare('SELECT * FROM merch_orders WHERE stripePaymentIntentId = ?').get(ref);
      if (row) return row;
    }
    throw e;
  }
  const order = db.prepare('SELECT * FROM merch_orders WHERE id = ?').get(info.lastInsertRowid);
  notifyManagersOfOrder(order);
  return order;
}

// Online payment hands off to Stripe-hosted Checkout. We price the cart from our
// own DB (never trusting the client) and let Stripe collect the buyer's email,
// phone, shipping address (for shipped orders), and any promotion code on its
// own page. We only pass the cart + pickup info along as metadata.
app.post('/api/shop/create-checkout-session', rateLimit({ windowMs: 60 * 60 * 1000, max: 30, name: 'shop-checkout' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Online payment is not configured yet — please check back soon.' });
  let { itemId, variantId, quantity, amount, deliveryMethod, studentEmail } = req.body || {};
  const p = computeOrderPricing({ itemId, variantId, quantity, amount });
  if (p.error) return res.status(400).json({ error: p.error });

  // Donations have nothing to ship or hand over, so they skip the delivery
  // choice, the student-email requirement, and the shipping-address collection.
  const isDonation = !!p.isDonation;
  if (isDonation) {
    deliveryMethod = 'digital';
    studentEmail = '';
  } else {
    deliveryMethod = deliveryMethod === 'pickup' ? 'pickup' : 'ship';
    studentEmail = String(studentEmail || '').trim().slice(0, 200);
    if (deliveryMethod === 'pickup' && !STUDENT_EMAIL_RE.test(studentEmail)) {
      return res.status(400).json({ error: 'Student pickup requires a valid @pcstudents.us email.' });
    }
  }
  // Stripe rejects card charges under 50¢. Say so plainly.
  if (p.total < 50) return res.status(400).json({ error: 'Orders must total at least $0.50.' });

  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const lineName = isDonation
    ? p.item.name
    : `${p.item.name}${p.variant ? ' — ' + p.variant.label : ''}${p.qty > 1 ? ' × ' + p.qty : ''}`;
  const idemKey = String((req.body || {}).idempotencyKey || '').trim().slice(0, 200);
  const meta = cartMetadata(p, deliveryMethod, studentEmail);
  // Reference the item's persistent Stripe Product so promotion codes scoped to
  // "specific products" can match. If Stripe has no product for it yet (or the
  // call fails), fall back to an ad-hoc product — order-wide promo codes still
  // work, only product-restricted ones require the persistent product.
  const stripeProductId = await ensureStripeProduct(p.item);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: p.total,
          ...(stripeProductId ? { product: stripeProductId } : { product_data: { name: lineName } }),
        },
      }],
      allow_promotion_codes: true,                    // Stripe shows + validates promo codes
      // Collect the phone for physical orders; a donation needs no logistics.
      ...(isDonation ? {} : { phone_number_collection: { enabled: true } }),
      // Stripe collects + validates the shipping address for shipped orders.
      ...(deliveryMethod === 'ship' ? { shipping_address_collection: { allowed_countries: ['US'] } } : {}),
      success_url: `${base}/shop?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/shop?checkout=cancel`,
      metadata: meta,
      payment_intent_data: { description: `Club America merch — ${lineName}`, metadata: meta },
    }, idemKey ? { idempotencyKey: idemKey } : undefined);
    res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe] create checkout session failed:', e.message);
    res.status(502).json({ error: 'Could not start checkout — please try again.' });
  }
});

// Called when the buyer returns from Stripe-hosted Checkout. Retrieves the
// session, verifies it was paid, and records the order idempotently (the same
// path the webhook uses) so fulfillment never depends on the webhook alone.
app.post('/api/shop/confirm-checkout', rateLimit({ windowMs: 60 * 60 * 1000, max: 40, name: 'shop-confirm' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Online payment is not configured.' });
  const sessionId = String((req.body || {}).sessionId || '').trim().slice(0, 200);
  if (!sessionId) return res.status(400).json({ error: 'Missing checkout session.' });
  let session;
  try { session = await stripe.checkout.sessions.retrieve(sessionId); }
  catch (e) { return res.status(400).json({ error: 'Could not verify checkout.' }); }
  if (!session || (session.metadata || {}).kind !== 'merch') {
    return res.status(400).json({ error: 'Payment was not completed.' });
  }
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    // A delayed-notification payment (e.g. bank debit) finishes checkout before
    // the money clears. Don't tell the buyer it failed — the webhook records
    // the order when Stripe's async_payment_succeeded event arrives.
    if (session.status === 'complete') {
      return res.json({
        ok: true, processing: true, orderId: null,
        total: Number(session.amount_total) || 0, paymentStatus: 'processing',
        deliveryMethod: (session.metadata || {}).deliveryMethod === 'pickup' ? 'pickup' : (session.metadata || {}).deliveryMethod === 'digital' ? 'digital' : 'ship',
      });
    }
    return res.status(400).json({ error: 'Payment was not completed.' });
  }
  let order;
  try { order = recordCheckoutSession(session); }
  catch (e) {
    console.error('[shop] confirm-checkout record failed:', e.message);
    return res.status(500).json({ error: 'Your payment went through, but we hit a snag recording the order — please contact us.' });
  }
  res.json({
    ok: true,
    orderId: order ? order.id : null,
    total: Number(session.amount_total) || 0,
    paymentStatus: order ? order.paymentStatus : 'paid',
    deliveryMethod: (session.metadata || {}).deliveryMethod === 'pickup' ? 'pickup' : (session.metadata || {}).deliveryMethod === 'digital' ? 'digital' : 'ship',
  });
});

// In-person "pay at pickup" orders were removed — every order (shipped or
// student pickup) is paid online through Stripe-hosted Checkout.

// ---- Public Speaker Application form ------------------------------------------
// The question list is VP-managed (speaker_form_config); the public form and
// the server-side validation below are both driven by the same stored config.
// Any number of yesno questions can set triggersUpload, each with its own PDF
// template (speaker_form_templates, one row per question id).
const { DEFAULT_SPEAKER_FORM, sanitizeQuestions, DEFAULT_UPLOAD_HEADING, DEFAULT_UPLOAD_INSTRUCTIONS } = require('./speakerForm');
const LEGACY_LOGISTICS_QUESTION_ID = 'needsLogistics'; // ships with a bundled template as a fallback

function getSpeakerForm() {
  const row = db.prepare('SELECT * FROM speaker_form_config WHERE id = 1').get();
  let questions = row ? null : DEFAULT_SPEAKER_FORM.questions;
  if (row) { try { questions = JSON.parse(row.questions || '[]'); } catch (_) { questions = DEFAULT_SPEAKER_FORM.questions; } }

  const templateRows = db.prepare('SELECT questionId, fileName FROM speaker_form_templates').all();
  const templateNames = new Map(templateRows.map((t) => [t.questionId, t.fileName]));

  const withUploads = questions.map((q) => {
    if (q.type !== 'yesno' || !q.triggersUpload) return q;
    const customName = templateNames.get(q.id);
    const isLegacyDefault = q.id === LEGACY_LOGISTICS_QUESTION_ID;
    return {
      ...q,
      uploadHeading: q.uploadHeading || DEFAULT_UPLOAD_HEADING,
      uploadInstructions: q.uploadInstructions || DEFAULT_UPLOAD_INSTRUCTIONS,
      templateFileName: customName || (isLegacyDefault ? 'speaker-logistics-form.pdf' : ''),
      templateAvailable: !!customName || isLegacyDefault,
    };
  });

  return {
    title: row ? (row.title || DEFAULT_SPEAKER_FORM.title) : DEFAULT_SPEAKER_FORM.title,
    intro: row ? (row.intro || '') : DEFAULT_SPEAKER_FORM.intro,
    questions: withUploads,
    updatedAt: row ? row.updatedAt : null,
  };
}

// Public: the current form definition (rendered by /apply-to-speak).
app.get('/api/public/speaker-form', (req, res) => {
  res.json({ form: getSpeakerForm() });
});

const SPEAKER_PDF_MAX = 7 * 1024 * 1024; // ~5 MB file after base64 encoding

// Public: download the PDF template attached to a triggersUpload question.
app.get('/api/public/speaker-form/template/:questionId', (req, res) => {
  const questionId = String(req.params.questionId || '');
  const form = getSpeakerForm();
  const q = form.questions.find((qq) => qq.id === questionId && qq.type === 'yesno' && qq.triggersUpload);
  if (!q) return res.status(404).json({ error: 'Not found' });

  const row = db.prepare('SELECT fileName, fileData FROM speaker_form_templates WHERE questionId = ?').get(questionId);
  if (row && row.fileData) {
    const m = String(row.fileData).match(/^data:application\/pdf;base64,(.+)$/s);
    if (m) {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${(row.fileName || 'form.pdf').replace(/"/g, '')}"`);
      return res.send(Buffer.from(m[1], 'base64'));
    }
  }
  if (questionId === LEGACY_LOGISTICS_QUESTION_ID) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'speaker-logistics-form.pdf'));
  }
  res.status(404).json({ error: 'No template has been uploaded for this question yet' });
});

// Public: submit a speaker application. Validation is driven by the stored
// question config — required questions, select options, and each question's
// conditional PDF requirement are all enforced here, not just in the browser.
app.post('/api/public/speaker-apply', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: 'speaker-apply' }), (req, res) => {
  const form = getSpeakerForm();
  const body = req.body || {};
  const rawAnswers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const rawUploads = body.uploads && typeof body.uploads === 'object' ? body.uploads : {};

  const snapshot = [];       // [{id, label, answer}] in question order
  const uploads = [];        // [{questionId, label, fileName, fileData}] for triggered questions
  let applicantName = '';
  let applicantEmail = '';

  for (const q of form.questions) {
    const answer = String(rawAnswers[q.id] ?? '').trim().slice(0, 4000);
    if (q.required && !answer) {
      return res.status(400).json({ error: `Please answer: ${q.label}` });
    }
    if (answer && q.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(answer)) {
      return res.status(400).json({ error: `Please enter a valid email for: ${q.label}` });
    }
    if (answer && q.type === 'select' && Array.isArray(q.options) && !q.options.includes(answer)) {
      return res.status(400).json({ error: `Invalid choice for: ${q.label}` });
    }
    if (q.type === 'yesno' && answer && answer !== 'Yes' && answer !== 'No') {
      return res.status(400).json({ error: `Invalid answer for: ${q.label}` });
    }
    if (q.type === 'yesno' && q.triggersUpload && answer === 'Yes') {
      const u = rawUploads[q.id] && typeof rawUploads[q.id] === 'object' ? rawUploads[q.id] : {};
      const fileData = typeof u.fileData === 'string' ? u.fileData : '';
      const fileName = String(u.fileName || 'form.pdf').replace(/[^\w. -]/g, '').slice(0, 120) || 'form.pdf';
      if (!/^data:application\/pdf;base64,/.test(fileData)) {
        return res.status(400).json({ error: `Please upload the signed PDF for: ${q.label}` });
      }
      if (fileData.length > SPEAKER_PDF_MAX) {
        return res.status(400).json({ error: 'That PDF is too large — please keep it under 5 MB.' });
      }
      uploads.push({ questionId: q.id, label: q.label, fileName, fileData });
    }
    if (!applicantName && q.type === 'text' && /name/i.test(q.label) && answer) applicantName = answer.slice(0, 120);
    if (!applicantEmail && q.type === 'email' && answer) applicantEmail = answer.slice(0, 200);
    snapshot.push({ id: q.id, label: q.label, answer });
  }

  const needsLogistics = uploads.length > 0;
  const info = db.prepare(`INSERT INTO speaker_applications
    (applicantName, applicantEmail, answers, needsLogistics, uploads)
    VALUES (?, ?, ?, ?, ?)`)
    .run(applicantName, applicantEmail, JSON.stringify(snapshot), needsLogistics ? 1 : 0,
         JSON.stringify(uploads));

  // Route new applications to the President/VP: in-app bell + email.
  const admins = db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all();
  const who = applicantName || 'Someone';
  for (const a of admins) {
    pushNotification(a.id, `New speaker application from ${who}`, 'speaker', 'submission');
    notify(a.email, 'New speaker application',
      'New speaker application',
      `<b>${escHtml(who)}</b> applied to speak at Club America.` +
      (applicantEmail ? `<br/>Email: ${escHtml(applicantEmail)}` : '') +
      (needsLogistics ? '<br/>Requires signed form(s) — attached in the portal.' : '') +
      '<br/><br/>Review it under Speaker Events → Applications.');
  }

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ---- Telegram webhook (public — Telegram posts here) ------------------------
// Telegram delivers bot updates to this URL. The :secret in the path is the
// only thing gating it, so it must match TELEGRAM_WEBHOOK_SECRET. We only care
// about the "/start <code>" a member sends when they tap their Connect link,
// and "/stop" to unlink. Always answer 200 so Telegram doesn't retry.
// A "yes"/"no" sent back to the bot approves or declines a pending sign-up.
//
// Authority comes from the account the chat is linked to, re-checked here on
// every reply — never from the fact that we once sent this chat a question. If
// someone loses roster rights (or the chat is relinked to a different account)
// their old questions stop working immediately.
function handleSignupReply(chatId, text, replyToMessageId) {
  const m = String(text).trim().match(/^(yes|y|approve|approved|no|n|decline|declined|reject)\b\s*#?(\d+)?\s*$/i);
  if (!m) return false;
  const approve = /^(yes|y|approve|approved)$/i.test(m[1]);
  const explicitId = m[2] ? Number(m[2]) : null;

  const user = db.prepare("SELECT * FROM users WHERE telegramChatId = ? AND telegramChatId != ''").get(chatId);
  if (!user) return false; // Unlinked chat — nothing to answer, stay silent.

  const open = db.prepare("SELECT * FROM roster_approval_requests WHERE chatId = ? AND answer = '' ORDER BY id").all(chatId);
  if (!open.length) {
    sendTelegram(chatId, 'There\'s nothing waiting on your approval right now.');
    return true;
  }

  // Which sign-up did they mean? An explicit id wins, then a Telegram reply to
  // the specific question, and only then "the one outstanding question".
  let target = null;
  if (explicitId) {
    target = open.find((r) => r.rosterId === explicitId);
    if (!target) {
      sendTelegram(chatId, `You don't have a pending question about #${explicitId}.`);
      return true;
    }
  } else if (replyToMessageId) {
    target = open.find((r) => r.messageId && r.messageId === replyToMessageId);
  }
  if (!target) {
    if (open.length === 1) {
      target = open[0];
    } else {
      // Guessing between several would silently approve the wrong student.
      const list = open.map((r) => {
        const p = db.prepare('SELECT firstName, lastName FROM roster_members WHERE id = ?').get(r.rosterId);
        return `• ${(p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : 'Unknown')} — reply "${approve ? 'yes' : 'no'} ${r.rosterId}"`;
      });
      sendTelegram(chatId, `You have ${open.length} sign-ups waiting. Which one?\n${list.join('\n')}`);
      return true;
    }
  }

  const member = db.prepare('SELECT * FROM roster_members WHERE id = ?').get(target.rosterId);
  const who = member ? `${member.firstName || ''} ${member.lastName || ''}`.trim() || 'That sign-up' : 'That sign-up';
  if (!member) {
    db.prepare("UPDATE roster_approval_requests SET answer = 'gone', answeredAt = datetime('now') WHERE id = ?").run(target.id);
    sendTelegram(chatId, 'That sign-up no longer exists.');
    return true;
  }
  if (!canWriteRoster(user)) {
    sendTelegram(chatId, 'You no longer have permission to approve sign-ups.');
    return true;
  }
  if (member.status !== 'Pending') {
    closeApprovalRequests(member.id, user.id, approve ? 'yes' : 'no');
    sendTelegram(chatId, `${who} was already handled (currently ${member.status}).`);
    return true;
  }

  if (approve) {
    approveRosterSubmission(member);
    sendTelegram(chatId, `✅ Approved — ${who} is on the roster.`);
  } else {
    declineRosterSubmission(member.id);
    sendTelegram(chatId, `🚫 Declined — ${who} was not added.`);
  }
  closeApprovalRequests(member.id, user.id, approve ? 'yes' : 'no');
  notifyRosterManagers(
    `${who} was ${approve ? 'approved' : 'declined'} by ${user.displayName} over Telegram.`, 'roster', 'info');
  return true;
}

app.post('/api/telegram/webhook/:secret', (req, res) => {
  if (!telegramEnabled() || req.params.secret !== TELEGRAM_WEBHOOK_SECRET) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const msg = (req.body && req.body.message) || {};
    const chatId = msg.chat && msg.chat.id;
    const text = String(msg.text || '').trim();
    if (chatId && text) {
      const startMatch = text.match(/^\/start(?:\s+(\S+))?/i);
      if (startMatch) {
        const code = String(startMatch[1] || '').trim();
        const user = code ? db.prepare('SELECT id, displayName FROM users WHERE telegramLinkCode = ? AND telegramLinkCode != \'\'').get(code) : null;
        if (user) {
          // One code, one chat: clear it from any other account first.
          db.prepare("UPDATE users SET telegramChatId = '' WHERE telegramChatId = ?").run(String(chatId));
          db.prepare('UPDATE users SET telegramChatId = ? WHERE id = ?').run(String(chatId), user.id);
          sendTelegram(chatId, `✅ Connected! You're linked as ${user.displayName} and will now get Club America updates here — tasks, orders, and form submissions. Send /stop any time to turn them off.`);
        } else {
          sendTelegram(chatId, `👋 Hi! To get Club America updates, open the "Connect Telegram" button on your profile in the board portal — it'll bring you back here with your personal link.`);
        }
      } else if (/^\/stop\b/i.test(text)) {
        db.prepare("UPDATE users SET telegramChatId = '' WHERE telegramChatId = ?").run(String(chatId));
        sendTelegram(chatId, '🔕 Done — you won\'t get Club America updates here anymore. Reconnect any time from your profile in the portal.');
      } else {
        const replyToId = msg.reply_to_message && msg.reply_to_message.message_id;
        handleSignupReply(String(chatId), text, replyToId ? String(replyToId) : '');
      }
    }
  } catch (e) {
    console.warn('[telegram] webhook error:', e.message);
  }
  res.json({ ok: true });
});

// Everything past this point requires a changed password.
app.use('/api', authenticate, requirePasswordChanged);

// ---- Own profile (photo + intro bio) ----------------------------------------
app.get('/api/me/profile', (req, res) => {
  const row = db.prepare('SELECT photo, bio, email, phone, profileComplete FROM users WHERE id = ?').get(req.user.id);
  res.json({ photo: row.photo || '', bio: row.bio || '', email: row.email || '', phone: row.phone || '', profileComplete: !!row.profileComplete });
});

app.put('/api/me/profile', (req, res) => {
  let { photo, bio, email, phone } = req.body || {};
  photo = typeof photo === 'string' ? photo : '';
  bio = String(bio || '').trim().slice(0, 4000);
  email = String(email || '').trim().slice(0, 200);
  phone = String(phone || '').trim().slice(0, 30);
  if (photo && !/^data:image\/(png|jpe?g|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: 'Photo must be an image' });
  }
  if (photo.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  // An empty photo means "no new photo chosen" — keep the existing one rather
  // than wiping it (there is no remove-photo flow; users replace instead).
  db.prepare('UPDATE users SET photo = COALESCE(?, photo), bio = ?, email = ?, phone = ?, profileComplete = 1 WHERE id = ?')
    .run(photo || null, bio, email, phone, req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

// ---- Telegram account linking (per-member DM updates) -----------------------
// Returns whether the feature is configured, whether this member is linked,
// and a personal deep link that opens the bot with their one-time code.
app.get('/api/me/telegram', (req, res) => {
  if (!telegramEnabled() || !TELEGRAM_BOT_USERNAME) {
    return res.json({ configured: false, linked: false });
  }
  const row = db.prepare('SELECT telegramChatId, telegramLinkCode FROM users WHERE id = ?').get(req.user.id);
  let code = row.telegramLinkCode;
  if (!code) {
    code = crypto.randomBytes(12).toString('hex');
    db.prepare('UPDATE users SET telegramLinkCode = ? WHERE id = ?').run(code, req.user.id);
  }
  res.json({
    configured: true,
    linked: !!row.telegramChatId,
    connectUrl: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${code}`,
  });
});

// Unlink Telegram from this account (also tell the chat it's off).
app.post('/api/me/telegram/disconnect', (req, res) => {
  const row = db.prepare('SELECT telegramChatId FROM users WHERE id = ?').get(req.user.id);
  db.prepare("UPDATE users SET telegramChatId = '' WHERE id = ?").run(req.user.id);
  if (row && row.telegramChatId) {
    sendTelegram(row.telegramChatId, '🔕 This account was disconnected from Club America updates. Reconnect any time from your profile in the portal.');
  }
  res.json({ ok: true, linked: false });
});

// Admins & managers can DM a board member through the bot from the team page.
app.post('/api/telegram/message', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Managers and admins only' });
  if (!telegramEnabled()) return res.status(400).json({ error: 'Telegram is not set up yet' });
  const userId = Number((req.body || {}).userId);
  const text = String((req.body || {}).text || '').trim().slice(0, 3000);
  if (!userId || !text) return res.status(400).json({ error: 'Recipient and a message are required' });
  const target = db.prepare('SELECT id, displayName, telegramChatId FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'That member no longer exists' });
  if (!target.telegramChatId) return res.status(400).json({ error: `${target.displayName} hasn't connected Telegram yet` });
  sendTelegram(target.telegramChatId, `💬 Message from ${req.user.displayName}:\n\n${text}`);
  res.json({ ok: true });
});

// Broadcast a Telegram DM to every board member who's linked their account.
app.post('/api/telegram/broadcast', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Managers and admins only' });
  if (!telegramEnabled()) return res.status(400).json({ error: 'Telegram is not set up yet' });
  const text = String((req.body || {}).text || '').trim().slice(0, 3000);
  if (!text) return res.status(400).json({ error: 'A message is required' });
  const recipients = db.prepare("SELECT telegramChatId FROM users WHERE telegramChatId != ''").all();
  for (const r of recipients) sendTelegram(r.telegramChatId, `📢 Message to all of Club America from ${req.user.displayName}:\n\n${text}`);
  res.json({ ok: true, sent: recipients.length });
});

// ---- In-app notifications ----------------------------------------------------
app.get('/api/notifications', (req, res) => {
  const notifications = db
    .prepare('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 50')
    .all(req.user.id);
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE userId = ? AND isRead = 0')
    .get(req.user.id).n;
  res.json({ notifications, unread });
});

app.post('/api/notifications/read', (req, res) => {
  const { id } = req.body || {};
  if (id) {
    db.prepare('UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?').run(Number(id), req.user.id);
  } else {
    db.prepare('UPDATE notifications SET isRead = 1 WHERE userId = ?').run(req.user.id);
  }
  res.json({ ok: true });
});

app.delete('/api/notifications/:id', (req, res) => {
  db.prepare('DELETE FROM notifications WHERE id = ? AND userId = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---- Approval / review history (admins & managers) --------------------------
app.get('/api/approval-log', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { entityType, entityId } = req.query;
  if (entityType && entityId) {
    const rows = db.prepare(
      'SELECT * FROM approval_log WHERE entityType = ? AND entityId = ? ORDER BY createdAt DESC'
    ).all(String(entityType), Number(entityId));
    return res.json({ log: rows });
  }
  const rows = db.prepare('SELECT * FROM approval_log ORDER BY createdAt DESC LIMIT 100').all();
  res.json({ log: rows });
});

// ---- Get Involved submissions inbox -----------------------------------------
// Routing/visibility:
//  - Admins (President/VP) see ALL submissions.
//  - The Secretary sees every CLUB-join submission. Get Involved runs
//    alongside the /join form as the club's other intake path, and the
//    Secretary owns both — they're also the one alerted about them.
//  - A grade rep (user.grade set) sees CLUB-join submissions for their grade.
//  - Board applications go to admins only.
function visibleSubmissionsFor(user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT * FROM submissions ORDER BY handled ASC, createdAt DESC').all();
  }
  if (isSecretary(user)) {
    return db.prepare("SELECT * FROM submissions WHERE type = 'club' ORDER BY handled ASC, createdAt DESC").all();
  }
  if (user.grade) {
    return db
      .prepare("SELECT * FROM submissions WHERE type = 'club' AND grade = ? ORDER BY handled ASC, createdAt DESC")
      .all(user.grade);
  }
  return [];
}
function canSeeSubmission(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  if (row.type !== 'club') return false;
  if (isSecretary(user)) return true;
  return !!user.grade && row.grade === user.grade;
}
function canAccessSubmissions(user) {
  return user.role === 'admin' || isSecretary(user) || !!user.grade;
}

app.get('/api/submissions', (req, res) => {
  if (!canAccessSubmissions(req.user)) return res.status(403).json({ error: 'Not allowed' });
  res.json({ submissions: visibleSubmissionsFor(req.user) });
});

app.post('/api/submissions/:id/handled', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(req.params.id));
  if (!canSeeSubmission(req.user, row)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('UPDATE submissions SET handled = ? WHERE id = ?').run(row.handled ? 0 : 1, row.id);
  res.json({ submission: db.prepare('SELECT * FROM submissions WHERE id = ?').get(row.id) });
});

app.delete('/api/submissions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(req.params.id));
  if (!canSeeSubmission(req.user, row)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM submissions WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// The full settings for authorized editors.
app.get('/api/home/settings', (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Not allowed' });
  res.json({ home: getHome() });
});

// Update homepage content — Digital Presence Manager (canEditHome) or admins.
function canEditHome(user) {
  return user.role === 'admin' || !!user.canEditHome;
}
// Post/clear homepage announcement — admins, secretary, digital presence manager.
function canPostAnnouncement(user) {
  return user.role === 'admin' || !!user.canAnnounce;
}
// Review public photo submissions — admins, Digital Presence, Social Media managers.
function canModeratePhotos(user) {
  return user.role === 'admin' || !!user.canEditHome || !!user.canManageSocial;
}
app.put('/api/home', (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Only the Digital Presence Manager can edit the homepage' });
  let { meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, donationUrl, instagramPosts, aboutText } = req.body || {};
  if (meetingDate   !== undefined) meetingDate    = String(meetingDate).trim().slice(0, 100);
  if (meetingTime   !== undefined) meetingTime    = String(meetingTime).trim().slice(0, 100);
  if (meetingLocation !== undefined) meetingLocation = String(meetingLocation).trim().slice(0, 300);
  if (podcastUrl    !== undefined) podcastUrl     = String(podcastUrl).trim().slice(0, 500);
  if (calendarUrl   !== undefined) calendarUrl    = String(calendarUrl).trim().slice(0, 500);
  if (instagramUrl  !== undefined) instagramUrl   = String(instagramUrl).trim().slice(0, 300);
  if (donationUrl   !== undefined) donationUrl    = String(donationUrl).trim().slice(0, 500);
  if (aboutText     !== undefined) aboutText      = String(aboutText).trim().slice(0, 8000);
  // Curated Instagram post URLs (one per entry) shown as live embeds. Keep only
  // valid instagram.com post/reel links, cap the count, and store as JSON.
  let instagramPostsJson = null;
  if (instagramPosts !== undefined) {
    const arr = Array.isArray(instagramPosts) ? instagramPosts : [];
    const clean = arr
      .map((u) => String(u || '').trim().slice(0, 300))
      .filter((u) => /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\//i.test(u))
      .slice(0, 12);
    instagramPostsJson = JSON.stringify(clean);
  }
  const podcastEnabledVal = podcastEnabled === undefined ? null : (podcastEnabled ? 1 : 0);
  db.prepare(`UPDATE site_settings SET
       meetingDate = COALESCE(?, meetingDate),
       meetingTime = COALESCE(?, meetingTime),
       meetingLocation = COALESCE(?, meetingLocation),
       podcastUrl = COALESCE(?, podcastUrl),
       podcastEnabled = COALESCE(?, podcastEnabled),
       calendarUrl = COALESCE(?, calendarUrl),
       instagramUrl = COALESCE(?, instagramUrl),
       donationUrl = COALESCE(?, donationUrl),
       instagramPosts = COALESCE(?, instagramPosts),
       aboutText = COALESCE(?, aboutText),
       updatedAt = datetime('now')
     WHERE id = 1`)
    .run(
      meetingDate ?? null,
      meetingTime ?? null,
      meetingLocation ?? null,
      podcastUrl ?? null,
      podcastEnabledVal,
      calendarUrl ?? null,
      instagramUrl ?? null,
      donationUrl ?? null,
      instagramPostsJson,
      aboutText ?? null,
    );
  res.json({ home: getHome() });
});


// Force-refresh the iCal cache for the configured calendar URL.
app.post('/api/home/calendar/refresh', async (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const url = db.prepare('SELECT calendarUrl FROM site_settings WHERE id = 1').get().calendarUrl;
  if (!url) return res.status(400).json({ error: 'No calendar URL configured' });
  clearCache(url);
  try {
    const events = await fetchUpcoming(url, 3);
    res.json({ ok: true, events });
  } catch (_) {
    res.status(502).json({ error: 'Failed to fetch calendar — check the URL' });
  }
});

// Homepage announcement — secretary, digital presence, VP, president.
app.put('/api/home/announcement', (req, res) => {
  if (!canPostAnnouncement(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const text = String((req.body || {}).text || '').trim();
  db.prepare(`UPDATE site_settings SET
    homeAnnouncement = ?,
    homeAnnouncementEnabled = ?,
    announcementPostedAt = CASE WHEN ? != '' THEN datetime('now') ELSE announcementPostedAt END,
    updatedAt = datetime('now')
  WHERE id = 1`).run(text, text ? 1 : 0, text);
  res.json({ home: getHome() });
});

// ---- Event-photo moderation (board members) ---------------------------------
// Pending photos include the inline image so a moderator can preview before
// approving (this route is authenticated; the public gallery never sees them).
app.get('/api/event-photos/pending', (req, res) => {
  if (!canModeratePhotos(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const photos = db.prepare(
    "SELECT id, photo, caption, submitterName, createdAt FROM event_photos WHERE status = 'pending' ORDER BY createdAt ASC"
  ).all();
  res.json({ photos });
});

// Approved list for moderators (so they can also un-publish a photo later).
app.get('/api/event-photos/approved', (req, res) => {
  if (!canModeratePhotos(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const photos = db.prepare(
    "SELECT id, caption, submitterName, createdAt, approvedAt FROM event_photos WHERE status = 'approved' ORDER BY createdAt DESC LIMIT 200"
  ).all();
  res.json({ photos });
});

app.post('/api/event-photos/:id/approve', (req, res) => {
  if (!canModeratePhotos(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const row = db.prepare('SELECT * FROM event_photos WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE event_photos SET status = 'approved', approvedById = ?, approvedAt = datetime('now') WHERE id = ?")
    .run(req.user.id, row.id);
  logApproval('event_photo', row.id, 'approved', req.user);
  res.json({ ok: true });
});

app.delete('/api/event-photos/:id', (req, res) => {
  if (!canModeratePhotos(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const row = db.prepare('SELECT id FROM event_photos WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM event_photos WHERE id = ?').run(row.id);
  logApproval('event_photo', row.id, 'removed', req.user);
  res.json({ ok: true });
});

// ---- Instagram highlights management (Edit Website permission) --------------
app.get('/api/instagram-highlights/manage', (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const items = db.prepare('SELECT id, link, caption, sortOrder, createdAt FROM instagram_highlights ORDER BY sortOrder ASC, createdAt DESC').all();
  res.json({ items });
});

app.post('/api/instagram-highlights', (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Not allowed' });
  let { image, link, caption } = req.body || {};
  image = typeof image === 'string' ? image : '';
  link = String(link || '').trim().slice(0, 500);
  caption = String(caption || '').trim().slice(0, 280);
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(image)) return res.status(400).json({ error: 'Please choose an image (JPG, PNG, or WEBP).' });
  if (image.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'That image is too large — pick a smaller one.' });
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  const max = db.prepare('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM instagram_highlights').get().m;
  const info = db.prepare('INSERT INTO instagram_highlights (image, link, caption, sortOrder, createdById) VALUES (?, ?, ?, ?, ?)')
    .run(image, link, caption, max + 1, req.user.id);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/instagram-highlights/:id', (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM instagram_highlights WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Directory / org --------------------------------------------------------
app.get('/api/users', (req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE username != 'logistics' ORDER BY displayName").all().map(publicUser);
  res.json({ users });
});

// People I Manage (direct reports). Admins manage everyone implicitly, but the
// sidebar list shows their explicit direct reports plus all users for admins.
app.get('/api/reports', (req, res) => {
  let reports;
  if (req.user.role === 'admin') {
    reports = db.prepare("SELECT * FROM users WHERE id != ? AND username != 'logistics' ORDER BY displayName").all(req.user.id);
  } else {
    reports = directReports(req.user.id).filter(u => u.username !== 'logistics');
  }
  res.json({ reports: reports.map(publicUser) });
});

app.get('/api/orgchart', (req, res) => {
  const users = db.prepare("SELECT * FROM users").all().map(publicUser);
  res.json({ users });
});

// ---- User page settings (per-person feature toggles) ------------------------
app.get('/api/users/:id/page-settings', (req, res) => {
  const targetId = Number(req.params.id);
  if (!canViewTasksOf(req.user, targetId)) return res.status(403).json({ error: 'Not allowed' });
  res.json({ settings: getPageSettings(targetId) });
});

app.put('/api/users/:id/page-settings', (req, res) => {
  const targetId = Number(req.params.id);
  if (req.user.role !== 'admin' && !isManagerOf(req.user, targetId)) {
    return res.status(403).json({ error: 'Only admins or the direct manager can edit page settings' });
  }
  const { bannerEnabled, bannerTitle, bannerUrl, bannerLinks,
          formEnabled, formTitle, formFields, announcementEnabled, announcementText,
          bioEnabled, bioText } = req.body || {};
  if (bannerUrl !== undefined && bannerUrl && !/^https?:\/\//i.test(bannerUrl.trim())) {
    return res.status(400).json({ error: 'Banner URL must start with http:// or https://' });
  }
  let normalizedBannerLinks = null;
  if (bannerLinks !== undefined) {
    if (!Array.isArray(bannerLinks)) {
      return res.status(400).json({ error: 'bannerLinks must be an array' });
    }
    normalizedBannerLinks = [];
    for (const link of bannerLinks) {
      const title = String((link && link.title) || '').trim();
      const url = String((link && link.url) || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'Each banner URL must start with http:// or https://' });
      }
      // Keep empty rows as-is so an admin can add a blank link and fill it in
      // afterward; blank links are filtered out when the page is rendered.
      normalizedBannerLinks.push({ title, url });
    }
  }
  db.prepare('INSERT OR IGNORE INTO user_page_settings (userId) VALUES (?)').run(targetId);
  db.prepare(`UPDATE user_page_settings SET
    bannerEnabled       = COALESCE(?, bannerEnabled),
    bannerTitle         = COALESCE(?, bannerTitle),
    bannerUrl           = COALESCE(?, bannerUrl),
    bannerLinks         = COALESCE(?, bannerLinks),
    formEnabled         = COALESCE(?, formEnabled),
    formTitle           = COALESCE(?, formTitle),
    formFields          = COALESCE(?, formFields),
    announcementEnabled = COALESCE(?, announcementEnabled),
    announcementText    = COALESCE(?, announcementText),
    bioEnabled          = COALESCE(?, bioEnabled),
    bioText             = COALESCE(?, bioText),
    updatedAt           = datetime('now')
  WHERE userId = ?`).run(
    bannerEnabled !== undefined ? (bannerEnabled ? 1 : 0) : null,
    bannerTitle ?? null,
    bannerUrl ?? null,
    normalizedBannerLinks !== null ? JSON.stringify(normalizedBannerLinks) : null,
    formEnabled !== undefined ? (formEnabled ? 1 : 0) : null,
    formTitle ?? null,
    formFields !== undefined ? JSON.stringify(Array.isArray(formFields) ? formFields : []) : null,
    announcementEnabled !== undefined ? (announcementEnabled ? 1 : 0) : null,
    announcementText ?? null,
    bioEnabled !== undefined ? (bioEnabled ? 1 : 0) : null,
    bioText ?? null,
    targetId,
  );
  res.json({ settings: getPageSettings(targetId) });
});

// ---- Team announcements (broadcast from manager/admin to all their reports) --
app.get('/api/team-announcement', (req, res) => {
  if (req.user.role === 'member') return res.status(403).json({ error: 'Not allowed' });
  const row = db.prepare('SELECT * FROM team_announcements WHERE authorId = ?').get(req.user.id);
  res.json({ announcement: row || null });
});

app.put('/api/team-announcement', (req, res) => {
  if (req.user.role === 'member') return res.status(403).json({ error: 'Not allowed' });
  const trimmed = String((req.body || {}).text || '').trim().slice(0, 2000);
  if (!trimmed) return res.status(400).json({ error: 'Announcement text required' });
  db.prepare(`
    INSERT INTO team_announcements (authorId, text) VALUES (?, ?)
    ON CONFLICT(authorId) DO UPDATE SET text = excluded.text, updatedAt = datetime('now')
  `).run(req.user.id, trimmed);
  res.json({ announcement: db.prepare('SELECT * FROM team_announcements WHERE authorId = ?').get(req.user.id) });
});

app.delete('/api/team-announcement', (req, res) => {
  if (req.user.role === 'member') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM team_announcements WHERE authorId = ?').run(req.user.id);
  res.json({ ok: true });
});

// Returns announcements from: the target user's direct manager + all admins.
app.get('/api/users/:id/announcements', (req, res) => {
  const targetId = Number(req.params.id);
  if (!canViewTasksOf(req.user, targetId)) return res.status(403).json({ error: 'Not allowed' });
  const target = getUser(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`
    SELECT ta.id, ta.authorId, ta.text, ta.updatedAt,
           u.displayName AS authorName, u.title AS authorTitle
    FROM team_announcements ta
    JOIN users u ON u.id = ta.authorId
    WHERE u.role = 'admin' OR ta.authorId = ?
    ORDER BY ta.updatedAt DESC
  `).all(target.managerId || 0);
  res.json({ announcements: rows });
});

// ---- Roster -----------------------------------------------------------------
function canViewRoster(user) {
  return user.role === 'admin' || user.role === 'manager' || !!user.canManageRoster;
}
function canWriteRoster(user) {
  return user.role === 'admin' || user.role === 'manager' || !!user.canManageRoster;
}

// Phone numbers are the identity key for de-duping the roster: strip everything
// but digits so "(555) 123-4567" and "555-123-4567" collide.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}
// Returns a short human label if this phone already belongs to the club (an
// existing roster member or a portal account), otherwise null.
function findClubMemberByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  const rosterRows = db.prepare("SELECT firstName, lastName, phone FROM roster_members").all();
  for (const r of rosterRows) {
    if (normalizePhone(r.phone) === digits) return `${r.firstName} ${r.lastName}`.trim() || 'a roster member';
  }
  const userRows = db.prepare("SELECT displayName, phone FROM users WHERE phone != ''").all();
  for (const u of userRows) {
    if (normalizePhone(u.phone) === digits) return u.displayName || 'a club member';
  }
  return null;
}

// Does this sign-up look like someone the club already has? Checked at review
// time rather than stored, so a flag can't go stale as the roster changes around
// it. Phone and email are near-certain matches; a name match is only a prompt to
// look, since two students can share a name.
//
// excludeId keeps a submission from flagging itself once it is a roster row.
function duplicateFlagsFor({ firstName, lastName, phone, email, excludeId = null }) {
  const flags = [];
  const digits = normalizePhone(phone);
  const mail = String(email || '').trim().toLowerCase();
  const fullName = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim().toLowerCase();

  const label = (r) => `${r.firstName || ''} ${r.lastName || ''}`.trim() || 'a roster entry';
  const roster = db.prepare('SELECT id, firstName, lastName, phone, email, status FROM roster_members').all()
    .filter((r) => r.id !== excludeId);
  const users = db.prepare("SELECT id, displayName, phone, email FROM users WHERE username != 'logistics'").all();

  if (digits) {
    for (const r of roster) {
      if (normalizePhone(r.phone) === digits) {
        flags.push({ kind: 'phone', severity: 'high', where: 'roster', id: r.id,
          message: `Same phone number as ${label(r)} (${r.status}) already on the roster` });
      }
    }
    for (const u of users) {
      if (normalizePhone(u.phone) === digits) {
        flags.push({ kind: 'phone', severity: 'high', where: 'board', id: u.id,
          message: `Same phone number as board member ${u.displayName}` });
      }
    }
  }
  if (mail) {
    for (const r of roster) {
      if (String(r.email || '').trim().toLowerCase() === mail) {
        flags.push({ kind: 'email', severity: 'high', where: 'roster', id: r.id,
          message: `Same email as ${label(r)} (${r.status}) already on the roster` });
      }
    }
    for (const u of users) {
      if (String(u.email || '').trim().toLowerCase() === mail) {
        flags.push({ kind: 'email', severity: 'high', where: 'board', id: u.id,
          message: `Same email as board member ${u.displayName}` });
      }
    }
  }
  if (fullName) {
    for (const r of roster) {
      if (label(r).toLowerCase() === fullName) {
        flags.push({ kind: 'name', severity: 'medium', where: 'roster', id: r.id,
          message: `Same name as ${label(r)} (${r.status}) already on the roster` });
      }
    }
    for (const u of users) {
      if (String(u.displayName || '').trim().toLowerCase() === fullName) {
        flags.push({ kind: 'name', severity: 'medium', where: 'board', id: u.id,
          message: `Same name as board member ${u.displayName}` });
      }
    }
  }
  // One person matching on several fields is one duplicate, not three warnings.
  const seen = new Set();
  return flags.filter((f) => {
    const key = `${f.kind}:${f.where}:${f.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Keep every portal account (board member) mirrored onto the roster as a
// 'Board Member' entry with linkedUserId set, so board-meeting attendance
// (which is recorded against users.id, not roster_members.id) resolves back
// to a roster row and shows up under that person's "View Activity" panel.
// Idempotent: only inserts users who don't already have a roster row (matched
// by email, falling back to name) and never touches existing rows.
function syncBoardRoster() {
  const users = db.prepare('SELECT * FROM users').all();
  const existing = db.prepare('SELECT email, firstName, lastName FROM roster_members').all();
  const existingEmails = new Set(existing.map((r) => r.email?.toLowerCase()).filter(Boolean));
  const existingNames = new Set(existing.map((r) => `${r.firstName?.toLowerCase()}|${r.lastName?.toLowerCase()}`));

  const insert = db.prepare(`INSERT INTO roster_members (firstName, lastName, email, grade, roleDescription, status, linkedUserId)
    VALUES (?, ?, ?, ?, 'Board Member', 'Onboarded', ?)`);

  let imported = 0;
  let skipped = 0;
  const importMany = db.transaction(() => {
    for (const u of users) {
      if (u.username === 'logistics') continue;
      const email = (u.email || '').trim().toLowerCase();
      const nameKey = `${(u.firstName || '').toLowerCase()}|${(u.lastName || '').toLowerCase()}`;
      if ((email && existingEmails.has(email)) || existingNames.has(nameKey)) {
        skipped++;
        continue;
      }
      insert.run(
        u.firstName || u.displayName, u.lastName || '',
        u.email || '', u.grade ? String(u.grade) : null, u.id
      );
      if (email) existingEmails.add(email);
      existingNames.add(nameKey);
      imported++;
    }
  });
  importMany();
  return { imported, skipped };
}

app.get('/api/roster', (req, res) => {
  if (!canViewRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  try { syncBoardRoster(); } catch (e) { console.error('[roster] board sync failed:', e.message); }
  const { grade, status } = req.query;
  let sql = `SELECT r.*, u.displayName as claimedByName, ref.displayName as referredByName
    FROM roster_members r
    LEFT JOIN users u ON u.id = r.claimedByUserId
    LEFT JOIN users ref ON ref.id = r.referredByUserId
    WHERE 1=1`;
  const params = [];
  if (grade) { sql += ' AND r.grade = ?'; params.push(Number(grade)); }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  sql += ' ORDER BY r.createdAt DESC';
  const members = db.prepare(sql).all(...params).map((m) => (
    // Only sign-ups still awaiting a decision carry flags — that is the moment
    // the duplicate matters, and it keeps this off the whole-roster path.
    m.status === 'Pending'
      ? { ...m, duplicateFlags: duplicateFlagsFor({
          firstName: m.firstName, lastName: m.lastName, phone: m.phone, email: m.email, excludeId: m.id }) }
      : m
  ));
  res.json({ members, myGrade: req.user.managedGrade || null });
});

// Manual re-trigger, kept for admins who want to force a sync without reloading
// the roster page (GET /api/roster already runs this automatically).
app.post('/api/roster/import-board', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  res.json(syncBoardRoster());
});

// Add-to-roster form. Open to EVERY authenticated member: roster managers add
// directly, while regular members' submissions become pending referrals that
// credit them once the Secretary approves. Phone is required and is the de-dupe
// key so the same person can't be referred twice / added if already in the club.
app.post('/api/roster', (req, res) => {
  const { firstName, lastName, phone, email, grade, gender, roleDescription, status, notes } = req.body || {};
  if (!firstName || !String(firstName).trim()) return res.status(400).json({ error: 'First name required' });
  if (!phone || !normalizePhone(phone)) return res.status(400).json({ error: 'Phone number is required' });
  if (grade != null && grade !== '' && !GRADES.includes(String(grade))) {
    return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email' });
  }
  const existing = findClubMemberByPhone(phone);
  if (existing) {
    return res.status(409).json({ error: `${existing} is already in the club — that phone number is already on the roster.` });
  }

  const privileged = canWriteRoster(req.user);
  // A "referral" credits the submitter and needs the Secretary's approval before
  // it counts. Everyone competes this way (the referral form sends referral:true).
  // Regular members can ONLY refer; roster managers can also add members straight
  // into the pipeline (no referral flag) for their own recruiting.
  const asReferral = !privileged || req.body.referral === true;
  const rosterStatus  = asReferral ? 'Pending' : (status || 'Prospect');
  const referredBy    = asReferral ? req.user.id : null;
  const referralState = asReferral ? 'pending' : '';

  const info = db.prepare(`INSERT INTO roster_members
    (firstName,lastName,phone,email,grade,gender,roleDescription,status,notes,referredByUserId,referralStatus)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    String(firstName).trim().slice(0, 100), String(lastName||'').trim().slice(0, 100),
    String(phone||'').trim().slice(0, 30), String(email||'').trim().slice(0, 200),
    grade||null, String(gender||'').trim().slice(0, 30),
    String(roleDescription||'').trim().slice(0, 500), rosterStatus,
    String(notes||'').trim().slice(0, 2000),
    referredBy || null, referralState,
  );
  if (asReferral) {
    const name = `${String(firstName).trim()} ${String(lastName||'').trim()}`.trim();
    // Only the secretary is told: the referrer is the one submitting the form,
    // so they already know, and nobody else needs a ping about a new sign-up.
    notifySecretary(`${req.user.displayName} referred ${name} — approve it in the roster to award the referral.`, 'roster', 'submission');
  }
  res.status(201).json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/roster/:id', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { firstName, lastName, phone, email, grade, gender, roleDescription, status, notes, parentFormCollected } = req.body || {};
  if (grade != null && grade !== '' && !GRADES.includes(String(grade))) {
    return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email' });
  }
  if (status != null && status !== m.status && !isValidRosterTransition(m.status, status)) {
    return res.status(400).json({ error: `Cannot move a member from ${m.status} to ${status}` });
  }
  db.prepare(`UPDATE roster_members SET
    firstName=COALESCE(?,firstName), lastName=COALESCE(?,lastName), phone=COALESCE(?,phone),
    email=COALESCE(?,email), grade=COALESCE(?,grade), gender=COALESCE(?,gender),
    roleDescription=COALESCE(?,roleDescription), status=COALESCE(?,status), notes=COALESCE(?,notes),
    parentFormCollected=COALESCE(?,parentFormCollected),
    updatedAt=datetime('now') WHERE id=?`).run(
    firstName??null, lastName??null, phone??null, email??null, grade??null,
    gender??null, roleDescription??null, status??null, notes??null,
    parentFormCollected !== undefined ? (parentFormCollected ? 1 : 0) : null, m.id
  );
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(m.id) });
});

app.delete('/api/roster/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM roster_members WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// First-to-claim logic — atomic UPDATE WHERE claimedByUserId IS NULL.
app.post('/api/roster/:id/claim', (req, res) => {
  if (!canViewRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const result = db.prepare(`UPDATE roster_members SET claimedByUserId=?, updatedAt=datetime('now')
    WHERE id=? AND claimedByUserId IS NULL`).run(req.user.id, Number(req.params.id));
  if (result.changes === 0) return res.status(409).json({ error: 'Already claimed by someone else' });
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id)) });
});

app.post('/api/roster/:id/contacted', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare(`UPDATE roster_members SET status='Contacted', updatedAt=datetime('now') WHERE id=?`).run(Number(req.params.id));
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id)) });
});

app.post('/api/roster/:id/convert', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.status !== 'Contacted') return res.status(400).json({ error: 'Member must be Contacted before onboarding' });
  const { grade, roleDescription } = req.body || {};
  db.prepare(`UPDATE roster_members SET status='Onboarded', convertedAt=datetime('now'),
    grade=COALESCE(?,grade), roleDescription=COALESCE(?,roleDescription), updatedAt=datetime('now')
    WHERE id=?`).run(grade||null, roleDescription||null, m.id);
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(m.id) });
});

// The people asked to approve a sign-up: the President and VP by title, since
// that is the club's actual approval authority. Falling back to admins keeps the
// question reaching someone if those titles are ever renamed.
function signupApprovers() {
  const byTitle = db.prepare(
    "SELECT id, displayName, telegramChatId FROM users WHERE title IN ('President', 'Vice President') AND username != 'logistics'"
  ).all();
  if (byTitle.length) return byTitle;
  return db.prepare("SELECT id, displayName, telegramChatId FROM users WHERE role = 'admin' AND username != 'logistics'").all();
}

// Mark every outstanding Telegram question about this sign-up as answered, and
// tell the other approver who handled it so two people don't both act on it.
function closeApprovalRequests(rosterId, actorUserId, answer) {
  let open = [];
  try {
    open = db.prepare("SELECT * FROM roster_approval_requests WHERE rosterId = ? AND answer = ''").all(rosterId);
    if (!open.length) return;
    db.prepare(`UPDATE roster_approval_requests SET answer = ?, answeredAt = datetime('now')
      WHERE rosterId = ? AND answer = ''`).run(answer, rosterId);
  } catch (e) {
    console.warn('[signup] closing approval requests failed:', e.message);
    return;
  }
  const actor = actorUserId ? getUser(actorUserId) : null;
  const m = db.prepare('SELECT firstName, lastName FROM roster_members WHERE id = ?').get(rosterId);
  const who = `${(m && m.firstName) || ''} ${(m && m.lastName) || ''}`.trim() || 'that sign-up';
  const verdict = answer === 'yes' ? 'approved' : 'declined';
  for (const r of open) {
    // The person who acted already knows; only the others need telling.
    if (actor && r.userId === actor.id) continue;
    sendTelegram(r.chatId, `ℹ️ ${who} was ${verdict}${actor ? ` by ${actor.displayName}` : ''} — no reply needed.`);
  }
}

// Approving and declining happen from two places now — the roster screen and a
// Telegram reply — so the actual state changes live here and both callers go
// through them. Anything else and the two paths drift: one awards the referral
// point, the other quietly doesn't.
function approveRosterSubmission(m, { grade, roleDescription } = {}) {
  const awardsReferral = m.referredByUserId && m.referralStatus === 'pending';
  db.prepare(`UPDATE roster_members SET status='Onboarded', convertedAt=datetime('now'),
    grade=COALESCE(?,grade), roleDescription=COALESCE(?,roleDescription),
    referralStatus=CASE WHEN ? THEN 'approved' ELSE referralStatus END, updatedAt=datetime('now')
    WHERE id=?`).run(grade || null, roleDescription || null, awardsReferral ? 1 : 0, m.id);
  if (awardsReferral) {
    const name = `${m.firstName} ${m.lastName}`.trim();
    pushNotification(m.referredByUserId, `Your referral of ${name} was approved — you earned a referral point!`, 'referrals', 'info');
    sendReferralStandings(m.referredByUserId);
  }
  return db.prepare('SELECT * FROM roster_members WHERE id=?').get(m.id);
}

function declineRosterSubmission(rosterId) {
  db.prepare(`UPDATE roster_members SET status='Declined', updatedAt=datetime('now') WHERE id=?`).run(rosterId);
  return db.prepare('SELECT * FROM roster_members WHERE id=?').get(rosterId);
}

app.post('/api/roster/:id/decline', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const id = Number(req.params.id);
  declineRosterSubmission(id);
  // Someone answered on the website, so stop asking about it over Telegram.
  closeApprovalRequests(id, req.user.id, 'no');
  res.json({ ok: true });
});

// Approve a self-service (Pending) submission — adds it to the roster as an
// onboarded member. Optional grade/roleDescription let the secretary fill in
// anything the member left blank at approval time.
app.post('/api/roster/:id/approve', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.status !== 'Pending') return res.status(400).json({ error: 'Only pending submissions can be approved' });
  const { grade, roleDescription } = req.body || {};
  if (grade != null && grade !== '' && !GRADES.includes(String(grade))) {
    return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  }
  const member = approveRosterSubmission(m, { grade, roleDescription });
  closeApprovalRequests(m.id, req.user.id, 'yes');
  res.json({ member });
});

// Absence follow-up — "Remove": mark the member Inactive (they stay on the
// attendance roster for a 30-day grace window, then auto-purge) and immediately
// pull the referrer's point. Coming back (a present mark) restores both.
app.post('/api/roster/:id/deactivate', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  const losesCredit = m.referralStatus === 'approved';
  db.prepare(`UPDATE roster_members SET status='Inactive', inactivatedAt=datetime('now'),
    referralStatus = CASE WHEN ? THEN 'removed' ELSE referralStatus END, updatedAt=datetime('now')
    WHERE id=?`).run(losesCredit ? 1 : 0, m.id);
  if (losesCredit && m.referredByUserId) {
    const name = `${m.firstName} ${m.lastName}`.trim();
    pushNotification(m.referredByUserId, `${name} was removed for missing meetings — the referral point was deducted (it returns if they come back).`, 'referrals', 'info');
    sendReferralStandings(m.referredByUserId);
  }
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(m.id) });
});

// Absence follow-up — "Mark as contacted": silence the alert until their next
// absence. The alert event id already suppresses re-notifying for this streak;
// this just records the acknowledgement for the detail view.
app.post('/api/roster/:id/absence-contacted', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE roster_members SET absenceContactedAt=datetime('now'), updatedAt=datetime('now') WHERE id=?").run(m.id);
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(m.id) });
});

// Referral competition standings, ranked by the number of approved referrals each
// member has (a referral counts once the Secretary approves it, and drops back off
// if the referred member is later removed). Shared by the leaderboard endpoint and
// the Telegram standings message so the two can't drift apart.
function referralStandings() {
  return db.prepare(`
    SELECT u.id, u.displayName, u.title,
           COUNT(r.id) AS count
    FROM users u
    JOIN roster_members r ON r.referredByUserId = u.id AND r.referralStatus = 'approved'
    GROUP BY u.id
    ORDER BY count DESC, u.displayName ASC
  `).all();
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

// Telegram-only nudge sent whenever a member's referral count changes: the top of
// the board, plus their own line when they rank below it. Deliberately not routed
// through pushNotification — that mirrors to both channels, and a leaderboard blob
// in the notification bell would be noise. Silent when Telegram is off or the
// member never linked their account.
function sendReferralStandings(userId) {
  if (!userId || !telegramEnabled()) return;
  try {
    const row = db.prepare('SELECT telegramChatId FROM users WHERE id = ?').get(userId);
    if (!row || !row.telegramChatId) return;
    const board = referralStandings();
    const top = board.slice(0, 5).map((r, i) => `${i + 1}. ${r.displayName} — ${r.count}`);
    const rank = board.findIndex((r) => r.id === userId);
    // Someone back down to zero drops out of the ranked query entirely, so spell
    // that out rather than leaving them wondering where they went.
    const ownLine =
      rank < 0 ? '\n\nYou: unranked — 0' :
      rank >= 5 ? `\n\nYou: ${ordinal(rank + 1)} — ${board[rank].count}` : '';
    sendTelegram(row.telegramChatId, `🏆 Referral standings\n${top.join('\n')}${ownLine}`);
  } catch (e) {
    console.warn('[telegram] referral standings failed:', e.message);
  }
}

app.get('/api/roster/leaderboard', (req, res) => {
  const rows = referralStandings();
  // Pending referrals the current user is waiting on (not yet counted). The
  // names come back too, so someone who shared their link can see the sign-up
  // landed instead of wondering why their count hasn't moved.
  const myPendingRows = db.prepare(
    "SELECT id, firstName, lastName FROM roster_members WHERE referredByUserId = ? AND referralStatus = 'pending' ORDER BY createdAt DESC"
  ).all(req.user.id);
  const myPendingNames = myPendingRows.map((r) => `${r.firstName} ${r.lastName || ''}`.trim());

  // Who each member has actually brought in. The leaderboard alone only says how
  // many, which doesn't tell anyone whether the person they're about to approach
  // has already been referred by someone else.
  //
  // This endpoint is open to every signed-in member, while the roster itself sits
  // behind canViewRoster — so this deliberately selects names and grade only.
  // Phone and email stay on the roster page where the permission check is.
  const referrals = db.prepare(`
    SELECT r.id, r.firstName, r.lastName, r.grade, r.referralStatus AS status,
           r.referredByUserId AS referrerId, u.displayName AS referrerName
    FROM roster_members r
    JOIN users u ON u.id = r.referredByUserId
    WHERE r.referralStatus IN ('pending', 'approved', 'removed')
    ORDER BY r.createdAt DESC
  `).all().map((r) => ({
    id: r.id,
    name: `${r.firstName || ''} ${r.lastName || ''}`.trim() || 'Unnamed',
    grade: r.grade || null,
    status: r.status,
    referrerId: r.referrerId,
    referrerName: r.referrerName,
  }));

  res.json({ leaderboard: rows, myPending: myPendingRows.length, myPendingNames, referrals });
});

// ---- Weekly Check-Ins -------------------------------------------------------
function getCheckinEnabled() {
  const row = db.prepare('SELECT weeklyCheckinEnabled FROM site_settings WHERE id=1').get();
  return !!row?.weeklyCheckinEnabled;
}

app.get('/api/checkins/settings', (req, res) => {
  res.json({ enabled: getCheckinEnabled() });
});

app.put('/api/checkins/settings', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Managers and admins only' });
  const enabled = !!(req.body || {}).enabled;
  db.prepare("UPDATE site_settings SET weeklyCheckinEnabled=?, updatedAt=datetime('now') WHERE id=1").run(enabled ? 1 : 0);
  res.json({ enabled });
});

app.post('/api/checkins', (req, res) => {
  if (!getCheckinEnabled()) return res.status(400).json({ error: 'Check-ins are currently disabled' });
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: 'Content required' });
  // weekOf = this week's Friday (the deadline everyone submits against).
  const weekOf = currentCheckinWeek();
  const existing = db.prepare('SELECT id FROM weekly_checkins WHERE userId=? AND weekOf=?').get(req.user.id, weekOf);
  if (existing) {
    db.prepare("UPDATE weekly_checkins SET content=?, submittedAt=datetime('now') WHERE id=?").run(content, existing.id);
  } else {
    db.prepare('INSERT INTO weekly_checkins (userId,content,weekOf) VALUES (?,?,?)').run(req.user.id, content, weekOf);
  }
  res.json({ ok: true, weekOf });
});

app.get('/api/checkins', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const rows = db.prepare(`SELECT wc.*, u.displayName as userName, u.title as userTitle
    FROM weekly_checkins wc JOIN users u ON u.id = wc.userId
    ORDER BY wc.submittedAt DESC LIMIT 100`).all();
  res.json({ checkins: rows });
});

app.get('/api/checkins/my', (req, res) => {
  const weekOf = req.query.weekOf || currentCheckinWeek();
  const row = db.prepare('SELECT * FROM weekly_checkins WHERE userId=? AND weekOf=?').get(req.user.id, weekOf);
  res.json({ checkin: row || null, weekOf, enabled: getCheckinEnabled() });
});

// ---- Funding Requests -------------------------------------------------------
app.get('/api/funding', (req, res) => {
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  let rows;
  if (isPrivileged) {
    rows = db.prepare(`SELECT fr.*, u.displayName as submitterName, rv.displayName as reviewerName
      FROM funding_requests fr
      JOIN users u ON u.id=fr.submittedById
      LEFT JOIN users rv ON rv.id=fr.reviewedById
      ORDER BY fr.createdAt DESC`).all();
  } else {
    rows = db.prepare(`SELECT fr.*, u.displayName as submitterName, rv.displayName as reviewerName
      FROM funding_requests fr
      JOIN users u ON u.id=fr.submittedById
      LEFT JOIN users rv ON rv.id=fr.reviewedById
      WHERE fr.submittedById=?
      ORDER BY fr.createdAt DESC`).all(req.user.id);
  }
  res.json({ requests: rows });
});

app.post('/api/funding', rateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'funding' }), (req, res) => {
  const { title, description, amount } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  const amt = Number(amount) || 0;
  if (amt < 0) return res.status(400).json({ error: 'Amount cannot be negative' });
  const safeTitle = String(title).trim().slice(0, 300);
  const safeDesc = String(description || '').trim().slice(0, 4000);
  const info = db.prepare(`INSERT INTO funding_requests (submittedById,title,description,amount)
    VALUES (?,?,?,?)`).run(req.user.id, safeTitle, safeDesc, amt);

  // Notify the CFO + admins that a funding request is awaiting review.
  const reviewers = db.prepare("SELECT id, email FROM users WHERE role = 'admin' OR title = 'CFO'").all();
  for (const r of reviewers) {
    if (r.id === req.user.id) continue;
    notify(r.email, 'New funding request', 'Funding request awaiting review',
      `<b>${escHtml(req.user.displayName)}</b> requested funding: <b>${escHtml(safeTitle)}</b> ($${amt}).`);
    pushNotification(r.id, `${req.user.displayName} submitted a funding request: "${safeTitle}" ($${amt})`, 'funding', 'funding');
  }
  res.status(201).json({ request: db.prepare('SELECT * FROM funding_requests WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/funding/:id', (req, res) => {
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  const fr = db.prepare('SELECT * FROM funding_requests WHERE id=?').get(Number(req.params.id));
  if (!fr) return res.status(404).json({ error: 'Not found' });
  const { action, reviewNotes } = req.body || {};
  if (!isPrivileged) return res.status(403).json({ error: 'Not allowed' });
  // Reviewers may not approve/deny their own funding requests.
  if ((action === 'approve' || action === 'deny') && fr.submittedById === req.user.id) {
    return res.status(403).json({ error: 'You cannot review your own funding request' });
  }
  if ((action === 'approve' || action === 'deny') && fr.status !== 'pending') {
    return res.status(400).json({ error: 'This request has already been reviewed' });
  }
  if (action === 'purchased' && fr.status !== 'approved') {
    return res.status(400).json({ error: 'Only approved requests can be marked as purchased' });
  }
  if (action === 'approve') {
    db.transaction(() => {
      db.prepare(`UPDATE funding_requests SET status='approved', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?,reviewNotes) WHERE id=?`).run(req.user.id, reviewNotes??null, fr.id);
      logApproval('funding', fr.id, 'approved', req.user, reviewNotes || fr.title);
    })();
    pushNotification(fr.submittedById, `Your funding request "${fr.title}" was approved by ${req.user.displayName}`, 'funding', 'funding');
  } else if (action === 'deny') {
    db.transaction(() => {
      db.prepare(`UPDATE funding_requests SET status='denied', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?,reviewNotes) WHERE id=?`).run(req.user.id, reviewNotes??null, fr.id);
      logApproval('funding', fr.id, 'denied', req.user, reviewNotes || fr.title);
    })();
    pushNotification(fr.submittedById, `Your funding request "${fr.title}" was denied by ${req.user.displayName}`, 'funding', 'funding');
  } else if (action === 'purchased') {
    db.transaction(() => {
      db.prepare(`UPDATE funding_requests SET status='purchased', purchasedById=?, purchasedAt=datetime('now') WHERE id=?`).run(req.user.id, fr.id);
      logApproval('funding', fr.id, 'purchased', req.user, fr.title);
    })();
    pushNotification(fr.submittedById, `Your funding request "${fr.title}" was marked purchased by ${req.user.displayName}`, 'funding', 'funding');
  }
  res.json({ request: db.prepare('SELECT * FROM funding_requests WHERE id=?').get(fr.id) });
});

// ---- Board Applications -----------------------------------------------------
app.get('/api/board-apps', (req, res) => {
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  let rows;
  if (isPrivileged) {
    rows = db.prepare(`SELECT ba.*, u.displayName as applicantName, u.title as applicantTitle
      FROM board_applications ba JOIN users u ON u.id=ba.userId
      ORDER BY ba.createdAt DESC`).all();
  } else {
    rows = db.prepare(`SELECT ba.*, u.displayName as applicantName, u.title as applicantTitle
      FROM board_applications ba JOIN users u ON u.id=ba.userId
      WHERE ba.userId=? ORDER BY ba.createdAt DESC`).all(req.user.id);
  }
  res.json({ applications: rows });
});

app.post('/api/board-apps', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: 'board-apps' }), (req, res) => {
  const { positionTitle, statement } = req.body || {};
  if (!positionTitle || !String(positionTitle).trim()) return res.status(400).json({ error: 'Position title required' });
  const safePosition = String(positionTitle).trim().slice(0, 200);
  const safeStatement = String(statement || '').trim().slice(0, 6000);
  const info = db.prepare(`INSERT INTO board_applications (userId,positionTitle,statement) VALUES (?,?,?)`).run(
    req.user.id, safePosition, safeStatement
  );

  // Notify admins that a leadership application is awaiting review.
  const admins = db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    if (a.id === req.user.id) continue;
    notify(a.email, 'New board application', 'Board application awaiting review',
      `<b>${escHtml(req.user.displayName)}</b> applied for <b>${escHtml(safePosition)}</b>.`);
    pushNotification(a.id, `${req.user.displayName} applied for "${safePosition}"`, 'board-apps', 'board-app');
  }
  res.status(201).json({ application: db.prepare('SELECT * FROM board_applications WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/board-apps/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const ba = db.prepare('SELECT * FROM board_applications WHERE id=?').get(Number(req.params.id));
  if (!ba) return res.status(404).json({ error: 'Not found' });
  const { action } = req.body || {};
  if (action === 'accept' || action === 'decline') {
    if (ba.status !== 'pending') return res.status(400).json({ error: 'This application has already been reviewed' });
    const status = action === 'accept' ? 'accepted' : 'declined';
    db.transaction(() => {
      db.prepare(`UPDATE board_applications SET status=?, reviewedById=?, reviewedAt=datetime('now') WHERE id=?`).run(status, req.user.id, ba.id);
      logApproval('board-app', ba.id, status, req.user, ba.positionTitle);
    })();
    pushNotification(ba.userId, `Your application for "${ba.positionTitle}" was ${status} by ${req.user.displayName}`, 'board-apps', 'board-app');
  } else {
    return res.status(400).json({ error: 'Invalid action — use "accept" or "decline"' });
  }
  res.json({ application: db.prepare('SELECT * FROM board_applications WHERE id=?').get(ba.id) });
});

// ---- Manager Dashboard aggregate --------------------------------------------
app.get('/api/dashboard', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const pendingFunding = db.prepare(`SELECT fr.*, u.displayName as submitterName
    FROM funding_requests fr JOIN users u ON u.id=fr.submittedById
    WHERE fr.status='pending' ORDER BY fr.createdAt DESC`).all();
  const pendingApps = db.prepare(`SELECT ba.*, u.displayName as applicantName, u.title as applicantTitle
    FROM board_applications ba JOIN users u ON u.id=ba.userId
    WHERE ba.status='pending' ORDER BY ba.createdAt DESC`).all();
  const recentCheckins = db.prepare(`SELECT wc.*, u.displayName as userName, u.title as userTitle
    FROM weekly_checkins wc JOIN users u ON u.id=wc.userId
    ORDER BY wc.submittedAt DESC LIMIT 50`).all();
  let pendingTasks;
  if (req.user.role === 'admin') {
    pendingTasks = db.prepare("SELECT * FROM tasks WHERE approvalStatus='pending' ORDER BY createdAt DESC").all();
  } else {
    pendingTasks = db.prepare("SELECT * FROM tasks WHERE approvalStatus='pending' AND approverId=? ORDER BY createdAt DESC").all(req.user.id);
  }
  const pendingTasksNamed = pendingTasks.map(taskWithNames);

  // Who still owes this Friday's check-in (only meaningful while check-ins are on).
  const weekOf = currentCheckinWeek();
  let missingCheckins = [];
  if (getCheckinEnabled()) {
    missingCheckins = db.prepare(`
      SELECT u.id, u.displayName, u.title
      FROM users u
      WHERE u.username != 'logistics'
        AND u.id NOT IN (SELECT userId FROM weekly_checkins WHERE weekOf = ?)
      ORDER BY u.displayName
    `).all(weekOf);
  }

  const recentActivity = db.prepare('SELECT * FROM approval_log ORDER BY createdAt DESC LIMIT 25').all();

  res.json({ pendingFunding, pendingApps, recentCheckins, pendingTasks: pendingTasksNamed,
    missingCheckins, checkinWeekOf: weekOf, recentActivity,
    counts: { funding: pendingFunding.length, apps: pendingApps.length, tasks: pendingTasksNamed.length,
              missingCheckins: missingCheckins.length } });
});

// ---- page-settings: also support bio fields ---------------------------------
// (existing PUT /api/users/:id/page-settings already handles bioEnabled/bioText via COALESCE)
// Extend getPageSettings to include bio fields.

// ---- Tasks ------------------------------------------------------------------
// A user's task page.
app.get('/api/users/:id/tasks', (req, res) => {
  const targetId = Number(req.params.id);
  if (!canViewTasksOf(req.user, targetId)) return res.status(403).json({ error: 'Not allowed' });
  const target = getUser(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Order by soonest due date first (tasks without a due date sink to the
  // bottom), so the most urgent work surfaces at the top of each column.
  const tasks = db
    .prepare(`SELECT * FROM tasks WHERE userId = ? AND approvalStatus != ?
              ORDER BY
                CASE WHEN dueDate IS NULL OR dueDate = '' THEN 1 ELSE 0 END,
                dueDate ASC,
                createdAt DESC`)
    .all(targetId, 'rejected')
    .map(taskWithNames);
  // Surface the job description for this member's position (their role's
  // responsibilities, managed centrally by the President/VP) so it can show at
  // the top of their page.
  const roleRow = target.title
    ? db.prepare('SELECT description FROM role_descriptions WHERE positionTitle = ?').get(target.title)
    : null;
  const user = { ...publicUser(target), positionDescription: roleRow ? roleRow.description : '' };
  res.json({ user, tasks });
});

// Create a task. If targetUserId is omitted or equals self -> own task.
// If sending to someone else -> pending their manager's approval,
// unless the sender is an admin (President/VP), who can assign directly.
// Given a comma-separated list of day numbers (0=Sun…6=Sat), return the ISO
// date string of the next calendar day that matches one of those days.
function nextOccurrenceDate(recurringDays) {
  const days = String(recurringDays || '').split(',').map(Number).filter((d) => !isNaN(d) && d >= 0 && d <= 6);
  if (!days.length) return null;
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    if (days.includes(d.getDay())) return d.toISOString().slice(0, 10);
  }
  return null;
}

app.post('/api/tasks', rateLimit({ windowMs: 60 * 60 * 1000, max: 60, name: 'tasks' }), (req, res) => {
  const { name, description, dueDate, targetUserId, docUrl, isRecurring, recurringDays, parentTaskId } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name required' });

  const ownerId = targetUserId ? Number(targetUserId) : req.user.id;
  const owner = getUser(ownerId);
  if (!owner) return res.status(404).json({ error: 'Target user not found' });

  const isSelf = ownerId === req.user.id;
  const senderIsAdmin = req.user.role === 'admin';
  // A manager delegating to one of their own direct reports is the approval
  // authority for that report, so their tasks land directly — no self-approval.
  const senderIsOwnersManager = owner.managerId === req.user.id;

  // Optional parent task: validate it exists and that the sender may delegate
  // from it (they must own the parent, or be an admin / the owner's manager).
  let safeParentTaskId = null;
  if (parentTaskId !== undefined && parentTaskId !== null && parentTaskId !== '') {
    const parent = getTask(Number(parentTaskId));
    if (parent && (parent.userId === req.user.id || senderIsAdmin || isManagerOf(req.user, parent.userId))) {
      safeParentTaskId = parent.id;
    }
  }

  let approvalStatus = 'approved';
  let approverId = null;

  if (!isSelf && !senderIsAdmin && !senderIsOwnersManager) {
    // Needs the recipient's manager to approve.
    approvalStatus = 'pending';
    approverId = owner.managerId || null;
    // If the recipient has no manager, route approval to any admin (President),
    // excluding the sender themselves.
    if (!approverId) {
      const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND id != ? ORDER BY id LIMIT 1").get(req.user.id);
      approverId = admin ? admin.id : null;
    }
    // No manager and no other admin exists to approve — there is no one to gate
    // on, so auto-approve instead of leaving the task stuck in limbo forever.
    if (!approverId) {
      approvalStatus = 'approved';
    }
  }

  const safeName = String(name).trim().slice(0, 300);
  const safeDesc = String(description || '').trim().slice(0, 5000);
  let safeDocUrl = String(docUrl || '').trim().slice(0, 500);
  if (safeDocUrl && !/^https?:\/\//i.test(safeDocUrl)) safeDocUrl = '';
  const recurringFlag = isRecurring ? 1 : 0;
  const safeRecurDays = String(recurringDays || '').replace(/[^0-6,]/g, '').slice(0, 20);
  const info = db
    .prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus, approverId, docUrl, isRecurring, recurringDays, parentTaskId)
              VALUES (?, ?, ?, ?, 'Not Started', ?, ?, ?, ?, ?, ?, ?)`)
    .run(ownerId, safeName, safeDesc, dueDate || null, req.user.id, approvalStatus, approverId, safeDocUrl, recurringFlag, safeRecurDays, safeParentTaskId);

  // Notifications
  if (!isSelf) {
    const taskName = safeName;
    if (approvalStatus === 'approved') {
      // Assigned directly (by an admin, or auto-approved) — tell the assignee.
      notify(owner.email, 'New task assigned to you',
        'You have a new task',
        `<b>${escHtml(req.user.displayName)}</b> assigned you a task: <b>${escHtml(taskName)}</b>.`);
      pushNotification(owner.id, `${req.user.displayName} assigned you a task: "${taskName}"`, 'tasks', 'task');
    } else if (approverId) {
      // Pending — tell the approver they have something to review.
      const approver = getUser(approverId);
      notify(approver && approver.email, 'A task needs your approval',
        'Task awaiting your approval',
        `<b>${escHtml(req.user.displayName)}</b> wants to assign <b>${escHtml(owner.displayName)}</b> the task <b>${escHtml(taskName)}</b>. Approve it in Pending Approvals.`);
      pushNotification(approverId, `${req.user.displayName} wants to assign ${owner.displayName} the task "${taskName}" — needs your approval`, 'approvals', 'approval');
    }
  }

  res.status(201).json({ task: taskWithNames(getTask(info.lastInsertRowid)) });
});

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

// List the delegated sub-tasks spun off from a given task, so the manager who
// owns the parent can track who they handed work to and how it's progressing.
app.get('/api/tasks/:id/subtasks', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canViewTasksOf(req.user, task.userId)) return res.status(403).json({ error: 'Not allowed' });
  const subtasks = db
    .prepare(`SELECT * FROM tasks WHERE parentTaskId = ? AND approvalStatus != 'rejected'
              ORDER BY createdAt DESC`)
    .all(task.id)
    .map(taskWithNames);
  res.json({ subtasks });
});

// Update status (owner, that user's manager, or admin).
app.patch('/api/tasks/:id', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canViewTasksOf(req.user, task.userId)) return res.status(403).json({ error: 'Not allowed' });

  const body = req.body || {};
  const { status, name, description, dueDate, docUrl, isRecurring, recurringDays } = body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Task name cannot be blank' });
  const isOwnSelfCreated = task.userId === req.user.id && task.assignedById === req.user.id;
  const canEditContent = req.user.role === 'admin' || req.user.role === 'manager' ||
    task.assignedById === req.user.id || isOwnSelfCreated;
  const editsContent = name !== undefined || description !== undefined || dueDate !== undefined ||
    docUrl !== undefined || isRecurring !== undefined || recurringDays !== undefined;
  if (!canEditContent && editsContent) {
    return res.status(403).json({ error: 'You can only update the status of assigned tasks' });
  }
  const hasDueDate = 'dueDate' in body ? 1 : 0;
  let safeDocUrl = null;
  if (docUrl !== undefined) {
    safeDocUrl = String(docUrl).trim().slice(0, 500);
    if (safeDocUrl && !/^https?:\/\//i.test(safeDocUrl)) safeDocUrl = '';
  }
  // Repeat schedule, sanitised exactly as it is on create. Sent as a pair so
  // turning recurrence off also clears the days that drove it — otherwise a
  // task switched off keeps stale days and starts repeating again the moment
  // anyone turns it back on.
  const hasRecurring = 'isRecurring' in body ? 1 : 0;
  const recurringFlag = isRecurring ? 1 : 0;
  const safeRecurDays = recurringFlag
    ? String(recurringDays || '').replace(/[^0-6,]/g, '').slice(0, 20)
    : '';

  db.prepare(`UPDATE tasks SET
       status        = COALESCE(?, status),
       name          = COALESCE(?, name),
       description   = COALESCE(?, description),
       dueDate       = CASE WHEN ? = 1 THEN ? ELSE dueDate END,
       docUrl        = COALESCE(?, docUrl),
       isRecurring   = CASE WHEN ? = 1 THEN ? ELSE isRecurring END,
       recurringDays = CASE WHEN ? = 1 THEN ? ELSE recurringDays END
     WHERE id = ?`)
    .run(status || null, name || null, description ?? null, hasDueDate, dueDate ?? null, safeDocUrl,
         hasRecurring, recurringFlag, hasRecurring, safeRecurDays, task.id);

  // When a recurring task is newly marked complete, automatically spawn the
  // next instance. Guard on the previous status so re-saving an already
  // completed task doesn't spawn duplicates.
  const updatedTask = getTask(task.id);
  if (status === 'Complete' && task.status !== 'Complete' && updatedTask.isRecurring && updatedTask.recurringDays) {
    const nextDate = nextOccurrenceDate(updatedTask.recurringDays);
    db.prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus, approverId, docUrl, isRecurring, recurringDays)
                VALUES (?, ?, ?, ?, 'Not Started', ?, 'approved', ?, ?, 1, ?)`)
      .run(updatedTask.userId, updatedTask.name, updatedTask.description, nextDate,
           updatedTask.assignedById, updatedTask.approverId, updatedTask.docUrl || '', updatedTask.recurringDays);
  }

  res.json({ task: taskWithNames(updatedTask) });
});

app.delete('/api/tasks/:id', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const allowed = task.userId === req.user.id || task.assignedById === req.user.id || req.user.role === 'admin';
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.json({ ok: true });
});

// ---- Approvals --------------------------------------------------------------
app.get('/api/approvals', (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare("SELECT * FROM tasks WHERE approvalStatus = 'pending' ORDER BY createdAt DESC").all();
  } else {
    rows = db
      .prepare("SELECT * FROM tasks WHERE approvalStatus = 'pending' AND approverId = ? ORDER BY createdAt DESC")
      .all(req.user.id);
  }
  res.json({ approvals: rows.map(taskWithNames) });
});

function canApprove(user, task) {
  return user.role === 'admin' || task.approverId === user.id;
}

app.post('/api/tasks/:id/approve', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.approvalStatus !== 'pending') return res.status(400).json({ error: 'Task is not pending' });
  if (!canApprove(req.user, task)) return res.status(403).json({ error: 'Not allowed to approve' });
  db.transaction(() => {
    db.prepare("UPDATE tasks SET approvalStatus = 'approved' WHERE id = ?").run(task.id);
    logApproval('task', task.id, 'approved', req.user, task.name);
  })();
  // Now that it's approved, the assignee should know about their new task.
  const owner = getUser(task.userId);
  const assigner = task.assignedById ? getUser(task.assignedById) : null;
  notify(owner && owner.email, 'New task assigned to you',
    'You have a new task',
    `${assigner ? '<b>' + escHtml(assigner.displayName) + '</b> assigned' : 'You were assigned'} the task <b>${escHtml(task.name)}</b> (approved by ${escHtml(req.user.displayName)}).`);
  pushNotification(owner && owner.id, `Your task "${task.name}" was approved by ${req.user.displayName}`, 'tasks', 'task');
  // Let the original sender know their assignment went through.
  if (assigner && assigner.id !== owner.id) {
    pushNotification(assigner.id, `${req.user.displayName} approved the task "${task.name}" you assigned to ${owner.displayName}`, 'tasks', 'task');
  }
  res.json({ task: taskWithNames(getTask(task.id)) });
});

app.post('/api/tasks/:id/reject', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.approvalStatus !== 'pending') return res.status(400).json({ error: 'Task is not pending' });
  if (!canApprove(req.user, task)) return res.status(403).json({ error: 'Not allowed to reject' });
  db.transaction(() => {
    db.prepare("UPDATE tasks SET approvalStatus = 'rejected' WHERE id = ?").run(task.id);
    logApproval('task', task.id, 'rejected', req.user, task.name);
  })();
  // Tell whoever proposed the assignment that it was turned down.
  if (task.assignedById && task.assignedById !== req.user.id) {
    pushNotification(task.assignedById, `${req.user.displayName} rejected the task "${task.name}" you proposed`, 'tasks', 'task');
  }
  res.json({ ok: true });
});

// ---- Task Comments ----------------------------------------------------------
app.get('/api/tasks/:id/comments', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canViewTasksOf(req.user, task.userId)) return res.status(403).json({ error: 'Not allowed' });
  const comments = db.prepare(`
    SELECT tc.*, u.displayName AS authorName
    FROM task_comments tc JOIN users u ON u.id = tc.userId
    WHERE tc.taskId = ? ORDER BY tc.createdAt ASC
  `).all(task.id);
  res.json({ comments });
});

app.post('/api/tasks/:id/comments', rateLimit({ windowMs: 60 * 60 * 1000, max: 120, name: 'task-comments' }), (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canViewTasksOf(req.user, task.userId)) return res.status(403).json({ error: 'Not allowed' });
  const content = String((req.body || {}).content || '').trim().slice(0, 2000);
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
  const info = db.prepare('INSERT INTO task_comments (taskId, userId, content) VALUES (?, ?, ?)').run(task.id, req.user.id, content);
  const comment = db.prepare(`SELECT tc.*, u.displayName AS authorName FROM task_comments tc JOIN users u ON u.id = tc.userId WHERE tc.id = ?`).get(info.lastInsertRowid);
  const notifyIds = new Set([task.userId, task.assignedById].filter(Boolean));
  notifyIds.delete(req.user.id);
  for (const uid of notifyIds) {
    pushNotification(uid, `${req.user.displayName} commented on "${task.name}"`, 'tasks', 'task');
  }
  res.status(201).json({ comment });
});

app.delete('/api/tasks/:id/comments/:commentId', (req, res) => {
  const comment = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(Number(req.params.commentId));
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM task_comments WHERE id = ?').run(comment.id);
  res.json({ ok: true });
});

// ---- Global Search ----------------------------------------------------------
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: { tasks: [], members: [], funding: [], announcements: [] } });
  const like = `%${q}%`;

  let tasks;
  if (req.user.role === 'admin') {
    tasks = db.prepare(`SELECT t.*, u.displayName AS ownerName FROM tasks t JOIN users u ON u.id = t.userId
      WHERE (t.name LIKE ? OR t.description LIKE ?) AND t.approvalStatus != 'rejected' LIMIT 12`).all(like, like);
  } else {
    const myReports = directReports(req.user.id).map((r) => r.id);
    const ids = [req.user.id, ...myReports];
    const ph = ids.map(() => '?').join(',');
    tasks = db.prepare(`SELECT t.*, u.displayName AS ownerName FROM tasks t JOIN users u ON u.id = t.userId
      WHERE t.userId IN (${ph}) AND (t.name LIKE ? OR t.description LIKE ?) AND t.approvalStatus != 'rejected' LIMIT 12`).all(...ids, like, like);
  }

  const members = db.prepare(`SELECT id, displayName, title, role, username FROM users
    WHERE (displayName LIKE ? OR username LIKE ? OR title LIKE ?) AND username != 'logistics' LIMIT 8`).all(like, like, like).map(publicUser);

  let funding;
  if (req.user.role === 'admin' || req.user.role === 'manager') {
    funding = db.prepare(`SELECT fr.*, u.displayName AS submitterName FROM funding_requests fr JOIN users u ON u.id = fr.submittedById
      WHERE fr.title LIKE ? OR fr.description LIKE ? LIMIT 8`).all(like, like);
  } else {
    funding = db.prepare(`SELECT fr.*, u.displayName AS submitterName FROM funding_requests fr JOIN users u ON u.id = fr.submittedById
      WHERE fr.submittedById = ? AND (fr.title LIKE ? OR fr.description LIKE ?) LIMIT 8`).all(req.user.id, like, like);
  }

  const announcements = db.prepare(`SELECT ta.*, u.displayName AS authorName FROM team_announcements ta JOIN users u ON u.id = ta.authorId
    WHERE ta.text LIKE ? LIMIT 5`).all(like);

  res.json({ results: { tasks, members, funding, announcements } });
});

// ---- Attendance Tracker -----------------------------------------------------
const ATTENDANCE_STATUSES = ['present', 'absent', 'excused'];

function canManageAttendance(user) {
  return user.role === 'admin' || user.role === 'manager';
}

// Auto-import attendance events from their sources. Idempotent via
// (sourceType, sourceId): 'board' meetings come from the meetings table, 'club'
// meetings come from the linked Google Calendar feed. Existing synced events are
// updated in place so title/date stay current; they persist in attendance_events
// even after a calendar event ages out of the upcoming feed.
async function syncAttendanceEvents() {
  // Upsert on (sourceType, sourceId) rather than check-then-insert: the check
  // and the write straddle an `await` below, so two concurrent syncs could both
  // find nothing and both insert the same meeting, splitting its roll call
  // across duplicate events. The unique index makes the conflict clause fire.
  const upsertSource = db.prepare(`
    INSERT INTO attendance_events (title, eventDate, location, notes, eventType, sourceType, sourceId)
    VALUES (@title, @eventDate, @location, '', @eventType, @sourceType, @sourceId)
    ON CONFLICT(sourceType, sourceId) WHERE sourceType != 'manual'
    DO UPDATE SET title = excluded.title, eventDate = excluded.eventDate, location = excluded.location`);

  // Board meetings -> board attendance events (roster = all portal accounts).
  const meetings = db.prepare('SELECT id, title, meetingDate FROM meetings').all();
  for (const m of meetings) {
    const eventDate = String(m.meetingDate || '').slice(0, 10);
    if (!isRealDate(eventDate)) continue;
    upsertSource.run({
      title: m.title, eventDate, location: '',
      eventType: 'board', sourceType: 'meeting', sourceId: String(m.id),
    });
  }

  // Club meetings from the calendar feed (roster = portal accounts + onboarded contacts).
  const home = db.prepare('SELECT calendarUrl FROM site_settings WHERE id = 1').get();
  if (home && home.calendarUrl) {
    let events = [];
    try { events = await fetchUpcoming(home.calendarUrl, 10); } catch (_) { events = []; }
    for (const ev of events) {
      if (!ev.uid) continue;
      const eventDate = String(ev.start || '').slice(0, 10);
      if (!isRealDate(eventDate)) continue;
      upsertSource.run({
        title: ev.title, eventDate, location: ev.location || '',
        eventType: 'club', sourceType: 'calendar', sourceId: ev.uid,
      });
    }
  }
}

// The roster for an event depends on its type. Board meetings pull every portal
// account; club meetings additionally pull onboarded (non-account) roster contacts.
function attendanceRoster(eventType) {
  const users = db.prepare("SELECT id, displayName, title FROM users WHERE username != 'logistics' ORDER BY displayName").all()
    .map((u) => ({ kind: 'user', id: u.id, displayName: u.displayName, title: u.title || '' }));
  if (eventType !== 'club') return users;
  // Onboarded members, plus Inactive ones still in their 30-day grace window so
  // they can be marked present and reactivated if they show back up.
  // Board members are mirrored into roster_members (see syncBoardRoster) so their
  // meeting history has somewhere to hang; those mirrors are excluded here or
  // every board member would appear on the club roll call twice — once as their
  // account and once as their roster row — and could be given two contradictory
  // statuses for the same meeting.
  const contacts = db.prepare(`SELECT id, firstName, lastName, grade, roleDescription, status
    FROM roster_members WHERE status IN ('Onboarded', 'Inactive') AND linkedUserId IS NULL
    ORDER BY firstName, lastName`).all()
    .map((r) => ({
      kind: 'roster',
      id: r.id,
      displayName: `${r.firstName || ''} ${r.lastName || ''}`.trim() || 'Club Member',
      title: r.roleDescription || (r.grade ? `Grade ${r.grade}` : 'Club Member'),
      inactive: r.status === 'Inactive',
    }));
  return [...users, ...contacts];
}

// Attendance ids arrive as untrusted JSON. Number() alone is far too permissive
// here: Number(true) === 1 and Number([2]) === 2 would forge a mark against a
// member nobody named, while Number('abc') === NaN binds as SQL NULL and writes
// a record that belongs to no one (invisible on the roster, yet still counted in
// the event's present/marked tallies). Only a real positive integer is an id.
function toMemberId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// A YYYY-MM-DD that is also a date that exists — the bare regex happily accepts
// '2026-13-45', which would sort into the roll-call list as a real meeting.
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1970 || y > 2999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Resolve one attendee against the roster the event actually has. Marking is
// only meaningful for someone who appears on that event's roll-call list, so a
// club-only contact can't be recorded at a board meeting (and vice versa), and
// an unknown id fails as a 400 here instead of surfacing as a FOREIGN KEY 500.
// Returns { userId, rosterId } or { error }.
function resolveAttendee(event, raw) {
  const hasUser = raw.userId !== undefined && raw.userId !== null;
  const hasRoster = raw.rosterId !== undefined && raw.rosterId !== null;
  if (hasUser && hasRoster) return { error: 'Provide either userId or rosterId, not both' };
  if (!hasUser && !hasRoster) return { error: 'userId or rosterId required' };

  if (hasUser) {
    const userId = toMemberId(raw.userId);
    if (!userId) return { error: `Invalid userId: ${JSON.stringify(raw.userId)}` };
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND username != 'logistics'").get(userId);
    if (!u) return { error: `No board member with id ${userId}` };
    return { userId, rosterId: null };
  }

  const rosterId = toMemberId(raw.rosterId);
  if (!rosterId) return { error: `Invalid rosterId: ${JSON.stringify(raw.rosterId)}` };
  // Only club events carry non-account contacts on their roster.
  if (event.eventType !== 'club') {
    return { error: 'Board meetings only take board members (userId), not roster contacts' };
  }
  // linkedUserId IS NULL mirrors attendanceRoster(): a board member's roster
  // mirror is not a separate attendee, so they must be marked via their userId.
  const r = db.prepare(`SELECT id FROM roster_members
    WHERE id = ? AND status IN ('Onboarded', 'Inactive') AND linkedUserId IS NULL`).get(rosterId);
  if (!r) return { error: `No club member with id ${rosterId} on this event's roster` };
  return { userId: null, rosterId };
}

// Upsert a single attendance record keyed by user or roster contact.
function markAttendanceRecord(eventId, { userId, rosterId, status, markedById }) {
  const col = userId != null ? 'userId' : 'rosterId';
  const refId = userId != null ? userId : rosterId;
  const existing = db.prepare(`SELECT id FROM attendance_records WHERE eventId = ? AND ${col} = ?`).get(eventId, refId);
  if (existing) {
    db.prepare("UPDATE attendance_records SET status = ?, markedById = ?, createdAt = datetime('now') WHERE id = ?")
      .run(status, markedById, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance_records (eventId, ${col}, status, markedById) VALUES (?, ?, ?, ?)`)
      .run(eventId, refId, status, markedById);
  }
  if (rosterId != null && userId == null) {
    try { handleRosterAttendanceSideEffects(Number(rosterId), status); } catch (e) {
      console.error('[absence] side-effect failed:', e.message);
    }
  }
}

// Restore a referral point to the member's referrer (used when an Inactive
// member comes back). Sets referralStatus back to 'approved' and notifies them.
function restoreReferralCredit(member) {
  if (member.referredByUserId && member.referralStatus === 'removed') {
    db.prepare("UPDATE roster_members SET referralStatus = 'approved', updatedAt = datetime('now') WHERE id = ?").run(member.id);
    const name = `${member.firstName} ${member.lastName}`.trim();
    pushNotification(member.referredByUserId, `${name} returned — your referral point has been restored.`, 'referrals', 'info');
    sendReferralStandings(member.referredByUserId);
  }
}

// After a roster member is marked at a club meeting, (1) reactivate them if they
// were Inactive and just showed up, and (2) alert roster managers when they hit
// two absences in a row. Only 'club' events count; a Present or Excused breaks
// the streak.
function handleRosterAttendanceSideEffects(rosterId, status) {
  const member = db.prepare('SELECT * FROM roster_members WHERE id = ?').get(rosterId);
  if (!member) return;

  // Comeback: a present mark reactivates an Inactive member and restores credit.
  if (status === 'present' && member.status === 'Inactive') {
    db.prepare(`UPDATE roster_members SET status = 'Onboarded', inactivatedAt = NULL,
      absenceAlertEventId = NULL, absenceContactedAt = NULL, updatedAt = datetime('now') WHERE id = ?`).run(rosterId);
    restoreReferralCredit(member);
    return;
  }

  // The two most recent club-meeting marks, newest first.
  const recent = db.prepare(`
    SELECT ar.status AS status, ae.id AS eventId
    FROM attendance_records ar
    JOIN attendance_events ae ON ae.id = ar.eventId
    WHERE ar.rosterId = ? AND ae.eventType = 'club'
    ORDER BY ae.eventDate DESC, ae.id DESC
    LIMIT 2
  `).all(rosterId);

  const twoInARow = recent.length === 2 && recent[0].status === 'absent' && recent[1].status === 'absent';
  if (!twoInARow) return;

  const latestAbsentEventId = recent[0].eventId;
  // Only alert once per new absence. A new absent event clears any prior
  // "contacted" acknowledgement, so the alert resurfaces (silence lasts only
  // until the next absence).
  if (member.absenceAlertEventId === latestAbsentEventId) return;

  db.prepare('UPDATE roster_members SET absenceAlertEventId = ?, absenceContactedAt = NULL WHERE id = ?').run(latestAbsentEventId, rosterId);
  const name = `${member.firstName} ${member.lastName}`.trim();
  notifyRosterManagers(`${name} has been absent 2 meetings in a row — review and follow up.`, 'roster', 'absence');
}

// Purge roster members who have sat Inactive for more than 30 days. Runs on
// startup and daily; deleting cascades their attendance records away too.
function purgeInactiveRosterMembers() {
  try {
    const info = db.prepare(
      "DELETE FROM roster_members WHERE status = 'Inactive' AND inactivatedAt IS NOT NULL AND inactivatedAt <= datetime('now', '-30 days')"
    ).run();
    if (info.changes) console.log(`[roster] purged ${info.changes} inactive member(s) past the 30-day window`);
  } catch (e) {
    console.error('[roster] purge failed:', e.message);
  }
}
purgeInactiveRosterMembers();
setInterval(purgeInactiveRosterMembers, 24 * 60 * 60 * 1000);
try { syncBoardRoster(); } catch (e) { console.error('[roster] board sync failed:', e.message); }

app.get('/api/attendance', async (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  try { await syncAttendanceEvents(); } catch (_) {}
  const events = db.prepare(`SELECT ae.*, u.displayName AS createdByName,
    (SELECT COUNT(*) FROM attendance_records ar WHERE ar.eventId = ae.id AND ar.status = 'present') AS presentCount,
    (SELECT COUNT(*) FROM attendance_records ar WHERE ar.eventId = ae.id) AS markedCount
    FROM attendance_events ae LEFT JOIN users u ON u.id = ae.createdById
    ORDER BY ae.eventDate DESC`).all();
  res.json({ events });
});

app.post('/api/attendance', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { title, eventDate, location, notes, eventType } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  if (!isRealDate(eventDate)) return res.status(400).json({ error: 'Valid event date required (YYYY-MM-DD)' });
  const safeType = eventType === 'board' ? 'board' : 'club';
  const info = db.prepare(`INSERT INTO attendance_events (title, eventDate, location, notes, eventType, sourceType, createdById)
    VALUES (?, ?, ?, ?, ?, 'manual', ?)`).run(
    String(title).trim().slice(0, 200), eventDate,
    String(location || '').trim().slice(0, 200), String(notes || '').trim().slice(0, 1000), safeType, req.user.id
  );
  res.status(201).json({ event: db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(info.lastInsertRowid) });
});

app.get('/api/attendance/:id', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const event = db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const members = attendanceRoster(event.eventType);
  const records = db.prepare('SELECT * FROM attendance_records WHERE eventId = ?').all(event.id);
  const byKey = {};
  for (const r of records) {
    const key = r.userId != null ? `user:${r.userId}` : `roster:${r.rosterId}`;
    byKey[key] = r;
  }
  res.json({ event, members, records: byKey });
});

app.post('/api/attendance/:id/mark', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const event = db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { status } = req.body || {};
  // Never coerce an unrecognised status: silently falling back to 'present'
  // turns a typo into a false attendance record for someone who wasn't there.
  if (!ATTENDANCE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
  }
  const who = resolveAttendee(event, req.body || {});
  if (who.error) return res.status(400).json({ error: who.error });
  markAttendanceRecord(event.id, { ...who, status, markedById: req.user.id });
  res.json({ ok: true, status });
});

app.delete('/api/attendance/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const eventId = Number(req.params.id);
  if (!Number.isSafeInteger(eventId)) return res.status(400).json({ error: 'Invalid event id' });
  // absenceAlertEventId is a plain column, not an FK, so the cascade that clears
  // the attendance records leaves it pointing at an event that no longer exists.
  // That pins the "Absent 2 meetings in a row" banner on the roster with no way
  // to clear it, and the "only alert once per absence" guard then suppresses the
  // member's next real alert. Drop the flag with the event it referred to.
  const tx = db.transaction(() => {
    db.prepare(`UPDATE roster_members SET absenceAlertEventId = NULL, absenceContactedAt = NULL
      WHERE absenceAlertEventId = ?`).run(eventId);
    db.prepare('DELETE FROM attendance_events WHERE id = ?').run(eventId);
  });
  tx();
  res.json({ ok: true });
});

// One roll-call submission covers a whole meeting, so it is all-or-nothing:
// every entry is validated up front and a single bad row rejects the batch.
// Skipping unparseable entries (the old behaviour) reported success while
// quietly leaving members unmarked — the worst possible failure for a register.
const ROLL_CALL_MAX = 500;
app.post('/api/attendance/:id/roll-call', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const event = db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: 'records array required' });
  if (records.length > ROLL_CALL_MAX) {
    return res.status(400).json({ error: `Too many records (max ${ROLL_CALL_MAX})` });
  }

  const resolved = [];
  const errors = [];
  const seen = new Set();
  records.forEach((r, index) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push({ index, error: 'Each record must be an object' }); return; }
    if (!ATTENDANCE_STATUSES.includes(r.status)) {
      errors.push({ index, error: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
      return;
    }
    const who = resolveAttendee(event, r);
    if (who.error) { errors.push({ index, error: who.error }); return; }
    // A member listed twice with conflicting statuses is an ambiguous register,
    // not something to silently resolve by taking whichever row happens to be last.
    const key = who.userId != null ? `user:${who.userId}` : `roster:${who.rosterId}`;
    if (seen.has(key)) { errors.push({ index, error: 'Duplicate entry for the same member' }); return; }
    seen.add(key);
    resolved.push({ ...who, status: r.status });
  });
  if (errors.length) return res.status(400).json({ error: 'Roll call rejected — no changes were saved', details: errors.slice(0, 20) });

  const tx = db.transaction(() => {
    for (const r of resolved) markAttendanceRecord(event.id, { ...r, markedById: req.user.id });
  });
  tx();
  res.json({ ok: true, marked: resolved.length });
});

// ---- Budget Overview (privileged users) -------------------------------------
app.get('/api/budget/overview', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const totals = db.prepare(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(amount), 0) AS totalAmount,
    COALESCE(SUM(CASE WHEN status = 'pending'   THEN amount ELSE 0 END), 0) AS pendingAmount,
    COALESCE(SUM(CASE WHEN status = 'approved'  THEN amount ELSE 0 END), 0) AS approvedAmount,
    COALESCE(SUM(CASE WHEN status = 'denied'    THEN amount ELSE 0 END), 0) AS deniedAmount,
    COALESCE(SUM(CASE WHEN status = 'purchased' THEN amount ELSE 0 END), 0) AS purchasedAmount,
    COUNT(CASE WHEN status = 'pending'   THEN 1 END) AS pendingCount,
    COUNT(CASE WHEN status = 'approved'  THEN 1 END) AS approvedCount,
    COUNT(CASE WHEN status = 'denied'    THEN 1 END) AS deniedCount,
    COUNT(CASE WHEN status = 'purchased' THEN 1 END) AS purchasedCount
    FROM funding_requests`).get();
  const bySubmitter = db.prepare(`SELECT u.displayName, u.title,
    COUNT(*) AS requests,
    COALESCE(SUM(fr.amount), 0) AS totalAmount,
    COALESCE(SUM(CASE WHEN fr.status IN ('approved','purchased') THEN fr.amount ELSE 0 END), 0) AS approvedAmount
    FROM funding_requests fr JOIN users u ON u.id = fr.submittedById
    GROUP BY fr.submittedById ORDER BY totalAmount DESC LIMIT 10`).all();
  const recent = db.prepare(`SELECT fr.*, u.displayName AS submitterName FROM funding_requests fr JOIN users u ON u.id = fr.submittedById
    ORDER BY fr.createdAt DESC LIMIT 5`).all();
  const reimbursedTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM reimbursements WHERE status='approved'`).get().total;
  res.json({ totals, bySubmitter, recent, reimbursedTotal });
});

// ---- Polls ------------------------------------------------------------------
function canCreatePoll(user) {
  return user.role === 'admin';
}

app.get('/api/polls', (req, res) => {
  const polls = db.prepare(`SELECT p.*, u.displayName AS createdByName,
    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.pollId = p.id) AS voteCount,
    (SELECT optionIndex FROM poll_votes pv WHERE pv.pollId = p.id AND pv.userId = ?) AS myVote
    FROM polls p JOIN users u ON u.id = p.createdById
    ORDER BY p.createdAt DESC`).all(req.user.id);
  res.json({ polls: polls.map((p) => ({
    ...p,
    options: (() => { try { return JSON.parse(p.options); } catch (_) { return []; } })(),
    myVote: p.myVote !== null && p.myVote !== undefined ? p.myVote : null,
  })) });
});

app.get('/api/polls/:id/results', (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(Number(req.params.id));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  const options = (() => { try { return JSON.parse(poll.options); } catch (_) { return []; } })();
  const votes = db.prepare('SELECT optionIndex, COUNT(*) AS count FROM poll_votes WHERE pollId = ? GROUP BY optionIndex').all(poll.id);
  const byOption = Object.fromEntries(votes.map((v) => [v.optionIndex, v.count]));
  const results = options.map((opt, i) => ({ option: opt, count: byOption[i] || 0 }));
  const total = results.reduce((s, r) => s + r.count, 0);
  res.json({ results, total });
});

app.post('/api/polls', (req, res) => {
  if (!canCreatePoll(req.user)) return res.status(403).json({ error: 'Only admins can create polls' });
  const { question, options } = req.body || {};
  if (!question || !String(question).trim()) return res.status(400).json({ error: 'Question required' });
  if (!Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'At least 2 options required' });
  const safeOptions = options.map((o) => String(o).trim().slice(0, 200)).filter(Boolean);
  if (safeOptions.length < 2) return res.status(400).json({ error: 'At least 2 non-empty options required' });
  const info = db.prepare('INSERT INTO polls (question, options, createdById) VALUES (?, ?, ?)').run(String(question).trim().slice(0, 500), JSON.stringify(safeOptions), req.user.id);
  const allUsers = db.prepare("SELECT id FROM users WHERE username != 'logistics' AND id != ?").all(req.user.id);
  for (const u of allUsers) {
    pushNotification(u.id, `${req.user.displayName} posted a new poll: "${String(question).trim().slice(0, 60)}"`, 'polls', 'info');
  }
  res.status(201).json({ poll: db.prepare('SELECT * FROM polls WHERE id = ?').get(info.lastInsertRowid) });
});

app.post('/api/polls/:id/vote', (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(Number(req.params.id));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.status !== 'open') return res.status(400).json({ error: 'This poll is closed' });
  const options = (() => { try { return JSON.parse(poll.options); } catch (_) { return []; } })();
  const { optionIndex } = req.body || {};
  const idx = Number(optionIndex);
  if (isNaN(idx) || idx < 0 || idx >= options.length) return res.status(400).json({ error: 'Invalid option' });
  const existing = db.prepare('SELECT id FROM poll_votes WHERE pollId = ? AND userId = ?').get(poll.id, req.user.id);
  if (existing) return res.status(409).json({ error: 'You have already voted on this poll' });
  db.prepare('INSERT INTO poll_votes (pollId, userId, optionIndex) VALUES (?, ?, ?)').run(poll.id, req.user.id, idx);
  res.json({ ok: true });
});

app.post('/api/polls/:id/close', (req, res) => {
  if (!canCreatePoll(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(Number(req.params.id));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  db.prepare("UPDATE polls SET status = 'closed', closedAt = datetime('now') WHERE id = ?").run(poll.id);
  res.json({ ok: true });
});

app.delete('/api/polls/:id', (req, res) => {
  if (!canCreatePoll(req.user)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM polls WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Positions / Role Descriptions ------------------------------------------
app.get('/api/role-descriptions', (req, res) => {
  const rows = db.prepare('SELECT * FROM role_descriptions ORDER BY positionTitle').all();
  res.json({ descriptions: rows });
});

// The full list of board positions for the "pick a position" dropdown — the
// union of every defined role description and every title already assigned to a
// member, so even positions without a written description are pickable. Each
// entry carries its description (blank when none) and a count of members in it.
app.get('/api/positions', (req, res) => {
  const descs = db.prepare('SELECT positionTitle, description FROM role_descriptions').all();
  const descByTitle = new Map(descs.map((d) => [d.positionTitle, d.description]));
  const titles = new Set(descByTitle.keys());
  db.prepare("SELECT DISTINCT title FROM users WHERE title != '' AND username != 'logistics'")
    .all().forEach((r) => titles.add(r.title));
  const counts = {};
  db.prepare("SELECT title, COUNT(*) AS n FROM users WHERE title != '' AND username != 'logistics' GROUP BY title")
    .all().forEach((r) => { counts[r.title] = r.n; });
  const positions = [...titles].sort((a, b) => a.localeCompare(b)).map((title) => ({
    title,
    description: descByTitle.get(title) || '',
    memberCount: counts[title] || 0,
  }));
  res.json({ positions });
});

// Rename a position everywhere at once: updates every member who holds it and
// carries the role description over to the new name. Reflects automatically on
// member pages and the org chart (both read the member's title). Admins only.
app.put('/api/positions/:title/rename', requireAdmin, (req, res) => {
  const oldTitle = decodeURIComponent(req.params.title).trim().slice(0, 200);
  const newTitle = String((req.body || {}).newTitle || '').trim().slice(0, 200);
  if (!oldTitle || !newTitle) return res.status(400).json({ error: 'Both the current and new position titles are required' });
  if (oldTitle === newTitle) return res.json({ ok: true });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET title = ? WHERE title = ?').run(newTitle, oldTitle);
    // Move the role description onto the new title. If a description already
    // exists under the new title, keep it and just drop the old row.
    const existingNew = db.prepare('SELECT id FROM role_descriptions WHERE positionTitle = ?').get(newTitle);
    const oldRow = db.prepare('SELECT * FROM role_descriptions WHERE positionTitle = ?').get(oldTitle);
    if (oldRow) {
      if (existingNew) {
        db.prepare('DELETE FROM role_descriptions WHERE positionTitle = ?').run(oldTitle);
      } else {
        db.prepare('UPDATE role_descriptions SET positionTitle = ?, updatedById = ?, updatedAt = datetime(\'now\') WHERE positionTitle = ?')
          .run(newTitle, req.user.id, oldTitle);
      }
    }
  });
  tx();
  res.json({ ok: true });
});

app.put('/api/role-descriptions/:title', requireAdmin, (req, res) => {
  const positionTitle = decodeURIComponent(req.params.title).trim().slice(0, 200);
  if (!positionTitle) return res.status(400).json({ error: 'Position title required' });
  const description = String((req.body || {}).description || '').trim().slice(0, 5000);
  db.prepare(`INSERT INTO role_descriptions (positionTitle, description, updatedById, updatedAt) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(positionTitle) DO UPDATE SET description = excluded.description, updatedById = excluded.updatedById, updatedAt = datetime('now')`).run(positionTitle, description, req.user.id);
  res.json({ ok: true, description: db.prepare('SELECT * FROM role_descriptions WHERE positionTitle = ?').get(positionTitle) });
});

// ---- Meetings ---------------------------------------------------------------

app.get('/api/meetings', (req, res) => {
  const rows = db.prepare(`SELECT m.*, u.displayName AS createdByName FROM meetings m
    LEFT JOIN users u ON u.id = m.createdById ORDER BY m.meetingDate DESC`).all();
  res.json({ meetings: rows });
});

// Returns upcoming iCal events for the Meetings page (club meetings tab).
app.get('/api/meetings/calendar', async (req, res) => {
  const home = db.prepare('SELECT calendarUrl FROM site_settings WHERE id = 1').get();
  if (!home || !home.calendarUrl) return res.json({ events: [], configured: false });
  try {
    const events = await fetchUpcoming(home.calendarUrl, 10);
    res.json({ events, configured: true });
  } catch (_) {
    res.json({ events: [], configured: true });
  }
});

app.post('/api/meetings', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const { title, meetingDate, agendaUrl, minutesUrl, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!meetingDate) return res.status(400).json({ error: 'Date is required' });
  const info = db.prepare(`INSERT INTO meetings (title, meetingDate, agendaUrl, minutesUrl, notes, createdById)
    VALUES (?, ?, ?, ?, ?, ?)`).run(title.trim(), meetingDate, agendaUrl || '', minutesUrl || '', notes || '', req.user.id);
  res.status(201).json({ meeting: db.prepare('SELECT * FROM meetings WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/meetings/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { title, meetingDate, agendaUrl, minutesUrl, notes } = req.body || {};
  db.prepare(`UPDATE meetings SET title=COALESCE(?,title), meetingDate=COALESCE(?,meetingDate),
    agendaUrl=COALESCE(?,agendaUrl), minutesUrl=COALESCE(?,minutesUrl), notes=COALESCE(?,notes) WHERE id=?`)
    .run(title||null, meetingDate||null, agendaUrl!=null?agendaUrl:null, minutesUrl!=null?minutesUrl:null, notes!=null?notes:null, m.id);
  res.json({ meeting: db.prepare('SELECT * FROM meetings WHERE id=?').get(m.id) });
});

app.delete('/api/meetings/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM meetings WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Grant Applications -----------------------------------------------------

app.get('/api/grants', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const rows = db.prepare(`SELECT g.*, u.displayName AS createdByName FROM grant_applications g
    LEFT JOIN users u ON u.id = g.createdById ORDER BY g.createdAt DESC`).all();
  res.json({ grants: rows });
});

app.post('/api/grants', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const { title, purpose, amountRequested, submissionDate, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const info = db.prepare(`INSERT INTO grant_applications (title, purpose, amountRequested, submissionDate, notes, createdById)
    VALUES (?, ?, ?, ?, ?, ?)`).run(title.trim(), purpose||'', Number(amountRequested)||0, submissionDate||null, notes||'', req.user.id);
  res.status(201).json({ grant: db.prepare('SELECT * FROM grant_applications WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/grants/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const g = db.prepare('SELECT * FROM grant_applications WHERE id=?').get(Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Not found' });
  const { title, purpose, amountRequested, submissionDate, status, amountAwarded, notes } = req.body || {};
  const validStatuses = ['Draft','Submitted','Under Review','Approved','Denied'];
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE grant_applications SET
    title=COALESCE(?,title), purpose=COALESCE(?,purpose), amountRequested=COALESCE(?,amountRequested),
    submissionDate=COALESCE(?,submissionDate), status=COALESCE(?,status),
    amountAwarded=COALESCE(?,amountAwarded), notes=COALESCE(?,notes),
    updatedAt=datetime('now') WHERE id=?`)
    .run(title||null, purpose!=null?purpose:null, amountRequested!=null?Number(amountRequested):null,
      submissionDate!=null?submissionDate:null, status||null, amountAwarded!=null?Number(amountAwarded):null,
      notes!=null?notes:null, g.id);
  res.json({ grant: db.prepare('SELECT * FROM grant_applications WHERE id=?').get(g.id) });
});

app.delete('/api/grants/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM grant_applications WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Speaker Events ---------------------------------------------------------

app.get('/api/speaker-events', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const rows = db.prepare(`SELECT se.*, u.displayName AS createdByName FROM speaker_events se
    LEFT JOIN users u ON u.id = se.createdById ORDER BY se.eventDate DESC`).all();
  res.json({ events: rows });
});

app.post('/api/speaker-events', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const { title, speakerName, speakerOrg, topic, eventDate, location, expectedAttendance, avNeeds, materialsRequested, budgetEstimate } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const info = db.prepare(`INSERT INTO speaker_events
    (title, speakerName, speakerOrg, topic, eventDate, location, expectedAttendance, avNeeds, materialsRequested, budgetEstimate, createdById)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title.trim(), speakerName||'', speakerOrg||'', topic||'', eventDate||null,
    location||'', Number(expectedAttendance)||0, avNeeds||'', materialsRequested||'', Number(budgetEstimate)||0, req.user.id);

  // A new speaker request lands on the VP's to-do page (falling back to all
  // admins if no one holds the Vice President title). The creator is skipped —
  // no point assigning them a to-do to review their own request.
  const vp = db.prepare("SELECT id FROM users WHERE title LIKE '%Vice President%' ORDER BY id LIMIT 1").get();
  const reviewers = vp ? [vp] : db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  const taskDesc =
    `${req.user.displayName} submitted a speaker request: "${title.trim()}".` +
    (speakerName ? `\nSpeaker: ${speakerName}${speakerOrg ? ' — ' + speakerOrg : ''}` : '') +
    (topic ? `\nTopic: ${topic}` : '') +
    (eventDate ? `\nEvent date: ${eventDate}` : '') +
    `\n\nFull details are on the Speaker Events page.`;
  for (const r of reviewers) {
    if (r.id === req.user.id) continue;
    createAutoTask(r.id, `Review speaker request: ${title.trim()}`, taskDesc);
    pushNotification(r.id, `New speaker request "${title.trim()}" from ${req.user.displayName} — added to your to-do list`, 'tasks', 'task');
  }

  res.status(201).json({ event: db.prepare('SELECT * FROM speaker_events WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/speaker-events/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const ev = db.prepare('SELECT * FROM speaker_events WHERE id=?').get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const { title, speakerName, speakerOrg, topic, eventDate, location, expectedAttendance, avNeeds,
    materialsRequested, budgetEstimate, roomConfirmed, promotionDone, logisticsSent, tpusaNotified,
    actualAttendance, postEventNotes, status } = req.body || {};
  const validStatuses = ['Planning','Confirmed','Completed','Cancelled'];
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE speaker_events SET
    title=COALESCE(?,title), speakerName=COALESCE(?,speakerName), speakerOrg=COALESCE(?,speakerOrg),
    topic=COALESCE(?,topic), eventDate=COALESCE(?,eventDate), location=COALESCE(?,location),
    expectedAttendance=COALESCE(?,expectedAttendance), avNeeds=COALESCE(?,avNeeds),
    materialsRequested=COALESCE(?,materialsRequested), budgetEstimate=COALESCE(?,budgetEstimate),
    roomConfirmed=COALESCE(?,roomConfirmed), promotionDone=COALESCE(?,promotionDone),
    logisticsSent=COALESCE(?,logisticsSent), tpusaNotified=COALESCE(?,tpusaNotified),
    actualAttendance=COALESCE(?,actualAttendance), postEventNotes=COALESCE(?,postEventNotes),
    status=COALESCE(?,status) WHERE id=?`)
    .run(title||null, speakerName!=null?speakerName:null, speakerOrg!=null?speakerOrg:null,
      topic!=null?topic:null, eventDate!=null?eventDate:null, location!=null?location:null,
      expectedAttendance!=null?Number(expectedAttendance):null, avNeeds!=null?avNeeds:null,
      materialsRequested!=null?materialsRequested:null, budgetEstimate!=null?Number(budgetEstimate):null,
      roomConfirmed!=null?(roomConfirmed?1:0):null, promotionDone!=null?(promotionDone?1:0):null,
      logisticsSent!=null?(logisticsSent?1:0):null, tpusaNotified!=null?(tpusaNotified?1:0):null,
      actualAttendance!=null?Number(actualAttendance):null, postEventNotes!=null?postEventNotes:null,
      status||null, ev.id);
  res.json({ event: db.prepare('SELECT * FROM speaker_events WHERE id=?').get(ev.id) });
});

app.delete('/api/speaker-events/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM speaker_events WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Speaker Application Form management --------------------------------------
// The VP (admin) edits the public application form's title, intro, and question
// list here; the /apply-to-speak page re-renders from the stored config.
app.put('/api/speaker-form', requireAdmin, (req, res) => {
  const { title, intro, questions } = req.body || {};
  const cleanQuestions = sanitizeQuestions(questions);
  if (cleanQuestions.length === 0) {
    return res.status(400).json({ error: 'The form needs at least one valid question' });
  }
  db.prepare(`UPDATE speaker_form_config SET
      title = ?, intro = ?, questions = ?, updatedById = ?, updatedAt = datetime('now')
    WHERE id = 1`)
    .run(String(title || '').trim().slice(0, 200) || DEFAULT_SPEAKER_FORM.title,
         String(intro || '').trim().slice(0, 2000),
         JSON.stringify(cleanQuestions),
         req.user.id);
  res.json({ form: getSpeakerForm() });
});

// Upload/replace the PDF template attached to one triggersUpload question.
// Each question manages its own template independently, so the form can have
// several different "answer Yes, upload a signed PDF" questions at once.
app.put('/api/speaker-form/template/:questionId', requireAdmin, (req, res) => {
  const questionId = String(req.params.questionId || '').slice(0, 40);
  const { fileName, fileData } = req.body || {};
  if (!/^data:application\/pdf;base64,/.test(String(fileData || ''))) {
    return res.status(400).json({ error: 'Please upload a PDF file' });
  }
  if (String(fileData).length > SPEAKER_PDF_MAX) {
    return res.status(400).json({ error: 'That PDF is too large — please keep it under 5 MB.' });
  }
  const cleanName = String(fileName || 'form.pdf').replace(/[^\w. -]/g, '').slice(0, 120) || 'form.pdf';
  db.prepare(`INSERT INTO speaker_form_templates (questionId, fileName, fileData, updatedById, updatedAt)
              VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT(questionId) DO UPDATE SET
                fileName = excluded.fileName, fileData = excluded.fileData,
                updatedById = excluded.updatedById, updatedAt = excluded.updatedAt`)
    .run(questionId, cleanName, fileData, req.user.id);
  res.json({ ok: true, fileName: cleanName });
});

app.delete('/api/speaker-form/template/:questionId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM speaker_form_templates WHERE questionId = ?').run(String(req.params.questionId || ''));
  res.json({ ok: true });
});

// Applications inbox (managers + admins). PDF blobs are withheld from the
// list payload; each is fetched per-application/question via the route below.
app.get('/api/speaker-applications', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const rows = db.prepare(`SELECT id, applicantName, applicantEmail, answers, needsLogistics,
      uploads, handled, createdAt
    FROM speaker_applications ORDER BY handled ASC, createdAt DESC`).all();
  const applications = rows.map((r) => {
    let answers = [];
    let uploads = [];
    try { answers = JSON.parse(r.answers || '[]'); } catch (_) {}
    try { uploads = JSON.parse(r.uploads || '[]'); } catch (_) {}
    return {
      ...r,
      answers,
      needsLogistics: !!r.needsLogistics,
      handled: !!r.handled,
      uploads: uploads.map((u) => ({ questionId: u.questionId, label: u.label, fileName: u.fileName })),
    };
  });
  res.json({ applications });
});

// Download one of the signed PDFs attached to an application, by question id.
app.get('/api/speaker-applications/:id/upload/:questionId', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const row = db.prepare('SELECT uploads FROM speaker_applications WHERE id = ?').get(Number(req.params.id));
  let uploads = [];
  try { uploads = JSON.parse((row && row.uploads) || '[]'); } catch (_) {}
  const u = uploads.find((x) => x.questionId === req.params.questionId);
  if (!u || !u.fileData) return res.status(404).json({ error: 'No PDF attached' });
  const m = String(u.fileData).match(/^data:application\/pdf;base64,(.+)$/s);
  if (!m) return res.status(404).json({ error: 'No PDF attached' });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${(u.fileName || 'form.pdf').replace(/"/g, '')}"`);
  res.send(Buffer.from(m[1], 'base64'));
});

app.post('/api/speaker-applications/:id/handled', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const row = db.prepare('SELECT id, handled FROM speaker_applications WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE speaker_applications SET handled = ? WHERE id = ?').run(row.handled ? 0 : 1, row.id);
  res.json({ ok: true });
});

app.delete('/api/speaker-applications/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM speaker_applications WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Social Media Posts -----------------------------------------------------

function canManageSocialPosts(user) {
  return user.role === 'admin' || user.role === 'manager' || !!user.canManageSocial;
}

app.get('/api/social-posts', (req, res) => {
  const posts = db.prepare(`SELECT sp.*, u.displayName AS assignedToName, c.displayName AS createdByName
    FROM social_posts sp
    LEFT JOIN users u ON u.id = sp.assignedToId
    LEFT JOIN users c ON c.id = sp.createdById
    ORDER BY sp.createdAt DESC`).all();
  // Calculate days since last posted post for nudge.
  const lastPosted = db.prepare(`SELECT postedDate FROM social_posts WHERE status='Posted' ORDER BY postedDate DESC LIMIT 1`).get();
  let daysSinceLastPost = null;
  if (lastPosted) {
    daysSinceLastPost = Math.floor((Date.now() - new Date(lastPosted.postedDate).getTime()) / (1000 * 60 * 60 * 24));
  } else {
    const firstPost = db.prepare('SELECT createdAt FROM social_posts ORDER BY createdAt ASC LIMIT 1').get();
    if (firstPost) daysSinceLastPost = 999;
  }
  // Send nudge notification to canManageSocial users if overdue.
  if (daysSinceLastPost !== null && daysSinceLastPost >= 3) {
    const socialManagers = db.prepare("SELECT id FROM users WHERE canManageSocial=1 OR role='admin'").all();
    const recentNudge = db.prepare(`SELECT id FROM notifications WHERE message LIKE '%social media post%' AND createdAt > datetime('now','-1 day') LIMIT 1`).get();
    if (!recentNudge) {
      for (const u of socialManagers) {
        pushNotification(u.id, `No social media post has been logged in ${daysSinceLastPost} day${daysSinceLastPost===1?'':'s'}. Time to post!`, 'social', 'warning');
      }
    }
  }
  res.json({ posts, daysSinceLastPost });
});

app.post('/api/social-posts', (req, res) => {
  if (!canManageSocialPosts(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { platform, captionDraft, imageDescription, scheduledDate, assignedToId } = req.body || {};
  if (!platform || !platform.trim()) return res.status(400).json({ error: 'Platform is required' });
  const validPlatforms = ['Instagram','Twitter/X','TikTok','Facebook','Other'];
  if (!validPlatforms.includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
  const info = db.prepare(`INSERT INTO social_posts (platform, captionDraft, imageDescription, scheduledDate, assignedToId, createdById)
    VALUES (?, ?, ?, ?, ?, ?)`).run(platform, captionDraft||'', imageDescription||'', scheduledDate||null,
    assignedToId ? Number(assignedToId) : null, req.user.id);
  res.status(201).json({ post: db.prepare(`SELECT sp.*, u.displayName AS assignedToName FROM social_posts sp LEFT JOIN users u ON u.id=sp.assignedToId WHERE sp.id=?`).get(info.lastInsertRowid) });
});

app.patch('/api/social-posts/:id', (req, res) => {
  if (!canManageSocialPosts(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const post = db.prepare('SELECT * FROM social_posts WHERE id=?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Not found' });
  const { platform, captionDraft, imageDescription, scheduledDate, postedDate, status, assignedToId } = req.body || {};
  const validStatuses = ['Planned','Posted','Cancelled'];
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const postedDateVal = status === 'Posted' && !postedDate ? new Date().toISOString().slice(0,10) : (postedDate != null ? postedDate : null);
  db.prepare(`UPDATE social_posts SET
    platform=COALESCE(?,platform), captionDraft=COALESCE(?,captionDraft),
    imageDescription=COALESCE(?,imageDescription), scheduledDate=COALESCE(?,scheduledDate),
    postedDate=COALESCE(?,postedDate), status=COALESCE(?,status),
    assignedToId=COALESCE(?,assignedToId) WHERE id=?`)
    .run(platform||null, captionDraft!=null?captionDraft:null, imageDescription!=null?imageDescription:null,
      scheduledDate!=null?scheduledDate:null, postedDateVal, status||null,
      assignedToId!=null?Number(assignedToId):null, post.id);
  res.json({ post: db.prepare(`SELECT sp.*, u.displayName AS assignedToName FROM social_posts sp LEFT JOIN users u ON u.id=sp.assignedToId WHERE sp.id=?`).get(post.id) });
});

app.delete('/api/social-posts/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM social_posts WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Admin Panel ------------------------------------------------------------
app.post('/api/admin/users', requireAdmin, rateLimit({ windowMs: 60 * 60 * 1000, max: 30, name: 'admin-create-user' }), (req, res) => {
  let { firstName, lastName, role, title, managerId, grade, email } = req.body || {};
  firstName = (firstName || '').trim();
  lastName = (lastName || '').trim();
  email = String(email || '').trim().slice(0, 200);
  if (!firstName) return res.status(400).json({ error: 'First name required' });
  role = ROLES.includes(role) ? role : 'member';
  grade = String(grade || '').trim().slice(0, 40);
  if (grade && !GRADES.includes(grade)) return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });

  const base = ((firstName[0] || '') + lastName).toLowerCase().replace(/[^a-z0-9]/g, '');
  let username = base || 'member';
  let n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    username = base + (++n);
  }
  const displayName = lastName ? `${firstName} ${lastName}` : firstName;
  const info = db
    .prepare(`INSERT INTO users (username, firstName, lastName, displayName, passwordHash, role, title, managerId, grade, email, firstLogin)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(username, firstName, lastName, displayName, bcrypt.hashSync(username, 10), role, title || '', managerId || null, grade, email);

  if (managerId) refreshRole(Number(managerId));
  if (email) newsletterEnroll(email, displayName, 'auto');
  res.status(201).json({ user: publicUser(getUser(info.lastInsertRowid)), defaultPassword: username });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role, title, managerId, grade, email, canManageRoster, managedGrade, canAnnounce, canEditHome, bigBoard, canViewLogistics, canManageSocial, canManageNewsletter, username, firstName, lastName, hiddenTabs } = req.body || {};
  const prevManager = user.managerId;

  // Validate and normalize username if provided.
  let newUsername = null;
  if (username !== undefined) {
    newUsername = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(newUsername)) return res.status(400).json({ error: 'Username may only contain letters, numbers, dots, hyphens, and underscores' });
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, user.id);
    if (clash) return res.status(400).json({ error: 'That username is already taken' });
  }

  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const newRole = ROLES.includes(role) ? role : user.role;
  // Never demote the last admin — that would lock everyone out of the Admin Panel.
  if (user.role === 'admin' && newRole !== 'admin') {
    const otherAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?").get(user.id).n;
    if (otherAdmins === 0) return res.status(400).json({ error: 'Cannot remove the last remaining admin.' });
  }
  const newManagerId = managerId === undefined ? user.managerId : (managerId || null);
  if (newManagerId === user.id) return res.status(400).json({ error: 'A user cannot manage themselves' });
  if (grade !== undefined && grade !== '' && !GRADES.includes(String(grade).trim())) {
    return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  }

  // Detect transitive cycles: walk up the proposed manager's chain; if we reach user.id, it's circular.
  if (newManagerId) {
    let cur = getUser(newManagerId);
    const seen = new Set();
    while (cur && cur.managerId) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      if (cur.managerId === user.id) return res.status(400).json({ error: 'This would create a circular reporting chain' });
      cur = getUser(cur.managerId);
    }
  }

  // managedGrade is nullable, so handle it directly (COALESCE can't clear a value).
  const newManagedGrade = managedGrade === undefined ? user.managedGrade : (managedGrade || null);

  // Recompute displayName when first or last name changes.
  const newFirst = firstName !== undefined ? String(firstName).trim() : null;
  const newLast  = lastName  !== undefined ? String(lastName).trim()  : null;
  const newDisplayName = (newFirst !== null || newLast !== null)
    ? [newFirst ?? user.firstName, newLast ?? user.lastName].filter(Boolean).join(' ')
    : null;

  const newHiddenTabs = hiddenTabs !== undefined
    ? JSON.stringify(Array.isArray(hiddenTabs) ? hiddenTabs : [])
    : null;

  db.prepare(`UPDATE users SET
    role = ?,
    title = COALESCE(?, title),
    managerId = ?,
    grade = COALESCE(?, grade),
    email = COALESCE(?, email),
    canManageRoster = COALESCE(?, canManageRoster),
    managedGrade    = ?,
    canAnnounce     = COALESCE(?, canAnnounce),
    canEditHome     = COALESCE(?, canEditHome),
    bigBoard           = COALESCE(?, bigBoard),
    canViewLogistics   = COALESCE(?, canViewLogistics),
    canManageSocial    = COALESCE(?, canManageSocial),
    canManageNewsletter = COALESCE(?, canManageNewsletter),
    username        = COALESCE(?, username),
    firstName       = COALESCE(?, firstName),
    lastName        = COALESCE(?, lastName),
    displayName     = COALESCE(?, displayName),
    hiddenTabs      = COALESCE(?, hiddenTabs)
  WHERE id = ?`).run(
    newRole,
    title ?? null,
    newManagerId,
    grade ?? null,
    email ?? null,
    canManageRoster !== undefined ? (canManageRoster ? 1 : 0) : null,
    newManagedGrade,
    canAnnounce !== undefined ? (canAnnounce ? 1 : 0) : null,
    canEditHome !== undefined ? (canEditHome ? 1 : 0) : null,
    bigBoard !== undefined ? (bigBoard ? 1 : 0) : null,
    canViewLogistics !== undefined ? (canViewLogistics ? 1 : 0) : null,
    canManageSocial !== undefined ? (canManageSocial ? 1 : 0) : null,
    canManageNewsletter !== undefined ? (canManageNewsletter ? 1 : 0) : null,
    newUsername,
    newFirst,
    newLast,
    newDisplayName,
    newHiddenTabs,
    user.id,
  );

  // If the username changed and the user hasn't set a custom password yet,
  // keep the default password in sync with the new username.
  if (newUsername && newUsername !== user.username && user.firstLogin) {
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?')
      .run(bcrypt.hashSync(newUsername, 10), user.id);
  }

  // Recompute manager flags for affected supervisors and the edited user themselves.
  if (prevManager) refreshRole(prevManager);
  if (newManagerId) refreshRole(newManagerId);
  if (newRole !== 'admin') refreshRole(user.id);
  res.json({ user: publicUser(getUser(user.id)) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = getUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  const formerManager = target.managerId;
  db.transaction(() => {
    // Re-parent direct reports to the removed user's manager.
    db.prepare('UPDATE users SET managerId = ? WHERE managerId = ?').run(formerManager, target.id);
    // Clean up all rows owned by or referencing this user.
    db.prepare('DELETE FROM notifications WHERE userId = ?').run(target.id);
    db.prepare('DELETE FROM team_announcements WHERE authorId = ?').run(target.id);
    db.prepare('DELETE FROM board_applications WHERE userId = ?').run(target.id);
    db.prepare('DELETE FROM ai_chat_messages WHERE userId = ?').run(target.id);
    db.prepare('DELETE FROM ai_notes WHERE userId = ?').run(target.id);
    db.prepare('UPDATE roster_members SET claimedByUserId = NULL WHERE claimedByUserId = ?').run(target.id);
    db.prepare('UPDATE funding_requests SET reviewedById = NULL WHERE reviewedById = ?').run(target.id);
    db.prepare('UPDATE funding_requests SET purchasedById = NULL WHERE purchasedById = ?').run(target.id);
    db.prepare('UPDATE board_applications SET reviewedById = NULL WHERE reviewedById = ?').run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  })();
  if (formerManager) refreshRole(formerManager);
  res.json({ ok: true });
});

// Reset a user's password back to their username default (admin convenience).
app.post('/api/admin/users/:id/reset-password', requireAdmin, rateLimit({ windowMs: 15 * 60 * 1000, max: 15, name: 'admin-reset-pw' }), (req, res) => {
  const target = getUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET passwordHash = ?, firstLogin = 1 WHERE id = ?')
    .run(bcrypt.hashSync(target.username, 10), target.id);
  res.json({ ok: true, defaultPassword: target.username });
});

// ---- AI assistant -----------------------------------------------------------

// GET /api/ai/notes — notes for current user; managers see reports'; admins use ?userId=X
app.get('/api/ai/notes', (req, res) => {
  let targetId = req.user.id;
  if (req.query.userId && req.user.role === 'admin') {
    targetId = Number(req.query.userId);
  }
  const canSee = req.user.id === targetId
    || req.user.role === 'admin'
    || isManagerOf(req.user, targetId);
  if (!canSee) return res.status(403).json({ error: 'Not allowed' });
  const notes = db.prepare(
    'SELECT * FROM ai_notes WHERE userId = ? ORDER BY createdAt DESC LIMIT 20'
  ).all(targetId);
  res.json({ notes });
});

// PATCH /api/ai/notes/:id/read — mark a note as read
app.patch('/api/ai/notes/:id/read', (req, res) => {
  const note = db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(Number(req.params.id));
  if (!note) return res.status(404).json({ error: 'Not found' });
  if (note.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not allowed' });
  }
  db.prepare('UPDATE ai_notes SET isRead = 1 WHERE id = ?').run(note.id);
  res.json({ ok: true });
});

// DELETE /api/ai/notes/:id — admin only
app.delete('/api/ai/notes/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM ai_notes WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// POST /api/ai/chat — admin only chat; body: { message, sessionId? }
app.post('/api/ai/chat', requireAdmin, rateLimit({ windowMs: 60 * 60 * 1000, max: 30, name: 'ai-chat' }), async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required' });
  const sid = sessionId || `${req.user.id}-${Date.now()}`;
  db.prepare(
    'INSERT INTO ai_chat_messages (sessionId, role, content, userId) VALUES (?, ?, ?, ?)'
  ).run(sid, 'user', message, req.user.id);
  const history = db.prepare(
    'SELECT role, content FROM ai_chat_messages WHERE sessionId = ? ORDER BY createdAt ASC LIMIT 40'
  ).all(sid);
  try {
    const { reply, proposal } = await chatWithAI(db, history, req.user.id);
    const info = db.prepare(
      'INSERT INTO ai_chat_messages (sessionId, role, content, userId, taskProposal) VALUES (?, ?, ?, ?, ?)'
    ).run(sid, 'assistant', reply, req.user.id, proposal ? JSON.stringify(proposal) : '');
    res.json({ reply, sessionId: sid, proposal: proposal || null, messageId: info.lastInsertRowid });
  } catch (err) {
    console.error('[AI chat error]', err);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// POST /api/ai/chat/proposal/:messageId/create — admin only. Creates the tasks
// from an AI-drafted proposal after the admin reviewed it. Body:
// { items: [{ index, userId? }] } — index into the stored proposal's tasks,
// userId only to fill in / override an assignee. Task content always comes
// from the stored proposal, never the client.
app.post('/api/ai/chat/proposal/:messageId/create', requireAdmin, rateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'ai-proposal-create' }), (req, res) => {
  const msg = db.prepare(
    "SELECT * FROM ai_chat_messages WHERE id = ? AND userId = ? AND role = 'assistant'"
  ).get(Number(req.params.messageId), req.user.id);
  if (!msg || !msg.taskProposal) return res.status(404).json({ error: 'Proposal not found' });

  let proposal;
  try { proposal = JSON.parse(msg.taskProposal); } catch { return res.status(500).json({ error: 'Stored proposal is corrupted' }); }
  if (proposal.status === 'created') return res.status(409).json({ error: 'These tasks were already created' });

  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No tasks selected' });

  // Resolve every selected item before inserting anything, so a bad row fails
  // the whole batch instead of half-creating it.
  const toCreate = [];
  for (const item of items) {
    const idx = Number(item && item.index);
    const task = Number.isInteger(idx) ? proposal.tasks[idx] : null;
    if (!task) return res.status(400).json({ error: `Invalid task index: ${item && item.index}` });
    const ownerId = Number(item.userId) || task.assigneeUserId;
    const owner = ownerId ? getUser(ownerId) : null;
    if (!owner) return res.status(400).json({ error: `No assignee for task "${task.title}" — pick a person for it first` });
    toCreate.push({ task, owner });
  }

  const insert = db.prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus)
                             VALUES (?, ?, ?, ?, 'Not Started', ?, 'approved')`);
  const createdIds = [];
  const byOwner = new Map();
  const createAll = db.transaction(() => {
    for (const { task, owner } of toCreate) {
      const info = insert.run(owner.id, task.title.slice(0, 300), (task.description || '').slice(0, 5000), task.dueDate || null, req.user.id);
      createdIds.push(info.lastInsertRowid);
      if (!byOwner.has(owner.id)) byOwner.set(owner.id, { owner, titles: [] });
      byOwner.get(owner.id).titles.push(task.title);
    }
    proposal.status = 'created';
    proposal.createdTaskIds = createdIds;
    proposal.createdAt = new Date().toISOString();
    db.prepare('UPDATE ai_chat_messages SET taskProposal = ? WHERE id = ?').run(JSON.stringify(proposal), msg.id);
  });
  createAll();

  // One notification per assignee, not per task — nine tasks shouldn't mean
  // nine pings.
  for (const { owner, titles } of byOwner.values()) {
    if (owner.id === req.user.id) continue;
    const preview = titles.slice(0, 3).map((t) => `"${t}"`).join(', ') + (titles.length > 3 ? ` and ${titles.length - 3} more` : '');
    notify(owner.email, `${titles.length === 1 ? 'New task' : `${titles.length} new tasks`} assigned to you`,
      'You have new tasks',
      `<b>${escHtml(req.user.displayName)}</b> assigned you ${titles.length === 1 ? 'a task' : `${titles.length} tasks`}: ${escHtml(preview)}.`);
    pushNotification(owner.id, `${req.user.displayName} assigned you ${titles.length === 1 ? `a task: ${preview}` : `${titles.length} tasks: ${preview}`}`, 'tasks', 'task');
  }

  res.status(201).json({ ok: true, created: createdIds.length, proposal });
});

// GET /api/ai/chat/history — admin only; returns most recent session or ?sessionId=...
app.get('/api/ai/chat/history', requireAdmin, (req, res) => {
  const { sessionId } = req.query;
  if (sessionId) {
    const messages = db.prepare(
      'SELECT * FROM ai_chat_messages WHERE userId = ? AND sessionId = ? ORDER BY createdAt ASC'
    ).all(req.user.id, sessionId);
    return res.json({ messages, sessionId });
  }
  const latest = db.prepare(
    'SELECT sessionId FROM ai_chat_messages WHERE userId = ? ORDER BY createdAt DESC LIMIT 1'
  ).get(req.user.id);
  if (!latest) return res.json({ messages: [], sessionId: null });
  const messages = db.prepare(
    'SELECT * FROM ai_chat_messages WHERE userId = ? AND sessionId = ? ORDER BY createdAt ASC'
  ).all(req.user.id, latest.sessionId);
  res.json({ messages, sessionId: latest.sessionId });
});

// POST /api/ai/analyze — admin only; manually trigger team health analysis
app.post('/api/ai/analyze', requireAdmin, rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: 'ai-analyze' }), async (req, res) => {
  if (!aiEnabled) return res.json({ ok: true, skipped: true, reason: 'AI not configured' });
  try {
    await runAIAnalysis();
    res.json({ ok: true });
  } catch (err) {
    console.error('[AI analyze error]', err);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// POST /api/howto/chat — managers/admins; stateless app how-to assistant.
// Body: { messages: [{ role, content }, ...] } (recent conversation from client).
app.post('/api/howto/chat', requireManagerOrAdmin, rateLimit({ windowMs: 60 * 60 * 1000, max: 40, name: 'howto-chat' }), async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages required' });
  const history = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (history.length === 0) return res.status(400).json({ error: 'messages required' });
  try {
    const reply = await chatWithHowTo(history, req.user.role);
    res.json({ reply });
  } catch (err) {
    console.error('[Howto chat error]', err);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// ---- Login activity dashboard (admin or canViewLogistics) -------------------
app.get('/api/logistics/stats', (req, res) => {
  if (req.user.role !== 'admin' && !req.user.canViewLogistics) return res.status(403).json({ error: 'Access denied' });
  const stats = db.prepare(`
    SELECT
      u.id         AS userId,
      u.username,
      u.displayName,
      u.title,
      u.role,
      COALESCE(COUNT(l.id), 0) AS totalLogins,
      MAX(l.loginAt)           AS lastLogin
    FROM users u
    LEFT JOIN login_logs l ON l.userId = u.id
    WHERE u.username != 'logistics'
    GROUP BY u.id
    ORDER BY totalLogins DESC, u.displayName
  `).all();
  // Per-user login count for each of the last 7 days (day 0 = today UTC).
  const perUserDaily = db.prepare(`
    SELECT l.userId, DATE(l.loginAt) AS day, COUNT(*) AS count
    FROM login_logs l
    JOIN users u ON u.id = l.userId
    WHERE u.username != 'logistics'
      AND l.loginAt >= DATE('now', '-6 days')
    GROUP BY l.userId, day
  `).all();
  // Team-wide totals per day for last 14 days (for the trend chart).
  const teamDaily = db.prepare(`
    SELECT DATE(l.loginAt) AS day, COUNT(*) AS count
    FROM login_logs l
    JOIN users u ON u.id = l.userId
    WHERE u.username != 'logistics'
      AND l.loginAt >= DATE('now', '-13 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();
  const recentLogins = db.prepare(`
    SELECT l.id, l.userId, l.username, l.loginAt, l.ipAddress,
           u.displayName, u.title, u.role
    FROM login_logs l
    JOIN users u ON u.id = l.userId
    WHERE u.username != 'logistics'
    ORDER BY l.loginAt DESC
    LIMIT 200
  `).all();
  const engagementSummary = db.prepare(`
    SELECT event, label, COUNT(*) AS count,
           MAX(loggedAt) AS lastSeen,
           SUM(CASE WHEN date(loggedAt) = date('now') THEN 1 ELSE 0 END) AS todayCount
    FROM page_events
    GROUP BY event, label
    ORDER BY count DESC
  `).all();
  const recentEvents = db.prepare(
    'SELECT id, event, label, loggedAt FROM page_events ORDER BY loggedAt DESC LIMIT 300'
  ).all();
  const totalMembers = db.prepare("SELECT COUNT(*) AS n FROM roster_members WHERE status = 'Onboarded'").get().n;
  const genderBreakdown = db.prepare(`
    SELECT
      CASE WHEN gender = '' OR gender IS NULL THEN 'Unknown' ELSE gender END AS label,
      COUNT(*) AS count
    FROM roster_members
    WHERE status = 'Onboarded'
    GROUP BY label
    ORDER BY count DESC
  `).all();
  const gradeBreakdown = db.prepare(`
    SELECT
      CASE WHEN grade IS NULL OR grade = '' THEN 'Unknown' ELSE CAST(grade AS TEXT) END AS label,
      COUNT(*) AS count
    FROM roster_members
    WHERE status = 'Onboarded'
    GROUP BY label
    ORDER BY CAST(label AS INTEGER) ASC, label ASC
  `).all();
  res.json({ stats, perUserDaily, teamDaily, recentLogins, demographics: { totalMembers, genderBreakdown, gradeBreakdown }, engagementSummary, recentEvents });
});

// ---- Site Activity dashboard (public website traffic — admin or canViewLogistics) -
// Time windows the dashboard can be scoped to. Each clause is a fixed, trusted
// SQL fragment selected by name (never interpolated from user input).
const SITE_RANGES = {
  today: {
    cur:   "date(viewedAt) = date('now')",
    prev:  "date(viewedAt) = date('now','-1 day')",
    start: "date('now')",
    trendDays: 1,
  },
  '7d': {
    cur:   "viewedAt >= datetime('now','-7 days')",
    prev:  "viewedAt >= datetime('now','-14 days') AND viewedAt < datetime('now','-7 days')",
    start: "datetime('now','-7 days')",
    trendDays: 7,
  },
  '30d': {
    cur:   "viewedAt >= datetime('now','-30 days')",
    prev:  "viewedAt >= datetime('now','-60 days') AND viewedAt < datetime('now','-30 days')",
    start: "datetime('now','-30 days')",
    trendDays: 30,
  },
  all: {
    cur:   "1=1",
    prev:  "0=1",
    start: "'0000-01-01'",
    trendDays: 30,
  },
};
// Rows that must never count as audience traffic: bots (rejected at
// /api/site-visit going forward, reclassified by the db.js migration for
// old rows) and board members' own browsers (visitorIds marked at portal
// login — which also retroactively removes their pre-existing rows). Fold
// the filter into every range clause so no stats query can miss it.
const AUDIENCE_ONLY = "deviceType != 'Bot' AND visitorId NOT IN (SELECT visitorId FROM internal_visitors)";
for (const r of Object.values(SITE_RANGES)) {
  r.cur  = `(${r.cur}) AND ${AUDIENCE_ONLY}`;
  r.prev = `(${r.prev}) AND ${AUDIENCE_ONLY}`;
}

app.get('/api/site-activity/stats', (req, res) => {
  if (req.user.role !== 'admin' && !req.user.canViewLogistics) return res.status(403).json({ error: 'Access denied' });

  const rangeKey = SITE_RANGES[req.query.range] ? req.query.range : '7d';
  const R = SITE_RANGES[rangeKey];

  // Headline metrics for the selected window + the prior equal-length window
  // (for the period-over-period % change badges).
  const metricsFor = (clause) => db.prepare(`
    SELECT
      COUNT(*)                                        AS views,
      COUNT(DISTINCT visitorId)                       AS visitors,
      AVG(CASE WHEN durationSec > 0 THEN durationSec END) AS avgDurationSec
    FROM site_visits WHERE ${clause}
  `).get();
  const current = metricsFor(R.cur);
  const previous = metricsFor(R.prev);

  // Live: distinct visitors seen in the last 5 minutes (independent of range).
  const activeNow = db.prepare(
    `SELECT COUNT(DISTINCT visitorId) AS n FROM site_visits WHERE viewedAt >= datetime('now','-5 minutes') AND ${AUDIENCE_ONLY}`
  ).get().n;

  // All-time reference numbers, always shown regardless of range.
  const allTime = db.prepare(
    `SELECT COUNT(*) AS views, COUNT(DISTINCT visitorId) AS visitors FROM site_visits WHERE ${AUDIENCE_ONLY}`
  ).get();

  const totals = {
    views: current.views || 0,
    visitors: current.visitors || 0,
    avgDurationSec: current.avgDurationSec || 0,
    pagesPerVisitor: current.visitors ? (current.views / current.visitors) : 0,
    prevViews: previous.views || 0,
    prevVisitors: previous.visitors || 0,
    prevAvgDurationSec: previous.avgDurationSec || 0,
    activeNow,
    allTimeViews: allTime.views || 0,
    allTimeVisitors: allTime.visitors || 0,
    hasPrev: rangeKey !== 'all',
  };

  // New vs. returning: classify every visitor active in the window by whether
  // their first-ever visit falls inside the window (new) or before it (return).
  const newReturning = db.prepare(`
    SELECT
      SUM(CASE WHEN firstSeen >= ${R.start} THEN 1 ELSE 0 END) AS newVisitors,
      SUM(CASE WHEN firstSeen <  ${R.start} THEN 1 ELSE 0 END) AS returningVisitors
    FROM (
      SELECT visitorId, MIN(viewedAt) AS firstSeen,
             MAX(CASE WHEN ${R.cur} THEN 1 ELSE 0 END) AS inRange
      FROM site_visits
      GROUP BY visitorId
      HAVING inRange = 1
    )
  `).get();

  const dailyTrend = db.prepare(`
    SELECT DATE(viewedAt) AS day, COUNT(*) AS views, COUNT(DISTINCT visitorId) AS visitors
    FROM site_visits
    WHERE viewedAt >= DATE('now', '-${R.trendDays - 1} days') AND ${AUDIENCE_ONLY}
    GROUP BY day
    ORDER BY day ASC
  `).all();

  // 24 hour-of-day buckets (UTC — the client rotates them to local time).
  const hourlyRows = db.prepare(`
    SELECT CAST(strftime('%H', viewedAt) AS INTEGER) AS hour, COUNT(*) AS count
    FROM site_visits WHERE ${R.cur}
    GROUP BY hour
  `).all();
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  for (const row of hourlyRows) if (row.hour >= 0 && row.hour < 24) hourly[row.hour].count = row.count;

  const topPages = db.prepare(`
    SELECT path, COUNT(*) AS views,
           COUNT(DISTINCT visitorId) AS visitors,
           AVG(CASE WHEN durationSec > 0 THEN durationSec END) AS avgDurationSec
    FROM site_visits WHERE ${R.cur}
    GROUP BY path
    ORDER BY views DESC
    LIMIT 20
  `).all();

  const topLocations = db.prepare(`
    SELECT
      CASE WHEN city != '' THEN city ELSE 'Unknown' END AS city,
      region, country, COUNT(*) AS views
    FROM site_visits
    WHERE country != '' AND ${R.cur}
    GROUP BY city, region, country
    ORDER BY views DESC
    LIMIT 15
  `).all();

  const deviceBreakdown = db.prepare(`
    SELECT CASE WHEN deviceType = '' THEN 'Unknown' ELSE deviceType END AS label, COUNT(*) AS count
    FROM site_visits WHERE ${R.cur}
    GROUP BY label ORDER BY count DESC
  `).all();

  const browserBreakdown = db.prepare(`
    SELECT CASE WHEN browser = '' THEN 'Unknown' ELSE browser END AS label, COUNT(*) AS count
    FROM site_visits WHERE ${R.cur}
    GROUP BY label ORDER BY count DESC
  `).all();

  const directCount = db.prepare(`SELECT COUNT(*) AS n FROM site_visits WHERE referrer = '' AND ${R.cur}`).get().n;
  const referrerRows = db.prepare(`
    SELECT referrer, COUNT(*) AS count FROM site_visits
    WHERE referrer != '' AND ${R.cur}
    GROUP BY referrer
    ORDER BY count DESC
    LIMIT 200
  `).all();
  // Bucket raw referrer URLs into a friendly source name by hostname.
  const sourceCounts = new Map();
  const bump = (name, n) => { if (n > 0) sourceCounts.set(name, (sourceCounts.get(name) || 0) + n); };
  bump('Direct', directCount);
  for (const r of referrerRows) {
    let host = '';
    try { host = new URL(r.referrer).hostname.replace(/^www\./, ''); } catch (_) { host = ''; }
    if (!host) { bump('Other', r.count); continue; }
    if (host.includes('google.')) bump('Google', r.count);
    else if (host.includes('instagram.')) bump('Instagram', r.count);
    else if (host.includes('facebook.') || host.includes('fb.')) bump('Facebook', r.count);
    else if (host.includes('youtube.')) bump('YouTube', r.count);
    else if (host.includes('bing.')) bump('Bing', r.count);
    else if (host.includes('duckduckgo.')) bump('DuckDuckGo', r.count);
    else if (host.includes('t.co') || host.includes('twitter.') || host.includes('x.com')) bump('Twitter/X', r.count);
    else if (host.includes('tiktok.')) bump('TikTok', r.count);
    else if (host.includes('linkedin.')) bump('LinkedIn', r.count);
    else if (host.includes('reddit.')) bump('Reddit', r.count);
    else bump(host, r.count);
  }
  const topSources = Array.from(sourceCounts, ([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);

  const recentVisits = db.prepare(`
    SELECT id, visitorId, path, referrer, country, region, city, ipAddress,
           deviceType, browser, durationSec, viewedAt
    FROM site_visits WHERE ${R.cur}
    ORDER BY viewedAt DESC
    LIMIT 200
  `).all();

  res.json({
    range: rangeKey, totals,
    newReturning: { newVisitors: newReturning.newVisitors || 0, returningVisitors: newReturning.returningVisitors || 0 },
    dailyTrend, hourly, topPages, topLocations, deviceBreakdown, browserBreakdown, topSources, recentVisits,
  });
});

// CSV export of raw visits for the selected window (admin / logistics only).
app.get('/api/site-activity/export.csv', (req, res) => {
  if (req.user.role !== 'admin' && !req.user.canViewLogistics) return res.status(403).json({ error: 'Access denied' });
  const R = SITE_RANGES[req.query.range] ? SITE_RANGES[req.query.range] : SITE_RANGES['7d'];
  const rows = db.prepare(`
    SELECT viewedAt, path, referrer, city, region, country, deviceType, browser, durationSec, ipAddress, visitorId
    FROM site_visits WHERE ${R.cur}
    ORDER BY viewedAt DESC
    LIMIT 5000
  `).all();
  const header = ['Time (UTC)', 'Page', 'Referrer', 'City', 'Region', 'Country', 'Device', 'Browser', 'Duration (s)', 'IP', 'Visitor ID'];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.viewedAt, r.path, r.referrer, r.city, r.region, r.country, r.deviceType, r.browser, r.durationSec, r.ipAddress, r.visitorId].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="site-activity-${req.query.range || '7d'}.csv"`);
  res.send(lines.join('\n'));
});

// Wipe all recorded site visits and start counting fresh. Admin only (not
// canViewLogistics) — it's destructive, so the president/VP has to pull the
// trigger themselves from the dashboard's confirm dialog.
app.delete('/api/site-activity', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const deleted = db.prepare('DELETE FROM site_visits').run().changes;
  res.json({ ok: true, deleted });
});

// ---- Grade Pipeline ---------------------------------------------------------
app.get('/api/roster/grade-pipeline', (req, res) => {
  const canViewAll = canViewRoster(req.user); // admin / manager / canManageRoster
  const myGrade = req.user.managedGrade != null ? Number(req.user.managedGrade) : null;
  // Only roster viewers or assigned grade reps may see pipeline PII at all.
  if (!canViewAll && myGrade == null) return res.status(403).json({ error: 'Not allowed' });

  const gradeParam = req.query.grade;
  let grade;
  if (gradeParam !== undefined && gradeParam !== '') {
    grade = Number(gradeParam);
    if (!Number.isInteger(grade)) return res.status(400).json({ error: 'Invalid grade' });
    // A grade rep (not a manager/admin) may only view their own grade.
    if (!canViewAll && grade !== myGrade) return res.status(403).json({ error: 'Not allowed' });
  } else if (!canViewAll) {
    grade = myGrade;
  }
  // Managers/admins with no grade param fall through to all grades (grade undefined).
  const gradeFilter = grade != null ? 'WHERE rm.grade = ' + Number(grade) : '';
  const statusFilter = grade != null
    ? 'WHERE rm.grade = ' + Number(grade) + " AND rm.status IN ('Prospect','Contacted')"
    : "WHERE rm.status IN ('Prospect','Contacted')";
  const counts = db.prepare(
    'SELECT COUNT(*) AS total,' +
    " COUNT(CASE WHEN status='Prospect' THEN 1 END) AS prospects," +
    " COUNT(CASE WHEN status='Contacted' THEN 1 END) AS contacted," +
    " COUNT(CASE WHEN status='Onboarded' THEN 1 END) AS onboarded" +
    ' FROM roster_members rm ' + gradeFilter
  ).get();
  const prospects = db.prepare(
    'SELECT rm.*, u.displayName AS claimedByName' +
    ' FROM roster_members rm LEFT JOIN users u ON u.id = rm.claimedByUserId ' +
    statusFilter + ' ORDER BY rm.createdAt ASC'
  ).all();
  const goalRow = grade != null ? db.prepare('SELECT goal FROM grade_goals WHERE grade = ?').get(Number(grade)) : null;
  const goal = goalRow ? goalRow.goal : 0;
  res.json({ grade, counts, prospects, goal });
});

// ---- Grade Goals ------------------------------------------------------------
app.get('/api/grade-goals', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const rows = db.prepare('SELECT grade, goal FROM grade_goals ORDER BY grade ASC').all();
  res.json({ goals: rows });
});

app.put('/api/grade-goals/:grade', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const grade = Number(req.params.grade);
  const goal = Math.max(0, Number(req.body.goal) || 0);
  db.prepare('INSERT OR REPLACE INTO grade_goals (grade, goal) VALUES (?, ?)').run(grade, goal);
  res.json({ ok: true, grade, goal });
});

// ---- Reimbursements ---------------------------------------------------------
const REIMBURSEMENT_CATEGORIES = ['Supplies', 'Food', 'Printing', 'Travel', 'Other'];

app.post('/api/reimbursements', (req, res) => {
  const { amount, category, description, purchaseDate } = req.body || {};
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  if (!REIMBURSEMENT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!purchaseDate) return res.status(400).json({ error: 'Purchase date required' });
  const info = db.prepare(`INSERT INTO reimbursements (submittedById, amount, category, description, purchaseDate)
    VALUES (?, ?, ?, ?, ?)`).run(req.user.id, Number(amount), category, String(description || '').trim(), String(purchaseDate));
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/reimbursements', (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  const rows = isManager
    ? db.prepare(`SELECT r.*, u.displayName AS submitterName, u.title AS submitterTitle,
        rv.displayName AS reviewerName
        FROM reimbursements r JOIN users u ON u.id = r.submittedById
        LEFT JOIN users rv ON rv.id = r.reviewedById
        ORDER BY r.createdAt DESC`).all()
    : db.prepare(`SELECT r.*, u.displayName AS submitterName FROM reimbursements r JOIN users u ON u.id = r.submittedById
        WHERE r.submittedById = ? ORDER BY r.createdAt DESC`).all(req.user.id);
  res.json({ reimbursements: rows });
});

app.patch('/api/reimbursements/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const r = db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  const { action, reviewNotes } = req.body || {};
  if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'action must be approve or deny' });
  // Reviewers may not approve/deny their own reimbursement requests.
  if (r.submittedById === req.user.id) return res.status(403).json({ error: 'You cannot review your own reimbursement request' });
  const status = action === 'approve' ? 'approved' : 'denied';
  db.prepare(`UPDATE reimbursements SET status=?, reviewedById=?, reviewedAt=datetime('now'), reviewNotes=? WHERE id=?`)
    .run(status, req.user.id, String(reviewNotes || '').trim(), r.id);
  const submitter = getUser(r.submittedById);
  if (submitter) {
    pushNotification(submitter.id,
      `Your reimbursement request ($${Number(r.amount).toFixed(2)} · ${r.category}) was ${status}.`,
      'reimbursements', 'info');
  }
  res.json({ ok: true, status });
});

// ---- Check-In Pulse ---------------------------------------------------------
app.get('/api/checkins/pulse', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const weekOf = currentCheckinWeek();
  const users = db.prepare(`SELECT id, displayName, title FROM users WHERE role != 'admin' OR id = ? ORDER BY displayName`).all(req.user.id);
  const submitted = new Set(
    db.prepare('SELECT userId FROM weekly_checkins WHERE weekOf = ?').all(weekOf).map((r) => r.userId)
  );
  res.json({
    weekOf,
    users: users.map((u) => ({ id: u.id, displayName: u.displayName, title: u.title, submitted: submitted.has(u.id) })),
  });
});

app.post('/api/checkins/nudge/:userId', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const target = getUser(Number(req.params.userId));
  if (!target) return res.status(404).json({ error: 'User not found' });
  pushNotification(target.id, `${req.user.displayName} is reminding you to submit your weekly check-in.`, 'checkin', 'info');
  res.json({ ok: true });
});

// ---- Team Tasks -------------------------------------------------------------
app.get('/api/team/tasks', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const reports = req.user.role === 'admin'
    ? db.prepare('SELECT * FROM users ORDER BY displayName').all()
    : directReports(req.user.id);
  const tasksByUser = reports.map((u) => {
    const tasks = db.prepare(`SELECT t.*, u.displayName AS ownerName
      FROM tasks t JOIN users u ON u.id = t.userId
      WHERE t.userId = ? AND t.approvalStatus = 'approved'
      ORDER BY t.dueDate ASC NULLS LAST, t.createdAt DESC`).all(u.id);
    return { user: { id: u.id, displayName: u.displayName, title: u.title }, tasks };
  }).filter((g) => g.tasks.length > 0);
  res.json({ tasksByUser });
});

// ---- Directory --------------------------------------------------------------
app.get('/api/directory', (req, res) => {
  // Return hasPhoto instead of the base64 blob — the client loads photos
  // lazily from /api/users/:id/photo, keeping this payload small.
  const users = db.prepare(`SELECT id, displayName, title, email, phone,
    CASE WHEN photo != '' THEN 1 ELSE 0 END AS hasPhoto
    FROM users ORDER BY displayName ASC`).all();
  res.json({ users });
});

// ---- Home feed / summary card -----------------------------------------------
app.get('/api/me/summary', async (req, res) => {
  const userId = req.user.id;
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // My tasks: active ones due within 7 days, or any overdue, up to 5
  const myTasks = db.prepare(
    "SELECT id, name, dueDate, status FROM tasks WHERE userId = ? AND status != 'Complete' AND approvalStatus = 'approved' ORDER BY dueDate ASC NULLS LAST LIMIT 5"
  ).all(userId);

  const settings = db.prepare('SELECT weeklyCheckinEnabled FROM site_settings WHERE id = 1').get();
  let checkinSubmitted = null;
  if (settings && settings.weeklyCheckinEnabled) {
    const week = currentCheckinWeek();
    const row = db.prepare('SELECT id FROM weekly_checkins WHERE userId = ? AND weekOf = ?').get(userId, week);
    checkinSubmitted = !!row;
  }

  // All upcoming meetings from the internal tracker...
  const trackedMeetings = db.prepare(
    "SELECT id, title, meetingDate FROM meetings WHERE meetingDate >= ? ORDER BY meetingDate ASC"
  ).all(today);

  // ...merged with the club's connected event calendar (the same feed Club
  // Home shows), so board members see every event, not just tracked meetings.
  let calendarEvents = [];
  const calRow = db.prepare('SELECT calendarUrl FROM site_settings WHERE id = 1').get();
  if (calRow && calRow.calendarUrl) {
    try {
      calendarEvents = (await fetchUpcoming(calRow.calendarUrl, 50)).map((e) => ({
        id: 'cal-' + (e.uid || e.title + e.start.toISOString()),
        title: e.title,
        meetingDate: e.start.toISOString().slice(0, 10),
      }));
    } catch (_) {}
  }
  // De-dupe: a tracked meeting and a calendar entry for the same event share
  // a title and date, so keep the tracked one (it links to agenda/minutes).
  const trackedKeys = new Set(trackedMeetings.map((m) => (m.title || '').trim().toLowerCase() + '|' + m.meetingDate));
  const upcomingMeetings = trackedMeetings
    .concat(calendarEvents.filter((e) => !trackedKeys.has((e.title || '').trim().toLowerCase() + '|' + e.meetingDate)))
    .sort((a, b) => a.meetingDate.localeCompare(b.meetingDate));

  // Open polls the user hasn't voted on yet
  const openPolls = db.prepare(
    "SELECT id, question FROM polls WHERE status = 'open' AND id NOT IN (SELECT pollId FROM poll_votes WHERE userId = ?) LIMIT 3"
  ).all(userId);

  // Current team announcement (most recent)
  const announcement = db.prepare(
    "SELECT text, updatedAt FROM team_announcements ORDER BY updatedAt DESC LIMIT 1"
  ).get();

  // My open action items from meetings
  const actionItems = db.prepare(`
    SELECT a.id, a.text, a.dueDate, m.title AS meetingTitle, m.id AS meetingId
    FROM meeting_action_items a
    JOIN meetings m ON m.id = a.meetingId
    WHERE a.assigneeId = ? AND a.done = 0
    ORDER BY a.dueDate ASC NULLS LAST LIMIT 5
  `).all(userId);

  res.json({
    myTasks,
    checkinSubmitted,
    upcomingMeetings,
    openPolls,
    announcement: announcement || null,
    actionItems,
    tasksDueSoon: myTasks.filter(t => t.dueDate && t.dueDate <= in7).length,
  });
});

// ---- Resource Hub -----------------------------------------------------------
const RESOURCE_CATEGORIES = ['Forms', 'Templates', 'Policies', 'Social', 'Finance', 'Other'];

app.get('/api/resources', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.title, r.url, r.category, r.description, r.createdAt,
           u.displayName AS createdByName
    FROM resources r
    LEFT JOIN users u ON u.id = r.createdById
    ORDER BY r.category, r.title
  `).all();
  res.json({ resources: rows });
});

app.post('/api/resources', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { title, url, category = 'Other', description = '' } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: 'title and url are required' });
  if (!RESOURCE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const result = db.prepare(
    'INSERT INTO resources (title, url, category, description, createdById) VALUES (?, ?, ?, ?, ?)'
  ).run(String(title).slice(0, 200), String(url).slice(0, 500), category, String(description).slice(0, 500), req.user.id);
  res.json({ id: result.lastInsertRowid });
});

app.patch('/api/resources/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const row = db.prepare('SELECT id FROM resources WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { title, url, category, description } = req.body || {};
  if (category && !RESOURCE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const fields = [];
  const vals = [];
  if (title !== undefined) { fields.push('title = ?'); vals.push(String(title).slice(0, 200)); }
  if (url !== undefined) { fields.push('url = ?'); vals.push(String(url).slice(0, 500)); }
  if (category !== undefined) { fields.push('category = ?'); vals.push(category); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(String(description).slice(0, 500)); }
  if (!fields.length) return res.json({ ok: true });
  vals.push(row.id);
  db.prepare('UPDATE resources SET ' + fields.join(', ') + ' WHERE id = ?').run(...vals);
  res.json({ ok: true });
});

app.delete('/api/resources/:id', (req, res) => {
  const row = db.prepare('SELECT id, createdById FROM resources WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && row.createdById !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM resources WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---- Meeting Action Items ----------------------------------------------------
app.get('/api/meetings/:id/action-items', (req, res) => {
  const meetingId = Number(req.params.id);
  const rows = db.prepare(`
    SELECT a.id, a.text, a.dueDate, a.done, a.taskId, a.createdAt,
           a.assigneeId, u.displayName AS assigneeName,
           c.displayName AS createdByName, a.createdById,
           t.status AS taskStatus
    FROM meeting_action_items a
    LEFT JOIN users u ON u.id = a.assigneeId
    LEFT JOIN users c ON c.id = a.createdById
    LEFT JOIN tasks t ON t.id = a.taskId
    WHERE a.meetingId = ?
    ORDER BY a.createdAt ASC
  `).all(meetingId);
  res.json({ items: rows });
});

app.post('/api/meetings/:id/action-items', (req, res) => {
  // Creating an action item can auto-create a task assigned to any user, which
  // would otherwise require manager approval — so gate it to managers/admins.
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const meetingId = Number(req.params.id);
  const meeting = db.prepare('SELECT id, title FROM meetings WHERE id = ?').get(meetingId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  const { text, assigneeId, dueDate = '' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });

  const parsedAssignee = assigneeId ? Number(assigneeId) : null;
  let taskId = null;

  // Auto-create a task for the assignee so it shows on their to-do page.
  if (parsedAssignee) {
    const taskResult = db.prepare(
      'INSERT INTO tasks (userId, name, description, dueDate, status, assignedById) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      parsedAssignee,
      String(text).slice(0, 500),
      'From meeting: ' + meeting.title,
      dueDate || null,
      'Not Started',
      req.user.id
    );
    taskId = taskResult.lastInsertRowid;
  }

  const result = db.prepare(
    'INSERT INTO meeting_action_items (meetingId, text, assigneeId, dueDate, createdById, taskId) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(meetingId, String(text).slice(0, 500), parsedAssignee, String(dueDate).slice(0, 10), req.user.id, taskId);

  if (parsedAssignee) {
    pushNotification(parsedAssignee, 'New action item from ' + meeting.title + ': "' + String(text).slice(0, 100) + '"', '', 'info');
  }
  res.json({ id: result.lastInsertRowid, taskId });
});

app.patch('/api/meetings/:id/action-items/:itemId', (req, res) => {
  const itemId = Number(req.params.itemId);
  const item = db.prepare('SELECT * FROM meeting_action_items WHERE id = ? AND meetingId = ?').get(itemId, Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  const isAssignee = item.assigneeId === req.user.id;
  const isCreator = item.createdById === req.user.id;
  if (!isManager && !isAssignee && !isCreator) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { text, done, assigneeId, dueDate } = req.body || {};
  const fields = [];
  const vals = [];
  if (text !== undefined && isManager) { fields.push('text = ?'); vals.push(String(text).slice(0, 500)); }
  if (done !== undefined) { fields.push('done = ?'); vals.push(done ? 1 : 0); }
  if (assigneeId !== undefined && isManager) { fields.push('assigneeId = ?'); vals.push(assigneeId ? Number(assigneeId) : null); }
  if (dueDate !== undefined && isManager) { fields.push('dueDate = ?'); vals.push(String(dueDate).slice(0, 10)); }
  if (!fields.length) return res.json({ ok: true });
  vals.push(itemId);
  db.prepare('UPDATE meeting_action_items SET ' + fields.join(', ') + ' WHERE id = ?').run(...vals);
  res.json({ ok: true });
});

app.delete('/api/meetings/:id/action-items/:itemId', (req, res) => {
  const itemId = Number(req.params.itemId);
  const item = db.prepare('SELECT id, createdById FROM meeting_action_items WHERE id = ? AND meetingId = ?').get(itemId, Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && req.user.role !== 'manager' && item.createdById !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM meeting_action_items WHERE id = ?').run(itemId);
  res.json({ ok: true });
});

app.post('/api/meetings/:id/action-items/:itemId/promote', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const itemId = Number(req.params.itemId);
  const item = db.prepare('SELECT * FROM meeting_action_items WHERE id = ? AND meetingId = ?').get(itemId, Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.taskId) return res.status(400).json({ error: 'Already promoted to a task' });
  if (!item.assigneeId) return res.status(400).json({ error: 'Assign to a user before promoting' });
  const meeting = db.prepare('SELECT title FROM meetings WHERE id = ?').get(Number(req.params.id));
  const taskResult = db.prepare(
    'INSERT INTO tasks (userId, name, description, dueDate, status, assignedById) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    item.assigneeId,
    item.text,
    meeting ? 'From meeting: ' + meeting.title : '',
    item.dueDate || null,
    'Not Started',
    req.user.id
  );
  db.prepare('UPDATE meeting_action_items SET taskId = ? WHERE id = ?').run(taskResult.lastInsertRowid, itemId);
  pushNotification(item.assigneeId, 'A meeting action item has been converted to a task: "' + item.text.slice(0, 100) + '"', '', 'info');
  res.json({ taskId: taskResult.lastInsertRowid });
});

app.get('/api/me/action-items', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.text, a.dueDate, a.done, a.taskId, a.createdAt, a.meetingId,
           m.title AS meetingTitle, m.meetingDate
    FROM meeting_action_items a
    JOIN meetings m ON m.id = a.meetingId
    WHERE a.assigneeId = ? AND a.done = 0
    ORDER BY a.dueDate ASC, a.createdAt ASC
  `).all(req.user.id);
  res.json({ items: rows });
});

// ---- Volunteer event management (manager/admin) ------------------------------
function requireManagerOrAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  res.status(403).json({ error: 'Managers and admins only' });
}

// Newsletter tools are open to admins and anyone granted the newsletter
// permission (e.g. the Secretary).
function requireNewsletterAccess(req, res, next) {
  if (req.user.role === 'admin' || req.user.canManageNewsletter) return next();
  res.status(403).json({ error: 'Not allowed' });
}

app.get('/api/volunteer-events', requireManagerOrAdmin, (req, res) => {
  const events = db.prepare(`
    SELECT ve.id, ve.icalUid, ve.title, ve.location, ve.startDate, ve.volunteersEnabled, ve.createdAt
    FROM volunteer_events ve ORDER BY ve.startDate DESC
  `).all();
  const result = events.map((ev) => {
    const roles = db.prepare('SELECT id, roleName, cap FROM volunteer_roles WHERE eventId = ? ORDER BY id').all(ev.id);
    const rolesWithCounts = roles.map((r) => {
      const confirmed  = db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'confirmed'").get(r.id).n;
      const waitlisted = db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'waitlisted'").get(r.id).n;
      return { ...r, confirmed, waitlisted };
    });
    // Event-level totals INCLUDE general (no-role) sign-ups, which role chips
    // alone would hide from the admin.
    const totals = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'confirmed'  THEN 1 ELSE 0 END) AS confirmedTotal,
        SUM(CASE WHEN status = 'waitlisted' THEN 1 ELSE 0 END) AS waitlistedTotal,
        SUM(CASE WHEN roleId IS NULL THEN 1 ELSE 0 END)        AS generalCount
      FROM volunteer_signups WHERE eventId = ?
    `).get(ev.id);
    return {
      ...ev, volunteersEnabled: !!ev.volunteersEnabled, roles: rolesWithCounts,
      confirmedTotal: totals.confirmedTotal || 0,
      waitlistedTotal: totals.waitlistedTotal || 0,
      generalCount: totals.generalCount || 0,
    };
  });
  res.json({ events: result });
});

app.post('/api/volunteer-events', requireManagerOrAdmin, (req, res) => {
  let { icalUid, title, location, startDate } = req.body || {};
  icalUid   = String(icalUid   || '').trim().slice(0, 500);
  title     = String(title     || '').trim().slice(0, 200);
  location  = String(location  || '').trim().slice(0, 200);
  startDate = String(startDate || '').trim().slice(0, 30);
  if (!icalUid || !title || !startDate) return res.status(400).json({ error: 'icalUid, title, and startDate are required' });
  try {
    const info = db.prepare(
      'INSERT INTO volunteer_events (icalUid, title, location, startDate, createdById) VALUES (?, ?, ?, ?, ?)'
    ).run(icalUid, title, location, startDate, req.user.id);
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      // Already exists — return the existing record's id.
      const existing = db.prepare('SELECT id FROM volunteer_events WHERE icalUid = ?').get(icalUid);
      return res.json({ ok: true, id: existing.id });
    }
    throw e;
  }
});

app.patch('/api/volunteer-events/:id', requireManagerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT id FROM volunteer_events WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const { volunteersEnabled, title } = req.body || {};
  if (volunteersEnabled !== undefined) {
    db.prepare('UPDATE volunteer_events SET volunteersEnabled = ? WHERE id = ?').run(volunteersEnabled ? 1 : 0, id);
  }
  if (title !== undefined) {
    db.prepare('UPDATE volunteer_events SET title = ? WHERE id = ?').run(String(title).trim().slice(0, 200), id);
  }
  res.json({ ok: true });
});

app.delete('/api/volunteer-events/:id', requireManagerOrAdmin, (req, res) => {
  db.prepare('DELETE FROM volunteer_events WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/volunteer-events/:id/roles', requireManagerOrAdmin, (req, res) => {
  const eventId = Number(req.params.id);
  const ev = db.prepare('SELECT id FROM volunteer_events WHERE id = ?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  let { roleName, cap } = req.body || {};
  roleName = String(roleName || '').trim().slice(0, 100);
  cap      = Math.max(0, Number(cap) || 0);
  if (!roleName) return res.status(400).json({ error: 'roleName is required' });
  const info = db.prepare('INSERT INTO volunteer_roles (eventId, roleName, cap) VALUES (?, ?, ?)').run(eventId, roleName, cap);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/volunteer-roles/:id', requireManagerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const role = db.prepare('SELECT id FROM volunteer_roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  let { roleName, cap } = req.body || {};
  if (roleName !== undefined) db.prepare('UPDATE volunteer_roles SET roleName = ? WHERE id = ?').run(String(roleName).trim().slice(0, 100), id);
  if (cap      !== undefined) db.prepare('UPDATE volunteer_roles SET cap = ? WHERE id = ?').run(Math.max(0, Number(cap) || 0), id);
  res.json({ ok: true });
});

app.delete('/api/volunteer-roles/:id', requireManagerOrAdmin, (req, res) => {
  db.prepare('DELETE FROM volunteer_roles WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/volunteer-events/:id/signups', requireManagerOrAdmin, (req, res) => {
  const eventId = Number(req.params.id);
  const signups = db.prepare(`
    SELECT vs.id, vs.name, vs.phone, vs.email, vs.grade, vs.status, vs.needsReview, vs.createdAt, vs.attendedAt,
           vr.roleName, rm.firstName || ' ' || rm.lastName AS matchedName, rm.id AS rosterMatchId
    FROM volunteer_signups vs
    LEFT JOIN volunteer_roles vr ON vr.id = vs.roleId
    LEFT JOIN roster_members rm ON rm.id = vs.matchedRosterId
    WHERE vs.eventId = ?
    ORDER BY vs.createdAt ASC
  `).all(eventId);
  res.json({ signups });
});

// Check a volunteer in/out at the event. Only checked-in sign-ups show up on
// a matched roster member's volunteer history — signing up isn't the same
// as showing up.
app.patch('/api/volunteer-signups/:id/attendance', requireManagerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const signup = db.prepare('SELECT id FROM volunteer_signups WHERE id = ?').get(id);
  if (!signup) return res.status(404).json({ error: 'Not found' });
  const attended = !!(req.body || {}).attended;
  if (attended) db.prepare("UPDATE volunteer_signups SET attendedAt = datetime('now') WHERE id = ?").run(id);
  else db.prepare('UPDATE volunteer_signups SET attendedAt = NULL WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.delete('/api/volunteer-signups/:id', requireManagerOrAdmin, (req, res) => {
  db.prepare('DELETE FROM volunteer_signups WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Manually resolve a "needs review" sign-up: link it to an existing roster
// member (rosterId set) when the auto phone/email match missed, or dismiss
// the flag with no link when it's confirmed to be a new person.
app.patch('/api/volunteer-signups/:id/review', requireManagerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const signup = db.prepare('SELECT id FROM volunteer_signups WHERE id = ?').get(id);
  if (!signup) return res.status(404).json({ error: 'Not found' });
  const { rosterId } = req.body || {};
  if (rosterId != null) {
    const member = db.prepare('SELECT id FROM roster_members WHERE id = ?').get(Number(rosterId));
    if (!member) return res.status(400).json({ error: 'Roster member not found' });
    db.prepare('UPDATE volunteer_signups SET matchedRosterId = ?, needsReview = 0 WHERE id = ?').run(Number(rosterId), id);
  } else {
    db.prepare('UPDATE volunteer_signups SET matchedRosterId = NULL, needsReview = 0 WHERE id = ?').run(id);
  }
  res.json({ ok: true });
});

// Roster cross-reference: volunteer events this roster member actually showed
// up to. Signing up alone doesn't count — a volunteer manager has to check
// them in at the event (attendedAt set) before it lands here.
app.get('/api/roster-members/:id/volunteer-history', (req, res) => {
  if (!canViewRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const rosterId = Number(req.params.id);
  const history = db.prepare(`
    SELECT vs.id, vs.name, vs.status, vs.createdAt, vs.attendedAt, ve.title AS eventTitle, ve.startDate,
           vr.roleName
    FROM volunteer_signups vs
    JOIN volunteer_events ve ON ve.id = vs.eventId
    LEFT JOIN volunteer_roles vr ON vr.id = vs.roleId
    WHERE vs.matchedRosterId = ? AND vs.attendedAt IS NOT NULL
    ORDER BY vs.createdAt DESC
  `).all(rosterId);
  res.json({ history });
});

// Roster cross-reference: meeting attendance for this roster member.
// Includes both records marked against this roster contact directly (rosterId)
// and records marked against a linked portal account — resolved via the explicit
// linkedUserId FK, falling back to an email match.
app.get('/api/roster-members/:id/attendance-history', (req, res) => {
  if (!canViewRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const rosterId = Number(req.params.id);
  const member = db.prepare('SELECT email, linkedUserId FROM roster_members WHERE id = ?').get(rosterId);
  if (!member) return res.status(404).json({ error: 'Not found' });
  let linkedUserId = member.linkedUserId;
  if (!linkedUserId && member.email) {
    const hit = db.prepare("SELECT id FROM users WHERE email != '' AND lower(email) = lower(?)").get(member.email);
    if (hit) linkedUserId = hit.id;
  }
  const history = db.prepare(`
    SELECT ae.id, ae.title, ae.eventDate, ae.location, ar.status
    FROM attendance_records ar
    JOIN attendance_events ae ON ae.id = ar.eventId
    WHERE ar.rosterId = ? OR (ar.userId IS NOT NULL AND ar.userId = ?)
    ORDER BY ae.eventDate DESC
  `).all(rosterId, linkedUserId || 0);
  res.json({ history });
});

// ---- Testimonials -----------------------------------------------------------

function notifyAdmins(message, link = '', type = 'info') {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
    for (const a of admins) pushNotification(a.id, message, link, type);
  } catch (_) {}
}

// Notify everyone who can act on the roster (admins + the secretary / anyone
// granted canManageRoster) — used for roster follow-ups such as absence alerts.
// New sign-ups deliberately do NOT use this; see notifySecretary below.
function notifyRosterManagers(message, link = '', type = 'info') {
  try {
    const managers = db.prepare("SELECT id FROM users WHERE role = 'admin' OR canManageRoster = 1").all();
    for (const m of managers) pushNotification(m.id, message, link, type);
  } catch (_) {}
}

// Everyone who should hear "someone joined the club" — the Secretary, and by
// design nobody else. The President and VP asked to be left out of the
// day-to-day sign-up stream; the only other people alerted about a join are
// the referrer (their own referral) and that grade's rep (their outreach).
//
// Matched on title, the same way db.js grants the Secretary's permissions, so a
// co-secretary or a renamed "Club Secretary" still counts. The fallbacks only
// matter when the club has no secretary at all: a sign-up announced to nobody
// would sit in the Pending queue unreviewed forever, which is worse than the
// President seeing it.
// Title match only, deliberately without the fallbacks below: this also gates
// what the Secretary can *see* in the Get Involved inbox, and access shouldn't
// silently spread to every grade rep just because the title is vacant.
function isSecretary(user) {
  return !!user && /secretary/i.test(String(user.title || ''));
}

function secretaryTargets() {
  try {
    const pick = (cond) => db.prepare(`SELECT id, email FROM users WHERE username != 'logistics' AND (${cond})`).all();
    let rows = pick("lower(title) LIKE '%secretary%'");
    if (!rows.length) rows = pick('canManageRoster = 1');
    if (!rows.length) rows = pick("role = 'admin'");
    return rows;
  } catch (_) { return []; }
}

// Returns the ids actually notified, so callers can avoid double-pinging
// someone who is both the secretary and the referrer.
function notifySecretary(message, link = '', type = 'info') {
  const targets = secretaryTargets();
  for (const t of targets) pushNotification(t.id, message, link, type);
  return targets.map((t) => t.id);
}

// The board members who own outreach for a grade. Admins are excluded so the
// President and VP stay out of the join stream even if they carry a grade.
function gradeRepsFor(grade) {
  if (!grade) return [];
  try {
    return db.prepare(
      "SELECT id, email, role, grade FROM users WHERE grade = ? AND role != 'admin' AND username != 'logistics'"
    ).all(String(grade));
  } catch (_) { return []; }
}

// NOTE: public testimonial routes (GET /api/testimonials and the
// /api/public/testimonial-submit endpoints) live above the auth gate.

// Admin: all testimonials (any status).
app.get('/api/admin/testimonials', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const rows = db.prepare(
    "SELECT id, name, role, photo, text, status, submitToken, submittedByMemberId, sortOrder, createdAt, updatedAt FROM testimonials ORDER BY createdAt DESC"
  ).all();
  res.json({ testimonials: rows });
});

// Admin: create a testimonial directly (instantly approved).
app.post('/api/admin/testimonials', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  let { name, role, photo, text, status } = req.body || {};
  name   = String(name   || '').trim().slice(0, 120);
  role   = String(role   || '').trim().slice(0, 120);
  photo  = cleanPhotoDataUrl(photo);
  text   = String(text   || '').trim().slice(0, 5000);
  status = ['pending', 'approved'].includes(status) ? status : 'approved';
  if (!name || !text) return res.status(400).json({ error: 'Name and testimonial text are required' });
  const info = db.prepare(
    "INSERT INTO testimonials (name, role, photo, text, status) VALUES (?, ?, ?, ?, ?)"
  ).run(name, role, photo, text, status);
  const row = db.prepare("SELECT * FROM testimonials WHERE id = ?").get(info.lastInsertRowid);
  res.json({ testimonial: row });
});

// Admin: update a testimonial.
app.patch('/api/admin/testimonials/:id', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM testimonials WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  let { name, role, photo, text, status, sortOrder } = req.body || {};
  const upName   = name      !== undefined ? String(name).trim().slice(0, 120) : row.name;
  const upRole   = role      !== undefined ? String(role).trim().slice(0, 120) : row.role;
  const upPhoto  = photo     !== undefined ? cleanPhotoDataUrl(photo) : row.photo;
  const upText   = text      !== undefined ? String(text).trim().slice(0, 5000) : row.text;
  const upStatus = (status !== undefined && ['pending', 'approved'].includes(status)) ? status : row.status;
  const upOrder  = sortOrder !== undefined ? Number(sortOrder) : row.sortOrder;
  db.prepare(
    "UPDATE testimonials SET name=?, role=?, photo=?, text=?, status=?, sortOrder=?, updatedAt=datetime('now') WHERE id=?"
  ).run(upName, upRole, upPhoto, upText, upStatus, upOrder, id);
  res.json({ testimonial: db.prepare("SELECT * FROM testimonials WHERE id = ?").get(id) });
});

// Admin: delete a testimonial.
app.delete('/api/admin/testimonials/:id', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM testimonials WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Admin: approve a testimonial.
app.post('/api/admin/testimonials/:id/approve', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT id FROM testimonials WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE testimonials SET status='approved', updatedAt=datetime('now') WHERE id=?").run(id);
  res.json({ ok: true });
});

// Admin: lightweight pending count (used for nav badge — avoids sending full photo blobs).
app.get('/api/admin/testimonials/pending-count', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM testimonials WHERE status='pending' AND (submitToken IS NULL OR submitToken='')").get();
  res.json({ count: row.n });
});

// Admin: reject (revert to pending or delete) a testimonial.
app.post('/api/admin/testimonials/:id/reject', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT id FROM testimonials WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE testimonials SET status='pending', updatedAt=datetime('now') WHERE id=?").run(id);
  res.json({ ok: true });
});

// Admin: generate a private pre-filled submit link for a specific member.
// The member's name/role are pre-filled but they write their own testimonial.
app.post('/api/admin/testimonials/generate-link', authenticate, requirePasswordChanged, requireAdmin, (req, res) => {
  const { userId } = req.body || {};
  const user = userId ? db.prepare("SELECT id, displayName, title FROM users WHERE id = ?").get(Number(userId)) : null;
  if (!user) return res.status(400).json({ error: 'User ID required' });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    "INSERT INTO testimonials (name, role, text, status, submitToken, submittedByMemberId) VALUES (?, ?, '', 'pending', ?, ?)"
  ).run(user.displayName, user.title || '', token, user.id);
  const appUrl = process.env.APP_URL || '';
  const link = `${appUrl}/testimonial-submit/${token}`;
  res.json({ link });
});

// ---- Newsletter -------------------------------------------------------------

function newsletterEnroll(email, name, source = 'auto') {
  const e = String(email || '').trim().toLowerCase();
  const n = String(name  || '').trim().slice(0, 120);
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return;
  try {
    db.prepare(
      "INSERT OR IGNORE INTO newsletter_subscribers (email, name, source) VALUES (?, ?, ?)"
    ).run(e, n, source);
  } catch (_) {}
}

// NOTE: the public newsletter signup route (POST /api/newsletter/subscribe)
// lives above the auth gate.

// Admin / newsletter manager: manually add a subscriber.
app.post('/api/admin/newsletter', authenticate, requirePasswordChanged, requireNewsletterAccess, (req, res) => {
  let { email, name } = req.body || {};
  email = String(email || '').trim().toLowerCase();
  name  = String(name  || '').trim().slice(0, 120);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  const existing = db.prepare("SELECT id, active FROM newsletter_subscribers WHERE lower(email) = ?").get(email);
  if (existing) {
    if (!existing.active) {
      db.prepare("UPDATE newsletter_subscribers SET active=1, name=?, source='manual', subscribedAt=datetime('now') WHERE id=?")
        .run(name || existing.name, existing.id);
      return res.json({ ok: true, reactivated: true });
    }
    return res.status(409).json({ error: 'This email is already subscribed.' });
  }
  const info = db.prepare("INSERT INTO newsletter_subscribers (email, name, source) VALUES (?, ?, 'manual')").run(email, name);
  res.status(201).json({ subscriber: { id: info.lastInsertRowid, email, name, source: 'manual', active: 1, subscribedAt: new Date().toISOString() } });
});

// Admin / newsletter manager: list all subscribers.
app.get('/api/admin/newsletter', authenticate, requirePasswordChanged, requireNewsletterAccess, (req, res) => {
  const rows = db.prepare(
    "SELECT id, email, name, source, active, subscribedAt FROM newsletter_subscribers ORDER BY subscribedAt DESC"
  ).all();
  res.json({ subscribers: rows });
});

// Admin / newsletter manager: toggle subscriber active/inactive.
app.patch('/api/admin/newsletter/:id', authenticate, requirePasswordChanged, requireNewsletterAccess, (req, res) => {
  const id = Number(req.params.id);
  const { active } = req.body || {};
  db.prepare("UPDATE newsletter_subscribers SET active=? WHERE id=?").run(active ? 1 : 0, id);
  res.json({ ok: true });
});

// Admin / newsletter manager: remove a subscriber.
app.delete('/api/admin/newsletter/:id', authenticate, requirePasswordChanged, requireNewsletterAccess, (req, res) => {
  db.prepare("DELETE FROM newsletter_subscribers WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Merch shop management (secretary + admins) ------------------------------
function adminItemWithVariants(item) {
  const { photo, createdById, ...rest } = item;
  return {
    ...rest,
    hasVariants: !!item.hasVariants,
    active: !!item.active,
    hasPhoto: !!photo,
    isDonation: !!item.isDonation,
    stripeProductId: item.stripeProductId || '',
    stripeEnabled: !!stripe,
    variants: db.prepare('SELECT id, label, inventory, priceOverride FROM merch_variants WHERE itemId = ? ORDER BY id').all(item.id),
  };
}

app.get('/api/shop/admin/items', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const items = db.prepare('SELECT * FROM merch_items ORDER BY name').all().map(adminItemWithVariants);
  res.json({ items });
});

app.post('/api/shop/admin/items', async (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  let { name, description, price, photo, hasVariants, inventory, variants, isDonation } = req.body || {};
  name = String(name || '').trim().slice(0, 120);
  description = String(description || '').trim().slice(0, 2000);
  price = Math.max(0, Math.round(Number(price) || 0));
  photo = cleanPhotoDataUrl(photo);
  isDonation = !!isDonation;
  // A donation item is pay-what-you-want (price = minimum), so it has no
  // variants and no inventory.
  hasVariants = !isDonation && !!hasVariants;
  inventory = Math.max(0, Math.round(Number(inventory) || 0));
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (isDonation && price < 50) return res.status(400).json({ error: 'The minimum donation must be at least $0.50.' });

  const info = db.prepare(`INSERT INTO merch_items (name, description, price, photo, hasVariants, inventory, isDonation, createdById)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, description, price, photo, hasVariants ? 1 : 0, hasVariants ? 0 : inventory, isDonation ? 1 : 0, req.user.id);
  const itemId = info.lastInsertRowid;

  if (hasVariants && Array.isArray(variants)) {
    const insertVariant = db.prepare('INSERT INTO merch_variants (itemId, label, inventory, priceOverride) VALUES (?, ?, ?, ?)');
    for (const v of variants) {
      const label = String((v || {}).label || '').trim().slice(0, 80);
      if (!label) continue;
      const vInventory = Math.max(0, Math.round(Number((v || {}).inventory) || 0));
      const priceOverride = (v || {}).priceOverride !== undefined && (v || {}).priceOverride !== null && (v || {}).priceOverride !== ''
        ? Math.max(0, Math.round(Number(v.priceOverride)))
        : null;
      insertVariant.run(itemId, label, vInventory, priceOverride);
    }
  }
  // Create the matching Stripe Product now so it's available in the Stripe
  // Dashboard when the admin builds a product-restricted promotion code, and
  // so checkout can reference it. Best-effort — item creation still succeeds
  // if Stripe is unreachable.
  await ensureStripeProduct(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId));
  res.status(201).json({ item: adminItemWithVariants(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId)) });
});

app.patch('/api/shop/admin/items/:id', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM merch_items WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  let { name, description, price, photo, active, inventory } = req.body || {};
  if (name !== undefined) {
    name = String(name).trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Name is required.' });
  }
  if (description !== undefined) description = String(description).trim().slice(0, 2000);
  if (price !== undefined) price = Math.max(0, Math.round(Number(price) || 0));
  if (photo !== undefined) photo = cleanPhotoDataUrl(photo);
  if (inventory !== undefined) inventory = Math.max(0, Math.round(Number(inventory) || 0));
  db.prepare(`UPDATE merch_items SET
    name = COALESCE(?, name), description = COALESCE(?, description), price = COALESCE(?, price),
    photo = CASE WHEN ? THEN ? ELSE photo END,
    active = COALESCE(?, active), inventory = COALESCE(?, inventory)
    WHERE id = ?`).run(
    name ?? null, description ?? null, price ?? null,
    photo !== undefined && photo !== '' ? 1 : 0, photo || null,
    active !== undefined ? (active ? 1 : 0) : null, inventory ?? null,
    id
  );
  res.json({ item: adminItemWithVariants(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(id)) });
});

app.delete('/api/shop/admin/items/:id', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM merch_items WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Create (or re-link) the item's Stripe Product on demand. Used to backfill
// items that predate Stripe syncing, and to re-create the product after
// switching between Stripe test and live keys (each mode has its own products).
// Returns the product id the admin can point a "specific products" coupon at.
app.post('/api/shop/admin/items/:id/sync-stripe', async (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured yet.' });
  const item = db.prepare('SELECT * FROM merch_items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const stripeProductId = await ensureStripeProduct(item);
  if (!stripeProductId) return res.status(502).json({ error: 'Could not sync to Stripe — please try again.' });
  res.json({ stripeProductId });
});

app.post('/api/shop/admin/items/:id/variants', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const itemId = Number(req.params.id);
  const item = db.prepare('SELECT id FROM merch_items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  let { label, inventory, priceOverride } = req.body || {};
  label = String(label || '').trim().slice(0, 80);
  if (!label) return res.status(400).json({ error: 'A label is required (e.g. "Small").' });
  inventory = Math.max(0, Math.round(Number(inventory) || 0));
  priceOverride = priceOverride !== undefined && priceOverride !== null && priceOverride !== '' ? Math.max(0, Math.round(Number(priceOverride))) : null;
  db.prepare('UPDATE merch_items SET hasVariants = 1 WHERE id = ?').run(itemId);
  const info = db.prepare('INSERT INTO merch_variants (itemId, label, inventory, priceOverride) VALUES (?, ?, ?, ?)')
    .run(itemId, label, inventory, priceOverride);
  res.status(201).json({ item: adminItemWithVariants(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId)) , variantId: info.lastInsertRowid });
});

app.patch('/api/shop/admin/variants/:id', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const id = Number(req.params.id);
  const variant = db.prepare('SELECT * FROM merch_variants WHERE id = ?').get(id);
  if (!variant) return res.status(404).json({ error: 'Not found' });
  let { label, inventory, priceOverride } = req.body || {};
  if (label !== undefined) label = String(label).trim().slice(0, 80);
  if (inventory !== undefined) inventory = Math.max(0, Math.round(Number(inventory) || 0));
  const hasOverride = priceOverride !== undefined;
  const overrideVal = hasOverride && priceOverride !== null && priceOverride !== '' ? Math.max(0, Math.round(Number(priceOverride))) : null;
  db.prepare(`UPDATE merch_variants SET
    label = COALESCE(?, label), inventory = COALESCE(?, inventory),
    priceOverride = CASE WHEN ? THEN ? ELSE priceOverride END
    WHERE id = ?`).run(label ?? null, inventory ?? null, hasOverride ? 1 : 0, overrideVal, id);
  res.json({ item: adminItemWithVariants(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(variant.itemId)) });
});

app.delete('/api/shop/admin/variants/:id', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const variant = db.prepare('SELECT itemId FROM merch_variants WHERE id = ?').get(Number(req.params.id));
  if (!variant) return res.status(404).json({ error: 'Not found' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM merch_variants WHERE id = ?').run(Number(req.params.id));
    // A variant item with zero variants can never be ordered (pricing insists a
    // variant be chosen), so fall back to plain per-item inventory.
    const left = db.prepare('SELECT COUNT(*) AS n FROM merch_variants WHERE itemId = ?').get(variant.itemId).n;
    if (left === 0) db.prepare('UPDATE merch_items SET hasVariants = 0 WHERE id = ?').run(variant.itemId);
  });
  tx();
  res.json({ item: adminItemWithVariants(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(variant.itemId)) });
});

app.get('/api/shop/admin/orders', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { fulfillmentStatus, deliveryMethod } = req.query;
  let sql = 'SELECT * FROM merch_orders WHERE 1=1';
  const params = [];
  if (fulfillmentStatus) { sql += ' AND fulfillmentStatus = ?'; params.push(String(fulfillmentStatus)); }
  if (deliveryMethod) { sql += ' AND deliveryMethod = ?'; params.push(String(deliveryMethod)); }
  sql += ' ORDER BY createdAt DESC';
  const orders = db.prepare(sql).all(...params).map((o) => ({
    ...o,
    shippingAddress: o.shippingAddress ? JSON.parse(o.shippingAddress) : null,
  }));
  res.json({ orders });
});

app.patch('/api/shop/admin/orders/:id', (req, res) => {
  if (!canManageShop(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM merch_orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { action, notes } = req.body || {};

  if (action === 'mark-paid') {
    if (order.fulfillmentStatus === 'cancelled') return res.status(400).json({ error: 'This order is cancelled.' });
    db.prepare("UPDATE merch_orders SET paymentStatus = 'paid' WHERE id = ?").run(id);
  } else if (action === 'mark-fulfilled') {
    if (order.fulfillmentStatus === 'cancelled') return res.status(400).json({ error: 'This order is cancelled.' });
    db.prepare("UPDATE merch_orders SET fulfillmentStatus = 'fulfilled' WHERE id = ?").run(id);
  } else if (action === 'cancel') {
    if (order.fulfillmentStatus !== 'cancelled') {
      const tx = db.transaction(() => {
        // needs_review orders never decremented inventory (the item was sold
        // out or gone by the time the payment landed), so restoring stock for
        // them would fabricate units that don't exist.
        if (order.fulfillmentStatus !== 'needs_review') {
          if (order.variantId) {
            db.prepare('UPDATE merch_variants SET inventory = inventory + ? WHERE id = ?').run(order.quantity, order.variantId);
          } else if (order.itemId) {
            db.prepare('UPDATE merch_items SET inventory = inventory + ? WHERE id = ?').run(order.quantity, order.itemId);
          }
        }
        db.prepare("UPDATE merch_orders SET fulfillmentStatus = 'cancelled' WHERE id = ?").run(id);
      });
      tx();
    }
  } else if (action === 'notes') {
    db.prepare('UPDATE merch_orders SET notes = ? WHERE id = ?').run(String(notes || '').trim().slice(0, 2000), id);
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  const updated = db.prepare('SELECT * FROM merch_orders WHERE id = ?').get(id);
  res.json({ order: { ...updated, shippingAddress: updated.shippingAddress ? JSON.parse(updated.shippingAddress) : null } });
});

// Promo codes are managed in the Stripe Dashboard and applied on Stripe's
// hosted checkout page (allow_promotion_codes), so there are no promo-code
// endpoints here anymore.

// ---- Remote MCP endpoint ----------------------------------------------------
// Lets an external Claude chat (claude.ai custom connector) manage the site —
// tasks, volunteers, events, shop, roster, and more. Enabled by setting
// MCP_SECRET; actions run through the same notification/audit helpers as the
// web routes. See server/mcp.js and the README's "Claude MCP connector" section.
registerMcpEndpoint(app, { pushNotification, logApproval, ensureStripeProduct });

// ---- Static frontend --------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// The SPA handles client-side routes (/, /survey, /volunteer/123, etc.).
// Paths that look like files (have an extension) get a real 404 instead of
// index.html, so a broken asset path fails loudly rather than feeding HTML
// to the script loader.
// MCP/OAuth-discovery clients (including claude.ai's connector setup) probe
// well-known paths like /.well-known/oauth-authorization-server before
// connecting. These have no file extension, so without this route they'd
// fall through to the SPA catch-all below and get back a 200 HTML page —
// which confuses clients expecting a clean 404 ("no OAuth here, proceed
// unauthenticated").
app.get('/.well-known/*', (req, res) => res.status(404).end());

app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).end();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Catch-all error handler: turn a thrown route error into a 500 instead of
// letting it bubble up and crash the process.
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  // Bad input from the caller is a 4xx, not a server fault. Reporting these as
  // 500 hides real breakage in the logs and tells the client to retry something
  // that can never succeed.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  res.status(500).json({ error: 'Something went wrong' });
});

// Point Telegram at our webhook so /start and /stop reach us. Idempotent —
// safe to call on every boot. Needs APP_URL to build a public https URL.
async function registerTelegramWebhook() {
  if (!telegramEnabled()) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram updates disabled.');
    return;
  }
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!appUrl || !/^https:\/\//i.test(appUrl)) {
    console.warn('[telegram] APP_URL (https) not set — cannot register webhook; DMs will still send but /start linking is inbound-only.');
    return;
  }
  const url = `${appUrl}/api/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, allowed_updates: ['message'] }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) console.log('[telegram] webhook registered.');
    else console.warn('[telegram] setWebhook failed:', JSON.stringify(d).slice(0, 200));
  } catch (e) {
    console.warn('[telegram] setWebhook error:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    if (seeded) console.log('Seeded database with default Club America accounts.');
    console.log(`Club America Management running at http://localhost:${PORT}`);
    registerTelegramWebhook();
  });
}

module.exports = { app };

async function runAIAnalysis() {
  if (!aiEnabled) return;
  console.log('[AI] Running team health analysis…');
  try {
    const notes = await analyzeTeamHealth(db);
    let inserted = 0;
    for (const { userId, noteContent } of notes) {
      const recent = db.prepare(
        "SELECT id FROM ai_notes WHERE userId = ? AND isRead = 0 AND createdAt >= datetime('now', '-6 days')"
      ).get(userId);
      if (!recent) {
        db.prepare('INSERT INTO ai_notes (userId, content) VALUES (?, ?)').run(userId, noteContent);
        inserted++;
      }
    }
    console.log(`[AI] Analysis complete — ${inserted} new note(s) created.`);
  } catch (err) {
    console.error('[AI] Background analysis error:', err);
  }
}

setTimeout(runAIAnalysis, 5 * 60 * 1000);
setInterval(runAIAnalysis, 24 * 60 * 60 * 1000);
