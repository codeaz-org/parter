// Builds the three.js model of a scene. `T` is the THREE namespace (r128), passed in so this file
// works in the browser (global THREE) and in node tests (require('three')).
//
// Plan (x, y) maps to three (x, height, -y).
import { MATS, partsOf } from './catalog.js';
import { wallAxis, opState } from './scene.js';

export const GROUND = -0.45;          // outside ground level; the finished floor is 0

export function makeMats(T) {
  const o = {};
  for (const k in MATS) {
    const m = MATS[k];
    o[k] = new T.MeshStandardMaterial({
      color: new T.Color(m.c).convertSRGBToLinear(), roughness: m.r, metalness: m.m || 0,
      emissive: new T.Color(m.e || 0).convertSRGBToLinear(), emissiveIntensity: m.e ? 0.9 : 0,
      transparent: !!m.op, opacity: m.op || 1
    });
    if (m.op) o[k].userData.glass = true;
  }
  return o;
}

export function buildItem(T, mats, type, w, d) {
  const g = new T.Group();
  for (const p of partsOf(type, w, d)) {
    let geo, y;
    if (p.t === 'b') { geo = new T.BoxGeometry(p.w, p.h, p.d); y = p.y + p.h / 2; }
    else if (p.t === 'c') { geo = new T.CylinderGeometry(p.r, p.r, p.h, 28); y = p.y + p.h / 2; }
    else { geo = new T.SphereGeometry(p.r, 20, 14); y = p.y; }
    const m = new T.Mesh(geo, mats[p.m]); m.position.set(p.x, y, p.z);
    const glass = !!MATS[p.m].op;
    m.castShadow = !glass; m.receiveShadow = !glass; m.userData.glass = glass; g.add(m);
  }
  return g;
}

/** One geometry made of many axis-aligned boxes (plan rect + height range). */
function slabGeometry(T, rects, yb, yt) {
  const pos = [], nor = [], idx = [];
  const quad = (a, b, c, d, n) => {
    const k = pos.length / 3;
    for (const p of [a, b, c, d]) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); }
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  for (const r of rects) {
    const x0 = r.x0, x1 = r.x1, z0 = -r.y1, z1 = -r.y0;       // z0 = north edge
    quad([x0, yt, z1], [x1, yt, z1], [x1, yt, z0], [x0, yt, z0], [0, 1, 0]);
    if (yt - yb > 1e-4) {
      quad([x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1], [0, -1, 0]);
      quad([x0, yb, z1], [x1, yb, z1], [x1, yt, z1], [x0, yt, z1], [0, 0, 1]);
      quad([x1, yb, z0], [x0, yb, z0], [x0, yt, z0], [x1, yt, z0], [0, 0, -1]);
      quad([x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z1], [1, 0, 0]);
      quad([x0, yb, z0], [x0, yb, z1], [x0, yt, z1], [x0, yt, z0], [-1, 0, 0]);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

export function buildHouse(T, scene, an) {
  const g = new T.Group(), ceilH = scene.ceiling;
  const M = (c, r, x) => new T.MeshStandardMaterial(Object.assign({ color: new T.Color(c).convertSRGBToLinear(), roughness: r }, x || {}));
  const wallM = M(0xf1eee8, 0.92), frameM = M(0x3b4046, 0.5), doorM = M(0x6a503c, 0.6), idoorM = M(0xd9d0c2, 0.6),
    glassM = M(0xcfe3ee, 0.05, { transparent: true, opacity: 0.22 }), gdoorM = M(0xc9cdd1, 0.5, { metalness: 0.3 }),
    baseM = M(0xcfc7ba, 0.8), ceilM = M(0xfafafa, 0.95), stepM = M(0xbdb8ae, 0.9),
    floorM = { tile: M(0xd9cebc, 0.38), wood: M(0xc59b6d, 0.55), bath: M(0xcdd3d7, 0.3), conc: M(0xb4b4af, 0.9) };
  const box = (x0, x1, yb, yt, p0, p1, mat, shadow) => {
    if (x1 - x0 < 1e-4 || yt - yb < 1e-4 || p1 - p0 < 1e-4) return null;
    const m = new T.Mesh(new T.BoxGeometry(x1 - x0, yt - yb, p1 - p0), mat);
    m.position.set((x0 + x1) / 2, (yb + yt) / 2, -(p0 + p1) / 2);
    m.castShadow = shadow !== false; m.receiveShadow = true; g.add(m); return m;
  };

  // plinth under the whole footprint, then one floor mesh per floor type
  if (an.footprint.length) {
    const m = new T.Mesh(slabGeometry(T, an.footprint, GROUND, -0.004), baseM); m.castShadow = true; m.receiveShadow = true; g.add(m);
  }
  const byFloor = {};
  for (const r of an.regions) (byFloor[r.floor] = byFloor[r.floor] || []).push(...r.rects);
  for (const k in byFloor) {
    const m = new T.Mesh(slabGeometry(T, byFloor[k], 0, 0), floorM[k] || floorM.tile); m.receiveShadow = true; g.add(m);
  }

  // walls, cut by their openings
  for (const w of scene.walls) {
    if (w.v) continue;
    const ax = wallAxis(w), lo = ax === 'x' ? w.x0 : w.y0, hi = ax === 'x' ? w.x1 : w.y1;
    const th = ax === 'x' ? w.y1 - w.y0 : w.x1 - w.x0;
    const seg = (a, b, yb, yt, mat, inset) => { const i = inset || 0; return ax === 'x' ? box(a, b, yb, yt, w.y0 + i, w.y1 - i, mat || wallM) : box(w.x0 + i, w.x1 - i, yb, yt, a, b, mat || wallM); };
    let cur = lo;
    for (const op of w.ops.slice().sort((p, q) => p.a - q.a)) {
      const ext = an.ext.has(op.id), st = opState(op, ext);
      if (st === 'wall') continue;
      const sill = Math.min(op.sill, ceilH - 0.2), head = Math.min(ceilH, op.head);
      seg(cur, op.a, GROUND, ceilH);
      seg(op.a, op.b, GROUND, sill); seg(op.a, op.b, head, ceilH);
      const ins = Math.max(0, th / 2 - 0.05);
      if (op.k === 'win') {
        const f = 0.05;
        seg(op.a, op.a + f, sill, head, frameM, ins); seg(op.b - f, op.b, sill, head, frameM, ins);
        seg(op.a, op.b, sill, sill + f, frameM, ins); seg(op.a, op.b, head - f, head, frameM, ins);
        const nm = Math.max(0, Math.round((op.b - op.a) / 1.05) - 1);
        for (let i = 1; i <= nm; i++) { const c = op.a + (op.b - op.a) * i / (nm + 1); seg(c - f / 2, c + f / 2, sill, head, frameM, ins); }
      } else if (st === 'closed') {
        const lm = op.k === 'garage' ? gdoorM : ext ? doorM : idoorM, li = Math.max(0, th / 2 - 0.03);
        if (op.gl && op.k === 'door' && op.b - op.a > 0.4 && head - sill > 0.6) {
          seg(op.a, op.a + 0.1, sill, head, lm, li); seg(op.b - 0.1, op.b, sill, head, lm, li);
          seg(op.a + 0.1, op.b - 0.1, sill, sill + 0.2, lm, li); seg(op.a + 0.1, op.b - 0.1, head - 0.1, head, lm, li);
          const gm = seg(op.a + 0.1, op.b - 0.1, sill + 0.2, head - 0.1, glassM, Math.max(0, th / 2 - 0.006));
          if (gm) { gm.userData.glass = true; gm.castShadow = false; gm.receiveShadow = false; }
        } else seg(op.a, op.b, sill, head, lm, li);
        if (op.k !== 'garage') { const hx = op.h === 'a' ? op.b - 0.12 : op.a + 0.08; seg(hx, hx + 0.04, sill + 1, sill + 1.04, frameM, Math.max(0, th / 2 - 0.08)); }
      }
      cur = op.b;
    }
    seg(cur, hi, GROUND, ceilH);
  }

  for (const t of scene.steps || []) for (let i = 1; i <= 3; i++) {
    const y = t.y + t.dir * 0.3 * i;
    box(t.x0, t.x1, GROUND, -0.15 * (i - 1) - 0.01, Math.min(t.y, y), Math.max(t.y, y), stepM);
  }

  // ceiling (hidden in the dollhouse view)
  const ceiling = new T.Group(); g.add(ceiling);
  if (an.footprint.length) {
    const m = new T.Mesh(slabGeometry(T, an.footprint, ceilH, ceilH + 0.15), ceilM); m.castShadow = true; m.receiveShadow = true; ceiling.add(m);
  }

  // one soft lamp per room so interiors read with the ceiling on; capped to keep shaders light
  const lit = an.regions.slice().sort((a, b) => b.area - a.area).slice(0, 14);
  for (const r of lit) {
    const pl = new T.PointLight(0xffe9cf, Math.min(0.42, 0.2 + r.area * 0.006), 11, 1.6);
    pl.position.set(r.lx, ceilH - 0.35, -r.ly); g.add(pl);
  }
  return { group: g, ceiling };
}

export function buildWorld(T) {
  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xffffff, 0xa89c8a, 0.3)); scene.add(new T.AmbientLight(0xffffff, 0.1));
  const sun = new T.DirectionalLight(0xfff1dc, 1.15);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; scene.add(sun, sun.target);
  const ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshStandardMaterial({ color: new T.Color(0x9fb08c).convertSRGBToLinear(), roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = GROUND; ground.receiveShadow = true; scene.add(ground);
  // depth map: near is white, far is black, on an inverse-depth curve like the depth estimators use
  const depth = new T.ShaderMaterial({
    uniforms: { nearRef: { value: 1 }, far: { value: 20 } },
    vertexShader: 'varying float vZ;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vZ=-mv.z;gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'uniform float nearRef;uniform float far;varying float vZ;void main(){float d=(1.0/max(vZ,0.001)-1.0/far)/(1.0/nearRef-1.0/far);gl_FragColor=vec4(vec3(pow(clamp(d,0.0,1.0),0.5)),1.0);}'
  });
  const clay = new T.MeshStandardMaterial({ color: new T.Color(0xe8e5df).convertSRGBToLinear(), roughness: 0.92 });
  const world = { scene, sun, ground, depth, clay, sky: new T.Color(0xdde8f1), clayBg: new T.Color(0xd6d8da), black: new T.Color(0), box: new T.Box3() };
  /** Point the sun and its shadow camera at a building of this size. */
  world.fit = (b, ceilH) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, half = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2 + 4;
    sun.position.set(cx - half * 0.75, half * 0.9 + 4, -cy + half * 0.95); sun.target.position.set(cx, 0, -cy);
    const sc = sun.shadow.camera; sc.left = -half * 1.5; sc.right = half * 1.5; sc.top = half * 1.5; sc.bottom = -half * 1.5; sc.near = 0.5; sc.far = half * 5 + 30;
    sc.updateProjectionMatrix();
    world.box.min.set(b.x0, GROUND, -b.y1); world.box.max.set(b.x1, ceilH + 0.2, -b.y0);
  };
  return world;
}
