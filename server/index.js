const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');

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
  const row = db.prepare('SELECT meetingDate, meetingTime, meetingLocation, podcastUrl, podcastEnabled, calendarUrl, instagramUrl, aboutText, updatedAt FROM site_settings WHERE id = 1').get();
  return { ...row, podcastEnabled: !!row.podcastEnabled };
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
  res.status(201).json({ ok: true });
});

// Everything past this point requires a changed password.
app.use('/api', authenticate, requirePasswordChanged);

// ---- Own profile (photo + intro bio) ----------------------------------------
app.get('/api/me/profile', (req, res) => {
  const row = db.prepare('SELECT photo, bio, profileComplete FROM users WHERE id = ?').get(req.user.id);
  res.json({ photo: row.photo || '', bio: row.bio || '', profileComplete: !!row.profileComplete });
});

app.put('/api/me/profile', (req, res) => {
  let { photo, bio } = req.body || {};
  photo = typeof photo === 'string' ? photo : '';
  bio = String(bio || '').trim().slice(0, 4000);
  if (photo && !/^data:image\/(png|jpe?g|webp);base64,/.test(photo)) {
    return res.status(400).json({ error: 'Photo must be an image' });
  }
  if (photo.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large' });
  db.prepare('UPDATE users SET photo = COALESCE(?, photo), bio = ?, profileComplete = 1 WHERE id = ?')
    .run(photo === undefined ? null : photo, bio, req.user.id);
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
  let { firstName, lastName, role, title, managerId, grade } = req.body || {};
  firstName = (firstName || '').trim();
  lastName = (lastName || '').trim();
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
    .prepare(`INSERT INTO users (username, firstName, lastName, displayName, passwordHash, role, title, managerId, grade, firstLogin)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(username, firstName, lastName, displayName, bcrypt.hashSync(username, 10), role, title || '', managerId || null, grade);

  if (managerId) refreshRole(Number(managerId));
  res.status(201).json({ user: publicUser(getUser(info.lastInsertRowid)), defaultPassword: username });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role, title, managerId, grade } = req.body || {};
  const prevManager = user.managerId;

  const newRole = ROLES.includes(role) ? role : user.role;
  const newManagerId = managerId === undefined ? user.managerId : (managerId || null);
  if (newManagerId === user.id) return res.status(400).json({ error: 'A user cannot manage themselves' });

  db.prepare('UPDATE users SET role = ?, title = COALESCE(?, title), managerId = ?, grade = COALESCE(?, grade) WHERE id = ?')
    .run(newRole, title ?? null, newManagerId, grade ?? null, user.id);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (seeded) console.log('Seeded database with default Club America accounts.');
  console.log(`Club America Management running at http://localhost:${PORT}`);
});
