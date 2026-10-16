// Flat 2D view: pan and zoom with d3-zoom; more pages fit as you zoom in.
// d3 is loaded from a CDN, and only when this view is switched on (FEATURES.flat in main.js).
import { select, zoom, zoomIdentity } from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

export class FlatView {
  constructor(scene, hooks) {
    this.scene = scene;
    this.hooks = hooks;
    this.t = zoomIdentity;
    this.savedCount = scene.graph.nodes.filter((n) => n.saved).length;
    this.zoom = zoom()
      .scaleExtent([0.5, 14])
      .clickDistance(4)
      .on('start', () => scene.canvas.classList.add('dragging'))
      .on('end', () => scene.canvas.classList.remove('dragging'))
      .on('zoom', (e) => {
        this.t = e.transform;
        hooks.onMove?.();
        scene.invalidate();
      });
  }

  attach() {
    const { canvas } = this.scene;
    this.sel = select(canvas).call(this.zoom).call(this.zoom.transform, this.t);
    this.sel.on('dblclick.zoom', null);
    canvas.addEventListener('pointermove', this.hooks.onPointerMove);
    canvas.addEventListener('pointerleave', this.hooks.onPointerLeave);
    canvas.addEventListener('click', this.hooks.onClick);
  }

  detach() {
    const { canvas } = this.scene;
    this.sel.interrupt().on('.zoom', null);
    canvas.removeEventListener('pointermove', this.hooks.onPointerMove);
    canvas.removeEventListener('pointerleave', this.hooks.onPointerLeave);
    canvas.removeEventListener('click', this.hooks.onClick);
  }

  // Bounds of the saved pages, ignoring a couple of outliers on each side (reachable by panning).
  get bounds() {
    if (!this._bounds) {
      const saved = this.scene.graph.nodes.filter((n) => n.saved);
      const q = (arr, f) => arr.sort((a, b) => a - b)[Math.round((arr.length - 1) * f)];
      const xs = saved.map((n) => n.p2[0]), ys = saved.map((n) => n.p2[1]);
      const x0 = q(xs, 0.02), x1 = q(xs, 0.98), y0 = q(ys, 0.02), y1 = q(ys, 0.98);
      this._bounds = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    }
    return this._bounds;
  }

  // Vertical centre, nudged up to clear the timeline bar.
  get centerY() {
    return (this.scene.h - 36) / 2;
  }

  // Pixels per layout unit at zoom 1, fitting the saved pages (plus room for labels) to the
  // canvas. The build spaces saved labels for 330px per unit, so smaller screens hide some
  // until zoomed.
  get unit() {
    const b = this.bounds;
    return Math.max(60, Math.min((this.scene.w - 220) / b.w, (this.scene.h - 70) / b.h));
  }

  project(scene) {
    const { t } = this;
    const U = this.unit, b = this.bounds, cx = scene.w / 2, cy = this.centerY;
    const k = Math.min(1.25, Math.pow(t.k, 0.12));
    scene.graph.nodes.forEach((n, i) => {
      scene.px[i] = t.x + t.k * (cx + (n.p2[0] - b.cx) * U);
      scene.py[i] = t.y + t.k * (cy + (n.p2[1] - b.cy) * U);
      scene.pk[i] = k;
      scene.pa[i] = 1;
      scene.pz[i] = 0;
    });
  }

  // How many ranked nodes may be considered at this zoom.
  budget() {
    return this.savedCount + Math.round(30 * this.t.k * this.t.k);
  }

  // Straight line between two nodes, in the same shape as SphereView.edgePolyline.
  edgePolyline(a, b, scene) {
    return { segs: [[[scene.px[a], scene.py[a]], [scene.px[b], scene.py[b]]]], startA: true, endB: true };
  }

  flyTo(i) {
    const { scene } = this;
    const n = scene.graph.nodes[i];
    const U = this.unit, b = this.bounds;
    const k = Math.max(this.t.k, n.saved ? 2.5 : 4);
    const x = scene.w / 2 + (n.p2[0] - b.cx) * U, y = this.centerY + (n.p2[1] - b.cy) * U;
    const t = zoomIdentity.translate(scene.w / 2, this.centerY).scale(k).translate(-x, -y);
    this.sel.transition().duration(900).call(this.zoom.transform, t);
  }

  reset() {
    this.sel.transition().duration(600).call(this.zoom.transform, zoomIdentity);
  }
}
