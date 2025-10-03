// server/sixdegrees.routes.js
// Dependencies: npm i jsdom
const express = require('express');
const { JSDOM } = require('jsdom');

const router = express.Router();
const UA = 'SixDegreesSteam/1.0 (+stream)';

// Use Node 18 global fetch if present; else lazy-load node-fetch
const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const cache = {
  tagHtml: new Map(),   // tag -> html
  app: new Map(),       // appid -> {appid,name,header_image,year,tags}
  moreLike: new Map(),  // appid -> [neighbor ids]
};

// --- helpers ---
async function getAppDetails(appid) {
  if (cache.app.has(appid)) return cache.app.get(appid);
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
  const r = await fetchAny(url, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  const d = j?.[appid]?.data || {};
  const year = parseInt((d.release_date?.date || '').match(/\b(\d{4})\b/)?.[1]) || undefined;
  const out = {
    appid,
    name: d.name,
    header_image: d.header_image || d.capsule_image || d.capsule_imagev5 || '',
    year,
    tags: (d.genres?.map(g => g.description) || [])
      .concat(d.categories?.map(c => c.description) || [])
      .slice(0, 10),
  };
  cache.app.set(appid, out);
  return out;
}

async function fetchTagHtml(tag) {
  const key = tag.toLowerCase();
  if (cache.tagHtml.has(key)) return cache.tagHtml.get(key);
  const url = `https://store.steampowered.com/tags/en/${encodeURIComponent(tag)}`;
  const r = await fetchAny(url, { headers: { 'User-Agent': UA } });
  const html = await r.text();
  cache.tagHtml.set(key, html);
  return html;
}

function extractSection(dom, title) {
  const doc = dom.window.document;
  const hs = [...doc.querySelectorAll('h2, h3')];
  const h = hs.find(el => el.textContent.trim().toLowerCase().includes(title.toLowerCase()));
  if (!h) return [];
  let wrap = h.nextElementSibling;
  for (let i = 0; i < 4 && wrap; i++, wrap = wrap.nextElementSibling) {
    const as = [...wrap.querySelectorAll('a[href*="/app/"]')];
    const ids = as.map(a => a.href.match(/\/app\/(\d+)/)?.[1]).filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  return [];
}

async function tagCandidates(tag, limit = 10) {
  const html = await fetchTagHtml(tag);
  const dom = new JSDOM(html);
  const s1 = extractSection(dom, 'New & Trending').slice(0, 4);
  const s2 = extractSection(dom, 'Top Sellers').slice(0, 3);
  const s3 = extractSection(dom, 'Top Rated').slice(0, 3);
  const mix = [...new Set([...s1, ...s2, ...s3])].sort(() => Math.random() - 0.5).slice(0, limit);
  const games = await Promise.all(mix.map(getAppDetails));
  return games.filter(g => g && g.name);
}

async function moreLike(appid, cap = 12) {
  if (cache.moreLike.has(appid)) return cache.moreLike.get(appid).slice(0, cap);
  const url = `https://store.steampowered.com/recommended/morelike/app/${appid}?l=english`;
  const r = await fetchAny(url, { headers: { 'User-Agent': UA } });
  const html = await r.text();
  const dom = new JSDOM(html);
  const cards = [...dom.window.document.querySelectorAll('.cluster_capsule, a[href*="/app/"]')];
  const ids = [];
  for (const el of cards) {
    const id = el.getAttribute('data-ds-appid') || el.href?.match(/\/app\/(\d+)/)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  cache.moreLike.set(appid, ids);
  return ids.slice(0, cap);
}

// 12 slices for the dual-marker wheel (adjust labels as you like)
const TAG_SLICES = [
  'Farming Sim','City Builder','Roguelike','Puzzle','Horror','Souls-like',
  'VR','Racing','Sports','Strategy','Platformer','Life Sim',
];

// --- routes ---
router.get('/api/six/slices', (req, res) => {
  res.json({ slices: TAG_SLICES });
});

router.get('/api/six/tag', async (req, res) => {
  try {
    const { tag, limit = 10 } = req.query;
    const games = await tagCandidates(tag, +limit);
    res.json({ games });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/six/similar/:appid', async (req, res) => {
  try {
    const ids = await moreLike(req.params.appid, 12);
    const games = await Promise.all(ids.slice(0, 10).map(getAppDetails));
    res.json({ games });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
