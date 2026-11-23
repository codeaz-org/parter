// Where projects live.
//
//   hosted, signed out (or any static host):     this browser's storage, nothing leaves the device
//   hosted, signed in:                           the account, through functions/api (same routes as local)
//   local  (npm start):                          JSON files in ./projects on your disk, so Claude Code
//                                                and the MCP server can edit the same plan you see
//
// The app asks /api/local once at start to find out which one it is running under.
import { normalizeScene, serialize, uid } from '../core/scene.js';

const IDX = 'parter:index', PRE = 'parter:p:', SET = 'parter:settings';
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

// pictures (the scanned plan, renders) are too big for localStorage: IndexedDB, with a memory fallback
const mem = new Map();
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise(res => {
    try {
      const rq = indexedDB.open('parter', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('blobs');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  return dbp;
}
async function idbOp(mode, fn) {
  const db = await idb(); if (!db) return undefined;
  return new Promise(res => {
    try { const tx = db.transaction('blobs', mode), rq = fn(tx.objectStore('blobs')); tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => res(undefined); tx.onabort = () => res(undefined); }
    catch (e) { res(undefined); }
  });
}

export const store = {
  local: false,          // true when served by server/local.mjs
  agent: false,          // true when that server can reach the Claude Code CLI
  cloud: null,           // what the hosted backend offers: { on, limits, user }; null on a plain static host
  get user() { return this.cloud && this.cloud.user; },
  get remote() { return this.local || !!this.user; },   // plans live behind /api rather than in this browser
  lastSaved: '',
  saveError: '',         // why the account refused the last save, in words for the user
  recent: [],            // the last few texts this window wrote, to tell its own saves from outside edits

  async init() {
    try {
      const r = await fetch('api/local', { headers: { accept: 'application/json' } });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) { const j = await r.json(); if (j && j.cloud) this.cloud = j; else if (j && j.parter) { this.local = true; this.agent = !!j.agent; } }
    } catch (e) { /* static hosting: no API */ }
    if (this.user) await this.adoptBrowserPlans();
    return this;
  },
  /** First sign-in on this device: move the plans made while signed out into the account. */
  async adoptBrowserPlans() {
    const mine = ls.get(IDX, []); if (!mine.length || (await this.list()).length) return;
    const put = (path, type, body) => fetch(path, { method: 'PUT', headers: { 'content-type': type }, body });
    for (const p of mine) {
      const data = ls.get(PRE + p.id, null);
      if (!data || !(await put('api/projects/' + encodeURIComponent(p.id), 'application/json', JSON.stringify(data))).ok) continue;   // over the plan allowance: it stays in this browser
      const keys = ((await idbOp('readonly', s => s.getAllKeys())) || []).filter(k => String(k).startsWith(p.id + ':'));
      for (const k of keys) { const v = await idbOp('readonly', s => s.get(k)); if (v) await put('api/blobs/' + encodeURIComponent(k), 'text/plain', v); }
    }
  },

  settings() { return ls.get(SET, {}); },
  saveSettings(s) { ls.set(SET, s); },

  async list() {
    if (this.remote) { const r = await fetch('api/projects'); return r.ok ? r.json() : []; }
    return ls.get(IDX, []).sort((a, b) => (b.modified || 0) - (a.modified || 0));
  },
  async load(id) {
    let raw;
    if (this.remote) { const r = await fetch('api/projects/' + encodeURIComponent(id)); if (!r.ok) return null; raw = await r.json(); }
    else raw = ls.get(PRE + id, null);
    if (!raw) return null;
    const scene = normalizeScene(raw);
    this.lastSaved = JSON.stringify(serialize(scene));
    return scene;
  },
  /** Local mode: the project file exactly as it is on disk. */
  async fetchRaw(id) { const r = await fetch('api/projects/' + encodeURIComponent(id)); return r.ok ? r.text() : null; },
  /** @returns true if it was written */
  async save(id, scene) {
    const data = serialize(scene), text = JSON.stringify(data);
    if (text === this.lastSaved) return true;
    this.saveError = '';
    if (this.remote) {
      const r = await fetch('api/projects/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text });
      if (!r.ok) { this.saveError = ((await r.json().catch(() => ({}))).error || {}).message || ''; return false; }
    } else {
      if (!ls.set(PRE + id, data)) return false;
      const idx = ls.get(IDX, []).filter(p => p.id !== id);
      idx.push({ id, name: scene.name, modified: Date.now() }); ls.set(IDX, idx);
    }
    this.lastSaved = text; this.recent.push(text); if (this.recent.length > 8) this.recent.shift(); return true;
  },
  async create(scene, wantId) {
    const base = (wantId || scene.name || 'plan').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'plan';
    const taken = new Set((await this.list()).map(p => p.id));
    let id = base; for (let n = 2; taken.has(id); n++) id = base + '-' + n;
    this.lastSaved = ''; await this.save(id, scene);
    return id;
  },
  async remove(id) {
    if (this.remote) await fetch('api/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    else { ls.del(PRE + id); ls.set(IDX, ls.get(IDX, []).filter(p => p.id !== id)); }
    for (const k of await this.blobKeys(id)) await this.delBlob(k);
  },

  // ---- pictures, stored as data URLs under "<project>:<name>"
  async putBlob(key, dataUrl) {
    if (this.remote) { const r = await fetch('api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: dataUrl }); return r.ok; }
    mem.set(key, dataUrl); await idbOp('readwrite', s => s.put(dataUrl, key)); return true;
  },
  async getBlob(key) {
    if (this.remote) { const r = await fetch('api/blobs/' + encodeURIComponent(key)); return r.ok ? r.text() : null; }
    if (mem.has(key)) return mem.get(key);
    const v = await idbOp('readonly', s => s.get(key)); return v || null;
  },
  async delBlob(key) {
    if (this.remote) { await fetch('api/blobs/' + encodeURIComponent(key), { method: 'DELETE' }); return; }
    mem.delete(key); await idbOp('readwrite', s => s.delete(key));
  },
  async blobKeys(id) {
    if (this.remote) { const r = await fetch('api/blobs?prefix=' + encodeURIComponent(id + ':')); return r.ok ? r.json() : []; }
    const keys = (await idbOp('readonly', s => s.getAllKeys())) || [];
    return [...new Set([...keys, ...mem.keys()])].filter(k => String(k).startsWith(id + ':'));
  },

  /** Local mode only: call back when a project file changes on disk (Claude Code, an editor, git). */
  watch(cb) {
    if (!this.local || typeof EventSource === 'undefined') return;
    const es = new EventSource('api/events');
    es.onmessage = e => { try { cb(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
  },

  /** Local mode only: hand a request to Claude Code. */
  async askAgent(body) {
    const r = await fetch('api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Claude Code did not answer (' + r.status + ')');
    return j;
  },

  newId: () => uid('p')
};
