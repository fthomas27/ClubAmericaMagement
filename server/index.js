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
app.use(cors());
app.use(express.json());

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
  };
  let formFields = [];
  try { formFields = JSON.parse(row.formFields || '[]'); } catch (_) {}
  return {
    ...row,
    bannerEnabled: !!row.bannerEnabled,
    calendarEnabled: !!row.calendarEnabled,
    formEnabled: !!row.formEnabled,
    announcementEnabled: !!row.announcementEnabled,
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
  const row = db.prepare('SELECT meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, homeAnnouncement, homeAnnouncementEnabled, updatedAt FROM site_settings WHERE id = 1').get();
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

// Everything past this point requires a changed password.
app.use('/api', authenticate, requirePasswordChanged);

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
  const { meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl } = req.body || {};
  const podcastEnabledVal = podcastEnabled === undefined ? null : (podcastEnabled ? 1 : 0);
  db.prepare(`UPDATE site_settings SET
       meetingDate = COALESCE(?, meetingDate),
       meetingTime = COALESCE(?, meetingTime),
       meetingLocation = COALESCE(?, meetingLocation),
       podcastUrl = COALESCE(?, podcastUrl),
       podcastEnabled = COALESCE(?, podcastEnabled),
       calendarUrl = COALESCE(?, calendarUrl),
       updatedAt = datetime('now')
     WHERE id = 1`)
    .run(
      meetingDate ?? null,
      meetingTime ?? null,
      meetingLocation ?? null,
      podcastUrl ?? null,
      podcastEnabledVal,
      calendarUrl ?? null,
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
          formEnabled, formTitle, formFields, announcementEnabled, announcementText } = req.body || {};
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
  let { firstName, lastName, role, title, managerId } = req.body || {};
  firstName = (firstName || '').trim();
  lastName = (lastName || '').trim();
  if (!firstName) return res.status(400).json({ error: 'First name required' });
  role = ROLES.includes(role) ? role : 'member';

  const base = ((firstName[0] || '') + lastName).toLowerCase().replace(/[^a-z0-9]/g, '');
  let username = base || 'member';
  let n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    username = base + (++n);
  }
  const displayName = lastName ? `${firstName} ${lastName}` : firstName;
  const info = db
    .prepare(`INSERT INTO users (username, firstName, lastName, displayName, passwordHash, role, title, managerId, firstLogin)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(username, firstName, lastName, displayName, bcrypt.hashSync(username, 10), role, title || '', managerId || null);

  if (managerId) refreshRole(Number(managerId));
  res.status(201).json({ user: publicUser(getUser(info.lastInsertRowid)), defaultPassword: username });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role, title, managerId } = req.body || {};
  const prevManager = user.managerId;

  const newRole = ROLES.includes(role) ? role : user.role;
  const newManagerId = managerId === undefined ? user.managerId : (managerId || null);
  if (newManagerId === user.id) return res.status(400).json({ error: 'A user cannot manage themselves' });

  db.prepare('UPDATE users SET role = ?, title = COALESCE(?, title), managerId = ? WHERE id = ?')
    .run(newRole, title ?? null, newManagerId, user.id);

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
