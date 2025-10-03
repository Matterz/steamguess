// server.js — Render side (Node)
// Serves Steam proxies + Six Degrees API with CORS for your Bluehost domain(s)

const express = require('express');
const path = require('path');
const cors = require('cors');

// Use Node 18+ global fetch if available; otherwise lazy-load node-fetch
const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const root = __dirname;

/* ------------ CORS: allow your Bluehost site ------------- */
// Set these to your actual site(s); you can use an env var on Render.
const ALLOWED_ORIGINS = [
  'https://yourdomain.com',
  'https://www.yourdomain.com',
];
app.use(cors({
  origin: (origin, cb) => {
    // allow no-origin (curl, server-to-server) and whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET'],
}));
/* --------------------------------------------------------- */

// Serve any local assets you might keep on Render (optional)
app.use(express.static(root));

/* ---------------- Steam Review Guessr proxies ---------------- */

app.get('/api/reviews/:appid', async (req, res) => {
  const { appid } = req.params;
  const qs = new URLSearchParams({
    json: '1', filter: 'funny', language: 'english',
    purchase_type: 'all', num_per_page: '100',
  }).toString();
  const url = `https://store.steampowered.com/appreviews/${appid}?${qs}`;
  try {
    const r = await fetchAny(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(502).json({ error: 'proxy_failed' });
  }
});

app.get('/api/achievements/:appid', async (req, res) => {
  const { appid } = req.params;
  if (!/^\d+$/.test(String(appid))) return res.status(400).json({ error: 'bad_appid' });
  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
  try {
    const r = await fetchAny(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('Achievements proxy error:', e);
    res.status(502).json({ error: 'achievements_proxy_failed' });
  }
});

/* ---------------- Six Degrees API routes ---------------- */
const sixRoutes = require('./sixdegrees.routes'); // this file lives on Render next to server.js
app.use(sixRoutes);

// You DO NOT need a page route here; the page is hosted on Bluehost.

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => {
  console.log(`Render API listening on http://localhost:${PORT}`);
});
