const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// Choose where the SQLite file lives, in priority order:
//  1. DB_PATH if explicitly set.
//  2. A Railway volume, if one is attached (RAILWAY_VOLUME_MOUNT_PATH is provided
//     automatically) — so just attaching a volume makes data persist.
//  3. The local file next to the code (fine for dev; ephemeral on most hosts).
const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'clubamerica.db')
    : path.join(__dirname, 'clubamerica.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT UNIQUE NOT NULL,
      firstName        TEXT NOT NULL,
      lastName         TEXT NOT NULL DEFAULT '',
      displayName      TEXT NOT NULL,
      passwordHash     TEXT NOT NULL,
      role             TEXT NOT NULL DEFAULT 'member',
      title            TEXT NOT NULL DEFAULT '',
      managerId        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      firstLogin       INTEGER NOT NULL DEFAULT 1,
      canEditHome      INTEGER NOT NULL DEFAULT 0,
      canAnnounce      INTEGER NOT NULL DEFAULT 0,
      canManageRoster  INTEGER NOT NULL DEFAULT 0,
      managedGrade     INTEGER,
      createdAt        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      userId         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      dueDate        TEXT,
      status         TEXT NOT NULL DEFAULT 'Not Started', -- Not Started | In Progress | Complete
      assignedById   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approvalStatus TEXT NOT NULL DEFAULT 'approved',    -- approved | pending | rejected
      approverId     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Single-row store for the public homepage content.
    CREATE TABLE IF NOT EXISTS site_settings (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      meetingDate             TEXT NOT NULL DEFAULT '',
      meetingTime             TEXT NOT NULL DEFAULT '',
      meetingLocation         TEXT NOT NULL DEFAULT '',
      podcastUrl              TEXT NOT NULL DEFAULT '',
      podcastEnabled          INTEGER NOT NULL DEFAULT 1,
      calendarUrl             TEXT NOT NULL DEFAULT '',
      homeAnnouncement        TEXT NOT NULL DEFAULT '',
      homeAnnouncementEnabled INTEGER NOT NULL DEFAULT 0,
      weeklyCheckinEnabled    INTEGER NOT NULL DEFAULT 0,
      updatedAt               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-user page feature flags configured by admins/managers.
    CREATE TABLE IF NOT EXISTS user_page_settings (
      userId              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bannerEnabled       INTEGER NOT NULL DEFAULT 0,
      bannerTitle         TEXT NOT NULL DEFAULT '',
      bannerUrl           TEXT NOT NULL DEFAULT '',
      calendarEnabled     INTEGER NOT NULL DEFAULT 0,
      calendarUrl         TEXT NOT NULL DEFAULT '',
      formEnabled         INTEGER NOT NULL DEFAULT 0,
      formTitle           TEXT NOT NULL DEFAULT '',
      formFields          TEXT NOT NULL DEFAULT '[]',
      announcementEnabled INTEGER NOT NULL DEFAULT 0,
      announcementText    TEXT NOT NULL DEFAULT '',
      bioEnabled          INTEGER NOT NULL DEFAULT 0,
      bioText             TEXT NOT NULL DEFAULT '',
      updatedAt           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One active broadcast announcement per manager/admin; shown to all their reports.
    CREATE TABLE IF NOT EXISTS team_announcements (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      authorId  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      text      TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Club roster: prospects through fully onboarded members (not app users).
    CREATE TABLE IF NOT EXISTS roster_members (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      firstName       TEXT NOT NULL,
      lastName        TEXT NOT NULL DEFAULT '',
      phone           TEXT NOT NULL DEFAULT '',
      email           TEXT NOT NULL DEFAULT '',
      grade           INTEGER,
      gender          TEXT NOT NULL DEFAULT '',
      roleDescription TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'Prospect',
      claimedByUserId INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes           TEXT NOT NULL DEFAULT '',
      convertedAt     TEXT,
      createdAt       TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Funding requests routed to CFO for review.
    CREATE TABLE IF NOT EXISTS funding_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      submittedById INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      amount        REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      reviewedById  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewedAt    TEXT,
      purchasedById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      purchasedAt   TEXT,
      reviewNotes   TEXT NOT NULL DEFAULT '',
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Weekly check-in submissions from board members.
    CREATE TABLE IF NOT EXISTS weekly_checkins (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      userId      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      weekOf      TEXT NOT NULL,
      submittedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Board / leadership position applications.
    CREATE TABLE IF NOT EXISTS board_applications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      userId        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      positionTitle TEXT NOT NULL,
      statement     TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending',
      reviewedById  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewedAt    TEXT,
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // User column migrations.
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes('canEditHome'))     db.exec("ALTER TABLE users ADD COLUMN canEditHome INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('canAnnounce')) {
    db.exec("ALTER TABLE users ADD COLUMN canAnnounce INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE users SET canAnnounce = 1 WHERE username IN ('campbell', 'dhays')").run();
  }
  if (!cols.includes('canManageRoster')) {
    db.exec("ALTER TABLE users ADD COLUMN canManageRoster INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE users SET canManageRoster = 1 WHERE title IN ('Secretary', 'Grade Rep')").run();
  }
  if (!cols.includes('managedGrade'))    db.exec("ALTER TABLE users ADD COLUMN managedGrade INTEGER");

  // site_settings column migrations.
  const siteCols = db.prepare("PRAGMA table_info(site_settings)").all().map((c) => c.name);
  if (!siteCols.includes('podcastEnabled'))          db.exec("ALTER TABLE site_settings ADD COLUMN podcastEnabled INTEGER NOT NULL DEFAULT 1");
  if (!siteCols.includes('calendarUrl'))              db.exec("ALTER TABLE site_settings ADD COLUMN calendarUrl TEXT NOT NULL DEFAULT ''");
  if (!siteCols.includes('homeAnnouncement'))         db.exec("ALTER TABLE site_settings ADD COLUMN homeAnnouncement TEXT NOT NULL DEFAULT ''");
  if (!siteCols.includes('homeAnnouncementEnabled'))  db.exec("ALTER TABLE site_settings ADD COLUMN homeAnnouncementEnabled INTEGER NOT NULL DEFAULT 0");
  if (!siteCols.includes('weeklyCheckinEnabled'))     db.exec("ALTER TABLE site_settings ADD COLUMN weeklyCheckinEnabled INTEGER NOT NULL DEFAULT 0");

  // user_page_settings column migrations.
  const upsCols = db.prepare("PRAGMA table_info(user_page_settings)").all().map((c) => c.name);
  if (!upsCols.includes('bioEnabled'))  db.exec("ALTER TABLE user_page_settings ADD COLUMN bioEnabled INTEGER NOT NULL DEFAULT 0");
  if (!upsCols.includes('bioText'))     db.exec("ALTER TABLE user_page_settings ADD COLUMN bioText TEXT NOT NULL DEFAULT ''");

  // Ensure the homepage row exists with friendly placeholder content.
  db.prepare(`INSERT OR IGNORE INTO site_settings (id, meetingDate, meetingTime, meetingLocation, podcastUrl)
              VALUES (1, 'To be announced', 'To be announced', 'To be announced', '')`).run();
}

// ---- Seed data ---------------------------------------------------------------
// managerUsername = the person they report to (used for task-approval routing).
const SEED_USERS = [
  { username: 'fthomas',     firstName: 'Finley',   lastName: 'Thomas',   role: 'admin',   title: 'President',                   manager: null },
  { username: 'deddy',       firstName: 'Derek',    lastName: 'Eddy',     role: 'admin',   title: 'Vice President',              manager: 'fthomas' },

  { username: 'mflachsmann', firstName: 'Max',      lastName: 'Flachsmann', role: 'manager', title: 'Chair Public Engagement',  manager: 'deddy' },
  { username: 'hfossey',     firstName: 'Hudson',   lastName: 'Fossey',   role: 'manager', title: 'CFO',                         manager: 'deddy' },
  { username: 'dhays',       firstName: 'Dane',     lastName: 'Hays',     role: 'manager', title: 'Digital Presence Manager',    manager: 'deddy' },

  { username: 'campbell',    firstName: 'Campbell', lastName: '',         role: 'member',  title: 'Secretary',                   manager: 'deddy' },
  { username: 'aperillo',    firstName: 'Andrew',   lastName: 'Perillo',  role: 'member',  title: 'Hospitality',                 manager: 'deddy' },
  { username: 'afox',        firstName: 'Audrey',   lastName: 'Fox',      role: 'member',  title: 'Swag Manager',                manager: 'deddy' },

  { username: 'lmoffat',     firstName: 'Ledger',   lastName: 'Moffat',   role: 'member',  title: 'Public Engagement',           manager: 'mflachsmann' },
  { username: 'whaladin',    firstName: 'Will',     lastName: 'Haladin',  role: 'member',  title: 'Fundraising & Volunteer',     manager: 'hfossey' },
  { username: 'jkindt',      firstName: 'Jacob',    lastName: 'Kindt',    role: 'member',  title: 'Content Editor',              manager: 'dhays' },
  { username: 'sgavin',      firstName: 'Sosie',    lastName: 'Gavin',    role: 'member',  title: 'Historian',                   manager: 'dhays' },
  { username: 'ssosie',      firstName: 'Sosie',    lastName: '',         role: 'member',  title: 'Historian',                   manager: 'dhays' },

  { username: 'dhuges',      firstName: 'Davis',    lastName: 'Hughes',   role: 'member',  title: 'Grade Rep',                   manager: 'deddy' },
  { username: 'lmcnalley',   firstName: 'Liam',     lastName: 'McNalley', role: 'member',  title: 'Grade Rep',                   manager: 'deddy' },
  { username: 'tsummers',    firstName: 'Thomas',   lastName: 'Summers',  role: 'member',  title: 'Grade Rep',                   manager: 'deddy' },
  { username: 'banderson',   firstName: 'Ben',      lastName: 'Anderson', role: 'member',  title: 'Grade Rep',                   manager: 'deddy' },
  { username: 'nneath',      firstName: 'Nola',     lastName: 'Neath',    role: 'member',  title: 'Grade Rep',                   manager: 'deddy' },
  { username: 'bhastings',   firstName: 'Ben',      lastName: 'Hastings', role: 'member',  title: 'Grade Rep',                   manager: 'deddy' },
];

function displayNameFor(u) {
  return u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName;
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;

  const insert = db.prepare(`
    INSERT INTO users (username, firstName, lastName, displayName, passwordHash, role, title, firstLogin)
    VALUES (@username, @firstName, @lastName, @displayName, @passwordHash, @role, @title, 1)
  `);

  const tx = db.transaction(() => {
    // First pass: insert everyone (default password === username).
    for (const u of SEED_USERS) {
      insert.run({
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        displayName: displayNameFor(u),
        passwordHash: bcrypt.hashSync(u.username, 10),
        role: u.role,
        title: u.title,
      });
    }
    // Second pass: wire up reporting relationships.
    const byUsername = {};
    for (const row of db.prepare('SELECT id, username FROM users').all()) {
      byUsername[row.username] = row.id;
    }
    const setManager = db.prepare('UPDATE users SET managerId = ? WHERE username = ?');
    for (const u of SEED_USERS) {
      if (u.manager) setManager.run(byUsername[u.manager], u.username);
    }
    db.prepare("UPDATE users SET canEditHome = 1 WHERE username IN ('fthomas', 'deddy', 'dhays')").run();
    db.prepare("UPDATE users SET canAnnounce = 1 WHERE username IN ('campbell', 'dhays')").run();
    db.prepare("UPDATE users SET canManageRoster = 1 WHERE title IN ('Secretary', 'Grade Rep')").run();
  });
  tx();
  return true;
}

module.exports = { db, init, seed, SEED_USERS, displayNameFor };
