// Build public/graph.json from the Are.na channel + Wikipedia.
//
//   node scripts/build.mjs
//
// Wikipedia responses are cached under cache/; Are.na is always fetched fresh.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from 'd3-force';
import * as d3_3d from 'd3-force-3d';
import { ROOT, fetchWithRetry, cached, pool, chunk, normTitle, titleFromUrl, wikiPath } from './lib.mjs';

const CHANNEL = 'wiki-f5ptsfqepas';
const WIKI = 'https://en.wikipedia.org';
const API = `${WIKI}/w/api.php`;

// Tuning knobs.
const BACKLINK_CAP = 3000; // pages that link to a saved page, per saved page
const VERIFY_MULTI = 700; // candidates touching ≥2 saved pages to verify
const VERIFY_SINGLE = 6; // candidates per saved page touching only it
const KEEP_BRIDGES = 400; // final level-1 nodes
const KEEP_SINGLE = 5; // final level-2 nodes per saved page

// Sections whose links say little about the topic.
const DROP_SECTIONS = /^(references|notes|citations|sources|bibliography|external links|further reading|footnotes|works cited)$/i;
const DROP_SELECTORS = [
  '.navbox', '.navbox-styles', '.vertical-navbox', '.sidebar', '.reflist', '.references',
  '.mw-references-wrap', '.refbegin', '.hatnote', '.metadata', '.ambox', '.sistersitebox',
  '.portalbox', '.noprint', '[role="navigation"]', '.authority-control', '.shortdescription',
].join(',');

const log = (...a) => console.log(...a);

// ---------- Are.na ----------

async function fetchChannel(slug) {
  const blocks = [];
  let info;
  for (let page = 1; ; page++) {
    const data = await fetchWithRetry(`https://api.are.na/v2/channels/${slug}/contents?per=100&page=${page}`);
    if (!info) info = await fetchWithRetry(`https://api.are.na/v2/channels/${slug}?per=1`);
    blocks.push(...data.contents);
    if (data.contents.length < 100) break;
  }
  return { info, blocks };
}

// ---------- Wikipedia: titles ----------

// raw title -> canonical title (null if missing or a disambiguation page). Persisted.
const titleMapFile = path.join(ROOT, 'cache', 'titles.json');
let titleMap = {};

async function resolveTitles(titles) {
  const todo = [...new Set(titles)].filter((t) => !(t in titleMap));
  await pool(chunk(todo, 50), 4, async (batch) => {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', redirects: '1',
      prop: 'pageprops', ppprop: 'disambiguation', titles: batch.join('|'),
    });
    const data = await fetchWithRetry(`${API}?${params}`);
    const q = data.query || {};
    const step = new Map(batch.map((t) => [t, t]));
    for (const n of q.normalized || []) for (const [k, v] of step) if (v === n.from) step.set(k, n.to);
    const redirects = new Map((q.redirects || []).map((r) => [r.from, r.to]));
    const pages = new Map((q.pages || []).map((p) => [p.title, p]));
    for (const [raw, norm] of step) {
      const target = redirects.get(norm) || norm;
      const p = pages.get(target);
      titleMap[raw] = !p || p.missing || p.invalid || p.ns !== 0 || p.pageprops?.disambiguation !== undefined ? null : p.title;
    }
  }, 'resolve titles');
  await fs.mkdir(path.dirname(titleMapFile), { recursive: true });
  await fs.writeFile(titleMapFile, JSON.stringify(titleMap));
  return (t) => titleMap[t] ?? null;
}

// ---------- Wikipedia: links ----------

// Links in the article body, in reading order, with navboxes/references stripped.
function bodyLinks(html, self) {
  const $ = cheerio.load(html);
  $('section').each((_, s) => {
    const h = $(s).children('h2').first().text().trim();
    if (DROP_SECTIONS.test(h)) $(s).remove();
  });
  $(DROP_SELECTORS).remove();
  const seen = new Set();
  const out = [];
  $('a[rel="mw:WikiLink"]').each((_, a) => {
    if ($(a).hasClass('new')) return;
    let href = $(a).attr('href') || '';
    if (!href.startsWith('./')) return;
    href = href.slice(2).split('#')[0].split('?')[0];
    let t;
    try {
      t = normTitle(decodeURIComponent(href));
    } catch {
      return;
    }
    if (!t || t === self || /^[A-Za-z ]+:/.test(t) && /^(File|Image|Category|Help|Special|Wikipedia|Template|Portal|Talk|User|Draft|Module|MediaWiki|Media|TimedText|Book|Template talk|Category talk|User talk|Wikipedia talk):/i.test(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  });
  return out;
}

const getBodyLinks = (title) =>
  cached('body-links', title, async () => {
    const html = await fetchWithRetry(`${WIKI}/w/rest.php/v1/page/${wikiPath(title)}/html`, { type: 'text' });
    return html ? bodyLinks(html, title) : [];
  });

const getBacklinks = (title) =>
  cached('backlinks', `${title}|${BACKLINK_CAP}`, async () => {
    const out = new Set();
    let cont = {};
    while (out.size < BACKLINK_CAP) {
      const params = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', list: 'backlinks', bltitle: title,
        blnamespace: '0', blfilterredir: 'nonredirects', bllimit: 'max', blredirect: '1', ...cont,
      });
      const data = await fetchWithRetry(`${API}?${params}`);
      for (const b of data.query?.backlinks || []) {
        if (!b.redirect) out.add(b.title);
        for (const r of b.redirlinks || []) out.add(r.title);
      }
      if (!data.continue) break;
      cont = data.continue;
    }
    return [...out];
  });

// alias (redirect title) -> canonical, for every title in `titles`.
async function redirectAliases(titles) {
  const alias = new Map(titles.map((t) => [t, t]));
  const results = await pool(chunk(titles, 50), 4, (batch) =>
    cached('redirects', batch.join('|'), async () => {
      const pairs = [];
      let cont = {};
      for (;;) {
        const params = new URLSearchParams({
          action: 'query', format: 'json', formatversion: '2', prop: 'redirects',
          rdnamespace: '0', rdlimit: 'max', rdprop: 'title', titles: batch.join('|'), ...cont,
        });
        const data = await fetchWithRetry(`${API}?${params}`);
        for (const p of data.query?.pages || []) for (const r of p.redirects || []) pairs.push([r.title, p.title]);
        if (!data.continue) break;
        cont = data.continue;
      }
      return pairs;
    }), 'redirect aliases');
  for (const pairs of results) for (const [from, to] of pairs) alias.set(from, to);
  return alias;
}

// ---------- Wikipedia: page metadata ----------

async function pageMeta(titles) {
  const meta = new Map();
  const results = await pool(chunk(titles, 20), 4, (batch) =>
    cached('meta', batch.join('|'), async () => {
      const params = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', redirects: '1',
        prop: 'pageimages|description|extracts', piprop: 'thumbnail', pithumbsize: '320', pilimit: '50',
        exintro: '1', explaintext: '1', exsentences: '3', exlimit: '20', titles: batch.join('|'),
      });
      const data = await fetchWithRetry(`${API}?${params}`);
      return (data.query?.pages || []).map((p) => ({
        title: p.title,
        desc: p.description || '',
        extract: p.extract || '',
        thumb: p.thumbnail ? { src: p.thumbnail.source, w: p.thumbnail.width, h: p.thumbnail.height } : null,
      }));
    }), 'page metadata');
  for (const list of results) for (const m of list) meta.set(m.title, m);
  return meta;
}

// Some articles have no lead image set ("page image"), though they do contain pictures.
// Fall back to the first real content image, skipping icons and maintenance boxes.
const DECOR = '.navbox, .sidebar, .ambox, .metadata, .hatnote, .mbox-image, .noprint, .sistersitebox, .portalbox, [role="navigation"]';
const getArticleImage = (title) =>
  cached('article-image', title, async () => {
    const html = await fetchWithRetry(`${WIKI}/w/rest.php/v1/page/${wikiPath(title)}/html`, { type: 'text' });
    if (!html) return null;
    const $ = cheerio.load(html);
    for (const el of $('img').toArray()) {
      const img = $(el);
      const w = Number(img.attr('width')), h = Number(img.attr('height'));
      if (!(w >= 100 && h >= 80) || img.closest(DECOR).length) continue;
      let src = (img.attr('src') || '').split('?')[0];
      if (src.startsWith('//')) src = `https:${src}`;
      if (src) return { src, w, h };
    }
    return null;
  });

// Next fallback: the lead image of the same article in another language's Wikipedia.
const OTHER_LANGS = ['de', 'fr', 'es', 'it', 'ja', 'ru', 'pt', 'zh', 'nl', 'pl'];
const getOtherLanguageImage = (title) =>
  cached('other-language-image', title, async () => {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', prop: 'langlinks', lllimit: 'max', titles: title,
    });
    const data = await fetchWithRetry(`${API}?${params}`);
    const links = new Map((data.query?.pages?.[0]?.langlinks || []).map((l) => [l.lang, l.title]));
    for (const lang of OTHER_LANGS) {
      if (!links.has(lang)) continue;
      const q = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', prop: 'pageimages',
        piprop: 'thumbnail', pithumbsize: '320', titles: links.get(lang),
      });
      const r = await fetchWithRetry(`https://${lang}.wikipedia.org/w/api.php?${q}`);
      const t = r?.query?.pages?.[0]?.thumbnail;
      if (t) return { src: t.source, w: t.width, h: t.height, lang };
    }
    return null;
  });

// ---------- layout ----------

function layout2d(nodes, links) {
  const ns = nodes.map((n) => ({ id: n.i, saved: n.saved }));
  const ls = links.map((l) => ({ source: l.a, target: l.b, w: l.w }));
  const sim = forceSimulation(ns)
    .force('link', forceLink(ls).id((d) => d.id).distance((l) => 30 / Math.sqrt(l.w)).strength((l) => Math.min(1, 0.08 * l.w)))
    .force('charge', forceManyBody().strength((d) => (d.saved ? -160 : -35)).distanceMax(600))
    .force('collide', forceCollide((d) => (d.saved ? 14 : 6)))
    .force('x', forceX(0).strength(0.02))
    .force('y', forceY(0).strength(0.02))
    .force('center', forceCenter(0, 0))
    .stop();
  for (let i = 0; i < 500; i++) sim.tick();

  // Centre on the saved pages and rotate their main axis horizontal (screens are wide).
  const sv = ns.filter((d) => d.saved);
  const mx = sv.reduce((s, d) => s + d.x, 0) / sv.length, my = sv.reduce((s, d) => s + d.y, 0) / sv.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const d of sv) { sxx += (d.x - mx) ** 2; syy += (d.y - my) ** 2; sxy += (d.x - mx) * (d.y - my); }
  const th = -0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(th), s = Math.sin(th);
  for (const d of ns) {
    const x = d.x - mx, y = d.y - my;
    d.x = x * c - y * s; d.y = x * s + y * c;
    d.vx = d.vy = 0;
  }

  // Scale so most saved pages fit a 1.6:1 box, ignoring a few outliers.
  const pct = (arr, q) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * q)];
  const scale = Math.min(1.5 / pct(sv.map((d) => Math.abs(d.x)), 0.95), 0.9 / pct(sv.map((d) => Math.abs(d.y)), 0.95));

  // Settle again with saved-page labels as solid rectangles so they don't overlap at the
  // default zoom. 1 layout unit ≈ 330px or more on screen (FlatView.unit); a 14px serif
  // character ≈ 7px wide.
  const pxPerSim = scale * 330;
  const boxes = sv.map((d) => ({ d, hw: (nodes[d.id].title.length * 7.2 + 10) / 2 / pxPerSim, hh: 13 / pxPerSim }));
  const EPS = 0.5 / pxPerSim; // half a pixel
  const overlapping = () => {
    let count = 0;
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a], B = boxes[b];
        if (A.hw + B.hw - Math.abs(A.d.x - B.d.x) > EPS && A.hh + B.hh - Math.abs(A.d.y - B.d.y) > EPS) count++;
      }
    return count;
  };
  // Moves positions directly (Gauss–Seidel), resolving each pair along the axis of least
  // overlap relative to label size, so crowds spread sideways as well as up and down.
  const rectCollide = () => {
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a], B = boxes[b];
        const dx = B.d.x - A.d.x, dy = B.d.y - A.d.y;
        const ox = A.hw + B.hw - Math.abs(dx), oy = A.hh + B.hh - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        if (oy / (A.hh + B.hh) < ox / (A.hw + B.hw)) {
          const m = (Math.sign(dy) || 1) * (oy * 0.5 + EPS);
          A.d.y -= m; B.d.y += m;
        } else {
          const m = (Math.sign(dx) || 1) * (ox * 0.5 + EPS);
          A.d.x -= m; B.d.x += m;
        }
      }
  };
  sim.force('rect', rectCollide).force('center', null).alpha(0.3);
  for (let i = 0; i < 400; i++) sim.tick();
  for (let i = 0; i < 4000 && overlapping(); i++) rectCollide();
  const left = overlapping();
  if (left) log(`  ${left} saved labels still overlap`);

  return ns.map((d) => [+(d.x * scale).toFixed(4), +(d.y * scale).toFixed(4)]);
}

// Force layout in 3D with every node pinned back onto a sphere after each tick. Only saved
// pages are laid out, so they cover the whole globe; each connecting page then sits at the
// mean position of the saved pages it links to.
function layoutSphere(nodes, links, edges) {
  const R = 100;
  const saved = nodes.filter((n) => n.saved);
  const ns = saved.map((n, k) => {
    // Fibonacci sphere start so nothing begins stacked.
    const y = 1 - (2 * (k + 0.5)) / saved.length;
    const r = Math.sqrt(1 - y * y);
    const th = k * Math.PI * (3 - Math.sqrt(5));
    return { id: n.i, x: R * r * Math.cos(th), y: R * y, z: R * r * Math.sin(th) };
  });
  const isSaved = (i) => nodes[i].saved;
  const ls = links.filter((l) => isSaved(l.a) && isSaved(l.b)).map((l) => ({ source: l.a, target: l.b, w: l.w }));
  const sim = d3_3d.forceSimulation(ns, 3)
    .force('link', d3_3d.forceLink(ls).id((d) => d.id).distance((l) => 30 / Math.sqrt(l.w)).strength((l) => Math.min(0.6, 0.1 * l.w)))
    .force('charge', d3_3d.forceManyBody().strength(-300))
    .stop();
  for (let i = 0; i < 600; i++) {
    sim.tick();
    for (const d of ns) {
      const len = Math.hypot(d.x, d.y, d.z) || 1;
      d.x *= R / len; d.y *= R / len; d.z *= R / len;
    }
  }
  const pts = nodes.map(() => null);
  for (const d of ns) pts[d.id] = [d.x / R, d.y / R, d.z / R];
  const sum = nodes.map(() => [0, 0, 0]);
  for (const e of edges) {
    for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
      if (isSaved(u) || !isSaved(v)) continue;
      for (let k = 0; k < 3; k++) sum[u][k] += pts[v][k];
    }
  }
  nodes.forEach((n, i) => {
    if (pts[i]) return;
    // Tiny deterministic jitter so pages with the same neighbours don't coincide.
    const v = sum[i].map((x, k) => x + 0.02 * Math.sin(i * (k + 1) * 12.9898));
    const len = Math.hypot(...v) || 1;
    pts[i] = v.map((x) => x / len);
  });
  separateOnSphere(pts, nodes);
  return pts.map((p) => p.map((v) => +v.toFixed(4)));
}

// Spread saved pages over the globe so their labels (all shown at once) rarely overlap.
// At the default view the globe's radius is ~330px on screen, so 1 radian ≈ 330px; a 14px
// serif character ≈ 7px. Labels turn with the globe, so this keeps a minimum angular gap
// of most of two half-widths in every direction rather than a true rectangle test.
function separateOnSphere(pts, nodes) {
  const RPX = 330;
  const idx = nodes.map((n, i) => (n.saved ? i : -1)).filter((i) => i >= 0);
  const half = idx.map((i) => (nodes[i].title.length * 7 + 10) / 2 / RPX);
  const norm = (p) => { const l = Math.hypot(...p); return p.map((v) => v / l); };
  let left = 0;
  for (let iter = 0; iter < 3000; iter++) {
    left = 0;
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        const p = pts[idx[a]], q = pts[idx[b]];
        const need = 0.7 * (half[a] + half[b]);
        const dot = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
        const ang = Math.acos(dot);
        if (ang >= need) continue;
        left++;
        const step = (need - ang) / 2 + 1e-4;
        // Tangent at p pointing away from q (and vice versa).
        let tp = [p[0] * dot - q[0], p[1] * dot - q[1], p[2] * dot - q[2]];
        if (Math.hypot(...tp) < 1e-9) tp = [p[1], -p[0], 0.3];
        tp = norm(tp);
        let tq = [q[0] * dot - p[0], q[1] * dot - p[1], q[2] * dot - p[2]];
        if (Math.hypot(...tq) < 1e-9) tq = tp.map((v) => -v);
        tq = norm(tq);
        pts[idx[a]] = norm(p.map((v, k) => v + tp[k] * step));
        pts[idx[b]] = norm(q.map((v, k) => v + tq[k] * step));
      }
    }
    if (!left) break;
  }
  if (left) log(`  ${left} saved pages still crowded on the sphere`);
}

// ---------- main ----------

async function main() {
  try {
    titleMap = JSON.parse(await fs.readFile(titleMapFile, 'utf8'));
  } catch {}

  log(`Fetching Are.na channel ${CHANNEL}…`);
  const { info, blocks } = await fetchChannel(CHANNEL);
  const rawSaved = [];
  for (const b of blocks) {
    if (b.class !== 'Link' || !b.source?.url) continue;
    const t = titleFromUrl(b.source.url);
    if (t) rawSaved.push({ raw: t, savedAt: b.connected_at, arenaId: b.id });
    else log(`  skipping non-Wikipedia link: ${b.source.url}`);
  }

  const canon = await resolveTitles(rawSaved.map((s) => s.raw));
  const savedMap = new Map();
  for (const s of rawSaved) {
    const t = canon(s.raw);
    if (!t) { log(`  could not resolve: ${s.raw}`); continue; }
    if (!savedMap.has(t)) savedMap.set(t, { title: t, savedAt: s.savedAt, arenaId: s.arenaId });
  }
  const saved = [...savedMap.keys()];
  const S = new Set(saved);
  log(`${saved.length} saved pages`);

  // Outgoing body links of saved pages, resolved to canonical titles.
  const savedRawLinks = await pool(saved, 6, getBodyLinks, 'saved body links');
  const canon2 = await resolveTitles(savedRawLinks.flat());
  const out = new Map(saved.map((s, i) => {
    const list = [];
    const seen = new Set();
    for (const raw of savedRawLinks[i]) {
      const t = canon2(raw);
      if (t && t !== s && !seen.has(t)) { seen.add(t); list.push(t); }
    }
    return [s, list];
  }));

  // Pages linking to saved pages.
  const inLists = await pool(saved, 4, getBacklinks, 'backlinks');
  const inn = new Map(saved.map((s, i) => [s, new Set(inLists[i])]));

  // Tally candidate pages by how many saved pages they touch.
  const tally = new Map(); // title -> {out:Set, in:Set, pos}
  const touch = (t) => tally.get(t) || (tally.set(t, { out: new Set(), in: new Set(), pos: Infinity }), tally.get(t));
  for (const s of saved) {
    out.get(s).forEach((t, i) => { if (!S.has(t)) { const e = touch(t); e.out.add(s); e.pos = Math.min(e.pos, i); } });
    for (const t of inn.get(s)) if (!S.has(t)) touch(t).in.add(s);
  }
  const touched = (e) => new Set([...e.out, ...e.in]);
  const multi = [...tally].filter(([, e]) => touched(e).size >= 2)
    .map(([t, e]) => [t, e.out.size + 0.6 * e.in.size])
    .sort((a, b) => b[1] - a[1]).slice(0, VERIFY_MULTI).map(([t]) => t);
  const single = [];
  for (const s of saved) {
    const mine = [...tally].filter(([, e]) => touched(e).size === 1 && (e.out.has(s) || e.in.has(s)))
      .map(([t, e]) => [t, (e.out.has(s) && e.in.has(s) ? 0 : 1000) + (e.out.has(s) ? e.pos : 500)])
      .sort((a, b) => a[1] - b[1]).slice(0, VERIFY_SINGLE).map(([t]) => t);
    single.push(...mine);
  }
  const candidates = [...new Set([...multi, ...single])];
  log(`${tally.size} pages touch the saved set; verifying ${candidates.length}`);

  // Verify candidates by reading their own article bodies.
  const candLinks = await pool(candidates, 6, getBodyLinks, 'candidate body links');
  const V = [...saved, ...candidates];
  const alias = await redirectAliases(V);
  const resolveLocal = (raw) => alias.get(raw) ?? null;

  const links = new Map(); // title -> Set(out-link titles within V)
  const degree = new Map();
  saved.forEach((s) => {
    links.set(s, new Set(out.get(s).filter((t) => alias.has(t))));
    degree.set(s, out.get(s).length);
  });
  candidates.forEach((c, i) => {
    const set = new Set();
    for (const raw of candLinks[i]) {
      const t = resolveLocal(raw);
      if (t && t !== c) set.add(t);
    }
    links.set(c, set);
    degree.set(c, candLinks[i].length);
  });
  const has = (a, b) => links.get(a)?.has(b) ?? false;
  const penalty = (t) => 1 / Math.log2(2 + (degree.get(t) || 0) / 40);

  // Score candidates: saved neighbours (verified), damped by how link-heavy the page is.
  const scored = candidates.map((c) => {
    let sum = 0;
    const nbrs = [];
    for (const s of saved) {
      const k = (has(s, c) ? 1 : 0) + (has(c, s) ? 1 : 0);
      if (k) { sum += k; nbrs.push(s); }
    }
    return { title: c, nbrs, score: sum * penalty(c) * Math.sqrt(nbrs.length) };
  }).filter((c) => c.nbrs.length > 0);

  const bridges = scored.filter((c) => c.nbrs.length >= 2).sort((a, b) => b.score - a.score).slice(0, KEEP_BRIDGES);
  const bridgeSet = new Set(bridges.map((b) => b.title));
  const singles = [];
  for (const s of saved) {
    singles.push(...scored.filter((c) => c.nbrs.length === 1 && c.nbrs[0] === s && !bridgeSet.has(c.title))
      .sort((a, b) => b.score - a.score).slice(0, KEEP_SINGLE));
  }
  log(`${bridges.length} bridges, ${singles.length} single-neighbour pages`);

  // Saved–saved similarity: direct links + shared neighbours (damped).
  const finalTitles = [...saved, ...bridges.map((b) => b.title), ...singles.map((s) => s.title)];
  const adj = (a, b) => has(a, b) || has(b, a);
  const simPairs = [];
  for (let i = 0; i < saved.length; i++) {
    for (let j = i + 1; j < saved.length; j++) {
      const A = saved[i], B = saved[j];
      let sim = 2 * (has(A, B) ? 1 : 0) + 2 * (has(B, A) ? 1 : 0);
      for (const C of finalTitles) if (C !== A && C !== B && adj(C, A) && adj(C, B)) sim += penalty(C);
      if (sim > 0) simPairs.push([A, B, sim]);
    }
  }

  // Nodes, ranked for level-of-detail: saved, then bridges, then singles.
  const meta = await pageMeta(finalTitles);
  const noImage = finalTitles.filter((t) => meta.has(t) && !meta.get(t).thumb);
  const fallbacks = await pool(noImage, 6, getArticleImage, 'article images');
  noImage.forEach((t, k) => { if (fallbacks[k]) meta.get(t).thumb = fallbacks[k]; });
  const stillNone = noImage.filter((t) => !meta.get(t).thumb);
  const otherLang = await pool(stillNone, 4, getOtherLanguageImage, 'other-language images');
  stillNone.forEach((t, k) => { if (otherLang[k]) meta.get(t).thumb = otherLang[k]; });
  const savedStrength = new Map(saved.map((s) => [s, 0]));
  for (const [a, b, w] of simPairs) { savedStrength.set(a, savedStrength.get(a) + w); savedStrength.set(b, savedStrength.get(b) + w); }
  const ordered = [
    ...saved.slice().sort((a, b) => savedStrength.get(b) - savedStrength.get(a)).map((t) => ({ t, level: 0, score: savedStrength.get(t) })),
    ...bridges.map((b) => ({ t: b.title, level: 1, score: b.score })),
    ...singles.sort((a, b) => b.score - a.score).map((s) => ({ t: s.title, level: 2, score: s.score })),
  ];
  const index = new Map(ordered.map((o, i) => [o.t, i]));
  const nodes = ordered.map((o, i) => {
    const m = meta.get(o.t) || {};
    const sv = savedMap.get(o.t);
    return {
      i, title: o.t, level: o.level, saved: o.level === 0, score: +o.score.toFixed(3),
      desc: m.desc || '', extract: m.extract || '', thumb: m.thumb || null,
      savedAt: sv?.savedAt || null, arenaId: sv?.arenaId || null,
    };
  });

  // Edges: real hyperlinks within the final node set (merged across direction).
  const edgeMap = new Map();
  for (const a of finalTitles) {
    for (const b of links.get(a) || []) {
      if (!index.has(b)) continue;
      const [x, y] = [index.get(a), index.get(b)].sort((p, q) => p - q);
      const key = `${x}-${y}`;
      const e = edgeMap.get(key) || { a: x, b: y, dir: 0 };
      e.dir |= index.get(a) === x ? 1 : 2; // 1: x→y, 2: y→x, 3: both
      edgeMap.set(key, e);
    }
  }
  const edges = [...edgeMap.values()];
  const simEdges = simPairs.map(([a, b, w]) => ({ a: index.get(a), b: index.get(b), w }));

  // Layout uses hyperlinks touching a saved page, plus each saved page's strongest similarities.
  const layoutLinks = edges.filter((e) => nodes[e.a].saved || nodes[e.b].saved)
    .map((e) => ({ a: e.a, b: e.b, w: e.dir === 3 ? 1.5 : 1 }));
  const topSim = new Map();
  for (const e of simEdges) for (const k of [e.a, e.b]) (topSim.get(k) || topSim.set(k, []).get(k)).push(e);
  const simLayout = new Set();
  for (const list of topSim.values()) list.sort((p, q) => q.w - p.w).slice(0, 5).forEach((e) => simLayout.add(e));
  layoutLinks.push(...[...simLayout].map((e) => ({ a: e.a, b: e.b, w: Math.min(4, e.w) })));

  log('Laying out (2D)…');
  const pos2 = layout2d(nodes, layoutLinks);
  log('Laying out (sphere)…');
  const pos3 = layoutSphere(nodes, layoutLinks, edges);
  nodes.forEach((n, i) => { n.p2 = pos2[i]; n.p3 = pos3[i]; });

  const graph = {
    generated: new Date().toISOString(),
    channel: { title: info.title, slug: CHANNEL, url: `https://www.are.na/channel/${CHANNEL}` },
    nodes,
    edges: edges.map((e) => [e.a, e.b, e.dir]),
    similar: [...simLayout].map((e) => [e.a, e.b, +e.w.toFixed(3)]),
  };
  await fs.mkdir(path.join(ROOT, 'public'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'public', 'graph.json'), JSON.stringify(graph));
  log(`Wrote public/graph.json: ${nodes.length} nodes, ${edges.length} edges`);

  // A short report for tuning.
  log('\nTop bridges:');
  for (const b of bridges.slice(0, 25)) log(`  ${b.score.toFixed(2)}  ${b.title}  ← ${b.nbrs.slice(0, 5).join(', ')}${b.nbrs.length > 5 ? '…' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
