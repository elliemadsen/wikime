// Shared canvas renderer. A "view" (flat or sphere) projects nodes to screen space;
// the scene decides which labels fit, fades them in and out, and draws.

const SERIF = "'Linux Libertine', 'Libertinus Serif', Georgia, Times, serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Lato, 'Helvetica Neue', Arial, sans-serif";

const FONT_SIZE = [14, 12, 11]; // by level: saved, bridge, single
const IMAGE_SIZE = [52, 38, 34];
// Pages without an image show a tile with the article's first sentence (image mode).
const TILE = { w: 84, h: 56, pad: 5, font: 7.5, line: 9 };
const PAD = 3;

export class Scene {
  constructor(canvas, graph) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.graph = graph;
    const n = graph.nodes.length;
    this.px = new Float32Array(n); // screen x
    this.py = new Float32Array(n); // screen y
    this.pk = new Float32Array(n); // size multiplier
    this.pa = new Float32Array(n); // visibility from the view (facing, frustum)
    this.pz = new Float32Array(n); // depth: larger is nearer the camera
    this.alpha = new Float32Array(n); // animated label opacity
    this.boxes = []; // placed labels this frame: [i, x0, y0, x1, y1]
    this.mode = 'text';
    this.view = null;
    this.filter = () => true; // timeline
    this.showConnecting = true; // draw unsaved (connecting) pages
    this.labelAllSaved = false; // saved labels ignore collisions and zoom budget
    this.edges = null; // edges to draw ([a, b, dir]); defaults to graph.edges
    this.edgeDir = new Map(); // "low-high" -> dir, for arrows on path edges
    this.pathNodes = new Set(); // pages on the current path (labelled even if unsaved)
    this.hover = -1;
    this.focus = new Set(); // forced-visible nodes (hovered, path, search)
    this.near = new Set(); // hover neighbours: placed early and not dimmed, but still collide
    this.pathEdges = new Set(); // "a-b" keys
    this.visited = new Set();
    this.images = new Map();
    this.widths = new Map();
    this.dirty = true;
    this.readColors();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.readColors(); this.invalidate(); });
    const loop = () => {
      try {
        if (this.dirty) this.frame();
      } catch (err) {
        // One bad frame shouldn't stop rendering for good.
        console.error(err);
        this.lastError = err;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (name) => s.getPropertyValue(name).trim();
    this.colors = {
      bg: v('--bg'), text: v('--text'), subtle: v('--text-subtle'), link: v('--link'),
      visited: v('--link-visited'), edge: v('--edge'), border: v('--border-subtle'), bgSubtle: v('--bg-subtle'),
    };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.w = width;
    this.h = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.view?.resize?.();
    this.invalidate();
  }

  setView(view) {
    this.view?.detach();
    this.view = view;
    view.attach();
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  font(level) {
    return level === 0 ? SERIF : SANS;
  }

  textWidth(i) {
    let w = this.widths.get(i);
    if (w === undefined) {
      const node = this.graph.nodes[i];
      this.ctx.font = `100px ${this.font(node.level)}`;
      w = this.ctx.measureText(node.title).width / 100;
      this.widths.set(i, w);
    }
    return w;
  }

  image(i) {
    const node = this.graph.nodes[i];
    if (!node.thumb) return null;
    let img = this.images.get(i);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = () => this.invalidate();
      img.src = node.thumb.src;
      this.images.set(i, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  // Label box (width, height) for node i at size multiplier k.
  labelSize(i, k) {
    const node = this.graph.nodes[i];
    if (this.mode === 'image' && node.thumb) {
      const h = IMAGE_SIZE[node.level] * k;
      const w = Math.min(h * 1.6, Math.max(h * 0.6, (h * node.thumb.w) / node.thumb.h));
      return [w, h];
    }
    if (this.mode === 'image') {
      const s = (IMAGE_SIZE[node.level] / IMAGE_SIZE[0]) * k;
      return [TILE.w * s, TILE.h * s];
    }
    const fs = FONT_SIZE[node.level] * k;
    return [this.textWidth(i) * fs, fs * 1.25];
  }

  // First sentence of a page's extract, wrapped to fit a tile (computed once, at base size).
  tileLines(i) {
    if (!this._tileLines) this._tileLines = new Map();
    let lines = this._tileLines.get(i);
    if (lines) return lines;
    const node = this.graph.nodes[i];
    const m = node.extract.match(/^[\s\S]*?[.!?](?=\s+[A-Z(“"]|$)/);
    const text = ((m ? m[0] : node.extract) || node.title).trim();
    const { ctx } = this;
    ctx.font = `${TILE.font}px ${SERIF}`;
    const maxW = TILE.w - TILE.pad * 2;
    const maxLines = Math.floor((TILE.h - TILE.pad * 2) / TILE.line);
    lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxW || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trimEnd()}…`;
    }
    this._tileLines.set(i, lines);
    return lines;
  }

  drawTile(i, x, y, k, color) {
    const { ctx } = this;
    const node = this.graph.nodes[i];
    const [w, h] = this.labelSize(i, k);
    const s = w / TILE.w;
    ctx.fillStyle = this.colors.bgSubtle;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.strokeStyle = node.saved || i === this.hover ? color : this.colors.border;
    ctx.lineWidth = node.saved ? 1 : 0.5;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    ctx.save();
    ctx.translate(x - w / 2, y - h / 2);
    ctx.scale(s, s);
    ctx.font = `${TILE.font}px ${SERIF}`;
    ctx.fillStyle = this.colors.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    this.tileLines(i).forEach((line, n) => ctx.fillText(line, TILE.pad, TILE.pad + n * TILE.line));
    ctx.restore();
  }

  frame() {
    const { ctx, graph, view } = this;
    const nodes = graph.nodes;
    const n = nodes.length;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!view) return;
    view.drawBackground?.(ctx);
    view.project(this);

    // Choose labels: focused nodes, then hover neighbours by rank, then everything by rank
    // (saved pages are ranked first).
    const budget = view.budget();
    const order = [...this.focus];
    for (const i of [...this.near].sort((a, b) => a - b)) if (!this.focus.has(i)) order.push(i);
    for (let i = 0; i < n; i++) if (!this.focus.has(i) && !this.near.has(i)) order.push(i);
    const target = new Uint8Array(n);
    const grid = new Map();
    const CELL = 80;
    this.boxes = [];
    const collides = (x0, y0, x1, y1) => {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++)
          for (const b of grid.get(cx * 10007 + cy) || []) if (x0 < b[3] && x1 > b[1] && y0 < b[4] && y1 > b[2]) return true;
      return false;
    };
    const insert = (b) => {
      for (let cx = Math.floor(b[1] / CELL); cx <= Math.floor(b[3] / CELL); cx++)
        for (let cy = Math.floor(b[2] / CELL); cy <= Math.floor(b[4] / CELL); cy++) {
          const key = cx * 10007 + cy;
          (grid.get(key) || grid.set(key, []).get(key)).push(b);
        }
    };
    for (const i of order) {
      if (!this.filter(i) || this.pa[i] < 0.02) continue;
      if (!this.showConnecting && !nodes[i].saved && !this.pathNodes.has(i)) continue;
      const forced = this.focus.has(i) || (this.labelAllSaved && nodes[i].saved);
      if (!forced && !this.near.has(i) && i >= budget) continue;
      const x = this.px[i], y = this.py[i];
      if (x < -200 || y < -100 || x > this.w + 200 || y > this.h + 100) continue;
      const [w, h] = this.labelSize(i, this.pk[i]);
      const b = [i, x - w / 2 - PAD, y - h / 2 - PAD, x + w / 2 + PAD, y + h / 2 + PAD];
      if (!forced && collides(b[1], b[2], b[3], b[4])) continue;
      target[i] = 1;
      insert(b);
      this.boxes.push(b);
    }

    // Fade towards targets (time-based, so slow frames still settle).
    const now = performance.now();
    const rate = this.settled ? (this.lastFrame ? 1 - Math.exp(-(now - this.lastFrame) / 90) : 0.2) : 1;
    this.settled = true; // the first frame appears fully drawn
    this.lastFrame = now;
    let animating = false;
    for (let i = 0; i < n; i++) {
      const d = target[i] - this.alpha[i];
      if (Math.abs(d) > 0.01) {
        this.alpha[i] += d * rate;
        animating = true;
      } else this.alpha[i] = target[i];
    }

    const dimOthers = this.hover >= 0 || this.pathEdges.size > 0;
    const lit = (i) => this.focus.has(i) || this.near.has(i);
    const op = (i) => this.alpha[i] * this.pa[i] * (dimOthers && !lit(i) ? 0.25 : 1);

    // Edges between shown nodes.
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = this.colors.edge;
    const highlight = [];
    for (const [a, b, dir] of this.edges || graph.edges) {
      const oa = op(a), ob = op(b);
      if (oa < 0.02 || ob < 0.02) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (this.pathEdges.has(key)) continue; // drawn below
      if (this.hover >= 0 && (a === this.hover || b === this.hover)) {
        highlight.push([a, b, dir]);
        continue;
      }
      ctx.globalAlpha = Math.min(oa, ob) * (dimOthers ? 0.08 : 0.35);
      ctx.beginPath();
      this.link(a, b, dir);
      ctx.stroke();
    }
    for (const key of this.pathEdges) {
      const [a, b] = key.split('-').map(Number);
      highlight.push([a, b, this.edgeDir.get(key) || 0]);
    }
    ctx.strokeStyle = this.colors.link;
    ctx.lineWidth = 1.25;
    for (const [a, b, dir] of highlight) {
      const o = Math.min(op(a), op(b));
      if (o < 0.02) continue;
      ctx.globalAlpha = o * 0.7;
      ctx.beginPath();
      this.link(a, b, dir);
      ctx.stroke();
    }

    // Saved pages without room for a label still get a dot, so they're always marked.
    ctx.fillStyle = this.colors.link;
    for (let i = 0; i < n && nodes[i].saved; i++) {
      const o = (1 - this.alpha[i]) * this.pa[i] * (dimOthers ? 0.25 : 1);
      if (o < 0.02 || !this.filter(i)) continue;
      ctx.globalAlpha = o * 0.6;
      ctx.beginPath();
      ctx.arc(this.px[i], this.py[i], 2.2 * this.pk[i], 0, Math.PI * 2);
      ctx.fill();
    }

    // Labels, farthest first so nearer ones sit on top.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawn = [];
    for (let i = 0; i < n; i++) if (op(i) >= 0.02) drawn.push(i);
    drawn.sort((a, b) => this.pz[a] - this.pz[b] || b - a);
    for (const i of drawn) this.drawNode(i, op(i));
    // Hovered node on top.
    if (this.hover >= 0 && op(this.hover) > 0.02) this.drawNode(this.hover, op(this.hover));

    ctx.globalAlpha = 1;
    view.drawForeground?.(ctx);
    this.dirty = animating || view.animating?.();
    if (!this.dirty) this.lastFrame = 0; // the next change starts a fresh fade
  }

  drawNode(i, o) {
    const { ctx } = this;
    const node = this.graph.nodes[i];
    const x = this.px[i], y = this.py[i], k = this.pk[i];
    // Unsaved pages are grey on the full map, black when they only appear as part of a path.
    const unsaved = this.showConnecting ? this.colors.subtle : this.colors.text;
    const color = this.visited.has(i) ? this.colors.visited : node.saved ? this.colors.link : unsaved;
    const img = this.mode === 'image' ? this.image(i) : null;
    ctx.globalAlpha = o;
    if (this.mode === 'image' && node.thumb) {
      const [w, h] = this.labelSize(i, k);
      if (img) {
        // Cover-crop into the box.
        const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        const sw = w / s, sh = h / s;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x - w / 2, y - h / 2, w, h);
      } else {
        ctx.fillStyle = this.colors.bgSubtle;
        ctx.fillRect(x - w / 2, y - h / 2, w, h);
      }
      ctx.strokeStyle = node.saved || i === this.hover ? color : this.colors.border;
      ctx.lineWidth = node.saved ? 1 : 0.5;
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      return;
    }
    if (this.mode === 'image') {
      this.drawTile(i, x, y, k, color);
      return;
    }
    const fs = FONT_SIZE[node.level] * k;
    ctx.font = `${fs}px ${this.font(node.level)}`;
    // Halo so labels stay legible over edges.
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.colors.bg;
    ctx.lineJoin = 'round';
    ctx.strokeText(node.title, x, y);
    ctx.fillStyle = i === this.hover ? (node.saved ? this.colors.link : this.colors.text) : color;
    ctx.fillText(node.title, x, y);
    if (i === this.hover) {
      const w = this.textWidth(i) * fs;
      ctx.fillRect(x - w / 2, y + fs * 0.55, w, Math.max(1, fs / 14));
    }
  }

  // Screen box around node i's label, which lines stop short of.
  labelBox(i) {
    const [w, h] = this.labelSize(i, this.pk[i]);
    const x = this.px[i], y = this.py[i], m = PAD + 1;
    return [x - w / 2 - m, y - h / 2 - m, x + w / 2 + m, y + h / 2 + m];
  }

  // Add a link [a, b] (a < b) to the current path: its line trimmed to stop at both labels,
  // with arrowheads where it points. dir: 1 = a→b, 2 = b→a, 3 = both, 0 = no direction.
  link(a, b, dir) {
    const { segs, startA, endB } = this.view.edgePolyline(a, b, this);
    if (!segs.length) return;
    if (startA) segs[0] = clipFrom(segs[0], this.labelBox(a));
    const last = segs.length - 1;
    if (endB) segs[last] = clipFrom(segs[last].slice().reverse(), this.labelBox(b)).reverse();
    const { ctx } = this;
    for (const seg of segs) {
      if (seg.length < 2) continue;
      ctx.moveTo(seg[0][0], seg[0][1]);
      for (let k = 1; k < seg.length; k++) ctx.lineTo(seg[k][0], seg[k][1]);
    }
    const end = segs[last], start = segs[0];
    if (dir & 1 && endB && end.length >= 2) this.arrowhead(end[end.length - 1], end[end.length - 2]);
    if (dir & 2 && startA && start.length >= 2) this.arrowhead(start[0], start[1]);
  }

  // Arrowhead with its tip at `tip`, pointing away from `from`.
  arrowhead(tip, from) {
    const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
    const L = 6, spread = 0.45;
    const { ctx } = this;
    ctx.moveTo(tip[0] - L * Math.cos(ang - spread), tip[1] - L * Math.sin(ang - spread));
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - L * Math.cos(ang + spread), tip[1] - L * Math.sin(ang + spread));
  }

  hitTest(x, y) {
    // The nearest label under the pointer wins; faint labels (e.g. behind the globe) don't count.
    let hit = -1;
    for (const b of this.boxes) {
      const i = b[0];
      if (this.alpha[i] > 0.5 && this.pa[i] > 0.5 && x >= b[1] && x <= b[3] && y >= b[2] && y <= b[4]) {
        if (hit < 0 || this.pz[i] > this.pz[hit]) hit = i;
      }
    }
    return hit;
  }
}

// Drop the start of polyline P that lies inside box B, ending exactly where it leaves the box.
function clipFrom(P, B) {
  const inside = ([x, y]) => x > B[0] && x < B[2] && y > B[1] && y < B[3];
  let k = 0;
  while (k < P.length && inside(P[k])) k++;
  if (k === 0) return P;
  if (k === P.length) return [];
  const [px, py] = P[k - 1], [qx, qy] = P[k];
  const dx = qx - px, dy = qy - py;
  const tx = dx > 0 ? (B[2] - px) / dx : dx < 0 ? (B[0] - px) / dx : Infinity;
  const ty = dy > 0 ? (B[3] - py) / dy : dy < 0 ? (B[1] - py) / dy : Infinity;
  const t = Math.min(tx, ty);
  return [[px + dx * t, py + dy * t], ...P.slice(k)];
}
