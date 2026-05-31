const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'club-america-dev-secret-change-me';
const TOKEN_TTL = '12h';

// In production, a strong JWT_SECRET must be set or sessions can be forged.
if (!process.env.JWT_SECRET) {
  const msg = 'WARNING: JWT_SECRET is not set — using an insecure default. Set JWT_SECRET in your environment for production.';
  if (process.env.NODE_ENV === 'production') console.error('\x1b[31m%s\x1b[0m', msg);
  else console.warn(msg);
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Strip the password hash (and the heavy photo blob) before sending a user to
// the client. Photos are fetched only where needed (own profile, board page).
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, photo, ...rest } = u;
  return {
    ...rest,
    firstLogin: !!u.firstLogin,
    profileComplete: !!u.profileComplete,
    hasPhoto: !!photo,
  };
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Verify JWT, attach req.user (full row). 401 if invalid.
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Until a user changes their default password, block everything except
// /api/me and /api/auth/change-password.
function requirePasswordChanged(req, res, next) {
  if (req.user.firstLogin) {
    return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = {
  signToken,
  publicUser,
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  JWT_SECRET,
};
