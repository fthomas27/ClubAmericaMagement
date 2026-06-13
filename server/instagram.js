// Instagram Graph API helper — pulls the media your Business/Creator account has
// been *tagged* in (the `/tags` edge), so the board can curate which tagged
// posts appear on the public homepage.
//
// Requires (stored in site_settings, set by an admin in the app):
//   • a long-lived access token for a Meta app with instagram_basic +
//     pages_read_engagement, and
//   • the IG Business account id (discoverable via /me/accounts).
//
// No external dependencies — uses the global fetch built into Node 18+.

const API_BASE = 'https://graph.facebook.com';
const API_VERSION = process.env.IG_API_VERSION || 'v21.0';
const TAG_FIELDS = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,username';

const cache = new Map(); // userId -> { at, media }
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function api(pathAndQuery) {
  return `${API_BASE}/${API_VERSION}/${pathAndQuery}`;
}

async function call(url) {
  const res = await fetch(url, { redirect: 'follow' });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok || (body && body.error)) {
    const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.igError = body && body.error;
    throw err;
  }
  return body;
}

// Media the account has been tagged in, newest first. Cached for 10 min; on a
// fetch error we fall back to the last good result so a blip doesn't wipe the UI.
async function fetchTaggedMedia({ token, userId }) {
  if (!token || !userId) return [];
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.media;
  try {
    const data = await call(api(`${encodeURIComponent(userId)}/tags?fields=${TAG_FIELDS}&limit=40&access_token=${encodeURIComponent(token)}`));
    const media = (data && data.data) || [];
    cache.set(userId, { at: now, media });
    return media;
  } catch (e) {
    if (hit) return hit.media;
    throw e;
  }
}

// List the Facebook Pages on this token and the IG Business account linked to
// each — so an admin can find the right IG user id without leaving the app.
async function discoverAccounts({ token }) {
  if (!token) return [];
  const data = await call(api(`me/accounts?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`));
  return ((data && data.data) || [])
    .filter((p) => p.instagram_business_account)
    .map((p) => ({
      pageName: p.name,
      igUserId: p.instagram_business_account.id,
      igUsername: p.instagram_business_account.username || '',
    }));
}

// Lightweight connection test — confirms the token + id can read the tags edge.
async function testConnection({ token, userId }) {
  await call(api(`${encodeURIComponent(userId)}/tags?fields=id&limit=1&access_token=${encodeURIComponent(token)}`));
  return true;
}

module.exports = {
  fetchTaggedMedia,
  discoverAccounts,
  testConnection,
  clearCache: (userId) => (userId ? cache.delete(userId) : cache.clear()),
};
