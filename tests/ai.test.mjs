import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeScene, newScene } from '../public/js/core/scene.js';
import { analyze } from '../public/js/core/rooms.js';
import { runChat, importPlan, trimHistory } from '../public/js/ai/assistant.js';
import { modelStep, generateImage, PRESETS } from '../public/js/ai/providers.js';

const sample = () => normalizeScene(JSON.parse(fs.readFileSync(new URL('../public/projects/frumusita.json', import.meta.url), 'utf8')));
const reply = (status, body) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) });
const claude = { format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'm', key: 'k' };
const compat = { format: 'openai', baseUrl: 'http://localhost:11434/v1/', model: 'm', key: '' };

test('chat runs tool calls against the scene and feeds results back (Claude format)', async () => {
  const s = sample(), sent = []; let n = 0;
  const fetchFn = async (url, o) => {
    sent.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    return ++n === 1
      ? reply(200, { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'a', name: 'update_furniture', input: { id: 's1', y: 5 } }, { type: 'tool_use', id: 'b', name: 'no_such_tool', input: {} }], stop_reason: 'tool_use' })
      : reply(200, { content: [{ type: 'text', text: 'Moved the TV.' }], stop_reason: 'end_turn' });
  };
  const out = await runChat({ cfg: claude, scene: s, userText: 'move the tv', fetchFn });
  assert.equal(out.text, 'Moved the TV.'); assert.ok(out.changed); assert.equal(s.items.find(i => i.id === 's1').y, 5);
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(sent[0].body.system, /CURRENT PLAN/); assert.ok(sent[0].body.tools.every(t => t.name !== 'set_structure'));
  const results = sent[1].body.messages.at(-1).content;
  assert.equal(results[0].type, 'tool_result'); assert.equal(results[0].tool_use_id, 'a'); assert.match(results[1].content, /Unknown tool/);
  assert.equal(out.history.at(-1).role, 'assistant');
});

test('the same loop works over the OpenAI-compatible format, with no key for local models', async () => {
  const s = sample(), sent = []; let n = 0;
  const fetchFn = async (url, o) => {
    sent.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    return ++n === 1
      ? reply(200, { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_ceiling', arguments: '{"height":3}' } }] }, finish_reason: 'tool_calls' }] })
      : reply(200, { choices: [{ message: { content: 'Ceiling is 3 m now.' }, finish_reason: 'stop' }] });
  };
  const out = await runChat({ cfg: compat, scene: s, userText: 'raise the ceiling', fetchFn });
  assert.equal(s.ceiling, 3); assert.equal(out.text, 'Ceiling is 3 m now.');
  assert.equal(sent[0].url, 'http://localhost:11434/v1/chat/completions'); assert.equal(sent[0].headers.authorization, undefined);
  assert.equal(sent[0].body.messages[0].role, 'system'); assert.equal(sent[0].body.tools[0].type, 'function');
  const m = sent[1].body.messages; assert.equal(m.at(-1).role, 'tool'); assert.equal(m.at(-1).tool_call_id, 'c1'); assert.equal(m.at(-2).tool_calls[0].function.name, 'set_ceiling');
});

test('provider errors come back as readable messages', async () => {
  await assert.rejects(modelStep(claude, { system: '', messages: [{ role: 'user', text: 'hi' }], fetchFn: async () => reply(401, { error: { message: 'invalid x-api-key' } }) }), /API key was not accepted.*invalid x-api-key/);
  await assert.rejects(async () => modelStep({ format: 'anthropic', baseUrl: 'x', model: 'm', key: '' }, {}), /Add your API key/);
  await assert.rejects(modelStep(compat, { system: '', messages: [], fetchFn: async () => { throw new TypeError('Failed to fetch'); } }), /Could not reach localhost:11434/);
});

test('plan import forces set_structure, sends the image, and lets the model correct itself', async () => {
  const s = newScene('flat'), sent = []; let n = 0;
  const walls = w => [{ x0: 0, y0: 0, x1: w, y1: 0.3 }, { x0: 0, y0: 3.7, x1: w, y1: 4 }, { x0: 0, y0: 0.3, x1: 0.3, y1: 3.7 }, { x0: w - 0.3, y0: 0.3, x1: w, y1: 3.7 }];
  const fetchFn = async (url, o) => {
    const b = JSON.parse(o.body); sent.push(b); n++;
    if (n === 1) return reply(200, { content: [{ type: 'tool_use', id: 't1', name: 'set_structure', input: { walls: walls(5), rooms: [{ name: 'Studio', x: 2, y: 2 }], image_refs: [{ px: 100, py: 700, x: 0, y: 0 }, { px: 900, py: 60, x: 6, y: 4 }] } }] });
    if (n === 2) return reply(200, { content: [{ type: 'text', text: 'Too narrow, fixing.' }, { type: 'tool_use', id: 't2', name: 'set_structure', input: { walls: walls(6), rooms: [{ name: 'Studio', x: 2, y: 2 }] } }] });
    return reply(200, { content: [{ type: 'text', text: 'Matches now. Door positions are estimates.' }] });
  };
  const out = await importPlan({ cfg: claude, scene: s, image: { mime: 'image/jpeg', b64: 'AAAA', w: 1000, h: 800 }, hint: '1:100', fetchFn });
  assert.equal(out.passes, 2); assert.match(out.notes, /Matches now/);
  assert.deepEqual(sent[0].tool_choice, { type: 'tool', name: 'set_structure' }); assert.equal(sent[1].tool_choice, undefined);
  assert.equal(sent[0].messages[0].content[0].type, 'image'); assert.match(sent[0].messages[0].content[1].text, /1000 x 800 pixels[\s\S]*1:100/);
  assert.match(sent[1].messages.at(-1).content[0].content, /Studio 15\.0 m²/);
  const an = analyze(s); assert.ok(Math.abs(an.regions[0].area - 18.36) < 0.1); assert.ok(s.underlay && s.underlay.w > 5, 'scan lined up from image_refs');
});

test('image generation speaks to OpenAI and Gemini in their own formats', async () => {
  let got;
  const a = await generateImage({ provider: 'openai', key: 'k', model: 'gpt-image-2' }, { prompt: 'p', images: [{ mime: 'image/png', b64: 'AAAA' }], size: '1024x1024', fetchFn: async (url, o) => { got = { url, o }; return reply(200, { data: [{ b64_json: 'QUJD' }] }); } });
  assert.equal(a, 'data:image/png;base64,QUJD'); assert.equal(got.url, 'https://api.openai.com/v1/images/edits'); assert.ok(got.o.body instanceof FormData);
  assert.equal(got.o.body.get('model'), 'gpt-image-2'); assert.equal(got.o.headers.authorization, 'Bearer k'); assert.ok(got.o.body.get('image'));
  const g = await generateImage({ provider: 'gemini', key: 'k', model: 'gemini-3.1-flash-image' }, { prompt: 'p', images: [{ mime: 'image/png', b64: 'AAAA' }], fetchFn: async (url, o) => { got = { url, o }; return reply(200, { candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: 'WFla' } }] } }] }); } });
  assert.equal(g, 'data:image/png;base64,WFla'); assert.match(got.url, /models\/gemini-3\.1-flash-image:generateContent$/); assert.equal(got.o.headers['x-goog-api-key'], 'k');
  assert.equal(JSON.parse(got.o.body).contents[0].parts[1].inline_data.data, 'AAAA');
  await assert.rejects(generateImage({ provider: 'openai', key: '', model: 'x' }, { prompt: 'p', images: [] }), /image API key/);
});

test('history trimming never starts on a tool result', () => {
  const h = [{ role: 'user', text: 'a' }, { role: 'assistant', text: '', calls: [{ id: '1', name: 'x', args: {} }] }, { role: 'tool', results: [] }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'b' }];
  assert.equal(trimHistory(h, 3)[0].role, 'user'); assert.equal(trimHistory(h, 3).length, 1); assert.ok(PRESETS.anthropic.model);
});
