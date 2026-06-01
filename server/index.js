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
const { fetchUpcoming } = require('./calendar');
const { notify } = require('./email');
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
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
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
  const row = db.prepare('SELECT meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, aboutText, homeAnnouncement, homeAnnouncementEnabled, updatedAt FROM site_settings WHERE id = 1').get();
  return { ...row, podcastEnabled: !!row.podcastEnabled, homeAnnouncementEnabled: !!row.homeAnnouncementEnabled };
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
    .prepare('SELECT id, displayName, title, role, grade, managerId, bio, photo FROM users ORDER BY displayName')
    .all()
    .map((m) => ({ ...m, photo: m.photo || null }));
  res.json({ members });
});

// Public "Get Involved" submission (club-join or board application). No auth.
app.post('/api/submissions', (req, res) => {
  let { type, name, email, grade, message } = req.body || {};
  type = type === 'board' ? 'board' : 'club';
  name = String(name || '').trim().slice(0, 120);
  email = String(email || '').trim().slice(0, 200);
  grade = String(grade || '').trim().slice(0, 40);
  message = String(message || '').trim().slice(0, 2000);
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  db.prepare('INSERT INTO submissions (type, name, email, grade, message) VALUES (?, ?, ?, ?, ?)')
    .run(type, name, email, grade, message);

  // Notify the board members this submission is routed to:
  //  - club-join → that grade's grade reps + admins (President/VP)
  //  - board application → admins only
  let recipients;
  if (type === 'club' && grade) {
    recipients = db.prepare("SELECT email FROM users WHERE role = 'admin' OR grade = ?").all(grade);
  } else {
    recipients = db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  }
  const label = type === 'board' ? 'board application' : 'club-join request';
  for (const r of recipients) {
    notify(r.email, `New ${label}`,
      `New ${label}`,
      `<b>${name}</b>${grade ? ' (grade ' + grade + ')' : ''} submitted a ${label}.<br/>Email: ${email}${message ? '<br/>Message: ' + message : ''}<br/><br/>See it in the Get Involved inbox.`);
  }

  res.status(201).json({ ok: true });
});

// Public interest survey — no auth required.
app.post('/api/roster/survey', (req, res) => {
  const { firstName, lastName, phone, email, gender } = req.body || {};
  if (!firstName || !String(firstName).trim()) return res.status(400).json({ error: 'First name required' });
  const info = db.prepare(`INSERT INTO roster_members (firstName, lastName, phone, email, gender)
    VALUES (?, ?, ?, ?, ?)`).run(
    String(firstName).trim(), String(lastName || '').trim(),
    String(phone || '').trim(), String(email || '').trim(), String(gender || '').trim()
  );
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
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

// Homepage announcement — secretary, digital presence, VP, president.
app.put('/api/home/announcement', (req, res) => {
  if (!canPostAnnouncement(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const text = String((req.body || {}).text || '').trim();
  db.prepare(`UPDATE site_settings SET
    homeAnnouncement = ?,
    homeAnnouncementEnabled = ?,
    updatedAt = datetime('now')
  WHERE id = 1`).run(text, text ? 1 : 0);
  res.json({ home: getHome() });
});

// ---- Directory / org --------------------------------------------------------
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY displayName').all().map(publicUser);
  res.json({ users });
});

// People I Manage (direct reports). Admins manage everyone implicitly, but the
// sidebar list shows their explicit direct reports plus all users for admins.
app.get('/api/reports', (req, res) => {
  let reports;
  if (req.user.role === 'admin') {
    reports = db.prepare('SELECT * FROM users WHERE id != ? ORDER BY displayName').all(req.user.id);
  } else {
    reports = directReports(req.user.id);
  }
  res.json({ reports: reports.map(publicUser) });
});

app.get('/api/orgchart', (req, res) => {
  const users = db.prepare('SELECT * FROM users').all().map(publicUser);
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

app.post('/api/roster', (req, res) => {
  if (!canWriteRoster(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const { firstName, lastName, phone, email, grade, gender, roleDescription, status, notes } = req.body || {};
  if (!firstName) return res.status(400).json({ error: 'First name required' });
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
  // weekOf = Monday of the current week (ISO date).
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now); monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const weekOf = monday.toISOString().slice(0, 10);
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
  const weekOf = req.query.weekOf || (() => {
    const now = new Date(); const day = now.getDay();
    const monday = new Date(now); monday.setDate(now.getDate() - (day===0?6:day-1));
    return monday.toISOString().slice(0,10);
  })();
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
  if (!title) return res.status(400).json({ error: 'Title required' });
  const info = db.prepare(`INSERT INTO funding_requests (submittedById,title,description,amount)
    VALUES (?,?,?,?)`).run(req.user.id, String(title).trim(), String(description||'').trim(), Number(amount)||0);
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
  } else if (action === 'deny') {
    db.prepare(`UPDATE funding_requests SET status='denied', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?,reviewNotes) WHERE id=?`).run(req.user.id, reviewNotes??null, fr.id);
  } else if (action === 'purchased') {
    db.prepare(`UPDATE funding_requests SET status='purchased', purchasedById=?, purchasedAt=datetime('now') WHERE id=?`).run(req.user.id, fr.id);
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
  if (!positionTitle) return res.status(400).json({ error: 'Position title required' });
  const info = db.prepare(`INSERT INTO board_applications (userId,positionTitle,statement) VALUES (?,?,?)`).run(
    req.user.id, String(positionTitle).trim(), String(statement||'').trim()
  );
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
  res.json({ pendingFunding, pendingApps, recentCheckins, pendingTasks: pendingTasksNamed,
    counts: { funding: pendingFunding.length, apps: pendingApps.length, tasks: pendingTasksNamed.length } });
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
  const tasks = db
    .prepare('SELECT * FROM tasks WHERE userId = ? AND approvalStatus != ? ORDER BY createdAt DESC')
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
    // If the recipient has no manager, route approval to any admin (President).
    if (!approverId) {
      const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      approverId = admin ? admin.id : null;
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
      // Assigned directly (by an admin) — tell the assignee.
      notify(owner.email, 'New task assigned to you',
        'You have a new task',
        `<b>${req.user.displayName}</b> assigned you a task: <b>${taskName}</b>.`);
    } else if (approverId) {
      // Pending — tell the approver they have something to review.
      const approver = getUser(approverId);
      notify(approver && approver.email, 'A task needs your approval',
        'Task awaiting your approval',
        `<b>${req.user.displayName}</b> wants to assign <b>${owner.displayName}</b> the task <b>${taskName}</b>. Approve it in Pending Approvals.`);
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

  const { status, name, description, dueDate } = req.body || {};
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare(`UPDATE tasks SET
       status = COALESCE(?, status),
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       dueDate = COALESCE(?, dueDate)
     WHERE id = ?`)
    .run(status || null, name || null, description ?? null, dueDate ?? null, task.id);

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
  // Now that it's approved, the assignee should know about their new task.
  const owner = getUser(task.userId);
  const assigner = task.assignedById ? getUser(task.assignedById) : null;
  notify(owner && owner.email, 'New task assigned to you',
    'You have a new task',
    `${assigner ? '<b>' + assigner.displayName + '</b> assigned' : 'You were assigned'} the task <b>${task.name}</b> (approved by ${req.user.displayName}).`);
  res.json({ task: taskWithNames(getTask(task.id)) });
});

app.post('/api/tasks/:id/reject', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.approvalStatus !== 'pending') return res.status(400).json({ error: 'Task is not pending' });
  if (!canApprove(req.user, task)) return res.status(403).json({ error: 'Not allowed to reject' });
  db.prepare("UPDATE tasks SET approvalStatus = 'rejected' WHERE id = ?").run(task.id);
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
  const { role, title, managerId, grade, email, canManageRoster, managedGrade, canAnnounce, canEditHome } = req.body || {};
  const prevManager = user.managerId;

  const newRole = ROLES.includes(role) ? role : user.role;
  const newManagerId = managerId === undefined ? user.managerId : (managerId || null);
  if (newManagerId === user.id) return res.status(400).json({ error: 'A user cannot manage themselves' });

  // managedGrade is nullable, so handle it directly (COALESCE can't clear a value).
  const newManagedGrade = managedGrade === undefined ? user.managedGrade : (managedGrade || null);

  db.prepare(`UPDATE users SET
    role = ?,
    title = COALESCE(?, title),
    managerId = ?,
    grade = COALESCE(?, grade),
    email = COALESCE(?, email),
    canManageRoster = COALESCE(?, canManageRoster),
    managedGrade    = ?,
    canAnnounce     = COALESCE(?, canAnnounce),
    canEditHome     = COALESCE(?, canEditHome)
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
    user.id,
  );

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
app.listen(PORT, () => {
  if (seeded) console.log('Seeded database with default Club America accounts.');
  console.log(`Club America Management running at http://localhost:${PORT}`);
});
