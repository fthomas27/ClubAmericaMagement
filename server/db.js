const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'clubamerica.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT UNIQUE NOT NULL,
      firstName    TEXT NOT NULL,
      lastName     TEXT NOT NULL DEFAULT '',
      displayName  TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',  -- admin | manager | member
      title        TEXT NOT NULL DEFAULT '',
      managerId    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      firstLogin   INTEGER NOT NULL DEFAULT 1,
      createdAt    TEXT NOT NULL DEFAULT (datetime('now'))
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
  `);
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
  });
  tx();
  return true;
}

module.exports = { db, init, seed, SEED_USERS, displayNameFor };
