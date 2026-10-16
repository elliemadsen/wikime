// Sphere view: every page sits on the surface of a globe. Rotation is a free arcball
// (no poles, no seams). "Outside" orbits the globe; "inside" puts the camera at its centre.

// ---- quaternions [w, x, y, z] ----
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qAxis = (x, y, z, angle) => {
  const len = Math.hypot(x, y, z) || 1;
  const s = Math.sin(angle / 2) / len;
  return [Math.cos(angle / 2), x * s, y * s, z * s];
};
const qNorm = (q) => {
  const l = Math.hypot(...q);
  return q.map((v) => v / l);
};
function qRotate(q, v) {
  const [w, x, y, z] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
function qFromVectors(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.9999) return qAxis(0, 1, 0, Math.PI);
  return qNorm([1 + d, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}
function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; }
  if (d > 0.9995) return qNorm(a.map((v, i) => v + (b[i] - v) * t));
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((v, i) => (Math.sin((1 - t) * th) * v + Math.sin(t * th) * b[i]) / s);
}

const D0 = 2.6; // default camera distance (sphere radius = 1)
const BACK_ALPHA = 0.32; // opacity of saved labels seen through the globe
const FOV0 = 80; // default field of view inside

const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class SphereView {
  constructor(scene, hooks) {
    this.scene = scene;
    this.hooks = hooks;
    this.side = 'outside';
    this.q = qAxis(1, 0, 0, 0.35);
    this.D = D0;
    this.fov = FOV0;
    this.spin = null; // inertia: [axis x, y, z, angle per ms]
    this.idle = true; // slow rotation until first interaction
    this.fly = null;
    const n = scene.graph.nodes.length;
    this.rx = new Float32Array(n);
    this.ry = new Float32Array(n);
    this.rz = new Float32Array(n);
    this.savedCount = scene.graph.nodes.filter((d) => d.saved).length;
    this.pointers = new Map();
    this.last = performance.now();

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
  }

  attach() {
    const c = this.scene.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('pointerleave', this.hooks.onPointerLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    this.last = performance.now();
  }

  detach() {
    const c = this.scene.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('pointerleave', this.hooks.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    this.pointers.clear();
  }

  setSide(side) {
    this.side = side;
    this.spin = null;
    this.scene.invalidate();
  }

  get minDim() {
    return Math.min(this.scene.w, this.scene.h);
  }

  // Focal length in pixels.
  get F() {
    return this.side === 'outside'
      ? 0.45 * this.minDim * Math.sqrt(D0 * D0 - 1)
      : this.minDim / 2 / Math.tan((this.fov * Math.PI) / 360);
  }

  // ---------- interaction ----------

  stopMotion() {
    this.idle = false;
    this.spin = null;
    this.fly = null;
  }

  onDown(e) {
    this.scene.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() });
    this.stopMotion();
    this.scene.canvas.classList.add('dragging');
  }

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      this.hooks.onPointerMove(e);
      return;
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0) this.zoomBy(Math.log(before / after) * 1.5);
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    const now = performance.now();
    const dt = Math.max(1, now - p.t);
    p.x = e.clientX; p.y = e.clientY; p.t = now;
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const angle = this.side === 'outside' ? (len * (this.D - 1)) / this.F : len / this.F;
    const axis = this.side === 'outside' ? [dy, dx, 0] : [-dy, -dx, 0];
    this.q = qNorm(qMul(qAxis(...axis, angle), this.q));
    this.spin = [...axis, angle / dt];
    this.hooks.onMove?.();
    this.scene.invalidate();
  }

  onUp(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.scene.canvas.classList.remove('dragging');
    if (!p) return;
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (moved < 5 && this.pointers.size === 0) {
      this.spin = null;
      this.hooks.onClick(e);
    } else if (performance.now() - p.t > 80) {
      this.spin = null; // released after pausing: no throw
    }
    this.last = performance.now();
    this.scene.invalidate();
  }

  onWheel(e) {
    e.preventDefault();
    this.stopMotion();
    this.zoomBy(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
  }

  zoomBy(amount) {
    if (this.side === 'outside') this.D = Math.max(1.06, Math.min(6, 1 + (this.D - 1) * Math.exp(amount)));
    else this.fov = Math.max(20, Math.min(115, this.fov * Math.exp(amount)));
    this.hooks.onMove?.();
    this.scene.invalidate();
  }

  // Rotate so node i faces the camera; unless keepZoom, also move in closer.
  flyTo(i, { keepZoom = false } = {}) {
    const p = this.scene.graph.nodes[i].p3;
    const front = this.side === 'outside' ? [0, 0, 1] : [0, 0, -1];
    const target = qNorm(qMul(qFromVectors(qRotate(this.q, p), front), this.q));
    this.idle = false;
    this.spin = null;
    this.fly = {
      q0: this.q, q1: target, t0: performance.now(), dur: 1000,
      D0: this.D, D1: keepZoom ? this.D : this.scene.graph.nodes[i].saved ? Math.min(this.D, 2.1) : Math.min(this.D, 1.6),
      f0: this.fov, f1: keepZoom ? this.fov : Math.min(this.fov, 55),
    };
    this.scene.invalidate();
  }

  reset() {
    this.fly = { q0: this.q, q1: this.q, t0: performance.now(), dur: 600, D0: this.D, D1: D0, f0: this.fov, f1: FOV0 };
    this.scene.invalidate();
  }

  animating() {
    return !!(this.spin || this.idle || this.fly);
  }

  step() {
    const now = performance.now();
    const dt = Math.min(50, now - this.last);
    this.last = now;
    if (this.fly) {
      const f = this.fly;
      const t = Math.min(1, (now - f.t0) / f.dur);
      const e = ease(t);
      this.q = qSlerp(f.q0, f.q1, e);
      this.D = f.D0 + (f.D1 - f.D0) * e;
      this.fov = f.f0 + (f.f1 - f.f0) * e;
      if (t >= 1) this.fly = null;
    } else if (this.spin && this.pointers.size === 0) {
      const [x, y, z, w] = this.spin;
      this.q = qNorm(qMul(qAxis(x, y, z, w * dt), this.q));
      this.spin[3] *= Math.pow(0.995, dt);
      if (this.spin[3] < 1e-5) this.spin = null;
    } else if (this.idle) {
      this.q = qNorm(qMul(qAxis(0.15, 1, 0, 0.00004 * dt), this.q));
    }
  }

  // ---------- rendering ----------

  project(scene) {
    this.step();
    const F = this.F, cx = scene.w / 2, cy = scene.h / 2;
    const outside = this.side === 'outside';
    const D = this.D;
    const kInside = Math.max(0.8, Math.min(1.5, Math.pow(FOV0 / this.fov, 0.35)));
    const ghosts = scene.labelAllSaved;
    scene.graph.nodes.forEach((n, i) => {
      const [x, y, z] = qRotate(this.q, n.p3);
      this.rx[i] = x; this.ry[i] = y; this.rz[i] = z;
      if (outside) {
        const zc = D - z;
        scene.px[i] = cx + (F * x) / zc;
        scene.py[i] = cy - (F * y) / zc;
        scene.pk[i] = Math.max(0.6, Math.min(1.5, Math.pow((D0 - 1) / zc, 0.45)));
        scene.pa[i] = smooth(0, 0.18, z - 1 / D);
        // Saved pages on the far side show faintly through the globe.
        if (ghosts && (n.saved || scene.pathNodes.has(i))) scene.pa[i] = Math.max(scene.pa[i], BACK_ALPHA);
        scene.pz[i] = z;
      } else {
        const zc = -z;
        scene.px[i] = cx + (F * x) / Math.max(zc, 1e-3);
        scene.py[i] = cy - (F * y) / Math.max(zc, 1e-3);
        scene.pk[i] = kInside;
        scene.pa[i] = smooth(0.08, 0.3, zc);
        scene.pz[i] = zc;
      }
    });
  }

  drawBackground(ctx) {
    if (this.side !== 'outside') return;
    const { scene } = this;
    const r = this.F / Math.sqrt(this.D * this.D - 1);
    ctx.beginPath();
    ctx.arc(scene.w / 2, scene.h / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = scene.colors.bg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = scene.colors.border;
    ctx.stroke();
  }

  budget() {
    if (this.side === 'outside') {
      const t = Math.max(0, (D0 - this.D) / (D0 - 1.06));
      return this.savedCount + 80 + Math.round(900 * t * t);
    }
    const t = Math.max(0, (FOV0 - this.fov) / (FOV0 - 20));
    return this.savedCount + 160 + Math.round(800 * t * t);
  }

  // Great-circle arc between two nodes as screen-space polylines, split where it dips out of
  // view. startA / endB say whether the arc actually reaches each end node on screen.
  edgePolyline(a, b, scene) {
    const ax = this.rx[a], ay = this.ry[a], az = this.rz[a];
    const bx = this.rx[b], by = this.ry[b], bz = this.rz[b];
    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
    const om = Math.acos(dot);
    const steps = Math.max(1, Math.min(24, Math.ceil(om / 0.06)));
    const so = Math.sin(om);
    const F = this.F, cx = scene.w / 2, cy = scene.h / 2;
    const outside = this.side === 'outside';
    const segs = [];
    let cur = null, startA = false, endB = false;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      let x, y, z;
      if (so < 1e-6) { x = ax; y = ay; z = az; } else {
        const wa = Math.sin((1 - t) * om) / so, wb = Math.sin(t * om) / so;
        x = wa * ax + wb * bx; y = wa * ay + wb * by; z = wa * az + wb * bz;
      }
      const zc = outside ? this.D - z : -z;
      const visible = outside ? z > 1 / this.D : zc > 0.05;
      if (s === 0) startA = visible;
      if (s === steps) endB = visible;
      if (!visible) { cur = null; continue; }
      if (!cur) segs.push((cur = []));
      cur.push([cx + (F * x) / zc, cy - (F * y) / zc]);
    }
    return { segs, startA, endB };
  }
}
