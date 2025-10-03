// sixdegrees.routes.js — only "game" results + diversified "similar"
// deps: jsdom

const express = require('express');
const { JSDOM } = require('jsdom');

const router = express.Router();
const UA = 'SixDegreesSteam/1.3 (+stream)';

const fetchAny = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/* -------------------- caches -------------------- */
const cache = {
  tagHtml: new Map(),
  app: new Map(),        // appid -> details
  moreLike: new Map(),   // appid -> [ids]
};

/* -------------------- helpers -------------------- */
function uniq(arr) { return [...new Set(arr)]; }

function isGameDetails(d) {
  const t = (d?.type || '').toLowerCase();
  if (t && t !== 'game') return false;                     // DLC, demo, mod, soundtrack, app, video...
  const name = (d?.name || '').toLowerCase();
  if (/soundtrack|demo|beta/.test(name)) return false;
  // Some titles don’t mark type reliably; look at categories/genres
  const badCats = ['Downloadable Content', 'Demo'];
  const tags = [
    ...(d?.genres?.map(g => g.description) || []),
    ...(d?.categories?.map(c => c.description) || []),
  ];
  if (tags.some(t => badCats.includes(t))) return false;
  return true;
}

function normalizeTags(d) {
  const tags = [
    ...(d?.genres?.map(g => g.description) || []),
    ...(d?.categories?.map(c => c.description) || []),
  ].map(s => (s || '').toLowerCase());
  return uniq(tags);
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/* -------------------- app details -------------------- */
async function getAppDetails(appid) {
  if (cache.app.has(appid)) return cache.app.get(appid);
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
  const r = await fetchAny(url, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  const d = j?.[appid]?.data || {};
  if (!isGameDetails(d)) { // cache negative too to avoid refetch loops
    cache.app.set(appid, null);
    return null;
  }
  const year = parseInt((d.release_date?.date || '').match(/\b(\d{4})\b/)?.[1]) || undefined;
  const out = {
    appid,
    type: (d.type || '').toLowerCase(),
    name: d.name,
    header_image: d.header_image || d.capsule_image || d.capsule_imagev5 || '',
    year,
    tags: normalizeTags(d),
  };
  cache.app.set(appid, out);
  return out;
}

/* -------------------- more like this -------------------- */
async function moreLikeIds(appid, cap = 60) {
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

/* -------------------- tag page + fallbacks -------------------- */
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
    if (ids.length) return uniq(ids);
  }
  return [];
}

// Search JSON fallback
async function searchByTerm(term, count = 80) {
  const params = new URLSearchParams({
    term,
    count: String(count),
    start: '0',
    supportedlang: 'english',
    category1: '998',
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

// StoreSearch fallback
async function storeSearch(term, count = 80) {
  const params = new URLSearchParams({ term, l: 'english', cc: 'US' });
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

async function tagCandidates(tag, limit = 10) {
  // 1) try tag sections
  try {
    const html = await fetchTagHtml(tag);
    const dom = new JSDOM(html);
    const s1 = extractSection(dom, 'New & Trending').slice(0, 12);
    const s2 = extractSection(dom, 'Top Sellers').slice(0, 12);
    const s3 = extractSection(dom, 'Top Rated').slice(0, 12);
    let ids = uniq([...s1, ...s2, ...s3]);
    if (ids.length) {
      const games = (await Promise.all(ids.map(getAppDetails))).filter(Boolean);
      const clean = games.filter(g => (g.type || 'game') === 'game').slice(0, limit);
      if (clean.length >= limit) return clean;
      // fall through and top-up
      const have = new Set(clean.map(g => String(g.appid)));
      ids = ids.filter(id => !have.has(String(id)));
      const extra = (await Promise.all(ids.map(getAppDetails))).filter(Boolean);
      return uniq([...clean, ...extra]).slice(0, limit);
    }
  } catch {}

  // 2) search fallbacks
  try {
    const ids = await searchByTerm(tag, 120);
    const games = (await Promise.all(ids.map(getAppDetails))).filter(Boolean);
    const clean = games.filter(g => (g.type || 'game') === 'game').slice(0, limit);
    if (clean.length >= limit) return clean;
  } catch {}

  try {
    const ids = await storeSearch(tag, 120);
    const games = (await Promise.all(ids.map(getAppDetails))).filter(Boolean);
    const clean = games.filter(g => (g.type || 'game') === 'game').slice(0, limit);
    return clean;
  } catch {}

  return [];
}

/* -------------------- routes -------------------- */

// Tags list (unchanged)
const TAG_SLICES = [
  'Farming Sim','City Builder','Roguelike','Puzzle','Horror','Souls-like',
  'VR','Racing','Sports','Strategy','Platformer','Life Sim',
];

router.get('/api/six/slices', (req, res) => {
  res.json({ slices: TAG_SLICES });
});

// Tag -> games (ONLY games)
router.get('/api/six/tag', async (req, res) => {
  try {
    const { tag, limit = 10 } = req.query;
    if (!tag) return res.status(400).json({ error: 'missing_tag' });
    const games = await tagCandidates(tag, +limit || 10);
    res.json({ games });
  } catch (e) {
    console.error('TAG route error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Similar -> diversified games
 * Query params:
 *   ?exclude=123,456   (appid list to remove — e.g., the chain so far)
 *   ?limit=10
 *   ?max_overlap=0.85  (drop items with Jaccard >= max_overlap)
 *   ?prefer_diverse=1  (sort ascending by overlap; default 1)
 *   ?goal=YYYY         (if present in pool, NEVER filter it out; promote to front)
 */
router.get('/api/six/similar/:appid', async (req, res) => {
  try {
    const src = String(req.params.appid);
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit || '10', 10)));
    const preferDiverse = String(req.query.prefer_diverse || '1') !== '0';
    const maxOverlap = Math.min(0.99, Math.max(0.0, parseFloat(req.query.max_overlap || '0.85')));
    const goalId = req.query.goal ? String(req.query.goal) : null;

    const exclude = new Set(
      (req.query.exclude || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .concat(src) // always exclude the source itself
    );

    // source tags
    const srcDetails = await getAppDetails(src);
    const srcTagSet = new Set(srcDetails?.tags || []);

    // fetch a generous pool
    let ids = await moreLikeIds(src, 120);

    // resolve details & clean to "games" only
    let metas = (await Promise.all(ids.map(getAppDetails))).filter(Boolean);

    // Pull out goal meta if it exists in the pool (and do NOT exclude it)
    let goalMeta = null;
    if (goalId) {
      goalMeta = metas.find(m => String(m.appid) === goalId) || null;
    }

    // exclude everything else as requested
    metas = metas.filter(m => !exclude.has(String(m.appid)));

    // score by tag-diversity
    const scored = metas.map(m => {
      const set = new Set(m.tags || []);
      return { meta: m, overlap: jaccard(srcTagSet, set) };
    });

    // filter ultra-similar — BUT NEVER drop the goal if present
    let filtered = scored.filter(x => {
      if (goalMeta && String(x.meta.appid) === String(goalMeta.appid)) return true;
      return x.overlap < maxOverlap;
    });

    // sort for diversity (lower overlap first), keeping goal (if any) at the front later
    if (preferDiverse) {
      filtered.sort((a, b) => a.overlap - b.overlap);
    }

    // convert back to metas
    let pickFrom = filtered.map(x => x.meta);

    // If goal existed, move it to the very front (and dedup)
    if (goalMeta) {
      pickFrom = [goalMeta, ...pickFrom.filter(m => String(m.appid) !== String(goalMeta.appid))];
    }

    // Last-ditch fallback if filtering was too aggressive
    if (pickFrom.length < limit) {
      const pool = metas.map(x => x.meta || x); // original metas (already excluded)
      for (const m of pool) {
        if (!pickFrom.find(p => String(p.appid) === String(m.appid))) pickFrom.push(m);
        if (pickFrom.length >= limit) break;
      }
    }

    // Dedup by name as a last guard
    const seenNames = new Set();
    const out = [];
    for (const m of pickFrom) {
      const key = (m.name || '').toLowerCase().trim();
      if (!seenNames.has(key)) {
        seenNames.add(key);
        out.push(m);
      }
      if (out.length >= limit) break;
    }

    res.json({ games: out });
  } catch (e) {
    console.error('SIMILAR route error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
