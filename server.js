// server.js — serve static files, Steam proxies, and Six Degrees routes
const express = require('express');
const path = require('path');

// Use Node 18+ global fetch if available; otherwise lazy-load node-fetch
const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const root = __dirname;

// --- Static files (everything in this folder) ---
app.use(express.static(root));

/* ---------------- Steam Review Guessr proxies ---------------- */

// Reviews (funny-sorted)
app.get('/api/reviews/:appid', async (req, res) => {
  const { appid } = req.params;
  const qs = new URLSearchParams({
    json: '1',
    filter: 'funny',
    language: 'english',
    purchase_type: 'all',
    num_per_page: '100',
  }).toString();

  const url = `https://store.steampowered.com/appreviews/${appid}?${qs}`;
  try {
    const r = await fetchAny(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text(); // pass-through
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(502).json({ error: 'proxy_failed' });
  }
});

// Global achievements (no API key)
app.get('/api/achievements/:appid', async (req, res) => {
  const { appid } = req.params;
  if (!/^\d+$/.test(String(appid))) return res.status(400).json({ error: 'bad_appid' });
  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
  try {
    const r = await fetchAny(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text(); // sometimes text/plain
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('Achievements proxy error:', e);
    res.status(502).json({ error: 'achievements_proxy_failed' });
  }
});

/* ---------------- Six Degrees routes ---------------- */
const sixRoutes = require('./sixdegrees.routes'); // <- same folder now
app.use(sixRoutes);

// Nice URL for the page
app.get('/sixdegrees', (req, res) => {
  res.sendFile(path.join(__dirname, 'sixdegrees.html')); // <- same folder
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => {
  console.log(`Serving at http://localhost:${PORT}`);
});
