#!/usr/bin/env node
// Parter MCP server: lets Claude Code (or any MCP client) edit Parter plans on disk.
//
// It exposes the same tools the in-app assistant uses (public/js/core/ops.js), each with a
// "project" argument naming a JSON file in ./projects. When Parter is running locally
// (npm start), the browser shows every change as it lands.
//
// Claude Code picks this up from .mcp.json at the repository root. For other clients:
//   command: node   args: [ "<path to>/mcp/server.mjs" ]
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, GUIDE, runTool } from '../public/js/core/ops.js';
import { newScene, normalizeScene, serialize } from '../public/js/core/scene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = path.resolve(process.env.PARTER_PROJECTS || path.join(process.env.CLAUDE_PROJECT_DIR || ROOT, 'projects'));
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const READ_ONLY = new Set(['describe_scene', 'list_catalog']);

fss.mkdirSync(PROJ, { recursive: true });
if (!fss.readdirSync(PROJ).some(f => f.endsWith('.json'))) {
  try { fss.copyFileSync(path.join(ROOT, 'public', 'projects', 'frumusita.json'), path.join(PROJ, 'frumusita.json')); } catch (e) { /* no sample */ }
}

const fileOf = id => { if (!ID.test(id || '')) throw new Error('project must be a file name without .json, e.g. "frumusita". Call list_projects.'); return path.join(PROJ, id + '.json'); };
async function load(id) {
  let text; try { text = await fs.readFile(fileOf(id), 'utf8'); } catch (e) { throw new Error(`No project "${id}". Call list_projects.`); }
  return normalizeScene(JSON.parse(text));
}
async function save(id, scene) {
  scene.meta.modified = Date.now();
  const file = fileOf(id), tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(serialize(scene), null, 1)); await fs.rename(tmp, file);
}
async function listProjects() {
  const out = [];
  for (const f of await fs.readdir(PROJ)) {
    if (!f.endsWith('.json') || !ID.test(f.slice(0, -5))) continue;
    try { out.push(`${f.slice(0, -5)}: ${JSON.parse(await fs.readFile(path.join(PROJ, f), 'utf8')).name || ''}`); } catch (e) { /* skip */ }
  }
  return out.length ? out.join('\n') : '(no projects yet: call create_project)';
}

const projectProp = { project: { type: 'string', description: 'Project id: the file name in the projects folder without .json' } };
const tools = [
  { name: 'list_projects', description: 'List the Parter plans available on this computer.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_project', description: 'Create a new empty plan and return its id.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'editing_guide', description: 'How coordinates, rotation and walls work in Parter. Read once before editing.', inputSchema: { type: 'object', properties: {} } },
  ...TOOLS.map(t => ({
    name: t.name, description: t.description,
    inputSchema: { type: 'object', properties: Object.assign({}, projectProp, t.input_schema.properties || {}), required: ['project', ...(t.input_schema.required || [])] }
  }))
];

const server = new Server({ name: 'parter', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const reply = (text, isError) => ({ content: [{ type: 'text', text }], isError: !!isError });
  try {
    if (name === 'list_projects') return reply(await listProjects());
    if (name === 'editing_guide') return reply(GUIDE);
    if (name === 'create_project') {
      const base = String(args.name || 'plan').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'plan';
      let id = base; for (let n = 2; fss.existsSync(path.join(PROJ, id + '.json')); n++) id = base + '-' + n;
      await save(id, newScene(String(args.name || 'Untitled plan').slice(0, 80)));
      return reply(`Created project "${id}".`);
    }
    const { project, ...rest } = args;
    const scene = await load(project);
    const r = runTool(scene, name, rest);
    if (r.ok && !READ_ONLY.has(name)) await save(project, scene);
    return reply(r.text, !r.ok);
  } catch (e) { return reply('Error: ' + (e && e.message ? e.message : String(e)), true); }
});

await server.connect(new StdioServerTransport());
