// Parter editor: state, the 2D plan with its two editing modes, selection bars, undo and autosave.
// Sheets and AI panels live in panels.js; the 3D pane in view3d.js; storage in store.js.
import { CAT, partsOf, natH } from '../core/catalog.js';
import {
  newScene, serialize, uid, r2, snap, wallAxis, wallSpan, wallThick, wallLen, opBounds, opDefaults, opState, findOp, findWall, findItem, sceneBounds
} from '../core/scene.js';
import { analyze } from '../core/rooms.js';
import { drawPlan, drawParts, fitView, LIGHT } from '../core/plan2d.js';
import { shiftWall, moveWall } from '../core/ops.js';
import { store } from './store.js';
import { createView3D } from './view3d.js';
import { initPanels } from './panels.js';

const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
const RAD = Math.PI / 180, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm = a => ((a + 180) % 360 + 360) % 360 - 180;
const press = (sel, attr, val) => { for (const b of $$(sel + ' button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === val)); };
const KIND_NAME = { win: 'Window', door: 'Door', open: 'Opening', garage: 'Garage door' };

// ---------- state ----------
const A = {
  id: null, scene: newScene(), an: null,
  sel: null, selOp: null, selWall: null, selRoom: null,
  pm: 'furnish', tool: null, wallT: 0.2, draft: null, marks: [],
  V: { mode: 'eye', look: 'colour', asp: '4:3', orbit: { th: -0.6, ph: 0.78, r: 27, tx: 2.5, tz: -7.7 } },
  underImg: null, undo: [], lastSnap: '', busy: false,
  $, $$, press, store
};
A.an = analyze(A.scene);

let toastT = 0;
A.toast = (m, ms = 3000) => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); };
A.hint = m => { const h = $('#hint'); h.textContent = m || ''; h.hidden = !m; };

// ---------- palette (follows the page theme) ----------
let pal = LIGHT;
function readPal() {
  const cs = getComputedStyle(document.documentElement), g = n => cs.getPropertyValue(n).trim();
  pal = {
    bg: g('--paper') || LIGHT.bg, floor: g('--floor') || '#fff', wall: g('--wall') || LIGHT.wall, ink: g('--ink') || LIGHT.ink, muted: g('--muted') || LIGHT.muted,
    grid: g('--grid') || LIGHT.grid, accent: g('--accent') || LIGHT.accent, amber: g('--amber') || LIGHT.amber, itemLine: g('--item-line') || LIGHT.itemLine,
    itemFill: g('--item-fill'), dark: g('--mode') === 'dark'
  };
}

// ---------- undo + save ----------
const snapState = () => { const s = A.scene; return JSON.stringify({ walls: s.walls, rooms: s.rooms, steps: s.steps, items: s.items, ceiling: s.ceiling, underlay: s.underlay }); };
let saveT = 0;
A.save = () => {
  A.scene.meta.modified = Date.now();
  clearTimeout(saveT);
  saveT = setTimeout(async () => { if (A.id && !(await store.save(A.id, A.scene))) A.toast(store.saveError || 'Could not save. Storage may be full: export the project file to keep your work.'); }, 350);
};
A.structChanged = () => { A.an = analyze(A.scene); view.rebuildHouse(); };
/** Call after any edit. `struct` = walls, openings, rooms or ceiling changed. */
A.commit = (struct) => {
  if (struct) A.structChanged();
  const n = snapState();
  if (n !== A.lastSnap) { A.undo.push(A.lastSnap); if (A.undo.length > 80) A.undo.shift(); A.lastSnap = n; }
  for (const b of $$('[data-undo]')) b.disabled = !A.undo.length;
  A.save(); updateBars(); draw(); view.render();
};
function undo() {
  if (!A.undo.length) return;
  A.lastSnap = A.undo.pop(); Object.assign(A.scene, JSON.parse(A.lastSnap));
  clearSel(); for (const b of $$('[data-undo]')) b.disabled = !A.undo.length;
  A.structChanged(); A.save(); syncPanel(); updateBars(); draw(); view.render();
}
for (const b of $$('[data-undo]')) b.onclick = undo;

/** Swap in a whole scene (open a project, external update, undo of an import). */
A.setScene = (scene, id, { keepView, undoable } = {}) => {
  const before = A.lastSnap;
  A.scene = scene; if (id !== undefined) A.id = id;
  clearSel(); A.tool = null; A.draft = null; A.marks = [];
  A.lastSnap = snapState();
  if (undoable && before && before !== A.lastSnap) A.undo.push(before); else if (!undoable) A.undo.length = 0;
  for (const b of $$('[data-undo]')) b.disabled = !A.undo.length;
  A.an = analyze(scene); view.rebuildHouse();
  if (!keepView) { fitPlan(); view.frameOrbit(); }
  $('#projName').textContent = scene.name; document.title = scene.name + ' – Parter';
  syncPanel(); syncUnderPanel(); updateBars(); draw(); view.render();
};

// ---------- plan canvas ----------
const planCv = $('#plan'), pctx = planCv.getContext('2d');
let PW = 0, PH = 0, pv = { cx: 0, cy: 0, s: 30 }, planQueued = false;
function fitPlan() {
  if (!PW) return;
  const b = sceneBounds(A.scene), u = A.scene.underlay;
  if (u && !A.scene.walls.length) { b.x0 = Math.min(b.x0, u.x); b.y0 = Math.min(b.y0, u.y); b.x1 = Math.max(b.x1, u.x + u.w); b.y1 = Math.max(b.y1, u.y + u.h); }
  pv = fitView({ x0: b.x0 - 0.6, y0: b.y0 - 0.6, x1: b.x1 + 0.6, y1: b.y1 + 0.6 }, PW, Math.max(120, PH - 80), 10);
  pv.cy -= 40 / pv.s;
}
function sizePlan() {
  const r = planCv.parentElement.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
  const first = !PW; PW = r.width; PH = r.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5); planCv.width = Math.round(PW * dpr); planCv.height = Math.round(PH * dpr);
  if (first) fitPlan();
  drawNow();
}
function drawNow() {
  planQueued = false; if (!PW || !pctx) return;
  const dpr = planCv.width / PW, u = A.scene.underlay; pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPlan(pctx, PW, PH, pv, pal, A.scene, A.an, {
    ui: true, mode: A.pm, sel: A.sel, selOp: A.selOp, selWall: A.selWall, selRoom: A.selRoom, aspect: view.aspect(), draft: A.draft, marks: A.marks,
    underlay: (A.underImg && u && u.show !== false) ? Object.assign({ img: A.underImg }, u) : null
  });
  $('#scaleRead').textContent = 'Scale 1:' + Math.max(1, Math.round(3779.5 / pv.s));
}
function draw() { if (!planQueued) { planQueued = true; requestAnimationFrame(drawNow); } }
A.draw = draw;
const toW = p => ({ x: pv.cx + (p.x - PW / 2) / pv.s, y: pv.cy - (p.y - PH / 2) / pv.s });
const toS = (x, y) => ({ x: PW / 2 + (x - pv.cx) * pv.s, y: PH / 2 - (y - pv.cy) * pv.s });
const evPt = (e, el) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
A.toScreen = toS; A.toWorld = toW;

// ---------- hit testing ----------
function hitItem(w, touch) {
  const pad = (touch ? 10 : 4) / pv.s, items = A.scene.items;
  const order = items.filter(i => !CAT[i.t].flat).reverse().concat(items.filter(i => CAT[i.t].flat).reverse());
  for (const it of order) {
    const th = it.r * RAD, dx = w.x - it.x, dy = w.y - it.y, u = dx * Math.cos(th) + dy * Math.sin(th), z = dx * Math.sin(th) - dy * Math.cos(th);
    const hw = Math.max(it.w / 2, (touch ? 20 : 8) / pv.s) + pad, hd = Math.max(it.d / 2, (touch ? 20 : 8) / pv.s) + pad;
    if (Math.abs(u) <= hw && Math.abs(z) <= hd) return it;
  }
  return null;
}
function inItem(it, w) { const th = it.r * RAD, dx = w.x - it.x, dy = w.y - it.y; return Math.abs(dx * Math.cos(th) + dy * Math.sin(th)) <= it.w / 2 && Math.abs(dx * Math.sin(th) - dy * Math.cos(th)) <= it.d / 2; }
function hitOp(w, touch) {
  const pad = (touch ? 9 : 3) / pv.s;
  for (const wall of A.scene.walls) {
    const ax = wallAxis(wall);
    for (const op of wall.ops) {
      const x0 = ax === 'x' ? op.a : wall.x0, x1 = ax === 'x' ? op.b : wall.x1, y0 = ax === 'x' ? wall.y0 : op.a, y1 = ax === 'x' ? wall.y1 : op.b;
      if (w.x >= x0 - pad && w.x <= x1 + pad && w.y >= y0 - pad && w.y <= y1 + pad) return { wall, op };
    }
  }
  return null;
}
function hitWall(w, touch) {
  const pad = (touch ? 9 : 3) / pv.s; let best = null, bd = Infinity;
  for (const wall of A.scene.walls) {
    if (w.x < wall.x0 - pad || w.x > wall.x1 + pad || w.y < wall.y0 - pad || w.y > wall.y1 + pad) continue;
    const d = wallThick(wall); if (d < bd) { bd = d; best = wall; }           // thin walls win where walls cross
  }
  return best;
}
const labelLift = () => Math.max(10.5, Math.min(16, pv.s * 0.3)) * 1.05;
function hitRoomPin(p, touch) {
  const rr = touch ? 20 : 12;
  for (const t of A.scene.rooms) { const s = toS(t.x, t.y); if (Math.hypot(p.x - s.x, p.y - (s.y - labelLift())) <= rr) return t; }
  return null;
}
function wallEnds(wall) {
  const ax = wallAxis(wall), mx = (wall.x0 + wall.x1) / 2, my = (wall.y0 + wall.y1) / 2;
  return ax === 'x' ? [toS(wall.x0, my), toS(wall.x1, my)] : [toS(mx, wall.y0), toS(mx, wall.y1)];
}
function handlePos(it) { const th = it.r * RAD, off = it.d / 2 + 30 / pv.s; return toS(it.x - Math.sin(th) * off, it.y + Math.cos(th) * off); }

// ---------- selection ----------
function clearSel() { A.sel = A.selOp = A.selWall = A.selRoom = null; }
A.select = (kind, id) => { clearSel(); if (kind) A[kind] = id; updateBars(); draw(); };
const selItem = () => findItem(A.scene, A.sel);
const selOpCtx = () => { const f = A.selOp && findOp(A.scene, A.selOp); if (!f) return null; const [lo, hi] = opBounds(f.wall, f.op, 0.1); return { wall: f.wall, op: f.op, ax: wallAxis(f.wall), lo, hi }; };

// ---------- pointer interaction ----------
const pts = new Map(); let drag = null;
planCv.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { planCv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  const p = evPt(e, planCv); pts.set(e.pointerId, p); closeMore(); if (!A.tool) A.hint('');
  if (pts.size === 2) {
    finishDrag(true);
    const a = Array.from(pts.values()), mid = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }, u = A.scene.underlay;
    drag = { k: 'pinch', d0: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, s0: pv.s, w0: toW(mid), under: A.tool === 'under' && u ? { x: u.x, y: u.y, w: u.w, h: u.h } : null };
    return;
  }
  if (pts.size > 2) return;
  const w = toW(p), touch = e.pointerType !== 'mouse', rr = touch ? 24 : 14;
  const pan = () => { drag = { k: 'pan', sx: p.x, sy: p.y, cx0: pv.cx, cy0: pv.cy, moved: false }; planCv.style.cursor = 'grabbing'; };

  if (A.pm === 'build') {
    if (A.tool === 'wall') { const sx = snap(w.x), sy = snap(w.y); drag = { k: 'draft', sx, sy }; A.draft = null; return; }
    if (A.tool === 'under' && A.scene.underlay) { const u = A.scene.underlay; drag = { k: 'under', ox: w.x - u.x, oy: w.y - u.y, moved: false }; return; }
    if (A.tool === 'calib' || A.tool === 'room') { drag = { k: 'tap', sx: p.x, sy: p.y, w }; return; }
    const sw = findWall(A.scene, A.selWall);
    if (sw) { const ends = wallEnds(sw); for (let n = 0; n < 2; n++) if (Math.hypot(p.x - ends[n].x, p.y - ends[n].y) <= rr) { drag = { k: 'wallend', id: sw.id, end: n, moved: false }; return; } }
    const ho = hitOp(w, touch);
    if (ho) { A.select('selOp', ho.op.id); drag = { k: 'op', off: (wallAxis(ho.wall) === 'x' ? w.x : w.y) - ho.op.a, sx: p.x, sy: p.y, moved: false }; return; }
    const pin = hitRoomPin(p, touch);
    if (pin) { A.select('selRoom', pin.id); drag = { k: 'pin', id: pin.id, moved: false, sx: p.x, sy: p.y }; return; }
    const hw = hitWall(w, touch);
    if (hw) { A.select('selWall', hw.id); drag = { k: 'wall', id: hw.id, wx: w.x, wy: w.y, ax: 0, ay: 0, sx: p.x, sy: p.y, moved: false }; planCv.style.cursor = 'grabbing'; return; }
    pan(); return;
  }

  // furnish mode
  const c = A.scene.cam, cs = toS(c.x, c.y), cd = { x: cs.x + Math.cos(c.yaw) * 46, y: cs.y - Math.sin(c.yaw) * 46 }, si = selItem();
  if (si) { const h = handlePos(si); if (Math.hypot(p.x - h.x, p.y - h.y) <= rr) { drag = { k: 'rot', id: si.id }; return; } }
  if (Math.hypot(p.x - cd.x, p.y - cd.y) <= rr) { drag = { k: 'camdir' }; return; }
  if (Math.hypot(p.x - cs.x, p.y - cs.y) <= rr) { drag = { k: 'cam', ox: w.x - c.x, oy: w.y - c.y }; return; }
  const it = hitItem(w, touch), ho = hitOp(w, touch);
  if (ho && !(it && inItem(it, w))) { A.select('selOp', ho.op.id); drag = { k: 'op', off: (wallAxis(ho.wall) === 'x' ? w.x : w.y) - ho.op.a, sx: p.x, sy: p.y, moved: false }; return; }
  if (it) { A.select('sel', it.id); drag = { k: 'item', id: it.id, ox: w.x - it.x, oy: w.y - it.y, sx: p.x, sy: p.y, moved: false }; planCv.style.cursor = 'grabbing'; return; }
  pan();
});

planCv.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId) || !drag) return; const p = evPt(e, planCv); pts.set(e.pointerId, p);
  if (drag.k === 'pinch') {
    if (pts.size < 2) return;
    const a = Array.from(pts.values()), mid = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }, f = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) / drag.d0;
    if (drag.under) { scaleUnderlay(drag.under, f, drag.w0); draw(); return; }
    pv.s = clamp(drag.s0 * f, 5, 260); pv.cx = drag.w0.x - (mid.x - PW / 2) / pv.s; pv.cy = drag.w0.y + (mid.y - PH / 2) / pv.s; draw(); return;
  }
  const w = toW(p), far = (d = 4) => Math.hypot(p.x - drag.sx, p.y - drag.sy) >= d;
  switch (drag.k) {
    case 'item': {
      const it = findItem(A.scene, drag.id); if (!it || (!drag.moved && !far())) return; drag.moved = true;
      it.x = snap(w.x - drag.ox); it.y = snap(w.y - drag.oy); draw(); view.render(); break;
    }
    case 'rot': {
      const it = findItem(A.scene, drag.id); if (!it) return;
      it.r = norm(snap(Math.atan2(w.y - it.y, w.x - it.x) / RAD - 90, 15)); drag.moved = true; draw(); view.render(); break;
    }
    case 'op': {
      const c = selOpCtx(); if (!c || (!drag.moved && !far(5))) return; drag.moved = true;
      const len = c.op.b - c.op.a, a = clamp(snap((c.ax === 'x' ? w.x : w.y) - drag.off), c.lo, Math.max(c.lo, c.hi - len));
      c.op.a = r2(a); c.op.b = r2(a + len); draw(); break;
    }
    case 'cam': A.scene.cam.x = w.x - drag.ox; A.scene.cam.y = w.y - drag.oy; draw(); view.render(); break;
    case 'camdir': A.scene.cam.yaw = Math.atan2(w.y - A.scene.cam.y, w.x - A.scene.cam.x); draw(); view.render(); break;
    case 'pan': if (far(5)) drag.moved = true; pv.cx = drag.cx0 - (p.x - drag.sx) / pv.s; pv.cy = drag.cy0 + (p.y - drag.sy) / pv.s; draw(); break;
    case 'draft': {
      const cx = snap(w.x), cy = snap(w.y), t = A.wallT, alongX = Math.abs(cx - drag.sx) >= Math.abs(cy - drag.sy);
      A.draft = alongX ? { x0: Math.min(drag.sx, cx), x1: Math.max(drag.sx, cx), y0: drag.sy, y1: r2(drag.sy + t) } : { x0: drag.sx, x1: r2(drag.sx + t), y0: Math.min(drag.sy, cy), y1: Math.max(drag.sy, cy) };
      draw(); break;
    }
    case 'wall': {
      const wall = findWall(A.scene, drag.id); if (!wall || (!drag.moved && !far(5))) return; drag.moved = true;
      const dx = snap(w.x - drag.wx), dy = snap(w.y - drag.wy);
      if (dx !== drag.ax || dy !== drag.ay) { shiftWall(wall, dx - drag.ax, dy - drag.ay); drag.ax = dx; drag.ay = dy; A.an = analyze(A.scene); draw(); }
      break;
    }
    case 'wallend': {
      const wall = findWall(A.scene, drag.id); if (!wall) return; drag.moved = true;
      const ax = wallAxis(wall), v = snap(ax === 'x' ? w.x : w.y), min = wallThick(wall) + 0.1;
      let { x0, y0, x1, y1 } = wall;
      if (ax === 'x') { if (drag.end === 0) x0 = Math.min(v, x1 - min); else x1 = Math.max(v, x0 + min); }
      else { if (drag.end === 0) y0 = Math.min(v, y1 - min); else y1 = Math.max(v, y0 + min); }
      moveWall(wall, x0, y0, x1, y1); A.an = analyze(A.scene); draw(); break;
    }
    case 'pin': {
      const t = A.scene.rooms.find(r => r.id === drag.id); if (!t || (!drag.moved && !far(5))) return; drag.moved = true;
      t.x = r2(w.x); t.y = r2(w.y - labelLift() / pv.s); A.an = analyze(A.scene); draw(); break;
    }
    case 'under': { const u = A.scene.underlay; if (!u) return; drag.moved = true; u.x = r2(w.x - drag.ox); u.y = r2(w.y - drag.oy); draw(); break; }
    default: break;
  }
});

function finishDrag(interrupted) {
  if (!drag) return;
  const d = drag; drag = null;
  switch (d.k) {
    case 'item': case 'rot': if (d.moved) A.commit(); break;
    case 'op': case 'wall': case 'wallend': case 'pin': if (d.moved) A.commit(true); break;
    case 'under': if (d.moved) A.commit(); break;
    case 'cam': case 'camdir': A.save(); break;
    case 'pinch': if (d.under) A.commit(); break;
    case 'pan': if (!d.moved && !interrupted) A.select(null); break;
    case 'draft': {
      const r = A.draft; A.draft = null;
      if (!interrupted && r && Math.max(r.x1 - r.x0, r.y1 - r.y0) >= 0.3) {
        const wall = { id: uid('w'), x0: r2(r.x0), y0: r2(r.y0), x1: r2(r.x1), y1: r2(r.y1), ops: [] };
        A.scene.walls.push(wall); A.commit(true);
      } else draw();
      break;
    }
    case 'tap': if (!interrupted) tapTool(d.w); break;
    default: break;
  }
}
function planUp(e) {
  if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); planCv.style.cursor = 'grab';
  if (drag && drag.k === 'pinch') { if (pts.size < 2) finishDrag(); return; }
  finishDrag(e.type === 'pointercancel'); updateBars();
}
planCv.addEventListener('pointerup', planUp); planCv.addEventListener('pointercancel', planUp);
planCv.addEventListener('wheel', e => {
  e.preventDefault(); const p = evPt(e, planCv), w = toW(p), f = Math.exp(-e.deltaY * 0.0015);
  if (A.tool === 'under' && A.scene.underlay) { const u = A.scene.underlay; scaleUnderlay({ x: u.x, y: u.y, w: u.w, h: u.h }, f, w); draw(); A.save(); return; }
  pv.s = clamp(pv.s * f, 5, 260); pv.cx = w.x - (p.x - PW / 2) / pv.s; pv.cy = w.y + (p.y - PH / 2) / pv.s; draw();
}, { passive: false });

planCv.addEventListener('keydown', e => {
  const st = e.shiftKey ? 0.25 : 0.05, it = selItem(), wall = findWall(A.scene, A.selWall);
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (e.key === 'Escape') { setTool(null); A.select(null); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  if (it) {
    if (dir) { it.x = snap(it.x + dir[0] * st); it.y = snap(it.y + dir[1] * st); }
    else if (e.key === 'r' || e.key === 'R') it.r = norm(it.r + (e.shiftKey ? -15 : 15));
    else return;
    e.preventDefault(); A.commit();
  } else if (wall && dir) { e.preventDefault(); shiftWall(wall, dir[0] * st, dir[1] * st); A.commit(true); }
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); undo(); }
});

function deleteSelected() {
  const s = A.scene;
  if (A.sel) { s.items = s.items.filter(i => i.id !== A.sel); A.sel = null; A.commit(); }
  else if (A.selWall) { s.walls = s.walls.filter(w => w.id !== A.selWall); A.selWall = null; A.commit(true); }
  else if (A.selOp && A.pm === 'build') { const f = findOp(s, A.selOp); if (f) f.wall.ops.splice(f.wall.ops.indexOf(f.op), 1); A.selOp = null; A.commit(true); }
  else if (A.selRoom) { s.rooms = s.rooms.filter(r => r.id !== A.selRoom); A.selRoom = null; A.commit(true); }
}

// ---------- build tools ----------
function setTool(t) {
  A.tool = t; A.draft = null; if (t !== 'calib') A.marks = [];
  $('#wallTool').setAttribute('aria-pressed', String(t === 'wall')); $('#roomTool').setAttribute('aria-pressed', String(t === 'room'));
  $('#underMove').setAttribute('aria-pressed', String(t === 'under'));
  A.hint({ wall: 'Drag on the plan to draw a wall. Tap Draw wall again when you are done.', room: 'Tap inside a room to name it.', under: 'Drag the picture to move it. Pinch or scroll to resize it.', calib: 'Tap two points on the picture that you know the distance between.' }[t] || '');
  planCv.style.cursor = t === 'wall' || t === 'room' || t === 'calib' ? 'crosshair' : 'grab';
  if (t) { clearSel(); updateBars(); }
  draw();
}
A.setTool = setTool;
$('#wallTool').onclick = () => setTool(A.tool === 'wall' ? null : 'wall');
$('#roomTool').onclick = () => setTool(A.tool === 'room' ? null : 'room');

function tapTool(w) {
  if (A.tool === 'room') {
    const reg = A.an.regionAt(w.x, w.y);
    if (!reg) { A.toast('That spot is not inside closed walls. Close the room first.'); return; }
    let tag = reg.tag;
    if (!tag) { tag = { id: uid('r'), name: '', x: r2(w.x), y: r2(w.y), floor: 'tile' }; A.scene.rooms.push(tag); }
    setTool(null); A.commit(true); A.select('selRoom', tag.id);
    setTimeout(() => { const i = $('#roomName'); i.focus(); i.select(); }, 30);
  } else if (A.tool === 'calib') {
    A.marks.push({ x: w.x, y: w.y }); draw();
    if (A.marks.length < 2) return;
    const [p, q] = A.marks, now = Math.hypot(q.x - p.x, q.y - p.y);
    setTimeout(() => {
      const ans = window.prompt('How far apart are those two points in real life, in metres?', now.toFixed(2));
      const real = ans == null ? NaN : parseFloat(String(ans).replace(',', '.'));
      if (real > 0 && now > 0.01) { const u = A.scene.underlay; scaleUnderlay({ x: u.x, y: u.y, w: u.w, h: u.h }, real / now, p); A.commit(); A.toast('Scale set. Trace the walls over the picture.'); }
      setTool(null);
    }, 60);
  }
}
/** Scale the underlay rectangle `u0` by `f`, keeping world point `c` fixed. */
function scaleUnderlay(u0, f, c) {
  const u = A.scene.underlay; if (!u || !(f > 0)) return;
  u.w = r2(clamp(u0.w * f, 0.5, 400)); const g = u.w / u0.w; u.h = r2(u0.h * g);
  u.x = r2(c.x - (c.x - u0.x) * g); u.y = r2(c.y - (c.y - u0.y) * g);
}

// ---------- scanned plan underneath ----------
A.loadUnderlay = async () => {
  A.underImg = null;
  const url = A.id ? await store.getBlob(A.id + ':underlay') : null;
  if (url) await new Promise(res => { const im = new Image(); im.onload = () => { A.underImg = im; res(); }; im.onerror = () => res(); im.src = url; });
  syncUnderPanel(); draw();
};
/** Shrink a chosen picture so it stores and uploads comfortably. Returns { dataUrl, w, h }. */
A.readPicture = file => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onerror = () => rej(new Error('That file could not be read'));
  fr.onload = () => {
    const im = new Image();
    im.onerror = () => rej(new Error('That file is not a picture this browser can open'));
    im.onload = () => {
      const max = 2200, f = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.round(im.naturalWidth * f), h = Math.round(im.naturalHeight * f);
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      if (!x) { res({ dataUrl: fr.result, w: im.naturalWidth, h: im.naturalHeight }); return; }
      x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h);
      res({ dataUrl: c.toDataURL('image/jpeg', 0.9), w, h });
    };
    im.src = fr.result;
  };
  fr.readAsDataURL(file);
});
A.setUnderlayPicture = async (pic) => {
  await store.putBlob(A.id + ':underlay', pic.dataUrl);
  const s = A.scene;
  if (!s.underlay) {
    const b = sceneBounds(s), has = s.walls.length > 0, w = has ? Math.max(4, b.x1 - b.x0) * 1.25 : 14;
    s.underlay = { x: r2(has ? b.x0 - (w - (b.x1 - b.x0)) / 2 : 0), y: r2(has ? b.y0 : 0), w: r2(w), h: r2(w * pic.h / pic.w), opacity: 0.5, show: true };
  } else s.underlay.h = r2(s.underlay.w * pic.h / pic.w);
  await A.loadUnderlay(); A.commit();
};
function syncUnderPanel() {
  const u = A.scene.underlay, has = !!(u && A.underImg);
  $('#underShow').disabled = $('#underMove').disabled = $('#underCal').disabled = $('#underDel').disabled = $('#underRead').disabled = $('#underOp').disabled = !has;
  $('#underShow').setAttribute('aria-pressed', String(!!(has && u.show !== false)));
  $('#underOp').value = u ? u.opacity : 0.5; $('#underOpOut').textContent = Math.round((u ? u.opacity : 0.5) * 100) + '%';
  $('#underPick').textContent = has ? 'Change picture' : 'Choose picture';
}
$('#underBtn').onclick = () => { const p = $('#underPanel'); p.hidden = !p.hidden; $('#underBtn').setAttribute('aria-expanded', String(!p.hidden)); };
$('#underPick').onclick = () => $('#underFile').click();
$('#underFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { await A.setUnderlayPicture(await A.readPicture(f)); fitPlan(); draw(); A.toast('Picture added. Set its scale, then trace over it.'); } catch (err) { A.toast(err.message); }
};
$('#underShow').onclick = () => { const u = A.scene.underlay; if (!u) return; u.show = u.show === false; syncUnderPanel(); A.commit(); };
$('#underMove').onclick = () => setTool(A.tool === 'under' ? null : 'under');
$('#underCal').onclick = () => { if (A.scene.underlay) { A.scene.underlay.show = true; syncUnderPanel(); setTool('calib'); } };
$('#underOp').oninput = e => { const u = A.scene.underlay; if (!u) return; u.opacity = +e.target.value; syncUnderPanel(); draw(); };
$('#underOp').onchange = () => A.commit();
$('#underDel').onclick = async () => { await store.delBlob(A.id + ':underlay'); A.scene.underlay = null; A.underImg = null; setTool(null); syncUnderPanel(); A.commit(); };

// ---------- selection bars ----------
function updateBars() {
  const s = A.scene, it = selItem(), oc = selOpCtx(), wall = findWall(s, A.selWall), tag = s.rooms.find(r => r.id === A.selRoom), build = A.pm === 'build';
  if (A.sel && !it) A.sel = null; if (A.selOp && !oc) A.selOp = null; if (A.selWall && !wall) A.selWall = null; if (A.selRoom && !tag) A.selRoom = null;
  const any = !!(it || oc || wall || tag);
  $('#selBar').hidden = !it; $('#winBar').hidden = !oc; $('#wallBar').hidden = !wall; $('#roomBar').hidden = !tag;
  $('#dock').hidden = build || any; $('#buildDock').hidden = !build || any;
  if (any) $('#underPanel').hidden = true;
  if (it) {
    const c = CAT[it.t], h = (it.h || natH(it.t, it.w, it.d)).toFixed(2);
    $('#selName').textContent = c.n;
    $('#selSize').textContent = c.flat ? it.w.toFixed(2) + ' × ' + it.d.toFixed(2) + ' m' : c.round ? 'Ø ' + it.w.toFixed(2) + ' × ' + h + ' m high' : it.w.toFixed(2) + ' × ' + it.d.toFixed(2) + ' × ' + h + ' m high';
    $('#flipBtn').hidden = !!c.round; $('#stepD').hidden = !!c.round; $('#stepH').hidden = !!c.flat; $('#stepW').querySelector('i').textContent = c.round ? 'Size' : 'Width';
  }
  if (oc) {
    const op = oc.op, win = op.k === 'win', st = opState(op, A.an.ext.has(op.id)), sz = (op.b - op.a).toFixed(2) + ' × ' + (op.head - op.sill).toFixed(2) + ' m';
    $('#winName').textContent = KIND_NAME[op.k];
    $('#winSize').textContent = win ? sz + ', sill at ' + op.sill.toFixed(2) + ' m' : sz + ', ' + { open: 'open', closed: 'closed', wall: 'walled up' }[st] + (op.gl && st === 'closed' ? ', glass' : '');
    $('#sillStep').hidden = !win; $('#doorState').hidden = win; $('#swingBtn').hidden = $('#glassBtn').hidden = op.k !== 'door';
    $('#glassBtn').setAttribute('aria-pressed', String(!!op.gl)); press('#doorState', 'st', st);
    $('#opKind').hidden = $('#opDel').hidden = !build; press('#opKind', 'k', op.k);
  }
  if (wall) {
    $('#wallSize').textContent = wallLen(wall).toFixed(2) + ' m long, ' + wallThick(wall).toFixed(2) + ' m thick' + (wall.v ? ', divider' : '');
    $('#wallDiv').setAttribute('aria-pressed', String(!!wall.v)); $('#wallWin').disabled = $('#wallDoor').disabled = !!wall.v;
  }
  if (tag) {
    const reg = A.an.regionAt(tag.x, tag.y), inp = $('#roomName');
    $('#roomSize').textContent = reg ? reg.area.toFixed(1) + ' m²' : 'not inside closed walls';
    if (document.activeElement !== inp) inp.value = tag.name; press('#roomFloor', 'f', tag.floor);
  }
}
A.updateBars = updateBars;
for (const b of $$('[data-done]')) b.onclick = () => A.select(null);

// furniture
const changeItem = fn => { const it = selItem(); if (!it) return; fn(it); A.commit(); };
$('#rotL').onclick = () => changeItem(i => { i.r = norm(i.r + 15); });
$('#rotR').onclick = () => changeItem(i => { i.r = norm(i.r - 15); });
$('#rot90').onclick = () => changeItem(i => { i.r = norm(snap(i.r, 90) + 90); });
$('#flipBtn').onclick = () => changeItem(i => { i.f = i.f ? 0 : 1; });
const resize = (k, dir) => changeItem(i => { const v = clamp(r2(i[k] + dir * 0.1), 0.3, 8); i[k] = v; if (CAT[i.t].round) { i.w = v; i.d = v; } });
$('#stepW').addEventListener('click', e => { const b = e.target.closest('button'); if (b) resize('w', +b.dataset.d); });
$('#stepD').addEventListener('click', e => { const b = e.target.closest('button'); if (b) resize('d', +b.dataset.d); });
$('#stepH').addEventListener('click', e => { const b = e.target.closest('button'); if (b) changeItem(i => { i.h = clamp(r2((i.h || natH(i.t, i.w, i.d)) + b.dataset.d * 0.05), 0.1, 3.5); }); });
$('#dupBtn').onclick = () => { const it = selItem(); if (!it) return; const n = Object.assign({}, it, { id: uid('i'), x: snap(it.x + 0.4), y: snap(it.y - 0.4) }); A.scene.items.push(n); A.sel = n.id; A.commit(); };
$('#delBtn').onclick = deleteSelected;

// windows and doors
const changeOp = fn => { const c = selOpCtx(); if (!c) return; fn(c.op, c); c.wall.ops.sort((p, q) => p.a - q.a); A.commit(true); };
$('#winRow').addEventListener('click', e => {
  const b = e.target.closest('.step button[data-d]'); if (!b) return;
  const k = b.parentElement.dataset.k, dir = +b.dataset.d, top = A.scene.ceiling - 0.05;
  changeOp((op, c) => {
    if (k === 'w') { const mid = (op.a + op.b) / 2, len = clamp(r2(op.b - op.a + dir * 0.1), 0.4, Math.max(0.4, c.hi - c.lo)), a = clamp(mid - len / 2, c.lo, Math.max(c.lo, c.hi - len)); op.a = r2(a); op.b = r2(a + len); }
    else if (k === 'h') op.head = clamp(r2(op.head + dir * 0.1), op.sill + 0.3, top);
    else { const h = op.head - op.sill, s = clamp(r2(op.sill + dir * 0.1), 0, top - 0.3); op.sill = s; op.head = Math.min(top, r2(s + h)); }
  });
});
$('#doorState').addEventListener('click', e => { const b = e.target.closest('button'); if (b) changeOp(op => { if (op.k !== 'win') op.st = b.dataset.st; }); });
$('#glassBtn').onclick = () => changeOp(op => { if (op.k !== 'door') return; if (op.gl) delete op.gl; else { op.gl = 1; op.st = 'closed'; } });
$('#swingBtn').onclick = () => changeOp(op => { if (op.k !== 'door') return; const n = { a1: ['b', 1], b1: ['b', -1], 'b-1': ['a', -1], 'a-1': ['a', 1] }[op.h + (op.s || 1)] || ['a', 1]; op.h = n[0]; op.s = n[1]; });
$('#opKind').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  changeOp(op => {
    const k = b.dataset.k; if (k === op.k) return; const d = opDefaults(k);
    op.k = k; op.sill = d.sill; op.head = Math.min(d.head, A.scene.ceiling - 0.05); delete op.st; delete op.gl;
    if (k === 'door') { op.h = op.h || 'b'; op.s = op.s || 1; } else { delete op.h; delete op.s; }
  });
});
$('#opDel').onclick = deleteSelected;

// walls
const changeWall = fn => { const w = findWall(A.scene, A.selWall); if (!w) return; fn(w); A.commit(true); };
$('#wallThick').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  changeWall(w => { const t = clamp(r2(wallThick(w) + b.dataset.d * 0.05), 0.05, Math.min(0.8, wallLen(w) - 0.1)); if (wallAxis(w) === 'x') w.y1 = r2(w.y0 + t); else w.x1 = r2(w.x0 + t); A.wallT = t; });
});
function addOpening(k) {
  const w = findWall(A.scene, A.selWall); if (!w || w.v) return;
  const d = opDefaults(k), want = k === 'win' ? 1.2 : 0.9, [lo, hi] = wallSpan(w);
  // first free stretch that fits, starting from the middle of the wall
  const gaps = [], ops = w.ops.slice().sort((p, q) => p.a - q.a); let cur = lo + 0.1;
  for (const o of ops) { gaps.push([cur, o.a - 0.1]); cur = o.b + 0.1; } gaps.push([cur, hi - 0.1]);
  const mid = (lo + hi) / 2, fit = gaps.filter(g => g[1] - g[0] >= 0.5).sort((p, q) => Math.abs((p[0] + p[1]) / 2 - mid) - Math.abs((q[0] + q[1]) / 2 - mid))[0];
  if (!fit) { A.toast('There is no free stretch on this wall for another opening.'); return; }
  const len = Math.min(want, fit[1] - fit[0]), a = clamp(mid - len / 2, fit[0], fit[1] - len);
  const op = { id: uid('o'), k, a: r2(a), b: r2(a + len), sill: d.sill, head: Math.min(d.head, A.scene.ceiling - 0.05) };
  if (k === 'door') { op.h = 'b'; op.s = 1; }
  w.ops.push(op); w.ops.sort((p, q) => p.a - q.a); A.selWall = null; A.selOp = op.id; A.commit(true);
}
$('#wallWin').onclick = () => addOpening('win');
$('#wallDoor').onclick = () => addOpening('door');
$('#wallDiv').onclick = () => changeWall(w => { if (w.v) delete w.v; else { w.v = 1; w.ops = []; } });
$('#wallDel').onclick = deleteSelected;

// rooms
let nameT = 0;
$('#roomName').addEventListener('input', e => {
  const t = A.scene.rooms.find(r => r.id === A.selRoom); if (!t) return;
  t.name = e.target.value.slice(0, 40); A.an = analyze(A.scene); draw(); clearTimeout(nameT); nameT = setTimeout(() => A.commit(true), 600);
});
$('#roomName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); A.select(null); } });
$('#roomFloor').addEventListener('click', e => { const b = e.target.closest('button'), t = A.scene.rooms.find(r => r.id === A.selRoom); if (b && t) { t.floor = b.dataset.f; A.commit(true); } });
$('#roomDel').onclick = deleteSelected;

// ---------- plan mode, docks ----------
function setPlanMode(pm) {
  A.pm = pm; press('#planModeSeg', 'pm', pm); setTool(null); A.select(null);
  $('#underPanel').hidden = true;
  if (pm === 'build' && !A.scene.walls.length) A.hint('Draw walls to make rooms, or add a scan of your plan to trace over.');
  planCv.setAttribute('aria-label', pm === 'build' ? 'Floor plan, build mode. Tap a wall, window or door to change it.' : 'Floor plan. Drag furniture to move it, drag the amber marker to place the camera.');
}
A.setPlanMode = setPlanMode;
$('#planModeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPlanMode(b.dataset.pm); });
function closeMore() { $('#morePop').hidden = true; $('#moreBtn').setAttribute('aria-expanded', 'false'); }
$('#moreBtn').onclick = () => { const p = $('#morePop'); p.hidden = !p.hidden; $('#moreBtn').setAttribute('aria-expanded', String(!p.hidden)); };
$('#fitBtn').onclick = () => { closeMore(); fitPlan(); draw(); };
$('#emptyBtn').onclick = () => { closeMore(); if (!A.scene.items.length) return; A.scene.items = []; A.sel = null; A.commit(); A.toast('All furniture removed. Undo brings it back.'); };

// ---------- furniture catalogue ----------
function buildCatalog() {
  const body = $('#catBody'); body.textContent = ''; const groups = [];
  for (const k in CAT) { let g = groups.find(x => x.n === CAT[k].g); if (!g) groups.push(g = { n: CAT[k].g, k: [] }); g.k.push(k); }
  for (const g of groups) {
    const h = document.createElement('h3'); h.textContent = g.n; body.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'cat';
    for (const k of g.k) {
      const c = CAT[k], b = document.createElement('button'); b.type = 'button'; b.dataset.t = k;
      const cv = document.createElement('canvas'); cv.width = 168; cv.height = 116; b.appendChild(cv);
      const nm = document.createElement('b'); nm.textContent = c.n; b.appendChild(nm);
      const sm = document.createElement('small'); sm.textContent = c.round ? 'Ø ' + c.w.toFixed(2) + ' m' : c.w.toFixed(2) + ' × ' + c.d.toFixed(2) + ' m'; b.appendChild(sm);
      grid.appendChild(b);
    }
    body.appendChild(grid);
  }
  body.addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) addItem(b.dataset.t); });
}
function paintThumbs() {
  for (const cv of $$('#catBody canvas')) {
    const k = cv.parentElement.dataset.t, c = CAT[k], x = cv.getContext('2d'); if (!x) continue;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, 168, 116); const s = Math.min(150 / c.w, 98 / c.d, 150); x.translate(84, 58); x.scale(s, s); drawParts(x, partsOf(k, c.w, c.d), 2 / s, pal);
  }
}
function addItem(t) {
  const c = CAT[t]; let x = pv.cx, y = pv.cy;
  if (!A.an.regionAt(x, y) && A.an.regions.length) { const r = A.an.regions.slice().sort((p, q) => q.area - p.area)[0]; x = r.lx; y = r.ly; }
  const it = { id: uid('i'), t, x: snap(x), y: snap(y), r: 0, w: c.w, d: c.d, f: 0 };
  A.scene.items.push(it); A.closeSheets(); if (A.pm !== 'furnish') setPlanMode('furnish'); setView('plan'); A.sel = it.id; A.commit(); A.toast(c.n + ' added. Drag it into place.');
}
$('#addBtn').onclick = () => { paintThumbs(); A.openSheet('#catScrim'); };

// ---------- sheets ----------
A.openSheet = id => { $(id).hidden = false; const b = $(id).querySelector('[data-close]'); if (b) b.focus(); };
A.closeSheets = () => { for (const s of $$('.scrim')) s.hidden = true; };
for (const s of $$('.scrim')) s.addEventListener('click', e => { if (e.target === s || e.target.closest('[data-close]')) s.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { A.closeSheets(); $('#hold').hidden = true; closeMore(); } });
$('#holdClose').onclick = () => { $('#hold').hidden = true; };

// ---------- workspace tabs + 3D pane ----------
function setView(v) {
  $('#work').dataset.view = v; press('#viewSeg', 'view', v);
  requestAnimationFrame(() => { sizePlan(); view.size(); view.render(); });
}
A.setView = setView;
$('#viewSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });

function syncPanel() {
  const c = A.scene.cam, s = A.scene;
  $('#hRange').value = c.h; $('#hOut').textContent = c.h.toFixed(2) + ' m'; $('#fRange').value = c.fov; $('#fOut').textContent = Math.round(c.fov) + '°';
  $('#cRange').value = s.ceiling; $('#cOut').textContent = s.ceiling.toFixed(2) + ' m';
}
A.syncPanel = syncPanel; A.drawPlan = draw;
const view = createView3D(A, $('#gl'));
A.view = view;
if (!view.ok) { $('#nogl').hidden = false; $('#gl').hidden = true; }

$('#modeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; A.V.mode = b.dataset.mode; press('#modeSeg', 'mode', A.V.mode);
  $('#pad').hidden = A.V.mode !== 'eye'; $('#orbHint').hidden = A.V.mode === 'eye'; view.render();
});
$('#lookSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; A.V.look = b.dataset.look; press('#lookSeg', 'look', A.V.look); view.render(); });
$('#setBtn').onclick = () => { const p = $('#panel'); p.hidden = !p.hidden; $('#setBtn').setAttribute('aria-expanded', String(!p.hidden)); };
$('#aspChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; A.V.asp = b.dataset.a; press('#aspChips', 'a', A.V.asp); view.size(); draw(); view.render(); });
$('#hRange').oninput = e => { A.scene.cam.h = Math.min(+e.target.value, A.scene.ceiling - 0.1); syncPanel(); view.render(); };
$('#fRange').oninput = e => { A.scene.cam.fov = +e.target.value; syncPanel(); draw(); view.render(); };
$('#cRange').oninput = e => { A.scene.ceiling = +e.target.value; A.scene.cam.h = Math.min(A.scene.cam.h, A.scene.ceiling - 0.1); syncPanel(); view.rebuildHouse(); view.render(); };
for (const id of ['#hRange', '#fRange']) $(id).addEventListener('change', A.save);
$('#cRange').addEventListener('change', () => A.commit(true));

const MV = { f: [1, 0], b: [-1, 0], l: [0, 1], r: [0, -1] }; let mvT = 0;
function stopMove() { if (mvT) { clearInterval(mvT); mvT = 0; A.save(); } }
$('#pad').addEventListener('pointerdown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); const m = MV[b.dataset.m]; stopMove(); view.moveCam(m[0] * 0.12, m[1] * 0.12); mvT = setInterval(() => view.moveCam(m[0] * 0.07, m[1] * 0.07), 40); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('#pad').addEventListener(ev, stopMove);
$('#pad').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const b = e.target.closest('button'); if (b) { e.preventDefault(); const m = MV[b.dataset.m]; view.moveCam(m[0] * 0.25, m[1] * 0.25); A.save(); } } });
A.isBusy = () => !!drag || !!mvT;

/** Top-down plan as a PNG data URL, for export. */
A.planShot = () => {
  const b = sceneBounds(A.scene), W = 2000, H = Math.round(W * Math.max(1, b.y1 - b.y0 + 2) / Math.max(1, b.x1 - b.x0 + 2));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); if (!x) return null;
  drawPlan(x, W, H, fitView({ x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 }, W, H, 0), LIGHT, A.scene, A.an, { ui: false, clean: true });
  return c.toDataURL('image/png');
};
A.serialize = () => serialize(A.scene);

// ---------- boot ----------
readPal(); buildCatalog(); syncPanel(); syncUnderPanel(); updateBars(); $('#orbHint').hidden = true;
const relayout = () => { sizePlan(); if (view.size()) view.render(); };
if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(relayout); ro.observe(planCv.parentElement); ro.observe($('#gl').parentElement); }
else window.addEventListener('resize', relayout);
const reTheme = () => { readPal(); draw(); };
if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', reTheme); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw).catch(() => { });

initPanels(A).then(() => { relayout(); A.ready = true; }).catch(e => { console.error(e); A.toast('Something went wrong while starting: ' + e.message, 8000); });
window.parter = A;          // handy in the console, and used by the tests
