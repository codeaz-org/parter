// Everything that opens in a sheet or drawer: projects, starting from a plan picture,
// export and AI renders, settings, and the assistant chat.
import { newScene, normalizeScene, serialize } from '../core/scene.js';
import { buildPrompt, STYLES } from '../core/prompt.js';
import { PRESETS, IMAGE_PRESETS, generateImage } from '../ai/providers.js';
import { runChat, importPlan } from '../ai/assistant.js';

const CUR = 'parter:current';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const dataUrlParts = url => { const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(url || ''); return m ? { mime: m[1], b64: m[2] } : null; };

export async function initPanels(A) {
  const { $, $$, press, store } = A;
  await store.init();

  // =====================================================================================
  // settings
  // =====================================================================================
  const defaults = () => ({ chat: { engine: store.agent ? 'claude-code' : 'anthropic', keys: {}, models: {}, bases: {} }, image: { provider: 'openai', keys: {}, models: {} } });
  let S = Object.assign(defaults(), store.settings());
  S.chat = Object.assign(defaults().chat, S.chat); S.image = Object.assign(defaults().image, S.image);
  if (S.chat.engine === 'claude-code' && !store.agent) S.chat.engine = 'anthropic';

  function chatCfg() {
    const e = S.chat.engine;
    if (e === 'claude-code') return { engine: e, label: 'Claude Code on this computer' };
    const p = PRESETS[e] || PRESETS.anthropic;
    return { engine: e, label: p.label, format: p.format, baseUrl: S.chat.bases[e] || p.baseUrl, model: S.chat.models[e] || p.model, key: S.chat.keys[e] || '' };
  }
  function imageCfg() {
    const p = S.image.provider, d = IMAGE_PRESETS[p] || IMAGE_PRESETS.openai;
    // an OpenAI or Gemini chat key works for pictures too, so do not make people paste it twice
    const fallback = p === 'openai' ? S.chat.keys.openai : p === 'gemini' ? S.chat.keys.gemini : '';
    return { provider: p, label: d.label, model: S.image.models[p] || d.model, key: S.image.keys[p] || fallback || '' };
  }
  const chatReady = c => c.engine === 'claude-code' || (!!c.model && (c.format !== 'anthropic' || !!c.key) && (c.engine === 'local' || !!c.key));

  const sChat = $('#sChat'), sImg = $('#sImg');
  for (const k in PRESETS) sChat.add(new Option(PRESETS[k].label, k));
  if (store.local) sChat.add(new Option(store.agent ? 'Claude Code on this computer' : 'Claude Code (not found on this computer)', 'claude-code'), 0);
  for (const k in IMAGE_PRESETS) sImg.add(new Option(IMAGE_PRESETS[k].label, k));
  let shownChat = null, shownImg = null;
  function stash() {
    if (shownChat && shownChat !== 'claude-code') { S.chat.keys[shownChat] = $('#sKey').value.trim(); S.chat.models[shownChat] = $('#sModel').value.trim(); S.chat.bases[shownChat] = $('#sBase').value.trim(); }
    if (shownImg) { S.image.keys[shownImg] = $('#sImgKey').value.trim(); S.image.models[shownImg] = $('#sImgModel').value.trim(); }
  }
  function showSettings() {
    const e = sChat.value, cc = e === 'claude-code', p = PRESETS[e];
    for (const el of $$('#setScrim .k')) el.hidden = cc;
    if (!cc) {
      $('#sKey').value = S.chat.keys[e] || ''; $('#sKey').placeholder = p.keyHint;
      $('#sModel').value = S.chat.models[e] || p.model; $('#sModel').placeholder = p.model || 'model name, as the provider lists it';
      $('#sBase').value = S.chat.bases[e] || p.baseUrl;
    }
    $('#sChatNote').textContent = cc
      ? (store.agent ? 'Requests go to the Claude Code CLI on this computer, which edits the project file through Parter’s MCP tools. No API key is needed; it uses your Claude Code sign-in.' : 'Install Claude Code and restart “npm start” to use it here.')
      : e === 'openai' ? 'Parter speaks the Chat Completions format. Some of OpenAI’s newest models only allow tools through their Responses API; if the assistant answers but changes nothing, pick a model that supports tools on Chat Completions.'
        : e === 'local' ? 'Any server that speaks the OpenAI Chat Completions format. The model needs tool calling; plan reading also needs vision.' : '';
    const ip = sImg.value, d = IMAGE_PRESETS[ip];
    $('#sImgKey').value = S.image.keys[ip] || ''; $('#sImgKey').placeholder = d.keyHint; $('#sImgModel').value = S.image.models[ip] || d.model;
    shownChat = e; shownImg = ip;
  }
  sChat.onchange = () => { stash(); showSettings(); };
  sImg.onchange = () => { stash(); showSettings(); };
  function openSettings() { sChat.value = S.chat.engine; sImg.value = S.image.provider; shownChat = shownImg = null; showSettings(); A.openSheet('#setScrim'); }
  $('#sSave').onclick = () => {
    stash(); S.chat.engine = sChat.value === 'claude-code' && !store.agent ? S.chat.engine : sChat.value; S.image.provider = sImg.value;
    store.saveSettings(S); $('#setScrim').hidden = true; syncEngine(); A.toast('Settings saved in this browser.');
  };
  $('#sForget').onclick = () => { S.chat.keys = {}; S.image.keys = {}; store.saveSettings(S); showSettings(); syncEngine(); A.toast('Keys forgotten.'); };
  $('#chatSettings').onclick = openSettings;

  // =====================================================================================
  // projects
  // =====================================================================================
  let chatHistory = [], agentSession = null, renders = [];

  async function openProject(id) {
    const scene = await store.load(id);
    if (!scene) { A.toast('That plan could not be opened.'); return false; }
    A.setScene(scene, id); lsSet(CUR, id);
    chatHistory = []; agentSession = null; $('#chatLog').textContent = ''; greet();
    await A.loadUnderlay(); loadRenders();
    return true;
  }
  async function createAndOpen(scene, wantId) { const id = await store.create(scene, wantId); await openProject(id); return id; }
  async function sampleScene() { const r = await fetch('projects/frumusita.json'); if (!r.ok) throw new Error('The sample plan is missing from this copy of Parter.'); return normalizeScene(await r.json()); }

  async function renderProjects() {
    const list = await store.list(), box = $('#projList'); box.textContent = '';
    for (const p of list) {
      const row = document.createElement('div'); row.className = 'prow' + (p.id === A.id ? ' on' : '');
      const info = document.createElement('div'), b = document.createElement('b'), sp = document.createElement('span');
      b.textContent = p.name || p.id; sp.textContent = (p.id === A.id ? 'Open now' : p.modified ? 'Changed ' + new Date(p.modified).toLocaleDateString() : '');
      info.append(b, sp);
      const acts = document.createElement('div'); acts.className = 'acts';
      const mk = (label, fn, cls) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'btn' + (cls ? ' ' + cls : ''); x.textContent = label; x.onclick = fn; acts.appendChild(x); };
      if (p.id !== A.id) mk('Open', async () => { await flush(); if (await openProject(p.id)) A.closeSheets(); });
      mk('Rename', async () => {
        const name = window.prompt('Name for this plan', p.name || ''); if (!name || !name.trim()) return;
        if (p.id === A.id) { A.scene.name = name.trim().slice(0, 80); $('#projName').textContent = A.scene.name; document.title = A.scene.name + ' – Parter'; A.save(); await flush(); }
        else { const s = await store.load(p.id); if (s) { s.name = name.trim().slice(0, 80); store.lastSaved = ''; await store.save(p.id, s); if (A.id) await store.load(A.id); } }
        renderProjects();
      });
      mk('Duplicate', async () => { await flush(); const s = await store.load(p.id); if (!s) return; s.name = (s.name + ' copy').slice(0, 80); const from = p.id; const id = await createAndOpen(s); const u = await store.getBlob(from + ':underlay'); if (u) { await store.putBlob(id + ':underlay', u); await A.loadUnderlay(); } renderProjects(); });
      mk('Delete', async () => {
        if (!window.confirm('Delete “' + (p.name || p.id) + '”? This cannot be undone.')) return;
        await store.remove(p.id);
        if (p.id === A.id) { const rest = (await store.list()).filter(q => q.id !== p.id); if (rest.length) await openProject(rest[0].id); else await createAndOpen(await sampleScene(), 'frumusita'); }
        renderProjects();
      }, 'danger');
      row.append(info, acts); box.appendChild(row);
    }
    $('#storeNote').textContent = store.local
      ? 'Plans are saved as JSON files in the “projects” folder next to Parter, where Claude Code and other tools can edit them too.'
      : 'Plans are saved in this browser only. Use Export → Project file to back one up or move it to another device.';
  }
  $('#projBtn').onclick = () => { renderProjects(); A.openSheet('#projScrim'); };
  $('#newEmpty').onclick = async () => { await flush(); await createAndOpen(newScene('Untitled plan')); A.closeSheets(); A.setPlanMode('build'); };
  $('#newSample').onclick = async () => { try { await flush(); await createAndOpen(await sampleScene(), 'frumusita'); A.closeSheets(); } catch (e) { A.toast(e.message); } };
  $('#importJson').onclick = () => $('#jsonFile').click();
  $('#jsonFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { await flush(); await createAndOpen(normalizeScene(JSON.parse(await f.text()))); A.closeSheets(); A.toast('Plan opened.'); }
    catch (err) { A.toast('That file is not a Parter plan: ' + err.message); }
  };
  /** Write any pending change now (before switching project or handing over to Claude Code). */
  async function flush() { if (A.id) await store.save(A.id, A.scene); }

  // external edits in local mode (Claude Code through MCP, a text editor, git checkout)
  async function adoptFromDisk(quiet) {
    if (!store.local || !A.id || A.isBusy()) return false;
    const raw = await store.fetchRaw(A.id); if (!raw || store.recent.includes(raw)) return false;
    let scene; try { scene = normalizeScene(JSON.parse(raw)); } catch (e) { return false; }
    store.lastSaved = JSON.stringify(serialize(scene)); store.recent.push(raw);
    A.setScene(scene, A.id, { keepView: true, undoable: true });
    if (!quiet) A.toast('The plan was changed outside this window. Undo brings back your version.');
    return true;
  }
  store.watch(ev => { if (ev && ev.id === A.id) adoptFromDisk(); });

  // =====================================================================================
  // start from a plan picture
  // =====================================================================================
  let picked = null;
  $('#newFromImg').onclick = () => { picked = null; $('#impPrev').hidden = true; $('#impRead').disabled = $('#impTrace').disabled = true; $('#impStatus').textContent = ''; $('#projScrim').hidden = true; A.openSheet('#impScrim'); };
  $('#impPick').onclick = () => $('#impFile').click();
  $('#impFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { picked = await A.readPicture(f); picked.name = f.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Plan'; $('#impPrev').src = picked.dataUrl; $('#impPrev').hidden = false; $('#impRead').disabled = $('#impTrace').disabled = false; $('#impStatus').textContent = ''; }
    catch (err) { $('#impStatus').textContent = err.message; }
  };
  $('#impTrace').onclick = async () => {
    if (!picked) return; await flush();
    await createAndOpen(newScene(picked.name)); await A.setUnderlayPicture(picked);
    A.closeSheets(); A.setPlanMode('build'); $('#underPanel').hidden = false;
    A.toast('Set the scale from two points first, then draw the walls over the picture.', 6000);
  };

  const importAsk = hint => 'Transcribe the attached floor plan picture into this project. Read docs/IMPORT.md first and follow its rules. Call the parter MCP tool set_structure, compare the room areas it reports with the areas printed on the drawing, and correct with a second call if they differ.' + (hint ? ' Note from the user: ' + hint : '');

  /** Read a plan picture into walls and rooms. Used for new projects and for "Read walls with AI". */
  async function readPlan(pic, hint, status, intoCurrent) {
    const cfg = chatCfg();
    if (!chatReady(cfg)) { A.toast('Choose how the assistant runs and add a key first.'); openSettings(); return false; }
    const img = dataUrlParts(pic.dataUrl); if (!img) { status('That picture could not be prepared.'); return false; }
    await flush();
    if (cfg.engine === 'claude-code') {
      if (!intoCurrent) { await createAndOpen(newScene(pic.name || 'Plan')); await A.setUnderlayPicture(pic); await flush(); }
      status('Claude Code is reading the drawing. This can take a few minutes.');
      const j = await store.askAgent({ project: A.id, prompt: importAsk(hint), attach: 'underlay' });
      await adoptFromDisk(true);
      return j.text || 'Done.';
    }
    status('Reading the drawing. This usually takes a minute or two.');
    const scene = intoCurrent ? normalizeScene(A.serialize()) : newScene(pic.name || 'Plan');
    const out = await importPlan({ cfg, scene, image: { mime: img.mime, b64: img.b64, w: pic.w, h: pic.h }, hint, onStep: s => status('Checking the result, pass ' + s.pass + '…') });
    const fixed = normalizeScene(scene);
    if (intoCurrent) { A.setScene(fixed, A.id, { undoable: true }); A.save(); }
    else { await createAndOpen(fixed); }
    const hadRefs = !!fixed.underlay;
    if (!intoCurrent) await A.setUnderlayPicture(pic);
    if (!hadRefs) A.toast('The scan could not be lined up automatically. Use Scan → Move and resize.', 7000);
    return out.notes || out.result;
  }
  $('#impRead').onclick = async () => {
    if (!picked) return; const btn = $('#impRead'), st = m => { $('#impStatus').textContent = m; };
    btn.disabled = $('#impTrace').disabled = true;
    try {
      const notes = await readPlan(picked, $('#impHint').value.trim(), st, false);
      if (notes === false) return;
      A.closeSheets(); A.setPlanMode('build'); A.hint('Check every room against the drawing. ' + String(notes).slice(0, 400));
    } catch (err) { st('That did not work: ' + err.message); }
    finally { btn.disabled = $('#impTrace').disabled = !picked; }
  };
  $('#underRead').onclick = async () => {
    const url = await store.getBlob(A.id + ':underlay'); if (!url || !A.underImg) return;
    if (A.scene.walls.length && !window.confirm('Replace the walls and furniture of this plan with what the AI reads from the picture? Undo brings them back.')) return;
    A.hint('Reading the drawing…');
    try {
      const notes = await readPlan({ dataUrl: url, w: A.underImg.naturalWidth, h: A.underImg.naturalHeight }, '', m => A.hint(m), true);
      if (notes !== false) A.hint('Check every room against the drawing. ' + String(notes).slice(0, 400));
    } catch (err) { A.hint(''); A.toast('That did not work: ' + err.message, 7000); }
  };

  // =====================================================================================
  // export and renders
  // =====================================================================================
  let styleKey = 'warm';
  const fillPrompt = () => { $('#prompt').value = buildPrompt(A.scene, A.an, A.V.mode, styleKey); };
  {
    const box = $('#styleChips');
    for (const k in STYLES) { const b = document.createElement('button'); b.type = 'button'; b.dataset.s = k; b.textContent = STYLES[k][0]; b.setAttribute('aria-pressed', String(k === styleKey)); box.appendChild(b); }
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; styleKey = b.dataset.s; press('#styleChips', 's', styleKey); fillPrompt(); });
  }
  function download(name, url) {
    if (!url) { A.toast('That picture could not be made in this browser.'); return; }
    const a = document.createElement('a'); a.download = name;
    if (url.startsWith('data:')) {
      const p = dataUrlParts(url), bin = atob(p.b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      a.href = URL.createObjectURL(new Blob([u], { type: p.mime })); setTimeout(() => URL.revokeObjectURL(a.href), 20000);
    } else { a.href = url; a.target = '_blank'; a.rel = 'noopener'; }
    document.body.appendChild(a); a.click(); a.remove(); A.toast('Saved ' + name);
  }
  const fileBase = () => (A.id || 'plan');
  $('#expScrim').addEventListener('click', e => {
    const b = e.target.closest('button[data-save]'); if (!b) return; const k = b.dataset.save;
    if (k === 'plan') download(fileBase() + '-plan.png', A.planShot());
    else if (k === 'json') download(fileBase() + '.json', 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(A.serialize(), null, 1)))));
    else download(fileBase() + '-' + k + '.png', A.view.shot(k, 1));
  });
  $('#copyBtn').onclick = async () => {
    const t = $('#prompt'); let ok = false;
    try { await navigator.clipboard.writeText(t.value); ok = true; } catch (e) { try { t.focus(); t.select(); ok = document.execCommand('copy'); } catch (_) { /* ignore */ } }
    A.toast(ok ? 'Prompt copied' : 'Select the text and copy it by hand');
  };
  $('#exportBtn').onclick = () => {
    const u = A.view.shot('colour', 0.5), p = $('#prev'); if (u) { p.src = u; p.hidden = false; } else p.hidden = true;
    fillPrompt(); $('#genStatus').textContent = ''; $('#genBtn').textContent = 'Generate render'; paintGallery(); A.openSheet('#expScrim');
  };

  let holdUrl = null;
  function showPicture(url) { holdUrl = url; $('#holdImg').src = url; $('#hold').hidden = false; }
  $('#holdSave').onclick = () => download(fileBase() + '-render.png', holdUrl);
  function paintGallery() {
    const g = $('#gallery'); g.textContent = '';
    for (const r of renders) { const b = document.createElement('button'), im = document.createElement('img'); b.type = 'button'; im.src = r.url; im.alt = 'Render made ' + new Date(r.t).toLocaleString(); b.appendChild(im); b.onclick = () => showPicture(r.url); g.appendChild(b); }
  }
  async function loadRenders() {
    renders = [];
    const keys = (await store.blobKeys(A.id)).filter(k => k.includes(':render:')).sort().reverse().slice(0, 12);
    for (const k of keys) { const url = await store.getBlob(k); if (url) renders.push({ key: k, url, t: +k.split(':').pop() || 0 }); }
    paintGallery();
  }
  let genAbort = null;
  $('#genBtn').onclick = async () => {
    if (genAbort) { genAbort.abort(); return; }
    const cfg = imageCfg(), st = m => { $('#genStatus').textContent = m; };
    if (!cfg.key) { A.toast('Add an image API key first.'); openSettings(); return; }
    if (!A.view.ok) { st('This browser cannot make the 3D view the render is based on.'); return; }
    const colour = dataUrlParts(A.view.shot('colour', 1)); if (!colour) { st('The reference picture could not be made.'); return; }
    const images = [{ mime: colour.mime, b64: colour.b64, name: 'layout.png' }];
    let prompt = $('#prompt').value.trim();
    if ($('#genDepth').checked) { const d = dataUrlParts(A.view.shot('depth', 1)); if (d) { images.push({ mime: d.mime, b64: d.b64, name: 'depth.png' }); prompt += '\n\nThe second image is a depth map of the same view (white is near, black is far). Use it only to keep the geometry exact; do not show it.'; } }
    const size = { '4:3': '1536x1024', '16:9': '1536x1024', '1:1': '1024x1024', '3:4': '1024x1536' }[A.V.asp];
    genAbort = new AbortController(); $('#genBtn').textContent = 'Stop'; st('Rendering with ' + cfg.label + ' (' + cfg.model + '). This can take a minute.');
    try {
      const url = await generateImage(cfg, { prompt, images, size, signal: genAbort.signal });
      const t = Date.now(), key = A.id + ':render:' + t;
      if (url.startsWith('data:')) await store.putBlob(key, url);
      renders.unshift({ key, url, t }); paintGallery(); st('Done. Tap the picture to see it full size.');
    } catch (err) { st(err.name === 'AbortError' ? 'Stopped.' : 'That did not work: ' + err.message); }
    finally { genAbort = null; $('#genBtn').textContent = 'Generate render'; }
  };

  // =====================================================================================
  // assistant chat
  // =====================================================================================
  const log = $('#chatLog');
  const bubble = (cls, text) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  function syncEngine() { const c = chatCfg(); $('#chatEngine').textContent = c.engine === 'claude-code' ? c.label : chatReady(c) ? c.label + ' · ' + c.model : 'not set up yet'; }
  function greet() {
    if (log.childElementCount) return;
    bubble('a', 'Tell me what to change and I will edit the plan: move or add furniture, resize windows, close or glaze doors, rename rooms, aim the camera.' +
      (chatReady(chatCfg()) ? '' : '\n\nI need a model to run on first. Open Settings and add an API key' + (store.local ? ', or choose Claude Code.' : '.')));
  }
  $('#chatBtn').onclick = () => { const c = $('#chat'); c.hidden = !c.hidden; if (!c.hidden) { syncEngine(); greet(); $('#chatIn').focus(); } };
  $('#chatClose').onclick = () => { $('#chat').hidden = true; };
  let chatAbort = null;
  async function send() {
    if (chatAbort) { chatAbort.abort(); return; }
    const inp = $('#chatIn'), text = inp.value.trim(); if (!text) return;
    const cfg = chatCfg();
    if (!chatReady(cfg)) { A.toast('Set up the assistant first.'); openSettings(); return; }
    inp.value = ''; bubble('u', text);
    const work = bubble('t', 'Working…'); $('#chatSend').textContent = 'Stop';
    chatAbort = new AbortController();
    try {
      if (cfg.engine === 'claude-code') {
        await flush();
        const j = await store.askAgent({ project: A.id, prompt: text, session: agentSession });
        agentSession = j.session || agentSession; await adoptFromDisk(true);
        work.remove(); bubble('a', j.text || 'Done.');
      } else {
        const lines = [];
        const out = await runChat({
          cfg, scene: A.scene, history: chatHistory, userText: text, signal: chatAbort.signal,
          onStep: s => { for (const r of s.results) lines.push((r.ok ? '' : '⚠ ') + r.text.split('. ')[0].slice(0, 140)); work.textContent = lines.slice(-6).join('\n'); A.structChanged(); A.draw(); A.view.render(); log.scrollTop = log.scrollHeight; }
        });
        chatHistory = out.history;
        if (out.changed) A.commit(true);
        if (!lines.length) work.remove();
        bubble('a', out.text || (out.changed ? 'Done.' : 'I did not change anything.'));
      }
    } catch (err) {
      work.remove();
      if (cfg.engine !== 'claude-code') A.commit(true);           // keep whatever was already changed, as one undo step
      bubble(err.name === 'AbortError' ? 't' : 'e', err.name === 'AbortError' ? 'Stopped.' : err.message);
    } finally { chatAbort = null; $('#chatSend').textContent = 'Send'; }
  }
  $('#chatSend').onclick = send;
  $('#chatIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // =====================================================================================
  // first run
  // =====================================================================================
  syncEngine();
  const list = await store.list(), cur = lsGet(CUR);
  if (!list.length) {
    try { await createAndOpen(await sampleScene(), 'frumusita'); A.hint('This is a sample house. Drag furniture to move it; the amber marker is your camera. Your own plans start under the name at the top left.'); }
    catch (e) { await createAndOpen(newScene('Untitled plan')); A.setPlanMode('build'); }
  } else if (!(await openProject(list.some(p => p.id === cur) ? cur : list[0].id))) await createAndOpen(newScene('Untitled plan'));
  A.panels = { openProject, readPlan, chatCfg, imageCfg, send, flush };
}
