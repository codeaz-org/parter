#!/usr/bin/env node
// Parter on your own computer:  npm start
//
// Serves the same static app that runs on Cloudflare Pages, plus a tiny API so that
//   - plans are JSON files in ./projects (git-friendly, editable by any tool),
//   - the browser updates live when a file changes (Claude Code, the MCP server, an editor),
//   - the in-app assistant can hand a request to the Claude Code CLI instead of needing an API key.
//
// No dependencies. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PROJ = path.resolve(process.env.PARTER_PROJECTS || path.join(ROOT, 'projects'));
const BLOBS = path.join(PROJ, '.blobs');
const PORT = +(process.env.PORT || 4173);
const AGENT_CMD = process.env.PARTER_AGENT_CMD || 'claude';
const AGENT_TIMEOUT = +(process.env.PARTER_AGENT_TIMEOUT || 600000);

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,63}(:[a-z0-9]+){1,3}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME_OF = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

fs.mkdirSync(BLOBS, { recursive: true });
if (!fs.readdirSync(PROJ).some(f => f.endsWith('.json'))) {
  try { fs.copyFileSync(path.join(PUBLIC, 'projects', 'frumusita.json'), path.join(PROJ, 'frumusita.json')); } catch (e) { /* no sample */ }
}
const hasAgent = (() => { try { return spawnSync(AGENT_CMD, ['--version'], { timeout: 8000, stdio: 'ignore' }).status === 0; } catch (e) { return false; } })();

const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req, max = 40e6) => new Promise((ok, bad) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { bad(new Error('too large')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });
const atomic = async (file, data) => { const tmp = file + '.' + process.pid + '.tmp'; await fsp.writeFile(tmp, data); await fsp.rename(tmp, file); };
const blobBase = key => path.join(BLOBS, key.replace(/:/g, '__'));
async function findBlob(key) { for (const ext of Object.keys(MIME_OF)) { const f = blobBase(key) + ext; try { await fsp.access(f); return f; } catch (e) { /* next */ } } return null; }

// ---- live updates
const clients = new Set(); const timers = new Map();
try {
  fs.watch(PROJ, (ev, name) => {
    if (!name || !name.endsWith('.json')) return; const id = name.slice(0, -5); if (!ID.test(id)) return;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { for (const r of clients) r.write('data: ' + JSON.stringify({ id }) + '\n\n'); }, 150));
  });
} catch (e) { console.warn('File watching is not available here; the browser will not update live.'); }

// ---- Claude Code hand-off
function askAgent({ project, prompt, session, attach }) {
  return new Promise(async (ok, bad) => {
    let extra = '';
    if (attach) { const f = await findBlob(project + ':' + attach); if (f) extra = `\n\nThe picture is this file, read it: ${f}`; }
    const full = `You are the assistant inside Parter, a floor-plan editor. The user has the project "${project}" open and sees every change live. ` +
      `Use the parter MCP tools and always pass project "${project}". Start with describe_scene unless you already know the plan. ` +
      `When you are done, answer in one or two short sentences with no markdown.\n\nUser request: ${prompt}${extra}`;
    const args = ['-p', full, '--output-format', 'json', '--mcp-config', path.join(ROOT, '.mcp.json'), '--allowedTools', attach ? 'mcp__parter,Read' : 'mcp__parter'];
    if (session) args.push('--resume', session);
    const child = spawn(AGENT_CMD, args, { cwd: ROOT, env: Object.assign({}, process.env, { PARTER_PROJECTS: PROJ }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); bad(new Error('Claude Code took too long and was stopped.')); }, AGENT_TIMEOUT);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); bad(new Error('Could not start Claude Code: ' + e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch (e) { /* plain text */ }
      if (j && typeof j.result === 'string' && !j.is_error) ok({ text: j.result.trim(), session: j.session_id || null });
      else if (code === 0 && out.trim() && !j) ok({ text: out.trim(), session: null });
      else bad(new Error((j && (j.result || j.error)) || err.trim().split('\n').pop() || 'Claude Code stopped with code ' + code));
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) {
      // only this page may call the API: a web page on another site must not be able to drive it
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin)) return send(res, 403, { error: 'forbidden' });
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').match(/json|text\/plain/) && req.method !== 'DELETE') return send(res, 415, { error: 'unsupported content type' });

      if (p === '/api/local') return send(res, 200, { parter: true, agent: hasAgent, projects: PROJ });
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n');
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (p === '/api/projects' && req.method === 'GET') {
        const out = [];
        for (const f of await fsp.readdir(PROJ)) {
          if (!f.endsWith('.json') || !ID.test(f.slice(0, -5))) continue;
          try { const st = await fsp.stat(path.join(PROJ, f)), j = JSON.parse(await fsp.readFile(path.join(PROJ, f), 'utf8')); out.push({ id: f.slice(0, -5), name: j.name || f.slice(0, -5), modified: st.mtimeMs }); } catch (e) { /* skip unreadable */ }
        }
        return send(res, 200, out.sort((a, b) => b.modified - a.modified));
      }
      let m = /^\/api\/projects\/([^/]+)$/.exec(p);
      if (m) {
        if (!ID.test(m[1])) return send(res, 400, { error: 'bad project id' });
        const file = path.join(PROJ, m[1] + '.json');
        if (req.method === 'GET') { try { return send(res, 200, await fsp.readFile(file)); } catch (e) { return send(res, 404, { error: 'not found' }); } }
        if (req.method === 'PUT') { const body = await readBody(req, 5e6); JSON.parse(body.toString('utf8')); await atomic(file, body); return send(res, 200, { ok: true }); }
        if (req.method === 'DELETE') { await fsp.rm(file, { force: true }); return send(res, 200, { ok: true }); }
      }
      if (p === '/api/blobs' && req.method === 'GET') {
        const pre = (url.searchParams.get('prefix') || '').replace(/:/g, '__');
        return send(res, 200, (await fsp.readdir(BLOBS)).filter(f => f.startsWith(pre)).map(f => f.replace(/\.[a-z]+$/, '').replace(/__/g, ':')));
      }
      m = /^\/api\/blobs\/([^/]+)$/.exec(p);
      if (m) {
        if (!KEY.test(m[1])) return send(res, 400, { error: 'bad key' });
        const have = await findBlob(m[1]);
        if (req.method === 'GET') { if (!have) return send(res, 404, { error: 'not found' }); return send(res, 200, 'data:' + MIME_OF[path.extname(have)] + ';base64,' + (await fsp.readFile(have)).toString('base64'), 'text/plain'); }
        if (req.method === 'PUT') {
          const d = /^data:([^;,]+);base64,(.+)$/s.exec((await readBody(req)).toString('utf8')); if (!d || !EXT[d[1]]) return send(res, 400, { error: 'expected an image data URL' });
          if (have) await fsp.rm(have, { force: true });
          await atomic(blobBase(m[1]) + EXT[d[1]], Buffer.from(d[2], 'base64')); return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') { if (have) await fsp.rm(have, { force: true }); return send(res, 200, { ok: true }); }
      }
      if (p === '/api/agent' && req.method === 'POST') {
        if (!hasAgent) return send(res, 503, { error: 'Claude Code was not found on this computer. Install it, then restart Parter.' });
        const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
        if (!ID.test(b.project || '') || typeof b.prompt !== 'string' || !b.prompt.trim()) return send(res, 400, { error: 'project and prompt are required' });
        if (b.session && !/^[A-Za-z0-9-]{8,80}$/.test(b.session)) b.session = null;
        try { return send(res, 200, await askAgent({ project: b.project, prompt: b.prompt.slice(0, 8000), session: b.session, attach: b.attach === 'underlay' ? 'underlay' : null })); }
        catch (e) { return send(res, 502, { error: e.message }); }
      }
      return send(res, 404, { error: 'not found' });
    }
    // static files
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    try { const st = await fsp.stat(file); if (st.isDirectory()) file = path.join(file, 'index.html'); } catch (e) { return send(res, 404, 'not found', 'text/plain'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { send(res, 500, { error: String(e && e.message || e) }); }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Parter is running at  http://localhost:${PORT}\n\n  Plans:        ${PROJ}\n  Claude Code:  ${hasAgent ? 'found, the in-app assistant can use it' : 'not found (the assistant will need an API key instead)'}\n`);
});
