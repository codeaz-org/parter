import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeScene, newScene, serialize, findOp } from '../public/js/core/scene.js';
import { analyze } from '../public/js/core/rooms.js';
import { runTool, TOOLS, describeScene, itemBox } from '../public/js/core/ops.js';
import { CAT, partsOf, natH } from '../public/js/core/catalog.js';
import { MATS } from '../public/js/core/materials.js';
import { buildPrompt } from '../public/js/core/prompt.js';

const sample = () => normalizeScene(JSON.parse(fs.readFileSync(new URL('../public/projects/frumusita.json', import.meta.url), 'utf8')));
const area = (an, name) => an.regions.find(r => r.name === name).area;

test('the sample house loads and its rooms match the areas printed on the drawing', () => {
  const s = sample(), an = analyze(s);
  assert.equal(an.regions.length, 11);
  const want = { 'Cameră de zi': 51.2, Hol: 6.0, Birou: 10.9, 'Dormitor 2': 10.9, Dressing: 6.2, 'Dormitor 1': 15.5, Baie: 9.0, 'Bucătărie': 17.7, 'C.T.': 10.0, Garaj: 30.3 };
  for (const k in want) assert.ok(Math.abs(area(an, k) - want[k]) < 0.06, `${k}: ${area(an, k)} vs ${want[k]}`);
});

test('exterior openings are detected, interior ones are not', () => {
  const s = sample(), an = analyze(s);
  assert.ok(an.ext.has('o1_2'), 'front door is exterior');
  assert.ok(!an.ext.has('o7_1'), 'hall door is interior');
});

test('normalizeScene repairs bad input instead of throwing', () => {
  const s = normalizeScene({ name: 5, walls: [{ x0: 3, y0: 0, x1: 0, y1: 0.2, ops: [{ k: 'door', a: 1, b: 1.9 }, { k: 'nope', a: 0, b: 1 }, { k: 'win', a: 2, b: 99 }] }, { x0: 'x' }], items: [{ t: 'sofa3', x: 1, y: 1 }, { t: 'unknown', x: 1, y: 1 }], cam: { x: 'a' } });
  assert.equal(s.walls.length, 1); assert.equal(s.walls[0].x0, 0); assert.equal(s.walls[0].ops.length, 2);
  assert.ok(s.walls[0].ops[1].b <= 3); assert.equal(s.items.length, 1); assert.equal(s.name, 'Untitled plan');
  assert.throws(() => normalizeScene(null));
  const again = normalizeScene(serialize(s)); assert.deepEqual(serialize(again).walls, serialize(s).walls);
});

test('every catalogue piece builds parts with known materials and a positive height', () => {
  for (const k in CAT) {
    const c = CAT[k], parts = partsOf(k, c.w, c.d);
    assert.ok(parts.length, k); assert.ok(natH(k, c.w, c.d) > 0, k);
    for (const p of parts) { assert.ok(MATS[p.m], `${k}: material ${p.m}`); assert.ok(['b', 'c', 's'].includes(p.t)); }
    assert.ok(c.n && c.g && c.say, k + ' needs a name, group and phrase');
  }
});

test('furniture tools report overlaps so a model can correct itself', () => {
  const s = sample();
  const bad = runTool(s, 'add_furniture', { type: 'sofa3', x: 0.5, y: 5, rotation: 90 });
  assert.ok(bad.ok); assert.match(bad.text, /overlaps wall/);
  const id = /Added (\S+):/.exec(bad.text)[1];
  const good = runTool(s, 'update_furniture', { id, x: 5.4, y: 8.6, rotation: -90 });
  assert.doesNotMatch(good.text, /overlaps wall/);
  assert.ok(!runTool(s, 'add_furniture', { type: 'nope', x: 1, y: 1 }).ok);
  assert.ok(!runTool(s, 'update_furniture', { id: 'missing', x: 1 }).ok);
  assert.ok(runTool(s, 'remove_furniture', { id }).ok);
  const b = itemBox({ x: 0, y: 0, w: 2, d: 1, r: 90 }); assert.ok(Math.abs(b.x1 - 0.5) < 1e-9 && Math.abs(b.y1 - 1) < 1e-9);
});

test('openings stay inside their wall and clear of their neighbours', () => {
  const s = sample();
  runTool(s, 'update_opening', { id: 'o1_1', width: 30 });
  const { wall, op } = findOp(s, 'o1_1'), next = wall.ops.find(o => o.a > op.a);
  assert.ok(op.a >= wall.x0 && op.b <= next.a, 'clamped between the wall start and the front door');
  const r = runTool(s, 'update_opening', { id: 'o7_1', glass: true });
  assert.match(r.text, /closed, glass/);
  assert.ok(runTool(s, 'add_opening', { wall_id: 'w4', kind: 'window', center: 8.6, width: 1.2 }).ok);
  assert.ok(!runTool(s, 'add_opening', { wall_id: 'w19', kind: 'door', center: 5.8, width: 0.9 }).ok, 'dividers cannot hold openings');
});

test('set_structure builds rooms and reports their areas', () => {
  const s = newScene('t');
  const r = runTool(s, 'set_structure', {
    walls: [{ x0: 0, y0: 0, x1: 5, y1: 0.3 }, { x0: 0, y0: 3.7, x1: 5, y1: 4 }, { x0: 0, y0: 0.3, x1: 0.3, y1: 3.7 }, { x0: 4.7, y0: 0.3, x1: 5, y1: 3.7 }, { x0: 2.4, y0: 0.3, x1: 2.5, y1: 3.7 }],
    openings: [{ wall: 0, kind: 'door', from: 1, to: 1.9 }, { wall: 9, kind: 'door', from: 1, to: 2 }],
    rooms: [{ name: 'Living', x: 1.2, y: 2 }, { name: 'Bed', x: 3.6, y: 2, floor: 'wood' }]
  });
  assert.ok(r.ok); assert.match(r.text, /Living 7\.1 m², Bed 7\.5 m²/); assert.match(r.text, /Skipped openings at index 1/);
  const an = analyze(s); assert.equal(an.regions.length, 2); assert.ok(an.ext.has(s.walls[0].ops[0].id));
  assert.ok(an.regionAt(s.cam.x, s.cam.y), 'the starting camera is inside a room');
});

test('walls that do not meet leave no room, and the tool says so', () => {
  const s = newScene('t');
  const r = runTool(s, 'set_structure', { walls: [{ x0: 0, y0: 0, x1: 5, y1: 0.3 }, { x0: 0, y0: 0.5, x1: 0.3, y1: 4 }], rooms: [{ name: 'A', x: 2, y: 2 }] });
  assert.match(r.text, /do not enclose any room/); assert.match(r.text, /not inside any enclosed room/);
});

test('describeScene and prompts mention what is there', () => {
  const s = sample(), an = analyze(s), d = describeScene(s, an);
  assert.match(d, /Cameră de zi: 51\.2 m²/); assert.match(d, /sofaL/); assert.match(d, /CAMERA/);
  const p = buildPrompt(s, an, 'eye', 'warm');
  assert.match(p, /living and dining room/); assert.match(p, /corner sofa with a chaise/); assert.match(p, /Do not add, remove/);
  assert.match(buildPrompt(s, an, 'doll', 'my own style words'), /my own style words/);
});

test('every tool has a valid schema', () => {
  for (const t of TOOLS) { assert.match(t.name, /^[a-z_]+$/); assert.ok(t.description.length > 20); assert.equal(t.input_schema.type, 'object'); for (const r of t.input_schema.required || []) assert.ok(t.input_schema.properties[r], `${t.name}.${r}`); }
});
