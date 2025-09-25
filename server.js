// server.js (Render-ready)
const express = require('express');

const app = express();

// helpful: trust Render proxy and add a tiny ping route
app.set('trust proxy', 1);
app.get('/', (req, res) => res.type('text/plain').send('OK'));

// Reviews proxy (example; keep your exact upstream if it differs)
app.get('/api/reviews/:appid', async (req, res) => {
  const { appid } = req.params;
  try {
    const url = `https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=1&purchase_type=all`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('reviews proxy error', e);
    res.status(502).json({ error: 'reviews_proxy_failed' });
  }
});

// Achievements proxy (global percentages; no API key)
app.get('/api/achievements/:appid', async (req, res) => {
  const { appid } = req.params;
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('achievements proxy error', e);
    res.status(502).json({ error: 'achievements_proxy_failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API listening on', PORT);
});
