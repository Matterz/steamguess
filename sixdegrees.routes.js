// sixdegrees.routes.js — robust tag -> candidates with multi-tier fallbacks
// deps: jsdom

const express = require('express');
const { JSDOM } = require('jsdom');

const router = express.Router();
const UA = 'SixDegreesSteam/1.2 (+stream)';

// Use Node 18 global fetch if present; else lazy-load node-fetch
const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const cache = {
  tagHtml: new Map(),   // tag -> html
  app: new Map(),       // appid -> {appid,name,header_image,year,tags}
  moreLike: new Map(),  // appid -> [neighbor ids]
};

/* --------------------- App + Similar --------------------- */
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
  if (out.name) cache.app.set(appid, out);
  return out;
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

/* --------------------- Tag page (primary) --------------------- */
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

/* --------------------- Fallback A: Search JSON --------------------- */
/**
 * Steam search returns JSON with `results_html` (server-rendered snippets).
 * Adding headers like X-Requested-With makes it more reliable.
 */
async function searchByTerm(term, count = 80) {
  const params = new URLSearchParams({
    term,
    count: String(count),
    start: '0',
    supportedlang: 'english',
    category1: '998', // games only
    ndl: '1',
    json: '1',
    cc: 'US',
    l: 'english',
  });
  const url = `https://store.steampowered.com/search/results/?${params.toString()}`;
  const r = await fetchAny(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://store.steampowered.com/search/?term=${encodeURIComponent(term)}`
    }
  });
  const j = await r.json().catch(async () => {
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { results_html: '' }; }
  });
  const html = j.results_html || '';
  const dom = new JSDOM(`<div id="wrap">${html}</div>`);
  const cards = [...dom.window.document.querySelectorAll('#wrap a.search_result_row')];
  const ids = [];
  for (const a of cards) {
    const id = a.getAttribute('data-ds-appid') || a.href?.match(/\/app\/(\d+)/)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/* --------------------- Fallback B: StoreSearch API --------------------- */
/**
 * A simpler JSON API used by the store’s search box.
 * https://store.steampowered.com/api/storesearch/?term=roguelike&l=english&cc=US
 */
async function storeSearch(term, count = 80) {
  const params = new URLSearchParams({
    term,
    l: 'english',
    cc: 'US',
  });
  const url = `https://store.steampowered.com/api/storesearch/?${params.toString()}`;
  const r = await fetchAny(url, { headers: { 'User-Agent': UA } });
  const j = await r.json().catch(() => ({}));
  const items = Array.isArray(j?.items) ? j.items : [];
  const ids = [];
  for (const it of items) {
    const appid = String(it?.id || '').trim();
    if (appid && !ids.includes(appid)) ids.push(appid);
    if (ids.length >= count) break;
  }
  return ids;
}

/* --------------------- Tag -> Candidates --------------------- */
async function tagCandidates(tag, limit = 10) {
  // 1) Try tag page sections
  try {
    const html = await fetchTagHtml(tag);
    const dom = new JSDOM(html);
    const s1 = extractSection(dom, 'New & Trending').slice(0, 6);
    const s2 = extractSection(dom, 'Top Sellers').slice(0, 6);
    const s3 = extractSection(dom, 'Top Rated').slice(0, 6);
    let ids = [...new Set([...s1, ...s2, ...s3])];
    if (ids.length) {
      ids.sort(() => Math.random() - 0.5);
      const games = await Promise.all(ids.slice(0, Math.max(limit, 12)).map(getAppDetails));
      const clean = games.filter(g => g && g.name).slice(0, limit);
      if (clean.length) return clean;
    }
  } catch (e) {
    // continue to fallback
  }

  // 2) Fallback A: Search JSON
  try {
    let ids = await searchByTerm(tag, 80);
    ids = ids.slice(0, Math.max(limit, 12));
    const games = await Promise.all(ids.map(getAppDetails));
    const clean = games.filter(g => g && g.name).slice(0, limit);
    if (clean.length) return clean;
  } catch (e) {
    // continue to fallback
  }

  // 3) Fallback B: StoreSearch API
  try {
    let ids = await storeSearch(tag, 80);
    ids = ids.slice(0, Math.max(limit, 12));
    const games = await Promise.all(ids.map(getAppDetails));
    const clean = games.filter(g => g && g.name).slice(0, limit);
    if (clean.length) return clean;
  } catch (e) {
    // give up
  }

  return []; // no matches
}

/* --------------------- Slices & Routes --------------------- */
const TAG_SLICES = [
  'Farming Sim','City Builder','Roguelike','Puzzle','Horror','Souls-like',
  'VR','Racing','Sports','Strategy','Platformer','Life Sim',
];

router.get('/api/six/slices', (req, res) => {
  res.json({ slices: TAG_SLICES });
});

router.get('/api/six/tag', async (req, res) => {
  try {
    const { tag, limit = 10 } = req.query;
    if (!tag) return res.status(400).json({ error: 'missing_tag' });
    const games = await tagCandidates(tag, +limit);
    res.json({ games });
  } catch (e) {
    console.error('TAG route error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/six/similar/:appid', async (req, res) => {
  try {
    const ids = await moreLike(req.params.appid, 12);
    const games = await Promise.all(ids.slice(0, 10).map(getAppDetails));
    res.json({ games });
  } catch (e) {
    console.error('SIMILAR route error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
