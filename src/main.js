import { Scene } from './scene.js';
import { SphereView } from './sphere.js';

const $ = (sel) => document.querySelector(sel);
const wikiUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Features that are built but currently switched off.
const FEATURES = {
  flat: false, // the 2D map (otherwise sphere only)
  frontier: false, // sidebar list of unsaved pages that connect saved ones
  connecting: false, // draw unsaved connecting pages on the map (otherwise saved pages only)
  similarEdges: false, // also draw lines between saved pages that share many links (not direct links)
};

const graph = await fetch(new URL('../public/graph.json', import.meta.url)).then((r) => r.json());
const { nodes } = graph;

// ---------- graph prep ----------

const neighbors = nodes.map(() => []);
for (const [a, b] of graph.edges) {
  neighbors[a].push(b);
  neighbors[b].push(a);
}
const savedNbrs = nodes.map((_, i) => neighbors[i].filter((j) => nodes[j].saved));
const byTitle = new Map(nodes.map((n) => [n.title, n.i]));

// With connecting pages hidden, saved pages are drawn joined by direct links between them
// (and, if enabled, their strongest similarities: pages they both link to or from).
let displayEdges = graph.edges;
let displayNbrs = neighbors;
if (!FEATURES.connecting) {
  const seen = new Set();
  displayEdges = [];
  // Similarity lines have no direction (0), so they get no arrows.
  const similar = FEATURES.similarEdges ? graph.similar.map(([a, b]) => [a, b, 0]) : [];
  for (const [a, b, dir] of [...graph.edges, ...similar]) {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (!nodes[a].saved || !nodes[b].saved || seen.has(key)) continue;
    seen.add(key);
    displayEdges.push([a, b, dir]);
  }
  displayNbrs = nodes.map(() => []);
  for (const [a, b] of displayEdges) { displayNbrs[a].push(b); displayNbrs[b].push(a); }
}
nodes.forEach((n) => { if (n.savedAt) n.savedDate = new Date(n.savedAt); });

// ---------- scene & views ----------

const canvas = $('#map');
const scene = new Scene(canvas, graph);
scene.showConnecting = FEATURES.connecting;
scene.labelAllSaved = !FEATURES.connecting;
scene.edges = displayEdges;
// Link direction for any pair, as in graph.edges: [low, high, dir] with dir 1 = low→high,
// 2 = high→low, 3 = both.
scene.edgeDir = new Map(graph.edges.map(([a, b, dir]) => [`${a}-${b}`, dir]));

const VISITED_KEY = 'wikime:visited';
try {
  for (const t of JSON.parse(localStorage.getItem(VISITED_KEY) || '[]')) if (byTitle.has(t)) scene.visited.add(byTitle.get(t));
} catch {}

const hooks = {
  onPointerMove: (e) => {
    const r = canvas.getBoundingClientRect();
    setHover(scene.hitTest(e.clientX - r.left, e.clientY - r.top), e);
  },
  onPointerLeave: () => setHover(-1),
  onClick: (e) => {
    const r = canvas.getBoundingClientRect();
    const i = scene.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (i >= 0) activate(i);
  },
  onMove: () => { if (scene.hover >= 0) setHover(-1); },
};

const views = { sphere: new SphereView(scene, hooks) };
if (FEATURES.flat) views.flat = new (await import('./flat.js')).FlatView(scene, hooks);
let viewName = FEATURES.flat ? 'flat' : 'sphere';
scene.setView(views[viewName]);
if (!FEATURES.flat) {
  $('.tabgroup[data-group="view"]').hidden = true;
  $('.tabgroup[data-group="side"]').hidden = false;
}

// ---------- focus (hover, path, search) ----------

let path = []; // node indices of the current path
let pathPick = null; // first endpoint while picking
let pinned = -1; // search result

function refreshFocus() {
  scene.focus = new Set();
  if (pinned >= 0) scene.focus.add(pinned);
  for (const i of path) scene.focus.add(i);
  if (pathPick !== null) scene.focus.add(pathPick);
  scene.near = new Set();
  if (scene.hover >= 0) {
    scene.focus.add(scene.hover);
    for (const j of displayNbrs[scene.hover]) if (scene.filter(j)) scene.near.add(j);
  }
  scene.pathNodes = new Set(path);
  scene.pathEdges = new Set();
  for (let k = 1; k < path.length; k++) {
    const [a, b] = [path[k - 1], path[k]].sort((x, y) => x - y);
    scene.pathEdges.add(`${a}-${b}`);
  }
  scene.invalidate();
}

// ---------- hover card ----------

const card = $('#card');

function setHover(i, e) {
  if (i !== scene.hover) {
    scene.hover = i;
    refreshFocus();
    canvas.classList.toggle('pointing', i >= 0);
    if (i >= 0) fillCard(i);
    else card.hidden = true;
  }
  if (i >= 0 && e) placeCard(e);
}

function fillCard(i) {
  const n = nodes[i];
  const via = savedNbrs[i].filter((j) => j !== i && scene.filter(j)).map((j) => nodes[j].title);
  let meta;
  if (n.saved) {
    meta = `Saved ${n.savedDate ? fmtDate(n.savedDate) : ''}`;
  } else {
    meta = `Connects ${via.slice(0, 4).join(', ')}${via.length > 4 ? ` and ${via.length - 4} more` : ''}`;
  }
  if (pathPick !== null) meta = 'Click to end the path here';
  else if (activeTool === 'path') meta = 'Click to start a path here';
  card.innerHTML = `
    ${n.thumb ? `<img src="${esc(n.thumb.src)}" alt="">` : ''}
    <div class="body">
      <div class="title">${esc(n.title)}</div>
      ${n.desc ? `<div class="desc">${esc(n.desc)}</div>` : ''}
      <p class="extract">${esc(n.extract.length > 360 ? n.extract.slice(0, 357).replace(/\s+\S*$/, '') + '…' : n.extract)}</p>
      <div class="meta">${esc(meta)}</div>
    </div>`;
  card.hidden = false;
}

function placeCard(e) {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let left = x + 18, top = y + 18;
  if (left + cw > r.width - 8) left = x - cw - 18;
  if (top + ch > r.height - 8) top = y - ch - 18;
  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

// ---------- click ----------

function markVisited(i) {
  scene.visited.add(i);
  try {
    localStorage.setItem(VISITED_KEY, JSON.stringify([...scene.visited].map((j) => nodes[j].title)));
  } catch {}
  scene.invalidate();
}

function activate(i) {
  if (activeTool === 'path') {
    pickPath(i);
    return;
  }
  markVisited(i);
  window.open(wikiUrl(nodes[i].title), '_blank', 'noopener');
}

// ---------- tabs ----------

function setPressed(group, value) {
  document.querySelectorAll(`.tabgroup[data-group="${group}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
}

document.querySelectorAll('.tabgroup:not([data-group="tool"]) button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const group = btn.parentElement.dataset.group, value = btn.dataset.value;
    setPressed(group, value);
    if (group === 'view' && value !== viewName) {
      viewName = value;
      scene.setView(views[value]);
      $('.tabgroup[data-group="side"]').hidden = value !== 'sphere';
    } else if (group === 'side') {
      views.sphere.setSide(value);
    } else if (group === 'mode') {
      scene.mode = value;
      scene.invalidate();
    }
    setHover(-1);
  });
});

// ---------- search ----------

const list = $('#titles');
const searchable = FEATURES.connecting ? nodes : nodes.filter((n) => n.saved);
list.innerHTML = searchable.slice().sort((a, b) => a.title.localeCompare(b.title)).map((n) => `<option value="${esc(n.title)}"></option>`).join('');

function goTo(i) {
  pinned = i;
  refreshFocus();
  scene.view.flyTo(i);
}

$('.search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return;
  const hit = searchable.find((n) => n.title.toLowerCase() === q) || searchable.find((n) => n.title.toLowerCase().startsWith(q)) || searchable.find((n) => n.title.toLowerCase().includes(q));
  if (hit) goTo(hit.i);
});
$('#search').addEventListener('input', (e) => {
  const i = byTitle.get(e.target.value);
  if (i !== undefined && searchable.includes(nodes[i])) goTo(i);
  if (!e.target.value) { pinned = -1; refreshFocus(); }
});

// ---------- tools (Pathfinder, About) ----------

let activeTool = null;

// Clicking a tool in the top bar opens its panel; clicking it again closes it.
function setTool(name) {
  activeTool = activeTool === name ? null : name;
  document.querySelectorAll('.tabgroup[data-group="tool"] button[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === activeTool)));
  document.querySelectorAll('section.tool').forEach((s) => { s.hidden = s.dataset.tool !== activeTool; });
  $('#sidebar').classList.toggle('open', activeTool !== null);
  if (activeTool !== 'path') clearPath();
}
document.querySelectorAll('.tabgroup[data-group="tool"] button[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

$('#about-arena').href = graph.channel.url;
$('.tabgroup[data-group="tool"] button[data-tool="frontier"]').hidden = !FEATURES.frontier;

// Path finder: fewest direct Wikipedia links (either direction), through any page on the
// map. Unsaved pages appear only while they're on the current path. Among equally short
// paths, prefer saved and more specific pages over link-heavy hubs; the extra cost per page
// stays under 0.5 so a longer path never wins.
const pathNbrs = neighbors;
const hubCost = nodes.map((n, i) => (n.saved ? 0 : 0.1) + Math.min(0.35, 0.05 * Math.log2(1 + neighbors[i].length)));

function shortestPath(from, to) {
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const done = new Uint8Array(nodes.length);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === to) break;
    done[u] = 1;
    for (const v of pathNbrs[u]) {
      if (done[v] || !scene.filter(v)) continue;
      const d = dist[u] + 1 + (v === to ? 0 : hubCost[v]);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  if (dist[to] === Infinity) return [];
  const out = [to];
  while (out[0] !== from) out.unshift(prev[out[0]]);
  return out;
}

function pickPath(i) {
  if (pathPick === null || path.length) {
    path = [];
    pathPick = i;
    $('#path-hint').innerHTML = `<span class="path-from">${esc(nodes[i].title)}</span> → <span class="path-blank"></span>`;
    $('#path-chain').innerHTML = '';
  } else {
    path = shortestPath(pathPick, i);
    $('#path-hint').textContent = path.length
      ? `${path.length - 1} link${path.length === 2 ? '' : 's'} apart.`
      : `No path of direct links between ${nodes[pathPick].title} and ${nodes[i].title}.`;
    if (path.length) scene.view.flyTo(path[Math.floor((path.length - 1) / 2)], { keepZoom: true }); // bring it into view
    $('#path-chain').innerHTML = path.map((j) => `<li><a href="${wikiUrl(nodes[j].title)}" target="_blank" rel="noopener" data-i="${j}" class="${nodes[j].saved ? 'saved' : 'found'}">${esc(nodes[j].title)}</a></li>`).join('');
    pathPick = null;
  }
  setHover(-1);
  refreshFocus();
}

function clearPath() {
  path = [];
  pathPick = null;
  $('#path-hint').textContent = 'Click two pages on the map.';
  $('#path-chain').innerHTML = '';
  refreshFocus();
}
$('#path-clear').addEventListener('click', clearPath);
$('#path-chain').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-i]');
  if (a) markVisited(+a.dataset.i);
});

// Frontier: unsaved pages that best connect saved ones (by build score, which damps
// generic hub pages like "Mathematics").
const frontier = nodes.filter((n) => n.level === 1).map((n) => ({ n, k: savedNbrs[n.i].length }))
  .sort((a, b) => b.n.score - a.n.score).slice(0, 25);
$('#frontier').innerHTML = frontier.map(({ n, k }) =>
  `<li><button data-i="${n.i}">${esc(n.title)}</button> <a href="${wikiUrl(n.title)}" target="_blank" rel="noopener" aria-label="Open on Wikipedia">↗</a><small>links ${k} saved pages</small></li>`).join('');
$('#frontier').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) goTo(+b.dataset.i);
});

// ---------- timeline ----------

const savedByDate = nodes.filter((n) => n.saved).sort((a, b) => a.savedDate - b.savedDate);
const slider = $('#time');
slider.max = String(savedByDate.length);
slider.value = slider.max;
let shownSaved = new Set(savedByDate.map((n) => n.i));

function applyTime() {
  const k = +slider.value;
  shownSaved = new Set(savedByDate.slice(0, k).map((n) => n.i));
  const all = k === savedByDate.length;
  scene.filter = all ? () => true : (i) => {
    const n = nodes[i];
    if (n.saved) return shownSaved.has(i);
    const need = n.level === 1 ? 2 : 1;
    let c = 0;
    for (const j of savedNbrs[i]) if (shownSaved.has(j) && ++c >= need) return true;
    return false;
  };
  const last = savedByDate[k - 1];
  $('#time-label').innerHTML = `<span>${k}</span><span>${last ? fmtDate(last.savedDate) : ''}</span>`;
  refreshFocus();
}
slider.addEventListener('input', applyTime);
applyTime();

let playing = null;
$('#play').addEventListener('click', () => {
  if (playing) {
    clearInterval(playing);
    playing = null;
    $('#play').textContent = '▶';
    return;
  }
  if (+slider.value >= savedByDate.length) slider.value = '1';
  $('#play').textContent = '❚❚';
  playing = setInterval(() => {
    slider.value = String(+slider.value + 1);
    applyTime();
    if (+slider.value >= savedByDate.length) $('#play').click();
  }, 350);
});

// The Timeline button shows or hides the bar. Hiding it stops playback and shows every page again.
$('#timeline-toggle').addEventListener('click', (e) => {
  const bar = $('.timeline');
  bar.hidden = !bar.hidden;
  e.currentTarget.setAttribute('aria-pressed', String(!bar.hidden));
  if (bar.hidden) {
    if (playing) $('#play').click();
    slider.value = slider.max;
    applyTime();
  }
});

// ---------- deep links: ?view=sphere&side=inside&mode=image&page=Hysteresis&tool=frontier ----------

const params = new URLSearchParams(location.search);
for (const group of ['view', 'side', 'mode']) {
  const v = params.get(group);
  if (group === 'view' && !FEATURES.flat) continue;
  if (v) document.querySelector(`.tabgroup[data-group="${group}"] button[data-value="${v}"]`)?.click();
}
if (params.get('page') && byTitle.has(params.get('page'))) goTo(byTitle.get(params.get('page')));
if (params.get('tool') && (FEATURES.frontier || params.get('tool') !== 'frontier')) {
  setTool(params.get('tool'));
}

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    pinned = -1;
    $('#search').value = '';
    clearPath();
    setHover(-1);
  }
});
