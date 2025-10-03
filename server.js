// server.js — Render (Node)
// Serves Steam proxies + Six Degrees API with CORS for your Bluehost site(s)

const express = require('express');
const cors = require('cors');

const app = express();

// ---- CORS: allow your production site(s) + local dev ----
// Put your Bluehost domains here, or set env ALLOWED_ORIGINS="https://example.com, https://www.example.com"
const DEV_ORIGINS = ['http://localhost:3000'];
const PROD_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://keyguessing.com, https://www.keyguessing.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...DEV_ORIGINS, ...PROD_ORIGINS];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET'],
}));

// Quick health endpoint so Render can mark service healthy fast
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Use Node 18+ global fetch if available; otherwise lazy-load node-fetch
const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/* ---------------- Steam Review Guessr proxies ---------------- */

app.get('/api/reviews/:appid', async (req, res) => {
  try {
    const { appid } = req.params;
    const qs = new URLSearchParams({
      json: '1',
      filter: 'funny',
      language: 'english',
      purchase_type: 'all',
      num_per_page: '100',
    }).toString();

    const url = `https://store.steampowered.com/appreviews/${appid}?${qs}`;
    const r = await fetchAny(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('Proxy /api/reviews error:', e);
    res.status(502).json({ error: 'proxy_failed' });
  }
});

app.get('/api/achievements/:appid', async (req, res) => {
  try {
    const { appid } = req.params;
    if (!/^\d+$/.test(String(appid))) return res.status(400).json({ error: 'bad_appid' });

    const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
    const r = await fetchAny(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('Proxy /api/achievements error:', e);
    res.status(502).json({ error: 'achievements_proxy_failed' });
  }
});

/* ---------------- Six Degrees API routes ---------------- */
const sixRoutes = require('./sixdegrees.routes'); // <- file you uploaded
app.use(sixRoutes);

// Global error guard (helps catch crashes that cause wake loops)
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Render API listening on port ${PORT}. Allowed origins:`, ALLOWED_ORIGINS);
});
