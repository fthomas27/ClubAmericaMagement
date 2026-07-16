// ---------------------------------------------------------------------------
// Social media engagement metrics
//
// Pulls likes / comments / shares / reposts / views / saves for a *published*
// post from the platform's OFFICIAL API and normalizes them into one shape.
// Scraping public pages is intentionally NOT done here — Instagram and X both
// block it, it breaks constantly, and it risks getting the chapter's accounts
// suspended. Instead we use each platform's documented API, which returns
// metrics for the accounts you own.
//
// Configuration (environment variables):
//   X_BEARER_TOKEN          – X/Twitter API v2 app bearer token
//   INSTAGRAM_ACCESS_TOKEN  – Instagram Graph API access token (long-lived)
//   INSTAGRAM_USER_ID       – IG Business/Creator account id (to resolve media)
//
// Everything degrades gracefully: if a token is missing we report the post as
// "not configured" rather than throwing, so the rest of the app keeps working.
// ---------------------------------------------------------------------------

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';
const INSTAGRAM_USER_ID = process.env.INSTAGRAM_USER_ID || '';

const IG_GRAPH = 'https://graph.facebook.com/v19.0';

// Which platforms currently have credentials configured. Surfaced to the UI so
// managers know what to expect before linking a post.
function integrationStatus() {
  return {
    x: !!X_BEARER_TOKEN,
    instagram: !!(INSTAGRAM_ACCESS_TOKEN && INSTAGRAM_USER_ID),
  };
}

// Map a caption/platform label or a URL to one of our canonical providers.
function providerForPlatform(platform) {
  if (!platform) return null;
  const p = String(platform).toLowerCase();
  if (p.includes('insta')) return 'instagram';
  if (p.includes('twitter') || p === 'x' || p.includes('/x')) return 'x';
  return null;
}

function detectProviderFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return null;
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('twitter.com') || u.includes('x.com') || u.includes('t.co')) return 'x';
  return null;
}

// Pull the tweet id out of a status URL, or accept a bare id.
function parseTweetId(url) {
  if (!url) return '';
  const m = String(url).match(/status(?:es)?\/(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(String(url).trim())) return String(url).trim();
  return '';
}

// Pull the shortcode out of an Instagram post/reel/tv URL.
function parseInstagramShortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
  if (!res.ok) {
    const msg = (body && (body.error?.message || body.title || body.detail)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---- X / Twitter -----------------------------------------------------------

async function fetchXMetrics(post) {
  if (!X_BEARER_TOKEN) throw new Error('X integration not configured (missing X_BEARER_TOKEN)');
  const id = post.externalId || parseTweetId(post.postUrl);
  if (!id) throw new Error('Could not find a tweet id in the linked URL');

  const url = `https://api.twitter.com/2/tweets/${id}?tweet.fields=public_metrics`;
  const body = await fetchJson(url, { headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` } });
  const m = (body && body.data && body.data.public_metrics) || {};
  return {
    externalId: id,
    metrics: {
      likes: num(m.like_count),
      comments: num(m.reply_count),
      reposts: num(m.retweet_count),
      shares: num(m.quote_count),      // quote tweets are the closest "share" signal
      views: num(m.impression_count),
      saves: num(m.bookmark_count),
    },
    raw: m,
  };
}

// ---- Instagram -------------------------------------------------------------

// The Graph API keys media by an opaque id, not the shortcode in the URL, so we
// resolve the id by walking the account's own media list and matching the
// permalink shortcode. The resolved id is cached back onto the post.
async function resolveInstagramMediaId(shortcode) {
  let url = `${IG_GRAPH}/${INSTAGRAM_USER_ID}/media?fields=id,permalink&limit=50&access_token=${encodeURIComponent(INSTAGRAM_ACCESS_TOKEN)}`;
  for (let page = 0; page < 10 && url; page++) {
    const body = await fetchJson(url);
    for (const item of body.data || []) {
      const sc = parseInstagramShortcode(item.permalink);
      if (sc && sc === shortcode) return item.id;
    }
    url = body.paging && body.paging.next ? body.paging.next : null;
  }
  return '';
}

async function fetchInstagramMetrics(post) {
  if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_USER_ID) {
    throw new Error('Instagram integration not configured (missing INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID)');
  }
  let mediaId = post.externalId;
  if (!mediaId) {
    const shortcode = parseInstagramShortcode(post.postUrl);
    if (!shortcode) throw new Error('Could not find an Instagram post id in the linked URL');
    mediaId = await resolveInstagramMediaId(shortcode);
    if (!mediaId) throw new Error('That post was not found on the connected Instagram account');
  }

  // Base counts always available on the media node.
  const base = await fetchJson(
    `${IG_GRAPH}/${mediaId}?fields=like_count,comments_count,media_type,media_product_type&access_token=${encodeURIComponent(INSTAGRAM_ACCESS_TOKEN)}`
  );

  const metrics = {
    likes: num(base.like_count),
    comments: num(base.comments_count),
    shares: null,
    reposts: null,   // Instagram has no repost concept
    views: null,
    saves: null,
  };

  // Insights (reach/saves/shares/plays) require extra permissions and vary by
  // media type, so treat any failure as "not available" rather than fatal.
  try {
    const isReel = (base.media_product_type || '').toUpperCase() === 'REELS'
      || (base.media_type || '').toUpperCase() === 'VIDEO';
    const wanted = isReel ? ['plays', 'saved', 'shares'] : ['reach', 'saved', 'shares'];
    const ins = await fetchJson(
      `${IG_GRAPH}/${mediaId}/insights?metric=${wanted.join(',')}&access_token=${encodeURIComponent(INSTAGRAM_ACCESS_TOKEN)}`
    );
    const byName = {};
    for (const row of ins.data || []) {
      byName[row.name] = row.values && row.values[0] ? num(row.values[0].value) : null;
    }
    metrics.views = byName.plays != null ? byName.plays : byName.reach;
    metrics.saves = byName.saved;
    metrics.shares = byName.shares;
  } catch (_) { /* insights unavailable — keep base counts only */ }

  return { externalId: mediaId, metrics, raw: base };
}

// ---- Dispatch --------------------------------------------------------------

// Returns { externalId, metrics, raw } or throws with a human-readable message.
async function fetchMetrics(post) {
  const provider = detectProviderFromUrl(post.postUrl) || providerForPlatform(post.platform);
  if (provider === 'x') return fetchXMetrics(post);
  if (provider === 'instagram') return fetchInstagramMetrics(post);
  throw new Error('Auto metrics are only supported for X and Instagram posts');
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  integrationStatus,
  detectProviderFromUrl,
  providerForPlatform,
  parseTweetId,
  parseInstagramShortcode,
  fetchMetrics,
};
