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
const { notify } = require('./email');
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
app.set('trust proxy', 1); // behind Railway's proxy
app.use(cors());
app.use(express.json({ limit: '6mb' })); // profile photos travel as data URLs

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
  const day = d.getDay();           // 0 = Sun … 6 = Sat
  const offset = (5 - day + 7) % 7; // days until this week's Friday (0 if Friday)
  const friday = new Date(d);
  friday.setDate(d.getDate() + offset);
  return friday.toISOString().slice(0, 10);
}

// ---- simple in-memory rate limiter (per IP) ---------------------------------
const rateBuckets = new Map();
function rateLimit({ windowMs, max, name = '' }) {
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
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
    calendarEnabled: false, calendarUrl: '',
    formEnabled: false, formTitle: '', formFields: [],
    announcementEnabled: false, announcementText: '',
    bioEnabled: false, bioText: '',
  };
  let formFields = [];
  try { formFields = JSON.parse(row.formFields || '[]'); } catch (_) {}
  return {
    ...row,
    bannerEnabled: !!row.bannerEnabled,
    calendarEnabled: !!row.calendarEnabled,
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

app.post('/api/auth/change-password', authenticate, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  if (newPassword === req.user.username) {
    return res.status(400).json({ error: 'New password cannot be the same as your default (username)' });
  }
  const hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare('UPDATE users SET passwordHash = ?, firstLogin = 0 WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true, user: publicUser(getUser(req.user.id)) });
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
  res.json({ home: { ...publicHome, calendarConfigured: !!calendarUrl }, events });
});

// Public board roster for the "Meet the Board" page (no private info, no auth).
app.get('/api/board', (req, res) => {
  const members = db
    .prepare("SELECT id, displayName, title, role, grade, managerId, bio, photo FROM users ORDER BY displayName")
    .all()
    .map((m) => ({ ...m, photo: m.photo || null }));
  res.json({ members });
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
      `<b>${name}</b>${grade ? ' (grade ' + grade + ')' : ''} submitted a ${label}.<br/>Email: ${email}${message ? '<br/>Message: ' + message : ''}<br/><br/>See it in the Get Involved inbox.`);
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

// Everything past this point requires a changed password.
app.use('/api', authenticate, requirePasswordChanged);

// ---- Own profile (photo + intro bio) ----------------------------------------
app.get('/api/me/profile', (req, res) => {
  const row = db.prepare('SELECT photo, bio, email, profileComplete FROM users WHERE id = ?').get(req.user.id);
  res.json({ photo: row.photo || '', bio: row.bio || '', email: row.email || '', profileComplete: !!row.profileComplete });
});

app.put('/api/me/profile', (req, res) => {
  let { photo, bio, email } = req.body || {};
  photo = typeof photo === 'string' ? photo : '';
  bio = String(bio || '').trim().slice(0, 4000);
  email = String(email || '').trim().slice(0, 200);
  if (photo && !/^data:image\/(png|jpe?g|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: 'Photo must be an image' });
  }
  if (photo.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  db.prepare('UPDATE users SET photo = COALESCE(?, photo), bio = ?, email = ?, profileComplete = 1 WHERE id = ?')
    .run(photo === undefined ? null : photo, bio, email, req.user.id);
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

// The full settings (including the calendar URL) for authorized editors.
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
  const { meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, aboutText } = req.body || {};
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
  const home = getHome();
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
  const users = db.prepare("SELECT * FROM users ORDER BY displayName").all().map(publicUser);
  res.json({ users });
});

// People I Manage (direct reports). Admins manage everyone implicitly, but the
// sidebar list shows their explicit direct reports plus all users for admins.
app.get('/api/reports', (req, res) => {
  let reports;
  if (req.user.role === 'admin') {
    reports = db.prepare("SELECT * FROM users WHERE id != ? ORDER BY displayName").all(req.user.id);
  } else {
    reports = directReports(req.user.id);
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
  const { bannerEnabled, bannerTitle, bannerUrl, calendarEnabled, calendarUrl,
          formEnabled, formTitle, formFields, announcementEnabled, announcementText,
          bioEnabled, bioText } = req.body || {};
  db.prepare('INSERT OR IGNORE INTO user_page_settings (userId) VALUES (?)').run(targetId);
  db.prepare(`UPDATE user_page_settings SET
    bannerEnabled       = COALESCE(?, bannerEnabled),
    bannerTitle         = COALESCE(?, bannerTitle),
    bannerUrl           = COALESCE(?, bannerUrl),
    calendarEnabled     = COALESCE(?, calendarEnabled),
    calendarUrl         = COALESCE(?, calendarUrl),
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
    calendarEnabled !== undefined ? (calendarEnabled ? 1 : 0) : null,
    calendarUrl ?? null,
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

app.get('/api/users/:id/calendar', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!canViewTasksOf(req.user, targetId)) return res.status(403).json({ error: 'Not allowed' });
  const settings = getPageSettings(targetId);
  if (!settings.calendarEnabled || !settings.calendarUrl) return res.json({ events: [] });
  try {
    const events = await fetchUpcoming(settings.calendarUrl, 5);
    res.json({ events });
  } catch (_) {
    res.json({ events: [], error: 'Failed to fetch calendar events' });
  }
});

// ---- Team announcements (broadcast from manager/admin to all their reports) --
app.get('/api/team-announcement', (req, res) => {
  if (req.user.role === 'member') return res.status(403).json({ error: 'Not allowed' });
  const row = db.prepare('SELECT * FROM team_announcements WHERE authorId = ?').get(req.user.id);
  res.json({ announcement: row || null });
});

app.put('/api/team-announcement', (req, res) => {
  if (req.user.role === 'member') return res.status(403).json({ error: 'Not allowed' });
  const trimmed = String((req.body || {}).text || '').trim();
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
    String(firstName).trim(), String(lastName||'').trim(), String(phone||'').trim(),
    String(email||'').trim(), grade||null, String(gender||'').trim(),
    String(roleDescription||'').trim(), status||'Prospect', String(notes||'').trim()
  );
  res.status(201).json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/roster/:id', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const m = db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { firstName, lastName, phone, email, grade, gender, roleDescription, status, notes } = req.body || {};
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
    updatedAt=datetime('now') WHERE id=?`).run(
    firstName??null, lastName??null, phone??null, email??null, grade??null,
    gender??null, roleDescription??null, status??null, notes??null, m.id
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
  const { grade, roleDescription } = req.body || {};
  db.prepare(`UPDATE roster_members SET status='Onboarded', convertedAt=datetime('now'),
    grade=COALESCE(?,grade), roleDescription=COALESCE(?,roleDescription), updatedAt=datetime('now')
    WHERE id=?`).run(grade||null, roleDescription||null, Number(req.params.id));
  res.json({ member: db.prepare('SELECT * FROM roster_members WHERE id=?').get(Number(req.params.id)) });
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

app.post('/api/funding', (req, res) => {
  const { title, description, amount } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  const amt = Number(amount) || 0;
  if (amt < 0) return res.status(400).json({ error: 'Amount cannot be negative' });
  const info = db.prepare(`INSERT INTO funding_requests (submittedById,title,description,amount)
    VALUES (?,?,?,?)`).run(req.user.id, String(title).trim(), String(description||'').trim(), amt);

  // Notify the CFO + admins that a funding request is awaiting review.
  const reviewers = db.prepare("SELECT id, email FROM users WHERE role = 'admin' OR title = 'CFO'").all();
  for (const r of reviewers) {
    if (r.id === req.user.id) continue;
    notify(r.email, 'New funding request', 'Funding request awaiting review',
      `<b>${req.user.displayName}</b> requested funding: <b>${String(title).trim()}</b> ($${amt}).`);
    pushNotification(r.id, `${req.user.displayName} submitted a funding request: "${String(title).trim()}" ($${amt})`, 'funding', 'funding');
  }
  res.status(201).json({ request: db.prepare('SELECT * FROM funding_requests WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/funding/:id', (req, res) => {
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  const fr = db.prepare('SELECT * FROM funding_requests WHERE id=?').get(Number(req.params.id));
  if (!fr) return res.status(404).json({ error: 'Not found' });
  const { action, reviewNotes } = req.body || {};
  if (!isPrivileged) return res.status(403).json({ error: 'Not allowed' });
  if (action === 'approve') {
    db.prepare(`UPDATE funding_requests SET status='approved', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?,reviewNotes) WHERE id=?`).run(req.user.id, reviewNotes??null, fr.id);
    logApproval('funding', fr.id, 'approved', req.user, reviewNotes || fr.title);
    pushNotification(fr.submittedById, `Your funding request "${fr.title}" was approved by ${req.user.displayName}`, 'funding', 'funding');
  } else if (action === 'deny') {
    db.prepare(`UPDATE funding_requests SET status='denied', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?,reviewNotes) WHERE id=?`).run(req.user.id, reviewNotes??null, fr.id);
    logApproval('funding', fr.id, 'denied', req.user, reviewNotes || fr.title);
    pushNotification(fr.submittedById, `Your funding request "${fr.title}" was denied by ${req.user.displayName}`, 'funding', 'funding');
  } else if (action === 'purchased') {
    db.prepare(`UPDATE funding_requests SET status='purchased', purchasedById=?, purchasedAt=datetime('now') WHERE id=?`).run(req.user.id, fr.id);
    logApproval('funding', fr.id, 'purchased', req.user, fr.title);
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

app.post('/api/board-apps', (req, res) => {
  const { positionTitle, statement } = req.body || {};
  if (!positionTitle || !String(positionTitle).trim()) return res.status(400).json({ error: 'Position title required' });
  const info = db.prepare(`INSERT INTO board_applications (userId,positionTitle,statement) VALUES (?,?,?)`).run(
    req.user.id, String(positionTitle).trim(), String(statement||'').trim()
  );

  // Notify admins that a leadership application is awaiting review.
  const admins = db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    if (a.id === req.user.id) continue;
    notify(a.email, 'New board application', 'Board application awaiting review',
      `<b>${req.user.displayName}</b> applied for <b>${String(positionTitle).trim()}</b>.`);
    pushNotification(a.id, `${req.user.displayName} applied for "${String(positionTitle).trim()}"`, 'board-apps', 'board-app');
  }
  res.status(201).json({ application: db.prepare('SELECT * FROM board_applications WHERE id=?').get(info.lastInsertRowid) });
});

app.patch('/api/board-apps/:id', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Not allowed' });
  const ba = db.prepare('SELECT * FROM board_applications WHERE id=?').get(Number(req.params.id));
  if (!ba) return res.status(404).json({ error: 'Not found' });
  const { action } = req.body || {};
  if (action === 'accept' || action === 'decline') {
    const status = action === 'accept' ? 'accepted' : 'declined';
    db.prepare(`UPDATE board_applications SET status=?, reviewedById=?, reviewedAt=datetime('now') WHERE id=?`).run(status, req.user.id, ba.id);
    logApproval('board-app', ba.id, status, req.user, ba.positionTitle);
    pushNotification(ba.userId, `Your application for "${ba.positionTitle}" was ${status} by ${req.user.displayName}`, 'board-apps', 'board-app');
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
app.post('/api/tasks', (req, res) => {
  const { name, description, dueDate, targetUserId } = req.body || {};
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

  const info = db
    .prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus, approverId)
              VALUES (?, ?, ?, ?, 'Not Started', ?, ?, ?)`)
    .run(ownerId, String(name).trim(), description || '', dueDate || null, req.user.id, approvalStatus, approverId);

  // Notifications
  if (!isSelf) {
    const taskName = String(name).trim();
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
  const { status, name, description, dueDate } = body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const hasDueDate = 'dueDate' in body ? 1 : 0;

  db.prepare(`UPDATE tasks SET
       status = COALESCE(?, status),
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       dueDate = CASE WHEN ? = 1 THEN ? ELSE dueDate END
     WHERE id = ?`)
    .run(status || null, name || null, description ?? null, hasDueDate, dueDate ?? null, task.id);

  res.json({ task: taskWithNames(getTask(task.id)) });
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
  db.prepare("UPDATE tasks SET approvalStatus = 'approved' WHERE id = ?").run(task.id);
  logApproval('task', task.id, 'approved', req.user, task.name);
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
  db.prepare("UPDATE tasks SET approvalStatus = 'rejected' WHERE id = ?").run(task.id);
  logApproval('task', task.id, 'rejected', req.user, task.name);
  // Tell whoever proposed the assignment that it was turned down.
  if (task.assignedById && task.assignedById !== req.user.id) {
    pushNotification(task.assignedById, `${req.user.displayName} rejected the task "${task.name}" you proposed`, 'tasks', 'task');
  }
  res.json({ ok: true });
});

// ---- Admin Panel ------------------------------------------------------------
app.post('/api/admin/users', requireAdmin, (req, res) => {
  let { firstName, lastName, role, title, managerId, grade, email } = req.body || {};
  firstName = (firstName || '').trim();
  lastName = (lastName || '').trim();
  email = String(email || '').trim().slice(0, 200);
  if (!firstName) return res.status(400).json({ error: 'First name required' });
  role = ROLES.includes(role) ? role : 'member';
  grade = String(grade || '').trim().slice(0, 40);

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
  const { role, title, managerId, grade, email, canManageRoster, managedGrade, canAnnounce, canEditHome, bigBoard, canViewLogistics, username, firstName, lastName } = req.body || {};
  const prevManager = user.managerId;

  // Validate and normalize username if provided.
  let newUsername = null;
  if (username !== undefined) {
    newUsername = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(newUsername)) return res.status(400).json({ error: 'Username may only contain letters, numbers, dots, hyphens, and underscores' });
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, user.id);
    if (clash) return res.status(400).json({ error: 'That username is already taken' });
  }

  const newRole = ROLES.includes(role) ? role : user.role;
  const newManagerId = managerId === undefined ? user.managerId : (managerId || null);
  if (newManagerId === user.id) return res.status(400).json({ error: 'A user cannot manage themselves' });

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

  // Recompute manager flags for affected supervisors.
  if (prevManager) refreshRole(prevManager);
  if (newManagerId) refreshRole(newManagerId);
  res.json({ user: publicUser(getUser(user.id)) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = getUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  const formerManager = target.managerId;
  // Orphaned reports roll up to the removed user's manager.
  db.prepare('UPDATE users SET managerId = ? WHERE managerId = ?').run(formerManager, target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  if (formerManager) refreshRole(formerManager);
  res.json({ ok: true });
});

// Reset a user's password back to their username default (admin convenience).
app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
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
app.post('/api/ai/chat', requireAdmin, async (req, res) => {
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
app.post('/api/ai/analyze', requireAdmin, async (req, res) => {
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
