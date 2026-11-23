// The scene document. Everything in Parter (editor, chat, plan import, MCP server, exports)
// reads and writes this one JSON shape. See docs/SCENE.md for the field-by-field reference.
//
// Coordinates are metres. x runs east, y runs north, heights run up.
// Walls are axis-aligned rectangles on the plan. An opening sits inside its wall and is placed
// by `a`..`b`, measured along the wall's long axis in the same world coordinates.
import { CAT } from './catalog.js';

export const FORMAT = 'parter-scene';
export const VERSION = 1;
export const OPENING_KINDS = ['win', 'door', 'open', 'garage'];
export const OPENING_STATES = ['open', 'closed', 'wall'];
export const FLOORS = ['tile', 'wood', 'bath', 'conc'];

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const r2 = v => Math.round(v * 100) / 100;
export const snap = (v, q = 0.05) => Math.round(Math.round(v / q) * q * 1000) / 1000;

let seq = 0;
export function uid(prefix = 'x') {
  seq = (seq + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-5) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

export function newScene(name = 'Untitled plan') {
  const now = Date.now();
  return {
    format: FORMAT, version: VERSION, name, ceiling: 2.7,
    walls: [], rooms: [], steps: [], items: [],
    cam: { x: 2, y: 2, yaw: 0.8, pitch: -0.05, h: 1.5, fov: 65 },
    underlay: null,
    meta: { created: now, modified: now }
  };
}

export const wallAxis = w => ((w.x1 - w.x0) >= (w.y1 - w.y0) ? 'x' : 'y');
export const wallLen = w => Math.max(w.x1 - w.x0, w.y1 - w.y0);
export const wallThick = w => Math.min(w.x1 - w.x0, w.y1 - w.y0);
export const wallSpan = w => (wallAxis(w) === 'x' ? [w.x0, w.x1] : [w.y0, w.y1]);

export function opDefaults(k) {
  return k === 'win' ? { sill: 0.9, head: 2.2 } : k === 'door' ? { sill: 0, head: 2.1 } : { sill: 0, head: 2.2 };
}

/** Effective state of an opening. `ext` (is it on an outside wall) comes from rooms.analyze(). */
export function opState(op, ext) {
  if (op.k === 'win') return 'open';
  return op.st || ((ext || op.k === 'garage') ? 'closed' : 'open');
}

export function findWall(scene, id) { return scene.walls.find(w => w.id === id) || null; }
export function findOp(scene, id) {
  for (const wall of scene.walls) { const op = wall.ops.find(o => o.id === id); if (op) return { wall, op }; }
  return null;
}
export function findItem(scene, id) { return scene.items.find(i => i.id === id) || null; }

/** Room that the neighbours of an opening leave free: [lo, hi] along the wall axis. */
export function opBounds(wall, op, margin = 0.1) {
  let [lo, hi] = wallSpan(wall); lo += margin; hi -= margin;
  for (const o of wall.ops) {
    if (o === op) continue;
    if (o.b <= op.a + 1e-6) lo = Math.max(lo, o.b + margin);
    else if (o.a >= op.b - 1e-6) hi = Math.min(hi, o.a - margin);
  }
  return [lo, hi];
}

function cleanOp(o, wall, ids) {
  const k = OPENING_KINDS.includes(o.k) ? o.k : null;
  if (!k) return null;
  const [lo, hi] = wallSpan(wall), def = opDefaults(k);
  let a = num(o.a, NaN), b = num(o.b, NaN);
  if (!(b - a >= 0.2)) return null;
  a = clamp(a, lo, hi); b = clamp(b, lo, hi);
  if (b - a < 0.2) return null;
  const sill = clamp(num(o.sill, def.sill), 0, 3), head = clamp(num(o.head, def.head), sill + 0.2, 4);
  const out = { id: freshId(o.id, 'o', ids), k, a: r2(a), b: r2(b), sill: r2(sill), head: r2(head) };
  if (k !== 'win' && OPENING_STATES.includes(o.st)) out.st = o.st;
  if (k === 'door') { out.h = o.h === 'a' ? 'a' : 'b'; out.s = o.s === -1 ? -1 : 1; if (o.gl) out.gl = 1; }
  return out;
}
function freshId(id, prefix, ids) {
  let v = typeof id === 'string' && id && !ids.has(id) ? id : uid(prefix);
  while (ids.has(v)) v = uid(prefix);
  ids.add(v); return v;
}

/** Validate and repair anything shaped like a scene. Throws only if it is not an object at all. */
export function normalizeScene(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a Parter scene');
  const s = newScene(typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Untitled plan');
  const ids = new Set();
  s.ceiling = clamp(num(raw.ceiling, 2.7), 2.2, 4);
  for (const w of Array.isArray(raw.walls) ? raw.walls : []) {
    let x0 = num(w.x0, NaN), y0 = num(w.y0, NaN), x1 = num(w.x1, NaN), y1 = num(w.y1, NaN);
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (x1 - x0 < 0.04 || y1 - y0 < 0.04) continue;
    const wall = { id: freshId(w.id, 'w', ids), x0: r2(x0), y0: r2(y0), x1: r2(x1), y1: r2(y1), ops: [] };
    if (w.v) wall.v = 1;
    for (const o of Array.isArray(w.ops) ? w.ops : []) { const c = cleanOp(o, wall, ids); if (c) wall.ops.push(c); }
    wall.ops.sort((p, q) => p.a - q.a);
    s.walls.push(wall);
  }
  for (const r of Array.isArray(raw.rooms) ? raw.rooms : []) {
    if (!Number.isFinite(+r.x) || !Number.isFinite(+r.y)) continue;
    const room = { id: freshId(r.id, 'r', ids), name: String(r.name || '').slice(0, 40), x: r2(+r.x), y: r2(+r.y), floor: FLOORS.includes(r.floor) ? r.floor : 'tile' };
    if (typeof r.say === 'string' && r.say) room.say = r.say.slice(0, 200);
    s.rooms.push(room);
  }
  for (const t of Array.isArray(raw.steps) ? raw.steps : []) {
    if ([t.x0, t.x1, t.y].every(v => Number.isFinite(+v))) s.steps.push({ x0: +t.x0, x1: +t.x1, y: +t.y, dir: t.dir === 1 ? 1 : -1 });
  }
  for (const i of Array.isArray(raw.items) ? raw.items : []) {
    const c = CAT[i.t];
    if (!c || !Number.isFinite(+i.x) || !Number.isFinite(+i.y)) continue;
    const it = { id: freshId(i.id, 'i', ids), t: i.t, x: +i.x, y: +i.y, r: num(i.r, 0), w: clamp(num(i.w, c.w), 0.1, 12), d: clamp(num(i.d, c.d), 0.1, 12), f: i.f ? 1 : 0 };
    if (+i.h > 0) it.h = clamp(+i.h, 0.05, 4);
    s.items.push(it);
  }
  if (raw.cam && Number.isFinite(+raw.cam.x) && Number.isFinite(+raw.cam.y)) {
    const c = raw.cam;
    s.cam = { x: +c.x, y: +c.y, yaw: num(c.yaw, 0), pitch: clamp(num(c.pitch, 0), -1.2, 1.2), h: clamp(num(c.h, 1.5), 0.3, 3.5), fov: clamp(num(c.fov, 65), 25, 100) };
  }
  if (raw.underlay && Number.isFinite(+raw.underlay.w) && +raw.underlay.w > 0) {
    const u = raw.underlay;
    s.underlay = { x: num(u.x, 0), y: num(u.y, 0), w: +u.w, h: num(u.h, +u.w), opacity: clamp(num(u.opacity, 0.5), 0.05, 1), show: u.show === false ? false : true };
  }
  if (raw.meta && typeof raw.meta === 'object') {
    s.meta.created = num(raw.meta.created, s.meta.created);
    s.meta.modified = num(raw.meta.modified, s.meta.modified);
    if (typeof raw.meta.source === 'string') s.meta.source = raw.meta.source.slice(0, 200);
  }
  return s;
}

/** Bounding box of the built structure (falls back to furniture, then to a default patch). */
export function sceneBounds(scene) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of scene.walls) { x0 = Math.min(x0, w.x0); y0 = Math.min(y0, w.y0); x1 = Math.max(x1, w.x1); y1 = Math.max(y1, w.y1); }
  for (const t of scene.steps || []) { x0 = Math.min(x0, t.x0); x1 = Math.max(x1, t.x1); y0 = Math.min(y0, t.y, t.y + t.dir * 0.9); y1 = Math.max(y1, t.y, t.y + t.dir * 0.9); }
  if (!Number.isFinite(x0)) {
    for (const i of scene.items) { x0 = Math.min(x0, i.x - 1); y0 = Math.min(y0, i.y - 1); x1 = Math.max(x1, i.x + 1); y1 = Math.max(y1, i.y + 1); }
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 8, y1: 6 };
  return { x0, y0, x1, y1 };
}

export function serialize(scene) {
  const s = JSON.parse(JSON.stringify(scene));
  s.format = FORMAT; s.version = VERSION;
  return s;
}
