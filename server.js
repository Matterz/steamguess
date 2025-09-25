// server.js — Render API: Steam reviews/achievements proxy with Akamai-friendly headers + cookies
const express = require('express');

const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.set('trust proxy', 1);

// Health
app.get('/', (req, res) => res.type('text/plain').send('OK'));

/* ---------------------------
   Helpers
--------------------------- */
function buildReviewUrl(appid, clientQuery) {
  const u = new URL(`https://store.steampowered.com/appreviews/${encodeURIComponent(appid)}`);
  // sensible defaults for gameplay
  u.searchParams.set('json', '1');
  if (!u.searchParams.has('filter'))        u.searchParams.set('filter', 'funny');
  if (!u.searchParams.has('language'))      u.searchParams.set('language', 'english');
  if (!u.searchParams.has('purchase_type')) u.searchParams.set('purchase_type', 'all');
  if (!u.searchParams.has('review_type'))   u.searchParams.set('review_type', 'all');
  if (!u.searchParams.has('num_per_page'))  u.searchParams.set('num_per_page', '100');
  if (!u.searchParams.has('cursor'))        u.searchParams.set('cursor', '*');

  // allow client overrides (e.g., ?language=all)
  for (const [k, v] of Object.entries(clientQuery || {})) {
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// Age/region cookies commonly used to bypass age walls & reduce denials (harmless)
function steamCookiesUS() {
  // steamCountry value format: CC|<unix_timestamp>|<sha> — a generic placeholder works fine for this use case
  const steamCountry = 'US%7C0000000000%7C00000000000000000000000000000000';
  return [
    'birthtime=0',
    'lastagecheckage=1-January-1970',
    'wants_mature_content=1',
    `steamCountry=${steamCountry}`,
  ].join('; ');
}

function steamHeaders(appid) {
  return {
    // strong, modern UA + standard headers
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'referer': `https://store.steampowered.com/app/${appid}/`,
    'origin': 'https://store.steampowered.com',
    'x-requested-with': 'XMLHttpRequest',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    // benign cookies to satisfy age/country gating
    'cookie': steamCookiesUS(),
  };
}

/* ---------------------------
   Routes
--------------------------- */

// Reviews proxy
app.get('/api/reviews/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').trim();
  if (!/^\d+$/.test(appid)) return res.status(400).json({ error: 'bad_appid' });

  const tryFetch = async (url) => {
    const r = await fetchAny(url, { headers: steamHeaders(appid), redirect: 'follow' });
    const text = await r.text(); // Steam often sends text/plain; just pass text through
    return { r, text };
  };

  try {
    let url = buildReviewUrl(appid, req.query);
    let { r, text } = await tryFetch(url);

    // If blocked or we got HTML, try one fallback with broader language
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const looksHtml = text.trim().startsWith('<');
    if ((!r.ok || looksHtml || !ct.includes('application/json')) && !req.query.language) {
      url = buildReviewUrl(appid, { ...req.query, language: 'all' });
      ({ r, text } = await tryFetch(url));
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('reviews proxy error:', e);
    res.status(502).json({ error: 'reviews_proxy_failed' });
  }
});

// Achievements proxy (kept for future hints)
app.get('/api/achievements/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').trim();
  if (!/^\d+$/.test(appid)) return res.status(400).json({ error: 'bad_appid' });

  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;

  try {
    const r = await fetchAny(url, { headers: steamHeaders(appid), redirect: 'follow' });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('achievements proxy error:', e);
    res.status(502).json({ error: 'achievements_proxy_failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API listening on', PORT));
