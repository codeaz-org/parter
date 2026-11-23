// Draws the floor plan onto any 2D canvas context. Used by the editor, by thumbnails and by the
// PNG export, in the browser and (with node-canvas) in tests. No DOM access in here.
import { CAT, MATS, partsOf, partTop } from './catalog.js';
import { wallAxis, opState } from './scene.js';

const FONT = '"Barlow Semi Condensed","Arial Narrow",sans-serif';

/** A neutral light palette, used for exports and as the fallback. */
export const LIGHT = {
  bg: '#ffffff', floor: '#ffffff', wall: '#1d2832', ink: '#1d2832', muted: '#667481', grid: '#e3e8ec',
  accent: '#2b5c8f', amber: '#b4740b', itemLine: '#3b4854', itemFill: '', dark: false
};

export function fitView(bounds, W, H, pad = 24) {
  const bw = Math.max(1, bounds.x1 - bounds.x0), bh = Math.max(1, bounds.y1 - bounds.y0);
  return { cx: (bounds.x0 + bounds.x1) / 2, cy: (bounds.y0 + bounds.y1) / 2, s: Math.max(4, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)) };
}

export function drawParts(ctx, parts, lw, pal) {
  const ps = parts.slice().sort((a, b) => partTop(a) - partTop(b));
  ctx.lineWidth = lw; ctx.strokeStyle = pal.itemLine;
  for (const p of ps) {
    const m = MATS[p.m];
    // overhead pieces (wall cabinets, hoods) are drawn dashed, as on an architect's drawing
    const over = p.t === 'b' && p.y >= 1.4 && (p.m === 'cabinet' || p.m === 'metal' || p.m === 'dark');
    if (over && Math.min(p.w, p.d) < 0.05) continue;
    ctx.beginPath();
    if (p.t === 'b') ctx.rect(p.x - p.w / 2, p.z - p.d / 2, p.w, p.d); else ctx.arc(p.x, p.z, p.r, 0, 7);
    if (over) { ctx.save(); ctx.setLineDash([lw * 4, lw * 3]); ctx.stroke(); ctx.restore(); continue; }
    if (m.t) { ctx.fillStyle = pal.dark ? pal.itemFill : m.t; ctx.fill(); }
    ctx.stroke();
  }
}

function opRect(w, op, X, Y, s) {
  const ax = wallAxis(w);
  return {
    ax,
    x: ax === 'x' ? X(op.a) : X(w.x0), y: ax === 'x' ? Y(w.y1) : Y(op.b),
    w: (ax === 'x' ? op.b - op.a : w.x1 - w.x0) * s, h: (ax === 'x' ? w.y1 - w.y0 : op.b - op.a) * s
  };
}

/**
 * @param ctx  2D context, already scaled for device pixels
 * @param W,H  size in CSS pixels
 * @param v    view {cx, cy, s}: world point at the centre, and pixels per metre
 * @param pal  palette (see LIGHT)
 * @param scene, an   the scene and its rooms.analyze() result
 * @param o    { ui, mode, sel, selOp, selWall, selRoom, underlay, clean, aspect, draft, marks }
 */
export function drawPlan(ctx, W, H, v, pal, scene, an, o = {}) {
  const X = x => W / 2 + (x - v.cx) * v.s, Y = y => H / 2 - (y - v.cy) * v.s, s = v.s;
  const build = o.mode === 'build';
  ctx.save();
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);

  if (s > 13 && !o.clean) {
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1; ctx.beginPath();
    const gx0 = Math.floor(v.cx - W / 2 / s), gx1 = Math.ceil(v.cx + W / 2 / s), gy0 = Math.floor(v.cy - H / 2 / s), gy1 = Math.ceil(v.cy + H / 2 / s);
    for (let x = gx0; x <= gx1; x++) { const px = Math.round(X(x)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
    for (let y = gy0; y <= gy1; y++) { const py = Math.round(Y(y)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(W, py); }
    ctx.stroke();
  }

  // floors: every detected room
  ctx.fillStyle = pal.floor;
  for (const r of an.regions) for (const q of r.rects) ctx.fillRect(X(q.x0), Y(q.y1), (q.x1 - q.x0) * s + 0.5, (q.y1 - q.y0) * s + 0.5);

  // scanned plan underneath, for tracing and checking
  const ul = o.underlay;
  if (ul && ul.img) {
    ctx.save(); ctx.globalAlpha = ul.opacity == null ? 0.5 : ul.opacity;
    try { ctx.drawImage(ul.img, X(ul.x), Y(ul.y + ul.h), ul.w * s, ul.h * s); } catch (e) { /* image not ready */ }
    ctx.restore();
  }

  // outside steps
  ctx.strokeStyle = pal.muted; ctx.lineWidth = 1;
  for (const t of scene.steps || []) for (let i = 1; i <= 3; i++) {
    const y = t.y + t.dir * 0.3 * i;
    ctx.strokeRect(X(t.x0), Y(Math.max(t.y, y)), (t.x1 - t.x0) * s, 0.3 * i * s);
  }

  // room names and areas
  if (s > 17) {
    ctx.textAlign = 'center'; ctx.fillStyle = pal.muted;
    for (const r of an.regions) {
      const name = r.name || (build ? 'Room' : '');
      const fs = Math.max(10.5, Math.min(16, s * 0.3));
      if ((r.x1 - r.x0) * s < fs * 3) continue;
      ctx.textBaseline = 'alphabetic';
      ctx.font = '600 ' + fs + 'px ' + FONT;
      if (name) ctx.fillText(name, X(r.lx), Y(r.ly));
      ctx.font = '500 ' + (fs * 0.86) + 'px ' + FONT;
      ctx.fillText(r.area.toFixed(1) + ' m²', X(r.lx), Y(r.ly) + fs * 1.1);
    }
  }

  const drawItem = it => {
    ctx.save(); ctx.translate(X(it.x), Y(it.y)); ctx.rotate(-it.r * Math.PI / 180); ctx.scale(it.f ? -s : s, s);
    drawParts(ctx, partsOf(it.t, it.w, it.d), 1.1 / s, pal); ctx.restore();
  };
  ctx.save();
  if (build) ctx.globalAlpha = 0.3;
  for (const it of scene.items) if (CAT[it.t].flat) drawItem(it);
  ctx.restore();

  // walls
  ctx.save();
  if (ul && ul.img) ctx.globalAlpha = 0.62;
  for (const w of scene.walls) {
    if (w.v) {
      ctx.save(); ctx.strokeStyle = pal.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      if (build || o.ui) ctx.strokeRect(X(w.x0), Y(w.y1), (w.x1 - w.x0) * s, (w.y1 - w.y0) * s);
      ctx.restore(); continue;
    }
    ctx.fillStyle = pal.wall;
    ctx.fillRect(X(w.x0), Y(w.y1), (w.x1 - w.x0) * s, (w.y1 - w.y0) * s);
  }
  ctx.restore();

  // openings
  for (const w of scene.walls) {
    for (const op of w.ops) {
      const q = opRect(w, op, X, Y, s), ax = q.ax, st = opState(op, an.ext.has(op.id));
      if (st === 'wall') {
        if (o.ui) { ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = pal.floor; ctx.lineWidth = 1; ctx.strokeRect(q.x + 1.5, q.y + 1.5, q.w - 3, q.h - 3); ctx.restore(); }
        continue;
      }
      const shut = st === 'closed';
      const mid = () => { ctx.beginPath(); if (ax === 'x') { ctx.moveTo(q.x, q.y + q.h / 2); ctx.lineTo(q.x + q.w, q.y + q.h / 2); } else { ctx.moveTo(q.x + q.w / 2, q.y); ctx.lineTo(q.x + q.w / 2, q.y + q.h); } ctx.stroke(); };
      const leaf = () => { ctx.save(); ctx.lineWidth = op.gl ? 1.2 : 3; ctx.strokeStyle = pal.wall; mid(); if (op.gl) { ctx.strokeRect(q.x + (ax === 'x' ? 0 : q.w * 0.3), q.y + (ax === 'x' ? q.h * 0.3 : 0), ax === 'x' ? q.w : q.w * 0.4, ax === 'x' ? q.h * 0.4 : q.h); } ctx.restore(); };
      ctx.fillStyle = pal.floor; ctx.fillRect(q.x, q.y, q.w, q.h);
      ctx.strokeStyle = pal.wall; ctx.lineWidth = 1.2;
      if (op.k === 'win') { ctx.strokeRect(q.x, q.y, q.w, q.h); mid(); }
      else if (op.k === 'door') {
        const len = op.b - op.a, hg = op.h === 'a' ? op.a : op.b, sw = op.s || 1;
        let px, py, aL, aJ;
        if (ax === 'x') { px = hg; py = sw > 0 ? w.y1 : w.y0; aL = sw > 0 ? Math.PI / 2 : -Math.PI / 2; aJ = op.h === 'a' ? 0 : Math.PI; }
        else { py = hg; px = sw > 0 ? w.x1 : w.x0; aL = sw > 0 ? 0 : Math.PI; aJ = op.h === 'a' ? Math.PI / 2 : -Math.PI / 2; }
        const cx = X(px), cy = Y(py), R = len * s, a1 = -aL, a2 = -aJ;
        let df = (a2 - a1) % (2 * Math.PI); if (df < 0) df += 2 * Math.PI;
        if (shut) leaf(); else { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R); ctx.stroke(); }
        ctx.save(); ctx.lineWidth = 0.8; ctx.strokeStyle = pal.muted; ctx.beginPath(); ctx.arc(cx, cy, R, a1, a2, df > Math.PI); ctx.stroke(); ctx.restore();
      } else {
        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = pal.muted; ctx.strokeRect(q.x, q.y, q.w, q.h); ctx.restore();
        if (shut) leaf();
      }
    }
  }

  ctx.save();
  if (build) ctx.globalAlpha = 0.3;
  for (const it of scene.items) if (!CAT[it.t].flat) drawItem(it);
  // names on boxy pieces that are hard to tell apart
  if (s > 20) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const it of scene.items) {
      const tg = CAT[it.t].tag; if (!tg) continue;
      const fs = Math.max(9, Math.min(12.5, s * 0.2));
      ctx.font = '600 ' + fs + 'px ' + FONT;
      if (ctx.measureText(tg).width > Math.max(it.w, it.d) * s + 2 || fs > Math.min(it.w, it.d) * s) continue;
      let a = -it.r * Math.PI / 180 + (it.d > it.w ? Math.PI / 2 : 0);
      while (a > Math.PI / 2 + 0.01) a -= Math.PI; while (a <= -Math.PI / 2 + 0.01) a += Math.PI;
      ctx.save(); ctx.translate(X(it.x), Y(it.y)); ctx.rotate(a);
      ctx.lineWidth = 3; ctx.strokeStyle = pal.dark ? pal.floor : 'rgba(255,255,255,.85)'; ctx.strokeText(tg, 0, 0.5);
      ctx.fillStyle = pal.ink; ctx.fillText(tg, 0, 0.5); ctx.restore();
    }
  }
  ctx.restore();

  if (!o.ui) { ctx.restore(); return; }

  // ---------- editor overlays ----------
  const dashBox = (x, y, w, h, pad) => { ctx.save(); ctx.strokeStyle = pal.accent; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]); ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2); ctx.restore(); };
  const dot = (x, y, r, fill, ring) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = ring; ctx.stroke(); };

  if (build) {
    // room label pins
    for (const t of scene.rooms) {
      const on = t.id === o.selRoom;
      dot(X(t.x), Y(t.y) - Math.max(10.5, Math.min(16, s * 0.3)) * 1.05, on ? 6 : 3.5, on ? pal.accent : pal.muted, pal.floor);
    }
    const sw = scene.walls.find(w => w.id === o.selWall);
    if (sw) {
      dashBox(X(sw.x0), Y(sw.y1), (sw.x1 - sw.x0) * s, (sw.y1 - sw.y0) * s, 4);
      const ax = wallAxis(sw), mx = (sw.x0 + sw.x1) / 2, my = (sw.y0 + sw.y1) / 2;
      if (ax === 'x') { dot(X(sw.x0), Y(my), 8, pal.accent, pal.floor); dot(X(sw.x1), Y(my), 8, pal.accent, pal.floor); }
      else { dot(X(mx), Y(sw.y0), 8, pal.accent, pal.floor); dot(X(mx), Y(sw.y1), 8, pal.accent, pal.floor); }
      ctx.fillStyle = pal.accent; ctx.font = '600 13px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const len = Math.max(sw.x1 - sw.x0, sw.y1 - sw.y0);
      ctx.fillText(len.toFixed(2) + ' m', X(mx), Y(sw.y1) - 10);
    }
    if (o.draft) {
      const d = o.draft; ctx.save(); ctx.globalAlpha = 0.6; ctx.fillStyle = pal.accent;
      ctx.fillRect(X(d.x0), Y(d.y1), (d.x1 - d.x0) * s, (d.y1 - d.y0) * s); ctx.restore();
      ctx.fillStyle = pal.accent; ctx.font = '600 13px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(Math.max(d.x1 - d.x0, d.y1 - d.y0).toFixed(2) + ' m', X((d.x0 + d.x1) / 2), Y(d.y1) - 8);
    }
  }
  for (const m of o.marks || []) { dot(X(m.x), Y(m.y), 6, pal.amber, pal.floor); }

  if (o.selOp) {
    for (const w of scene.walls) { const op = w.ops.find(p => p.id === o.selOp); if (op) { const q = opRect(w, op, X, Y, s); dashBox(q.x, q.y, q.w, q.h, 5); } }
  }

  if (!build) {
    const c = scene.cam, cx = X(c.x), cy = Y(c.y), hf = Math.atan(Math.tan(c.fov * Math.PI / 360) * (o.aspect || 4 / 3)), Rr = Math.max(60, 2.4 * s);
    ctx.fillStyle = pal.amber; ctx.globalAlpha = 0.2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, Rr, -c.yaw - hf, -c.yaw + hf); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = pal.amber; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(c.yaw) * 46, cy - Math.sin(c.yaw) * 46); ctx.stroke();
    dot(cx, cy, 10, pal.amber, pal.floor);
    ctx.beginPath(); ctx.arc(cx + Math.cos(c.yaw) * 46, cy - Math.sin(c.yaw) * 46, 6.5, 0, 7); ctx.fillStyle = pal.floor; ctx.fill(); ctx.strokeStyle = pal.amber; ctx.lineWidth = 2.5; ctx.stroke();

    const it = scene.items.find(i => i.id === o.sel);
    if (it) {
      ctx.save(); ctx.translate(X(it.x), Y(it.y)); ctx.rotate(-it.r * Math.PI / 180);
      ctx.strokeStyle = pal.accent; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(-it.w / 2 * s - 4, -it.d / 2 * s - 4, it.w * s + 8, it.d * s + 8);
      ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(0, -it.d / 2 * s - 4); ctx.lineTo(0, -it.d / 2 * s - 30); ctx.stroke();
      dot(0, -it.d / 2 * s - 30, 8, pal.accent, pal.floor); ctx.restore();
    }
  }

  // scale bar
  const m = s > 70 ? 1 : s > 28 ? 2 : 5, bx = 14, by = 18;
  ctx.strokeStyle = pal.ink; ctx.fillStyle = pal.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + m * s, by); ctx.lineTo(bx + m * s, by - 4); ctx.stroke();
  ctx.font = '600 13px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(m + ' m', bx, by + 4);
  ctx.restore();
}
