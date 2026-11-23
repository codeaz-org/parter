// Rooms are not drawn by hand. They are whatever the walls enclose.
//
// analyze() rasterises the walls onto a 5 cm grid, floods in from outside, and calls every
// remaining pocket a room. A room gets its name and floor type from a room label (scene.rooms)
// that sits inside it. Doorways still separate rooms because an opening lives inside its wall.
// Walls flagged `v` ("dividers") separate rooms on the plan without being built in 3D.
import { wallAxis, sceneBounds } from './scene.js';

export const CELL = 0.05;

function mergeRuns(label, nx, ny, x0, y0, want) {
  // Turn grid cells into a small set of rectangles: runs along x, merged upward while identical.
  const out = [], open = new Map();
  for (let j = 0; j < ny; j++) {
    const seen = new Set();
    let i = 0;
    while (i < nx) {
      const v = want(label[j * nx + i]);
      if (v === null) { i++; continue; }
      let e = i + 1;
      while (e < nx && want(label[j * nx + e]) === v) e++;
      const key = v + ':' + i + ':' + e;
      const r = open.get(key);
      if (r && r.j1 === j) r.j1 = j + 1; else { const n = { v, i0: i, i1: e, j0: j, j1: j + 1 }; open.set(key, n); out.push(n); }
      seen.add(key); i = e;
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
  }
  return out.map(r => ({ v: r.v, x0: x0 + r.i0 * CELL, x1: x0 + r.i1 * CELL, y0: y0 + r.j0 * CELL, y1: y0 + r.j1 * CELL }));
}

export function analyze(scene) {
  const b = sceneBounds(scene), pad = 0.5;
  const x0 = Math.floor((b.x0 - pad) / CELL) * CELL, y0 = Math.floor((b.y0 - pad) / CELL) * CELL;
  const nx = Math.max(4, Math.ceil((b.x1 + pad - x0) / CELL)), ny = Math.max(4, Math.ceil((b.y1 + pad - y0) / CELL));
  const label = new Int32Array(nx * ny).fill(-2);          // -2 unvisited, -1 wall, 0 outside, 1.. rooms
  const ci = x => Math.floor((x - x0) / CELL + 1e-6), cj = y => Math.floor((y - y0) / CELL + 1e-6);

  for (const w of scene.walls) {
    const i0 = Math.max(0, Math.round((w.x0 - x0) / CELL)), i1 = Math.min(nx, Math.round((w.x1 - x0) / CELL));
    const j0 = Math.max(0, Math.round((w.y0 - y0) / CELL)), j1 = Math.min(ny, Math.round((w.y1 - y0) / CELL));
    for (let j = j0; j < Math.max(j1, j0 + 1); j++) for (let i = i0; i < Math.max(i1, i0 + 1); i++) label[j * nx + i] = -1;
  }

  const stack = [];
  const flood = (si, sj, id) => {
    let n = 0, sx = 0, sy = 0, bi0 = nx, bi1 = -1, bj0 = ny, bj1 = -1;
    label[sj * nx + si] = id; stack.push(si, sj);
    while (stack.length) {
      const j = stack.pop(), i = stack.pop();
      n++; sx += i; sy += j;
      if (i < bi0) bi0 = i; if (i > bi1) bi1 = i; if (j < bj0) bj0 = j; if (j > bj1) bj1 = j;
      if (i > 0 && label[j * nx + i - 1] === -2) { label[j * nx + i - 1] = id; stack.push(i - 1, j); }
      if (i < nx - 1 && label[j * nx + i + 1] === -2) { label[j * nx + i + 1] = id; stack.push(i + 1, j); }
      if (j > 0 && label[(j - 1) * nx + i] === -2) { label[(j - 1) * nx + i] = id; stack.push(i, j - 1); }
      if (j < ny - 1 && label[(j + 1) * nx + i] === -2) { label[(j + 1) * nx + i] = id; stack.push(i, j + 1); }
    }
    return { n, sx, sy, bi0, bi1, bj0, bj1 };
  };
  // outside: everything reachable from the border
  for (let i = 0; i < nx; i++) { if (label[i] === -2) flood(i, 0, 0); if (label[(ny - 1) * nx + i] === -2) flood(i, ny - 1, 0); }
  for (let j = 0; j < ny; j++) { if (label[j * nx] === -2) flood(0, j, 0); if (label[j * nx + nx - 1] === -2) flood(nx - 1, j, 0); }

  const regions = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (label[j * nx + i] !== -2) continue;
    const id = regions.length + 1, f = flood(i, j, id);
    if (f.n * CELL * CELL < 0.25) {                         // slivers between walls are not rooms
      for (let jj = f.bj0; jj <= f.bj1; jj++) for (let ii = f.bi0; ii <= f.bi1; ii++) if (label[jj * nx + ii] === id) label[jj * nx + ii] = -1;
      continue;
    }
    // label point: the centroid if it is inside the room, otherwise the nearest cell that is
    let li = Math.round(f.sx / f.n), lj = Math.round(f.sy / f.n);
    if (label[lj * nx + li] !== id) {
      let best = Infinity;
      for (let jj = f.bj0; jj <= f.bj1; jj++) for (let ii = f.bi0; ii <= f.bi1; ii++) {
        if (label[jj * nx + ii] !== id) continue;
        const d = (ii - f.sx / f.n) ** 2 + (jj - f.sy / f.n) ** 2;
        if (d < best) { best = d; li = ii; lj = jj; }
      }
    }
    regions.push({
      id, area: f.n * CELL * CELL, name: '', floor: 'tile', tag: null,
      x0: x0 + f.bi0 * CELL, x1: x0 + (f.bi1 + 1) * CELL, y0: y0 + f.bj0 * CELL, y1: y0 + (f.bj1 + 1) * CELL,
      lx: x0 + (li + 0.5) * CELL, ly: y0 + (lj + 0.5) * CELL, rects: []
    });
  }
  // ids may have gaps after dropping slivers: renumber so regions[id-1] always works
  const remap = new Map(); regions.forEach((r, k) => { remap.set(r.id, k + 1); r.id = k + 1; });
  for (let k = 0; k < label.length; k++) if (label[k] > 0) label[k] = remap.get(label[k]) || -1;

  const regionAt = (x, y) => {
    const i = ci(x), j = cj(y);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    const v = label[j * nx + i];
    return v > 0 ? regions[v - 1] : null;
  };
  for (const tag of scene.rooms || []) {
    const r = regionAt(tag.x, tag.y);
    if (r && !r.tag) { r.tag = tag; r.name = tag.name || ''; r.floor = tag.floor || 'tile'; r.lx = tag.x; r.ly = tag.y; }
  }
  for (const r of mergeRuns(label, nx, ny, x0, y0, v => (v > 0 ? v : null))) regions[r.v - 1].rects.push(r);

  // footprint: everything that is not outside (rooms plus the walls around them)
  let footprint = mergeRuns(label, nx, ny, x0, y0, v => (v !== 0 ? 1 : null));
  if (!regions.length && scene.walls.length) footprint = [{ v: 1, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }];

  // which openings face the outside
  const ext = new Set();
  const at = (x, y) => { const i = ci(x), j = cj(y); return (i < 0 || j < 0 || i >= nx || j >= ny) ? 0 : label[j * nx + i]; };
  for (const w of scene.walls) {
    const ax = wallAxis(w);
    for (const op of w.ops) {
      const m = (op.a + op.b) / 2, e = CELL * 1.5;
      const s1 = ax === 'x' ? at(m, w.y0 - e) : at(w.x0 - e, m), s2 = ax === 'x' ? at(m, w.y1 + e) : at(w.x1 + e, m);
      if (s1 === 0 || s2 === 0) ext.add(op.id);
    }
  }
  return { cell: CELL, x0, y0, nx, ny, label, regions, footprint, ext, regionAt, bounds: b };
}

/** Plain-language description of a room, used in prompts. */
export function roomPhrase(region) {
  if (!region) return 'a room in a house';
  if (region.tag && region.tag.say) return region.tag.say;
  const n = (region.name || 'room').trim(), w = (region.x1 - region.x0), d = (region.y1 - region.y0);
  return `${n || 'room'} of about ${region.area < 10 ? region.area.toFixed(1) : Math.round(region.area)} m², roughly ${Math.min(w, d).toFixed(1)} m by ${Math.max(w, d).toFixed(1)} m`;
}
