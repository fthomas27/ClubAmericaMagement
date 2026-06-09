const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');

// Keep a single stray error from taking the whole process down (which makes the
// host restart the app — the "crash then reboot and load" loop). We log it and
// stay up; Express request errors are already handled per-route below.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const { db, init, seed } = require('./db');
const { fetchUpcoming, clearCache } = require('./calendar');
const { notify, escHtml } = require('./email');
const { analyzeTeamHealth, chatWithAI, aiEnabled } = require('./ai');
const {
  signToken,
  publicUser,
  authenticate,
  requirePasswordChanged,
  requireAdmin,
} = require('./auth');

init();
const seeded = seed();

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
// Keep the global body limit small (photo upload gets its own parser).
app.use((req, res, next) => {
  const limit = req.method === 'PUT' && req.path === '/api/me/profile' ? '6mb' : '50kb';
  express.json({ limit })(req, res, next);
});

const STATUSES = ['Not Started', 'In Progress', 'Complete'];
const ROLES = ['admin', 'manager', 'member'];
const GRADES = ['9', '10', '11', '12'];

// Allowed roster pipeline transitions. A member may move forward, be declined,
// or be reactivated back to Prospect — but cannot skip straight from Prospect to
// Onboarded without being contacted first.
const ROSTER_TRANSITIONS = {
  Prospect:  ['Contacted', 'Declined'],
  Contacted: ['Onboarded', 'Declined', 'Prospect'],
  Onboarded: ['Contacted', 'Declined'],
  Declined:  ['Prospect', 'Contacted'],
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
    assignedByName: assigner ? assigner.displayName : 'Self',
  };
}

function getPageSettings(userId) {
  const row = db.prepare('SELECT * FROM user_page_settings WHERE userId = ?').get(userId);
  if (!row) return {
    userId,
    bannerEnabled: false, bannerTitle: '', bannerUrl: '',
    formEnabled: false, formTitle: '', formFields: [],
    announcementEnabled: false, announcementText: '',
    bioEnabled: false, bioText: '',
  };
  let formFields = [];
  try { formFields = JSON.parse(row.formFields || '[]'); } catch (_) {}
  return {
    ...row,
    bannerEnabled: !!row.bannerEnabled,
    formEnabled: !!row.formEnabled,
    announcementEnabled: !!row.announcementEnabled,
    bioEnabled: !!row.bioEnabled,
    formFields,
  };
}

// ---- Auth -------------------------------------------------------------------
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 40, name: 'login' }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    db.prepare('INSERT INTO login_logs (userId, username, ipAddress) VALUES (?, ?, ?)').run(user.id, user.username, ip);
  } catch (_) {}
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/change-password', authenticate, rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'change-password' }), (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
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
  const row = db.prepare('SELECT meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, aboutText, homeAnnouncement, homeAnnouncementEnabled, announcementPostedAt, updatedAt FROM site_settings WHERE id = 1').get();
  // Auto-expire the announcement after 7 days.
  let announcementEnabled = !!row.homeAnnouncementEnabled;
  if (announcementEnabled && row.announcementPostedAt) {
    const ageMs = Date.now() - new Date(row.announcementPostedAt + 'Z').getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      announcementEnabled = false;
      db.prepare("UPDATE site_settings SET homeAnnouncementEnabled = 0 WHERE id = 1").run();
    }
  }
  return { ...row, podcastEnabled: !!row.podcastEnabled, homeAnnouncementEnabled: announcementEnabled };
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
    WHERE ve.volunteersEnabled = 1 AND ve.startDate >= datetime('now', '-1 hour')
    ORDER BY ve.startDate ASC
  `).all();
  res.json({ home: { ...publicHome, calendarConfigured: !!calendarUrl }, events, volunteerEvents });
});

// Public board roster for the "Meet the Board" page (no private info, no auth).
// Filtered to bigBoard users so only actual board leaders appear publicly.
// Returns hasPhoto (boolean) instead of the full base64 blob to keep the payload small.
app.get('/api/board', (req, res) => {
  const members = db
    .prepare("SELECT id, displayName, title, role, grade, managerId, bio, photo FROM users WHERE bigBoard = 1 ORDER BY displayName")
    .all()
    .map(({ photo, ...m }) => ({ ...m, hasPhoto: !!photo }));
  res.json({ members });
});

// Serves a single user's profile photo. No auth required (same data shown publicly).
app.get('/api/users/:id/photo', (req, res) => {
  const row = db.prepare('SELECT photo FROM users WHERE id = ?').get(Number(req.params.id));
  if (!row || !row.photo) return res.status(404).end();
  // photo is stored as a data URL: "data:image/jpeg;base64,..."
  const m = String(row.photo).match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
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
  //  - club-join → that grade's grade reps + admins (President/VP)
  //  - board application → admins only
  let recipients;
  if (type === 'club' && grade) {
    recipients = db.prepare("SELECT id, email FROM users WHERE role = 'admin' OR grade = ?").all(grade);
  } else {
    recipients = db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all();
  }
  const label = type === 'board' ? 'board application' : 'club-join request';
  for (const r of recipients) {
    notify(r.email, `New ${label}`,
      `New ${label}`,
      `<b>${escHtml(name)}</b>${grade ? ' (grade ' + escHtml(grade) + ')' : ''} submitted a ${label}.<br/>Email: ${escHtml(email)}${message ? '<br/>Message: ' + escHtml(message) : ''}<br/><br/>See it in the Get Involved inbox.`);
    pushNotification(r.id, `New ${label} from ${name}${grade ? ' (grade ' + grade + ')' : ''}`, 'submissions', 'submission');
  }

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

// Public click tracking — no auth required (visitors haven't logged in).
app.post('/api/track', rateLimit({ windowMs: 60 * 1000, max: 120, name: 'track' }), (req, res) => {
  const { event, label } = req.body || {};
  if (!event || typeof event !== 'string') return res.status(400).json({ error: 'event required' });
  db.prepare('INSERT INTO page_events (event, label) VALUES (?, ?)')
    .run(String(event).slice(0, 80), String(label || '').slice(0, 200));
  res.json({ ok: true });
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
  roleId = roleId ? Number(roleId) : null;
  if (roleId) {
    const role = db.prepare('SELECT id, cap FROM volunteer_roles WHERE id = ? AND eventId = ?').get(roleId, eventId);
    if (!role) return res.status(400).json({ error: 'Invalid role' });
    let status = 'confirmed';
    if (role.cap > 0) {
      const confirmed = db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'confirmed'").get(roleId).n;
      if (confirmed >= role.cap) status = 'waitlisted';
    }
    // Cross-reference phone against roster.
    let matchedRosterId = null;
    if (phone) {
      const roster = db.prepare('SELECT id FROM roster_members WHERE phone = ? LIMIT 1').get(phone);
      if (roster) matchedRosterId = roster.id;
    }
    const info = db.prepare(
      'INSERT INTO volunteer_signups (eventId, roleId, name, phone, email, grade, status, matchedRosterId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(eventId, roleId, name, phone, email, grade, status, matchedRosterId);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid, status });
  }
  // No role — general sign-up (cap 0 = no limit).
  let matchedRosterId = null;
  if (phone) {
    const roster = db.prepare('SELECT id FROM roster_members WHERE phone = ? LIMIT 1').get(phone);
    if (roster) matchedRosterId = roster.id;
  }
  const info = db.prepare(
    'INSERT INTO volunteer_signups (eventId, roleId, name, phone, email, grade, status, matchedRosterId) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)'
  ).run(eventId, name, phone, email, grade, 'confirmed', matchedRosterId);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, status: 'confirmed' });
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
  db.prepare('UPDATE users SET photo = COALESCE(?, photo), bio = ?, email = ?, phone = ?, profileComplete = 1 WHERE id = ?')
    .run(photo === undefined ? null : photo, bio, email, phone, req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
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
//  - A grade rep (user.grade set) sees CLUB-join submissions for their grade.
//  - Board applications go to admins only.
function visibleSubmissionsFor(user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT * FROM submissions ORDER BY handled ASC, createdAt DESC').all();
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
  return row.type === 'club' && !!user.grade && row.grade === user.grade;
}
function canAccessSubmissions(user) {
  return user.role === 'admin' || !!user.grade;
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
app.put('/api/home', (req, res) => {
  if (!canEditHome(req.user)) return res.status(403).json({ error: 'Only the Digital Presence Manager can edit the homepage' });
  let { meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, aboutText } = req.body || {};
  if (meetingDate   !== undefined) meetingDate    = String(meetingDate).trim().slice(0, 100);
  if (meetingTime   !== undefined) meetingTime    = String(meetingTime).trim().slice(0, 100);
  if (meetingLocation !== undefined) meetingLocation = String(meetingLocation).trim().slice(0, 300);
  if (podcastUrl    !== undefined) podcastUrl     = String(podcastUrl).trim().slice(0, 500);
  if (calendarUrl   !== undefined) calendarUrl    = String(calendarUrl).trim().slice(0, 500);
  if (instagramUrl  !== undefined) instagramUrl   = String(instagramUrl).trim().slice(0, 300);
  if (aboutText     !== undefined) aboutText      = String(aboutText).trim().slice(0, 8000);
  const podcastEnabledVal = podcastEnabled === undefined ? null : (podcastEnabled ? 1 : 0);
  db.prepare(`UPDATE site_settings SET
       meetingDate = COALESCE(?, meetingDate),
       meetingTime = COALESCE(?, meetingTime),
       meetingLocation = COALESCE(?, meetingLocation),
       podcastUrl = COALESCE(?, podcastUrl),
       podcastEnabled = COALESCE(?, podcastEnabled),
       calendarUrl = COALESCE(?, calendarUrl),
       instagramUrl = COALESCE(?, instagramUrl),
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
  const { bannerEnabled, bannerTitle, bannerUrl,
          formEnabled, formTitle, formFields, announcementEnabled, announcementText,
          bioEnabled, bioText } = req.body || {};
  if (bannerUrl !== undefined && bannerUrl && !/^https?:\/\//i.test(bannerUrl.trim())) {
    return res.status(400).json({ error: 'Banner URL must start with http:// or https://' });
  }
  db.prepare('INSERT OR IGNORE INTO user_page_settings (userId) VALUES (?)').run(targetId);
  db.prepare(`UPDATE user_page_settings SET
    bannerEnabled       = COALESCE(?, bannerEnabled),
    bannerTitle         = COALESCE(?, bannerTitle),
    bannerUrl           = COALESCE(?, bannerUrl),
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

app.get('/api/roster', (req, res) => {
  if (!canViewRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { grade, status } = req.query;
  let sql = 'SELECT r.*, u.displayName as claimedByName FROM roster_members r LEFT JOIN users u ON u.id = r.claimedByUserId WHERE 1=1';
  const params = [];
  if (grade) { sql += ' AND r.grade = ?'; params.push(Number(grade)); }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  sql += ' ORDER BY r.createdAt DESC';
  res.json({ members: db.prepare(sql).all(...params), myGrade: req.user.managedGrade || null });
});

// Import all portal users (board members) as Onboarded roster entries, skipping duplicates.
app.post('/api/roster/import-board', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const users = db.prepare('SELECT * FROM users').all();
  const existing = db.prepare('SELECT email, firstName, lastName FROM roster_members').all();
  const existingEmails = new Set(existing.map((r) => r.email?.toLowerCase()).filter(Boolean));
  const existingNames = new Set(existing.map((r) => `${r.firstName?.toLowerCase()}|${r.lastName?.toLowerCase()}`));

  const insert = db.prepare(`INSERT INTO roster_members (firstName, lastName, email, grade, roleDescription, status)
    VALUES (?, ?, ?, ?, 'Board Member', 'Onboarded')`);

  let imported = 0;
  let skipped = 0;
  const importMany = db.transaction(() => {
    for (const u of users) {
      const email = (u.email || '').trim().toLowerCase();
      const nameKey = `${(u.firstName || '').toLowerCase()}|${(u.lastName || '').toLowerCase()}`;
      if ((email && existingEmails.has(email)) || existingNames.has(nameKey)) {
        skipped++;
        continue;
      }
      insert.run(
        u.firstName || u.displayName, u.lastName || '',
        u.email || '', u.grade ? String(u.grade) : null
      );
      if (email) existingEmails.add(email);
      existingNames.add(nameKey);
      imported++;
    }
  });
  importMany();
  res.json({ imported, skipped });
});

app.post('/api/roster', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { firstName, lastName, phone, email, grade, gender, roleDescription, status, notes } = req.body || {};
  if (!firstName || !String(firstName).trim()) return res.status(400).json({ error: 'First name required' });
  if (grade != null && grade !== '' && !GRADES.includes(String(grade))) {
    return res.status(400).json({ error: 'Grade must be 9, 10, 11, or 12' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email' });
  }
  const info = db.prepare(`INSERT INTO roster_members (firstName,lastName,phone,email,grade,gender,roleDescription,status,notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    String(firstName).trim().slice(0, 100), String(lastName||'').trim().slice(0, 100),
    String(phone||'').trim().slice(0, 30), String(email||'').trim().slice(0, 200),
    grade||null, String(gender||'').trim().slice(0, 30),
    String(roleDescription||'').trim().slice(0, 500), status||'Prospect',
    String(notes||'').trim().slice(0, 2000)
  );
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

app.post('/api/roster/:id/decline', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare(`UPDATE roster_members SET status='Declined', updatedAt=datetime('now') WHERE id=?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// Grade rep recruitment leaderboard — ranked by Onboarded members they claimed.
app.get('/api/roster/leaderboard', (req, res) => {
  if (!canViewRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const rows = db.prepare(`
    SELECT u.id, u.displayName, u.managedGrade,
           COUNT(r.id) AS count
    FROM users u
    LEFT JOIN roster_members r ON r.claimedByUserId = u.id AND r.status = 'Onboarded'
    WHERE u.title LIKE '%Grade Rep%' OR u.managedGrade IS NOT NULL
    GROUP BY u.id
    ORDER BY count DESC, u.displayName ASC
  `).all();
  res.json({ leaderboard: rows });
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
      `<b>${req.user.displayName}</b> requested funding: <b>${safeTitle}</b> ($${amt}).`);
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
      `<b>${req.user.displayName}</b> applied for <b>${safePosition}</b>.`);
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
  res.json({ user: publicUser(target), tasks });
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
  const { name, description, dueDate, targetUserId, docUrl, isRecurring, recurringDays } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name required' });

  const ownerId = targetUserId ? Number(targetUserId) : req.user.id;
  const owner = getUser(ownerId);
  if (!owner) return res.status(404).json({ error: 'Target user not found' });

  const isSelf = ownerId === req.user.id;
  const senderIsAdmin = req.user.role === 'admin';

  let approvalStatus = 'approved';
  let approverId = null;

  if (!isSelf && !senderIsAdmin) {
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
    .prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus, approverId, docUrl, isRecurring, recurringDays)
              VALUES (?, ?, ?, ?, 'Not Started', ?, ?, ?, ?, ?, ?)`)
    .run(ownerId, safeName, safeDesc, dueDate || null, req.user.id, approvalStatus, approverId, safeDocUrl, recurringFlag, safeRecurDays);

  // Notifications
  if (!isSelf) {
    const taskName = safeName;
    if (approvalStatus === 'approved') {
      // Assigned directly (by an admin, or auto-approved) — tell the assignee.
      notify(owner.email, 'New task assigned to you',
        'You have a new task',
        `<b>${req.user.displayName}</b> assigned you a task: <b>${taskName}</b>.`);
      pushNotification(owner.id, `${req.user.displayName} assigned you a task: "${taskName}"`, 'tasks', 'task');
    } else if (approverId) {
      // Pending — tell the approver they have something to review.
      const approver = getUser(approverId);
      notify(approver && approver.email, 'A task needs your approval',
        'Task awaiting your approval',
        `<b>${req.user.displayName}</b> wants to assign <b>${owner.displayName}</b> the task <b>${taskName}</b>. Approve it in Pending Approvals.`);
      pushNotification(approverId, `${req.user.displayName} wants to assign ${owner.displayName} the task "${taskName}" — needs your approval`, 'approvals', 'approval');
    }
  }

  res.status(201).json({ task: taskWithNames(getTask(info.lastInsertRowid)) });
});

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

// Update status (owner, that user's manager, or admin).
app.patch('/api/tasks/:id', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canViewTasksOf(req.user, task.userId)) return res.status(403).json({ error: 'Not allowed' });

  const body = req.body || {};
  const { status, name, description, dueDate, docUrl } = body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Task name cannot be blank' });
  const isOwnSelfCreated = task.userId === req.user.id && task.assignedById === req.user.id;
  const canEditContent = req.user.role === 'admin' || req.user.role === 'manager' ||
    task.assignedById === req.user.id || isOwnSelfCreated;
  if (!canEditContent && (name !== undefined || description !== undefined || dueDate !== undefined || docUrl !== undefined)) {
    return res.status(403).json({ error: 'You can only update the status of assigned tasks' });
  }
  const hasDueDate = 'dueDate' in body ? 1 : 0;
  let safeDocUrl = null;
  if (docUrl !== undefined) {
    safeDocUrl = String(docUrl).trim().slice(0, 500);
    if (safeDocUrl && !/^https?:\/\//i.test(safeDocUrl)) safeDocUrl = '';
  }

  db.prepare(`UPDATE tasks SET
       status      = COALESCE(?, status),
       name        = COALESCE(?, name),
       description = COALESCE(?, description),
       dueDate     = CASE WHEN ? = 1 THEN ? ELSE dueDate END,
       docUrl      = COALESCE(?, docUrl)
     WHERE id = ?`)
    .run(status || null, name || null, description ?? null, hasDueDate, dueDate ?? null, safeDocUrl, task.id);

  // When a recurring task is marked complete, automatically spawn the next instance.
  const updatedTask = getTask(task.id);
  if (status === 'Complete' && updatedTask.isRecurring && updatedTask.recurringDays) {
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
    `${assigner ? '<b>' + assigner.displayName + '</b> assigned' : 'You were assigned'} the task <b>${task.name}</b> (approved by ${req.user.displayName}).`);
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
function canManageAttendance(user) {
  return user.role === 'admin' || user.role === 'manager';
}

app.get('/api/attendance', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const events = db.prepare(`SELECT ae.*, u.displayName AS createdByName,
    (SELECT COUNT(*) FROM attendance_records ar WHERE ar.eventId = ae.id AND ar.status = 'present') AS presentCount,
    (SELECT COUNT(*) FROM attendance_records ar WHERE ar.eventId = ae.id) AS markedCount
    FROM attendance_events ae LEFT JOIN users u ON u.id = ae.createdById
    ORDER BY ae.eventDate DESC`).all();
  res.json({ events });
});

app.post('/api/attendance', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { title, eventDate, location, notes } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  if (!eventDate || !String(eventDate).match(/^\d{4}-\d{2}-\d{2}$/)) return res.status(400).json({ error: 'Valid event date required (YYYY-MM-DD)' });
  const info = db.prepare(`INSERT INTO attendance_events (title, eventDate, location, notes, createdById) VALUES (?, ?, ?, ?, ?)`).run(
    String(title).trim().slice(0, 200), eventDate,
    String(location || '').trim().slice(0, 200), String(notes || '').trim().slice(0, 1000), req.user.id
  );
  res.status(201).json({ event: db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(info.lastInsertRowid) });
});

app.get('/api/attendance/:id', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const event = db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const allMembers = db.prepare("SELECT id, displayName, title, role FROM users WHERE username != 'logistics' ORDER BY displayName").all().map(publicUser);
  const records = db.prepare(`SELECT ar.*, u.displayName AS memberName FROM attendance_records ar JOIN users u ON u.id = ar.userId WHERE ar.eventId = ?`).all(event.id);
  const byUser = Object.fromEntries(records.map((r) => [r.userId, r]));
  res.json({ event, members: allMembers, records: byUser });
});

app.post('/api/attendance/:id/mark', (req, res) => {
  if (!canManageAttendance(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const event = db.prepare('SELECT * FROM attendance_events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { userId, status } = req.body || {};
  const ATTENDANCE_STATUSES = ['present', 'absent', 'excused'];
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const safeStatus = ATTENDANCE_STATUSES.includes(status) ? status : 'present';
  db.prepare(`INSERT INTO attendance_records (eventId, userId, status, markedById) VALUES (?, ?, ?, ?)
    ON CONFLICT(eventId, userId) DO UPDATE SET status = excluded.status, markedById = excluded.markedById, createdAt = datetime('now')`).run(event.id, Number(userId), safeStatus, req.user.id);
  res.json({ ok: true, status: safeStatus });
});

app.delete('/api/attendance/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  db.prepare('DELETE FROM attendance_events WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/attendance/:id/roll-call', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const event = db.prepare('SELECT id FROM attendance_events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: 'records array required' });
  const insert = db.prepare('INSERT OR REPLACE INTO attendance_records (eventId, userId, status, markedById) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const r of records) {
      const VALID_STATUSES = ['present', 'absent', 'excused'];
      if (!r.userId || !VALID_STATUSES.includes(r.status)) continue;
      insert.run(event.id, Number(r.userId), r.status, req.user.id);
    }
  });
  tx();
  res.json({ ok: true });
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

// ---- Role Descriptions ------------------------------------------------------
app.get('/api/role-descriptions', (req, res) => {
  const rows = db.prepare('SELECT * FROM role_descriptions ORDER BY positionTitle').all();
  res.json({ descriptions: rows });
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
  res.status(201).json({ user: publicUser(getUser(info.lastInsertRowid)), defaultPassword: username });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role, title, managerId, grade, email, canManageRoster, managedGrade, canAnnounce, canEditHome, bigBoard, canViewLogistics, canManageSocial, username, firstName, lastName } = req.body || {};
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
    username        = COALESCE(?, username),
    firstName       = COALESCE(?, firstName),
    lastName        = COALESCE(?, lastName),
    displayName     = COALESCE(?, displayName)
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
    newUsername,
    newFirst,
    newLast,
    newDisplayName,
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
    const reply = await chatWithAI(db, history, req.user.id);
    db.prepare(
      'INSERT INTO ai_chat_messages (sessionId, role, content, userId) VALUES (?, ?, ?, ?)'
    ).run(sid, 'assistant', reply, req.user.id);
    res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('[AI chat error]', err);
    res.status(500).json({ error: 'AI request failed' });
  }
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

// ---- Grade Pipeline ---------------------------------------------------------
app.get('/api/roster/grade-pipeline', (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  const gradeParam = req.query.grade;
  let grade;
  if (gradeParam) {
    grade = Number(gradeParam);
  } else if (req.user.managedGrade != null) {
    grade = req.user.managedGrade;
  } else if (!isManager) {
    return res.status(403).json({ error: 'No grade assigned' });
  }
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
  const users = db.prepare(`SELECT id, displayName, title, email, phone, photo
    FROM users ORDER BY displayName ASC`).all();
  res.json({ users });
});

// ---- Home feed / summary card -----------------------------------------------
app.get('/api/me/summary', (req, res) => {
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

  // Upcoming meetings (next 3)
  const upcomingMeetings = db.prepare(
    "SELECT id, title, meetingDate FROM meetings WHERE meetingDate >= ? ORDER BY meetingDate ASC LIMIT 3"
  ).all(today);

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
    return { ...ev, volunteersEnabled: !!ev.volunteersEnabled, roles: rolesWithCounts };
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
    SELECT vs.id, vs.name, vs.phone, vs.email, vs.grade, vs.status, vs.createdAt,
           vr.roleName, rm.firstName || ' ' || rm.lastName AS matchedName, rm.id AS rosterMatchId
    FROM volunteer_signups vs
    LEFT JOIN volunteer_roles vr ON vr.id = vs.roleId
    LEFT JOIN roster_members rm ON rm.id = vs.matchedRosterId
    WHERE vs.eventId = ?
    ORDER BY vs.createdAt ASC
  `).all(eventId);
  res.json({ signups });
});

app.delete('/api/volunteer-signups/:id', requireManagerOrAdmin, (req, res) => {
  db.prepare('DELETE FROM volunteer_signups WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Roster cross-reference: volunteer events this roster member signed up for.
app.get('/api/roster-members/:id/volunteer-history', requireManagerOrAdmin, (req, res) => {
  const rosterId = Number(req.params.id);
  const history = db.prepare(`
    SELECT vs.id, vs.name, vs.status, vs.createdAt, ve.title AS eventTitle, ve.startDate,
           vr.roleName
    FROM volunteer_signups vs
    JOIN volunteer_events ve ON ve.id = vs.eventId
    LEFT JOIN volunteer_roles vr ON vr.id = vs.roleId
    WHERE vs.matchedRosterId = ?
    ORDER BY vs.createdAt DESC
  `).all(rosterId);
  res.json({ history });
});

// ---- Static frontend --------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// The SPA handles client-side routes (/, /home, etc.).
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Catch-all error handler: turn a thrown route error into a 500 instead of
// letting it bubble up and crash the process.
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    if (seeded) console.log('Seeded database with default Club America accounts.');
    console.log(`Club America Management running at http://localhost:${PORT}`);
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
