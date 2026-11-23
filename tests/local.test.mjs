import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parter-'));
const PORT = 4300 + Math.floor(Math.random() * 500), base = `http://127.0.0.1:${PORT}`;
const env = Object.assign({}, process.env, { PARTER_PROJECTS: dir, PORT: String(PORT), PARTER_AGENT_CMD: 'definitely-not-installed-xyz' });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let srv;

test.before(async () => {
  srv = spawn('node', ['server/local.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, bad) => { srv.stdout.on('data', d => { if (String(d).includes('running')) ok(); }); srv.on('exit', () => bad(new Error('server exited'))); setTimeout(() => bad(new Error('server did not start')), 8000); });
});
test.after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('local server: serves the app, seeds the sample, stores plans and pictures as files', async () => {
  assert.match(await (await fetch(base + '/')).text(), /<title>Parter/);
  assert.equal((await fetch(base + '/js/core/ops.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  const info = await (await fetch(base + '/api/local')).json(); assert.equal(info.parter, true); assert.equal(info.agent, false);
  const list = await (await fetch(base + '/api/projects')).json(); assert.equal(list[0].id, 'frumusita');
  const scene = await (await fetch(base + '/api/projects/frumusita')).json(); assert.equal(scene.format, 'parter-scene');
  scene.name = 'Renamed';
  assert.ok((await fetch(base + '/api/projects/copy-1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scene) })).ok);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'copy-1.json'), 'utf8')).name, 'Renamed');
  assert.ok((await fetch(base + '/api/blobs/copy-1%3Aunderlay', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: PNG })).ok);
  assert.ok(fs.existsSync(path.join(dir, '.blobs', 'copy-1__underlay.png')), 'stored as a real image file');
  assert.equal(await (await fetch(base + '/api/blobs/copy-1%3Aunderlay')).text(), PNG);
  assert.deepEqual(await (await fetch(base + '/api/blobs?prefix=copy-1%3A')).json(), ['copy-1:underlay']);
  assert.ok((await fetch(base + '/api/projects/copy-1', { method: 'DELETE' })).ok);
});

test('local server: refuses bad ids, other origins and path tricks', async () => {
  assert.equal((await fetch(base + '/api/projects/Bad_ID', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  assert.ok((await fetch(base + '/api/projects/..%2Fsecret', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status >= 400);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'secret.json')));
  assert.equal((await fetch(base + '/api/projects', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.notEqual((await fetch(base + '/..%2F..%2Fpackage.json')).status, 200);
  assert.equal((await fetch(base + '/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'frumusita', prompt: 'hi' }) })).status, 503);
});

test('MCP server edits the same files, and the browser is told', async () => {
  const events = []; const ac = new AbortController();
  const es = await fetch(base + '/api/events', { signal: ac.signal });
  (async () => { try { for await (const chunk of es.body) events.push(new TextDecoder().decode(chunk)); } catch (e) { /* aborted */ } })();
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs'], cwd: ROOT, env }));
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content[0].text }; };
  const names = (await c.listTools()).tools.map(t => t.name);
  for (const n of ['list_projects', 'create_project', 'describe_scene', 'add_furniture', 'update_opening', 'set_structure']) assert.ok(names.includes(n), n);
  assert.match((await call('list_projects', {})).text, /frumusita/);
  assert.match((await call('describe_scene', { project: 'frumusita' })).text, /Cameră de zi: 51\.2 m²/);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'frumusita.json'), 'utf8')).items.length;
  assert.match((await call('add_furniture', { project: 'frumusita', type: 'plant', x: 5.8, y: 3.2 })).text, /No overlaps/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'frumusita.json'), 'utf8')).items.length, before + 1);
  assert.ok((await call('add_furniture', { project: 'nope', type: 'plant', x: 1, y: 1 })).err);
  assert.match((await call('create_project', { name: 'Test Flat' })).text, /test-flat/);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(events.join('').includes('"id":"frumusita"'), 'live update event was sent');
  ac.abort(); await c.close();
});
