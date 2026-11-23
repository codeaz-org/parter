// The 3D pane: eye-level walk-through, dollhouse overview, and the pictures for export.
// Renders only when something changed (no animation loop), which keeps phones cool.
/* global THREE */
import { natH } from '../core/catalog.js';
import { makeMats, buildItem, buildHouse, buildWorld } from '../core/scene3d.js';
import { sceneBounds } from '../core/scene.js';

const RAD = Math.PI / 180, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const ASPECTS = { '4:3': [1600, 1200], '16:9': [1920, 1080], '1:1': [1440, 1440], '3:4': [1200, 1600] };

/**
 * @param app { scene, an, V, drawPlan(), save(), syncPanel() }  (scene and an are read live)
 */
export function createView3D(app, canvas) {
  const V = app.V, pane = canvas.parentElement;
  const evPt = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const aspect = () => ASPECTS[V.asp][0] / ASPECTS[V.asp][1];
  let G = null, queued = false;

  if (typeof THREE !== 'undefined') {
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      const w = buildWorld(THREE), cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.08, 400), itemsG = new THREE.Group();
      w.scene.add(itemsG);
      G = Object.assign(w, { renderer, cam, itemsG, mats: makeMats(THREE), groups: new Map(), house: null });
    } catch (e) { G = null; }
  }
  const api = { ok: !!G, aspect };
  if (!G) {
    Object.assign(api, { rebuildHouse() { }, render() { }, size() { return false; }, shot() { return null; }, moveCam() { }, frameOrbit() { } });
    return api;
  }

  const disposeTree = o => o.traverse(m => { if (m.geometry) m.geometry.dispose(); });

  api.rebuildHouse = () => {
    if (G.house) { G.scene.remove(G.house.group); disposeTree(G.house.group); }
    G.house = buildHouse(THREE, app.scene, app.an); G.scene.add(G.house.group);
    G.fit(sceneBounds(app.scene), app.scene.ceiling);
  };
  /** Aim the dollhouse camera at the whole building. */
  api.frameOrbit = () => {
    const b = sceneBounds(app.scene), o = V.orbit;
    o.tx = (b.x0 + b.x1) / 2; o.tz = -(b.y0 + b.y1) / 2; o.r = clamp(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.75, 8, 120); o.th = -0.6; o.ph = 0.78;
  };

  function syncItems() {
    const seen = new Set();
    for (const it of app.scene.items) {
      seen.add(it.id);
      const sig = it.t + '|' + it.w + '|' + it.d; let g = G.groups.get(it.id);
      if (!g || g.userData.sig !== sig) {
        if (g) { G.itemsG.remove(g); disposeTree(g); }
        g = buildItem(THREE, G.mats, it.t, it.w, it.d); g.userData.sig = sig; G.groups.set(it.id, g); G.itemsG.add(g);
      }
      g.position.set(it.x, 0, -it.y); g.rotation.y = it.r * RAD; g.scale.x = it.f ? -1 : 1; g.scale.y = it.h ? it.h / natH(it.t, it.w, it.d) : 1;
    }
    for (const [id, g] of G.groups) if (!seen.has(id)) { G.itemsG.remove(g); disposeTree(g); G.groups.delete(id); }
  }
  function applyCam() {
    const c = G.cam;
    if (V.mode === 'eye') {
      const k = app.scene.cam, cp = Math.cos(k.pitch);
      c.fov = k.fov; c.near = 0.08; c.position.set(k.x, k.h, -k.y);
      c.lookAt(k.x + Math.cos(k.yaw) * cp, k.h + Math.sin(k.pitch), -k.y - Math.sin(k.yaw) * cp);
    } else {
      const o = V.orbit; c.fov = 34; c.near = 0.3;
      c.position.set(o.tx + o.r * Math.sin(o.ph) * Math.sin(o.th), o.r * Math.cos(o.ph), o.tz + o.r * Math.sin(o.ph) * Math.cos(o.th));
      c.lookAt(o.tx, 0, o.tz);
    }
    c.updateProjectionMatrix(); c.updateMatrixWorld();
  }
  function applyLook(l) {
    const sc = G.scene;
    sc.overrideMaterial = l === 'clay' ? G.clay : l === 'depth' ? G.depth : null;
    sc.background = l === 'depth' ? G.black : l === 'clay' ? G.clayBg : G.sky;
    sc.traverse(m => { if (m.userData && m.userData.glass) m.visible = l === 'colour'; });
    G.ground.visible = l !== 'depth';
    if (G.house) G.house.ceiling.visible = V.mode === 'eye';
    if (l === 'depth') {
      const p = G.cam.position, b = G.box; let far = 0;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) far = Math.max(far, Math.hypot(p.x - x, p.y - y, p.z - z));
      G.depth.uniforms.far.value = Math.max(far, 2); G.depth.uniforms.nearRef.value = Math.max(0.9, b.distanceToPoint(p));
    }
  }
  api.size = () => {
    const r = pane.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const a = aspect(); let w = Math.min(r.width, r.height * a), h = w / a; w = Math.floor(w); h = Math.floor(h);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    G.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); G.renderer.setSize(w, h, false); G.cam.aspect = a; return true;
  };
  function renderNow() {
    queued = false;
    if (pane.getBoundingClientRect().width < 2 || !G.house) return;
    syncItems(); applyCam(); applyLook(V.look); G.renderer.render(G.scene, G.cam);
  }
  api.render = () => { if (!queued) { queued = true; requestAnimationFrame(renderNow); } };

  /** Render one picture at export size and return it as a PNG data URL. */
  api.shot = (look, scale = 1) => {
    if (!G.house) return null;
    const sz = ASPECTS[V.asp], w = Math.round(sz[0] * scale), h = Math.round(sz[1] * scale), r = G.renderer;
    syncItems(); r.setPixelRatio(1); r.setSize(w, h, false); G.cam.aspect = w / h; applyCam(); applyLook(look); r.render(G.scene, G.cam);
    let url = null; try { url = canvas.toDataURL('image/png'); } catch (e) { /* tainted or lost context */ }
    if (api.size()) { applyCam(); applyLook(V.look); r.render(G.scene, G.cam); }
    return url;
  };

  api.moveCam = (f, l) => {
    const c = app.scene.cam;
    c.x += Math.cos(c.yaw) * f - Math.sin(c.yaw) * l; c.y += Math.sin(c.yaw) * f + Math.cos(c.yaw) * l;
    app.drawPlan(); api.render();
  };

  // ---- pointer controls
  const gp = new Map(); let gd = null;
  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    gp.set(e.pointerId, evPt(e)); const a = Array.from(gp.values());
    gd = gp.size === 2 ? { d0: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, fov0: app.scene.cam.fov, r0: V.orbit.r, mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2 } : { last: a[0] };
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', e => {
    if (!gp.has(e.pointerId) || !gd) return; const p = evPt(e); gp.set(e.pointerId, p);
    const c = app.scene.cam;
    if (gp.size >= 2 && gd.d0) {
      const a = Array.from(gp.values()), d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
      if (V.mode === 'eye') { c.fov = clamp(gd.fov0 * gd.d0 / d, 30, 100); app.syncPanel(); }
      else {
        const o = V.orbit; o.r = clamp(gd.r0 * gd.d0 / d, 4, 160); const k = o.r * 0.0016, dx = mx - gd.mx, dy = my - gd.my;
        o.tx -= (Math.cos(o.th) * dx + Math.sin(o.th) * dy) * k; o.tz -= (-Math.sin(o.th) * dx + Math.cos(o.th) * dy) * k; gd.mx = mx; gd.my = my;
      }
      app.drawPlan(); api.render(); return;
    }
    if (!gd.last) return; const dx = p.x - gd.last.x, dy = p.y - gd.last.y; gd.last = p;
    if (V.mode === 'eye') { c.yaw += dx * 0.0045; c.pitch = clamp(c.pitch + dy * 0.0045, -0.9, 0.9); app.drawPlan(); }
    else { V.orbit.th -= dx * 0.006; V.orbit.ph = clamp(V.orbit.ph - dy * 0.006, 0.12, 1.4); }
    api.render();
  });
  const up = e => {
    if (!gp.has(e.pointerId)) return; gp.delete(e.pointerId); canvas.style.cursor = 'grab';
    if (gp.size === 1) gd = { last: Array.from(gp.values())[0] }; else if (!gp.size) { gd = null; if (V.mode === 'eye') app.save(); }
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (V.mode === 'eye') { api.moveCam(-e.deltaY * 0.003, 0); app.save(); }
    else { V.orbit.r = clamp(V.orbit.r * Math.exp(e.deltaY * 0.0012), 4, 160); api.render(); }
  }, { passive: false });
  canvas.addEventListener('keydown', e => {
    if (V.mode !== 'eye') return;
    const k = e.key.toLowerCase(), m = { w: [0.2, 0], arrowup: [0.2, 0], s: [-0.2, 0], arrowdown: [-0.2, 0], a: [0, 0.2], d: [0, -0.2] }[k];
    if (m) { e.preventDefault(); api.moveCam(m[0], m[1]); app.save(); }
    else if (k === 'arrowleft') { e.preventDefault(); app.scene.cam.yaw += 0.08; app.drawPlan(); api.render(); }
    else if (k === 'arrowright') { e.preventDefault(); app.scene.cam.yaw -= 0.08; app.drawPlan(); api.render(); }
  });
  return api;
}
