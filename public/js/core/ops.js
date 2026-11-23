// Every change an assistant can make to a scene, as plain functions with JSON-schema inputs.
// The in-app chat, the plan importer and the MCP server (mcp/server.mjs) all expose exactly
// this list, so anything one of them can do, the others can too.
//
// A tool's run(scene, args) mutates the scene and returns a short text result. The result
// reports problems (a sofa poking through a wall, a window wider than its wall) so the model
// can correct itself on the next step.
import { CAT, natH, catalogText } from './catalog.js';
import { analyze } from './rooms.js';
import {
  uid, r2, snap, wallAxis, wallSpan, wallThick, opDefaults, opState, opBounds,
  findWall, findOp, findItem, normalizeScene, FLOORS
} from './scene.js';

const KIND_IN = { window: 'win', door: 'door', opening: 'open', garage: 'garage' };
const KIND_OUT = { win: 'window', door: 'door', open: 'opening', garage: 'garage door' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const need = (v, name) => { if (!isNum(v)) throw new Error(`"${name}" must be a number`); return v; };
const f2 = v => (+v).toFixed(2);
const touch = scene => { (scene.meta = scene.meta || {}).modified = Date.now(); };
const normRot = a => ((a + 180) % 360 + 360) % 360 - 180;

/** Axis-aligned bounds of a (possibly rotated) piece on the plan. */
export function itemBox(it) {
  const th = it.r * Math.PI / 180, c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  const hw = (it.w * c + it.d * s) / 2, hd = (it.w * s + it.d * c) / 2;
  return { x0: it.x - hw, x1: it.x + hw, y0: it.y - hd, y1: it.y + hd };
}

/** Things worth telling whoever just placed this piece. */
export function itemIssues(scene, an, it) {
  const out = [], b = itemBox(it);
  if (!an.regionAt(it.x, it.y)) out.push('its centre is not inside any room');
  for (const w of scene.walls) {
    if (w.v) continue;
    const ox = Math.min(b.x1, w.x1) - Math.max(b.x0, w.x0), oy = Math.min(b.y1, w.y1) - Math.max(b.y0, w.y0);
    if (ox > 0.03 && oy > 0.03) out.push(`it overlaps wall ${w.id} by ${f2(Math.min(ox, oy))} m`);
  }
  if (!CAT[it.t].flat) for (const o of scene.items) {
    if (o === it || CAT[o.t].flat) continue;
    const ob = itemBox(o), ox = Math.min(b.x1, ob.x1) - Math.max(b.x0, ob.x0), oy = Math.min(b.y1, ob.y1) - Math.max(b.y0, ob.y0);
    if (ox > 0.05 && oy > 0.05 && ox * oy > 0.25 * Math.min(it.w * it.d, o.w * o.d)) out.push(`it overlaps ${CAT[o.t].n} (${o.id})`);
  }
  return out;
}

function itemLine(scene, an, it) {
  const c = CAT[it.t], room = an.regionAt(it.x, it.y);
  return `${it.id}: ${it.t} "${c.n}" at (${f2(it.x)}, ${f2(it.y)}) rotation ${Math.round(it.r)}°, ${f2(it.w)} x ${f2(it.d)} x ${f2(it.h || natH(it.t, it.w, it.d))} m${it.f ? ', mirrored' : ''}${room ? ', in ' + (room.name || 'unnamed room') : ', outside any room'}`;
}
function opLine(wall, op, an) {
  const ax = wallAxis(wall), ext = an.ext.has(op.id), st = opState(op, ext);
  return `${op.id}: ${KIND_OUT[op.k]} in wall ${wall.id}, ${ax} from ${f2(op.a)} to ${f2(op.b)} (width ${f2(op.b - op.a)}), sill ${f2(op.sill)}, top ${f2(op.head)}${op.k === 'win' ? '' : ', ' + (st === 'wall' ? 'walled up' : st)}${op.gl ? ', glass' : ''}${ext ? ', exterior' : ''}`;
}

/** The whole scene as text a model can reason over. */
export function describeScene(scene, an = analyze(scene)) {
  const L = [];
  L.push(`Project "${scene.name}". Units are metres. x runs east, y runs north. Ceiling height ${f2(scene.ceiling)}.`);
  L.push('', 'ROOMS (interior bounding box; rooms can be L-shaped):');
  if (!an.regions.length) L.push('(none: the walls do not enclose any room yet)');
  for (const r of an.regions) L.push(`- ${r.name || 'unnamed'}: ${r.area.toFixed(1)} m², x ${f2(r.x0)}..${f2(r.x1)}, y ${f2(r.y0)}..${f2(r.y1)}, floor ${r.floor}`);
  L.push('', 'WALLS (rectangles x0,y0 to x1,y1):');
  for (const w of scene.walls) L.push(`- ${w.id}: (${f2(w.x0)}, ${f2(w.y0)}) to (${f2(w.x1)}, ${f2(w.y1)}), runs along ${wallAxis(w)}, ${f2(wallThick(w))} thick${w.v ? ', divider only (not built)' : ''}`);
  L.push('', 'OPENINGS:');
  for (const w of scene.walls) for (const op of w.ops) L.push('- ' + opLine(w, op, an));
  L.push('', 'FURNITURE:');
  if (!scene.items.length) L.push('(none)');
  for (const it of scene.items) L.push('- ' + itemLine(scene, an, it));
  const c = scene.cam;
  L.push('', `CAMERA: at (${f2(c.x)}, ${f2(c.y)}), eye height ${f2(c.h)}, looking ${Math.round(c.yaw * 180 / Math.PI)}° (0° = east, 90° = north), lens ${Math.round(c.fov)}°.`);
  return L.join('\n');
}

/** Shared instructions for any model driving these tools. */
export const GUIDE = `You edit a floor plan through tools. All coordinates are metres: x runs east, y runs north.

Furniture rotation is in degrees, counter-clockwise seen from above:
  0 = the back of the piece faces north (+y) and its front faces south
  90 = back faces west, front faces east
  180 = back faces south, front faces north
  -90 = back faces east, front faces west
A piece's width runs along its back; its depth runs from back to front. To put a piece flat against
a wall, turn its back to that wall and set its centre half its depth away from the wall's inner face.
Keep roughly 0.7 m clear in front of doors and along walking routes.

Walls are axis-aligned rectangles. An opening (window, door, plain opening, garage door) belongs to
a wall and is positioned along that wall's long axis in the same world coordinates.

After each change the tool result tells you if something overlaps a wall or another piece; fix that
before you finish. Prefer changing existing things over deleting and re-adding them. When you are
done, tell the user in one or two short sentences what you changed.`;

const itemProps = {
  x: { type: 'number', description: 'Centre x in metres' },
  y: { type: 'number', description: 'Centre y in metres' },
  rotation: { type: 'number', description: 'Degrees counter-clockwise. 0 = back to the north.' },
  width: { type: 'number' }, depth: { type: 'number' }, height: { type: 'number' },
  mirror: { type: 'boolean', description: 'Flip left to right (for corner sofas, fridge handles)' }
};

function applyItem(it, a) {
  if (a.x !== undefined) it.x = r2(need(a.x, 'x'));
  if (a.y !== undefined) it.y = r2(need(a.y, 'y'));
  if (a.rotation !== undefined) it.r = normRot(need(a.rotation, 'rotation'));
  if (a.width !== undefined) it.w = clamp(r2(need(a.width, 'width')), 0.1, 12);
  if (a.depth !== undefined) it.d = clamp(r2(need(a.depth, 'depth')), 0.1, 12);
  if (CAT[it.t].round) it.d = it.w;
  if (a.height !== undefined) it.h = clamp(r2(need(a.height, 'height')), 0.05, 4);
  if (a.mirror !== undefined) it.f = a.mirror ? 1 : 0;
}
const withIssues = (scene, it, lead) => {
  const an = analyze(scene), is = itemIssues(scene, an, it);
  return lead + ' ' + itemLine(scene, an, it) + (is.length ? '. PROBLEMS: ' + is.join('; ') + '.' : '. No overlaps.');
};

function placeOp(wall, op, a, b) {
  const [lo, hi] = opBounds(wall, op);
  const len = clamp(b - a, 0.3, Math.max(0.3, hi - lo));
  const start = clamp(a, lo, Math.max(lo, hi - len));
  op.a = r2(start); op.b = r2(start + len);
}

export function underlayFromRefs(refs, imgW, imgH) {
  if (!Array.isArray(refs) || refs.length < 2 || !(imgW > 0) || !(imgH > 0)) return null;
  const [p, q] = refs, dp = Math.hypot(q.px - p.px, q.py - p.py), dw = Math.hypot(q.x - p.x, q.y - p.y);
  if (![p.px, p.py, p.x, p.y, q.px, q.py, q.x, q.y].every(isNum) || dp < 20 || dw < 0.5) return null;
  const s = dw / dp, w = imgW * s, h = imgH * s, yTop = p.y + p.py * s;
  return { x: r2(p.x - p.px * s), y: r2(yTop - h), w: r2(w), h: r2(h), opacity: 0.5, show: true };
}

export const TOOLS = [
  {
    name: 'describe_scene',
    description: 'Return the full current plan as text: rooms with sizes, walls, openings, furniture and camera. Call this first if you have not seen the plan.',
    input_schema: { type: 'object', properties: {} },
    run: scene => describeScene(scene)
  },
  {
    name: 'list_catalog',
    description: 'List every furniture type that can be added, with default sizes.',
    input_schema: { type: 'object', properties: {} },
    run: () => catalogText()
  },
  {
    name: 'add_furniture',
    description: 'Add one piece of furniture. Use a type key from the catalogue.',
    input_schema: { type: 'object', properties: Object.assign({ type: { type: 'string', description: 'Catalogue key, e.g. sofa3, bed2, kitSink' } }, itemProps), required: ['type', 'x', 'y'] },
    run(scene, a) {
      const c = CAT[a.type]; if (!c) throw new Error(`Unknown furniture type "${a.type}". Call list_catalog.`);
      const it = { id: uid('i'), t: a.type, x: 0, y: 0, r: 0, w: c.w, d: c.d, f: 0 };
      need(a.x, 'x'); need(a.y, 'y'); applyItem(it, a);
      scene.items.push(it); touch(scene);
      return withIssues(scene, it, 'Added');
    }
  },
  {
    name: 'update_furniture',
    description: 'Move, turn, resize or mirror an existing piece. Only pass the fields you want to change.',
    input_schema: { type: 'object', properties: Object.assign({ id: { type: 'string' } }, itemProps), required: ['id'] },
    run(scene, a) {
      const it = findItem(scene, a.id); if (!it) throw new Error(`No furniture with id "${a.id}"`);
      applyItem(it, a); touch(scene);
      return withIssues(scene, it, 'Updated');
    }
  },
  {
    name: 'remove_furniture',
    description: 'Delete a piece of furniture.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(scene, a) {
      const k = scene.items.findIndex(i => i.id === a.id); if (k < 0) throw new Error(`No furniture with id "${a.id}"`);
      const [it] = scene.items.splice(k, 1); touch(scene);
      return `Removed ${CAT[it.t].n} (${it.id}).`;
    }
  },
  {
    name: 'add_opening',
    description: 'Cut a window, door, plain opening or garage door into a wall.',
    input_schema: {
      type: 'object',
      properties: {
        wall_id: { type: 'string' }, kind: { type: 'string', enum: Object.keys(KIND_IN) },
        center: { type: 'number', description: 'Centre along the wall, as a world coordinate (x for a wall that runs along x, y otherwise)' },
        width: { type: 'number' }, sill: { type: 'number', description: 'Height of the bottom edge above the floor. Windows default to 0.9.' },
        height: { type: 'number', description: 'Height of the opening itself' }
      },
      required: ['wall_id', 'kind', 'center', 'width']
    },
    run(scene, a) {
      const wall = findWall(scene, a.wall_id); if (!wall) throw new Error(`No wall with id "${a.wall_id}"`);
      if (wall.v) throw new Error('That wall is only a divider; it cannot hold openings');
      const k = KIND_IN[a.kind]; if (!k) throw new Error('kind must be window, door, opening or garage');
      const def = opDefaults(k), w = need(a.width, 'width'), c = need(a.center, 'center');
      const sill = a.sill !== undefined ? clamp(need(a.sill, 'sill'), 0, 3) : def.sill;
      const op = { id: uid('o'), k, a: c - w / 2, b: c + w / 2, sill: r2(sill), head: r2(a.height !== undefined ? sill + clamp(need(a.height, 'height'), 0.2, 4) : Math.max(def.head, sill + 0.3)) };
      if (k === 'door') { op.h = 'b'; op.s = 1; }
      const [lo, hi] = opBounds(wall, op, 0.1);
      if (hi - lo < 0.3) throw new Error('There is no free space on that wall at that position');
      wall.ops.push(op); placeOp(wall, op, op.a, op.b); wall.ops.sort((p, q) => p.a - q.a); touch(scene);
      return 'Added ' + opLine(wall, op, analyze(scene)) + '.';
    }
  },
  {
    name: 'update_opening',
    description: 'Change a window or door: slide it, resize it, open or close it, wall it up, make it a glass door, or flip which way it swings.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, center: { type: 'number' }, width: { type: 'number' }, sill: { type: 'number' }, height: { type: 'number' },
        state: { type: 'string', enum: ['open', 'closed', 'wall'], description: 'Doors only. "wall" bricks the doorway up but keeps it restorable.' },
        glass: { type: 'boolean', description: 'Doors only' }, flip_swing: { type: 'boolean', description: 'Doors only: cycle hinge side and swing direction' }
      },
      required: ['id']
    },
    run(scene, a) {
      const f = findOp(scene, a.id); if (!f) throw new Error(`No opening with id "${a.id}"`);
      const { wall, op } = f;
      if (a.center !== undefined || a.width !== undefined) {
        const w = a.width !== undefined ? need(a.width, 'width') : op.b - op.a, c = a.center !== undefined ? need(a.center, 'center') : (op.a + op.b) / 2;
        placeOp(wall, op, c - w / 2, c + w / 2);
      }
      const h0 = op.head - op.sill;
      if (a.sill !== undefined) { op.sill = r2(clamp(need(a.sill, 'sill'), 0, 3)); op.head = r2(op.sill + h0); }
      if (a.height !== undefined) op.head = r2(op.sill + clamp(need(a.height, 'height'), 0.2, 4));
      if (op.k !== 'win') {
        if (a.state !== undefined) { if (!['open', 'closed', 'wall'].includes(a.state)) throw new Error('state must be open, closed or wall'); op.st = a.state; }
        if (op.k === 'door') {
          if (a.glass !== undefined) { if (a.glass) { op.gl = 1; if (op.st !== 'wall') op.st = 'closed'; } else delete op.gl; }
          if (a.flip_swing) { const n = { a1: ['b', 1], b1: ['b', -1], 'b-1': ['a', -1], 'a-1': ['a', 1] }[op.h + (op.s || 1)] || ['a', 1]; op.h = n[0]; op.s = n[1]; }
        }
      }
      wall.ops.sort((p, q) => p.a - q.a); touch(scene);
      return 'Updated ' + opLine(wall, op, analyze(scene)) + '.';
    }
  },
  {
    name: 'remove_opening',
    description: 'Remove a window or door completely, leaving solid wall.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(scene, a) {
      const f = findOp(scene, a.id); if (!f) throw new Error(`No opening with id "${a.id}"`);
      f.wall.ops.splice(f.wall.ops.indexOf(f.op), 1); touch(scene);
      return `Removed ${KIND_OUT[f.op.k]} ${f.op.id} from wall ${f.wall.id}.`;
    }
  },
  {
    name: 'add_wall',
    description: 'Add an axis-aligned wall as a rectangle on the plan. Interior walls are usually 0.10 to 0.20 thick, exterior walls 0.30 to 0.45. Make walls touch or overlap at corners so rooms close.',
    input_schema: {
      type: 'object',
      properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' }, divider: { type: 'boolean', description: 'True for an invisible line that only separates two rooms' } },
      required: ['x0', 'y0', 'x1', 'y1']
    },
    run(scene, a) {
      const w = makeWall(a); scene.walls.push(w); touch(scene);
      return `Added wall ${w.id}. ` + roomsLine(scene);
    }
  },
  {
    name: 'update_wall',
    description: 'Move or resize a wall by giving new rectangle corners. Its openings move with it.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } }, required: ['id'] },
    run(scene, a) {
      const w = findWall(scene, a.id); if (!w) throw new Error(`No wall with id "${a.id}"`);
      const n = makeWall(Object.assign({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }, a));
      moveWall(w, n.x0, n.y0, n.x1, n.y1); touch(scene);
      return `Updated wall ${w.id}. ` + roomsLine(scene);
    }
  },
  {
    name: 'remove_wall',
    description: 'Delete a wall together with its openings.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(scene, a) {
      const k = scene.walls.findIndex(w => w.id === a.id); if (k < 0) throw new Error(`No wall with id "${a.id}"`);
      scene.walls.splice(k, 1); touch(scene);
      return `Removed wall ${a.id}. ` + roomsLine(scene);
    }
  },
  {
    name: 'set_room',
    description: 'Name the room that contains the point (x, y) and choose its floor finish.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, name: { type: 'string' }, floor: { type: 'string', enum: FLOORS, description: 'tile, wood, bath (bathroom tile) or conc (concrete)' } },
      required: ['x', 'y', 'name']
    },
    run(scene, a) {
      need(a.x, 'x'); need(a.y, 'y');
      const an = analyze(scene), reg = an.regionAt(a.x, a.y);
      if (!reg) throw new Error('That point is not inside an enclosed room');
      let tag = reg.tag;
      if (!tag) { tag = { id: uid('r'), name: '', x: r2(a.x), y: r2(a.y), floor: 'tile' }; scene.rooms.push(tag); }
      tag.name = String(a.name || '').slice(0, 40);
      if (a.floor !== undefined) { if (!FLOORS.includes(a.floor)) throw new Error('floor must be one of ' + FLOORS.join(', ')); tag.floor = a.floor; }
      touch(scene);
      return `Room named "${tag.name}" (${reg.area.toFixed(1)} m², floor ${tag.floor}).`;
    }
  },
  {
    name: 'set_camera',
    description: 'Place the eye-level camera used for the 3D view and exports, and aim it at a point.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, look_at_x: { type: 'number' }, look_at_y: { type: 'number' }, height: { type: 'number', description: 'Eye height, usually 1.2 to 1.6' }, fov: { type: 'number', description: 'Vertical lens angle in degrees, 50 to 80 for interiors' } },
      required: ['x', 'y', 'look_at_x', 'look_at_y']
    },
    run(scene, a) {
      const c = scene.cam;
      c.x = need(a.x, 'x'); c.y = need(a.y, 'y');
      c.yaw = Math.atan2(need(a.look_at_y, 'look_at_y') - c.y, need(a.look_at_x, 'look_at_x') - c.x); c.pitch = -0.06;
      if (a.height !== undefined) c.h = clamp(need(a.height, 'height'), 0.3, Math.max(0.5, scene.ceiling - 0.15));
      if (a.fov !== undefined) c.fov = clamp(need(a.fov, 'fov'), 25, 100);
      touch(scene);
      const room = analyze(scene).regionAt(c.x, c.y);
      return `Camera at (${f2(c.x)}, ${f2(c.y)}) ${room ? 'in ' + (room.name || 'an unnamed room') : 'OUTSIDE any room'}, eye height ${f2(c.h)}, lens ${Math.round(c.fov)}°.`;
    }
  },
  {
    name: 'set_ceiling',
    description: 'Set the ceiling height for the whole floor.',
    input_schema: { type: 'object', properties: { height: { type: 'number' } }, required: ['height'] },
    run(scene, a) {
      scene.ceiling = clamp(r2(need(a.height, 'height')), 2.2, 4); scene.cam.h = Math.min(scene.cam.h, scene.ceiling - 0.15); touch(scene);
      return `Ceiling height is now ${f2(scene.ceiling)} m.`;
    }
  },
  {
    name: 'set_structure',
    description: 'Replace the whole building (walls, openings, room names) in one call. Use this when transcribing a floor plan drawing. Furniture is removed unless keep_furniture is true. The result lists the rooms that the walls enclose with their areas, so you can compare them with the areas printed on the drawing and correct mistakes with a second call.',
    input_schema: {
      type: 'object',
      properties: {
        ceiling: { type: 'number' },
        walls: {
          type: 'array', description: 'Axis-aligned wall rectangles in metres. Walls must touch or overlap where they meet.',
          items: { type: 'object', properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' }, divider: { type: 'boolean' } }, required: ['x0', 'y0', 'x1', 'y1'] }
        },
        openings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              wall: { type: 'integer', description: 'Index into the walls array, starting at 0' }, kind: { type: 'string', enum: Object.keys(KIND_IN) },
              from: { type: 'number', description: 'Start along the wall, as a world coordinate' }, to: { type: 'number' },
              sill: { type: 'number' }, height: { type: 'number' }
            },
            required: ['wall', 'kind', 'from', 'to']
          }
        },
        rooms: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, x: { type: 'number', description: 'A point well inside the room' }, y: { type: 'number' }, floor: { type: 'string', enum: FLOORS } }, required: ['name', 'x', 'y'] } },
        image_refs: {
          type: 'array', description: 'Optional. Two points far apart that you can locate both in the image (pixels from the top-left corner) and in the plan (metres). Used to lay the scan under the plan.',
          items: { type: 'object', properties: { px: { type: 'number' }, py: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['px', 'py', 'x', 'y'] }
        },
        notes: { type: 'array', items: { type: 'string' }, description: 'Anything you had to guess or could not read' },
        keep_furniture: { type: 'boolean' }
      },
      required: ['walls']
    },
    run(scene, a, ctx = {}) {
      if (!Array.isArray(a.walls) || !a.walls.length) throw new Error('walls must be a non-empty array');
      const walls = a.walls.map(w => makeWall(w)), skipped = [];
      (a.openings || []).forEach((o, n) => {
        const wall = walls[o.wall], k = KIND_IN[o.kind];
        if (!wall || !k || !isNum(o.from) || !isNum(o.to) || wall.v) { skipped.push(n); return; }
        const def = opDefaults(k), [lo, hi] = wallSpan(wall);
        const p = clamp(Math.min(o.from, o.to), lo, hi), q = clamp(Math.max(o.from, o.to), lo, hi);
        if (q - p < 0.3) { skipped.push(n); return; }
        const sill = isNum(o.sill) ? clamp(o.sill, 0, 3) : def.sill;
        const op = { id: uid('o'), k, a: r2(p), b: r2(q), sill: r2(sill), head: r2(isNum(o.height) ? sill + clamp(o.height, 0.2, 4) : Math.max(def.head, sill + 0.3)) };
        if (k === 'door') { op.h = 'b'; op.s = 1; }
        wall.ops.push(op);
      });
      walls.forEach(w => w.ops.sort((p, q) => p.a - q.a));
      scene.walls = walls;
      scene.rooms = (a.rooms || []).filter(r => isNum(r.x) && isNum(r.y)).map(r => ({ id: uid('r'), name: String(r.name || '').slice(0, 40), x: r2(r.x), y: r2(r.y), floor: FLOORS.includes(r.floor) ? r.floor : 'tile' }));
      scene.steps = [];
      if (!a.keep_furniture) scene.items = [];
      if (isNum(a.ceiling)) scene.ceiling = clamp(r2(a.ceiling), 2.2, 4);
      const fixed = normalizeScene(scene);            // one pass of the same repairs a loaded file gets
      scene.walls = fixed.walls; scene.rooms = fixed.rooms;
      const an = analyze(scene);
      if (ctx.image && a.image_refs) { const u = underlayFromRefs(a.image_refs, ctx.image.w, ctx.image.h); if (u) scene.underlay = u; }
      // a sensible first camera: in the biggest room, looking along its long side
      const big = an.regions.slice().sort((p, q) => q.area - p.area)[0];
      if (big && !a.keep_furniture) {
        const wide = (big.x1 - big.x0) >= (big.y1 - big.y0);
        scene.cam = { x: wide ? big.x0 + 0.6 : (big.x0 + big.x1) / 2, y: wide ? (big.y0 + big.y1) / 2 : big.y0 + 0.6, yaw: wide ? 0 : Math.PI / 2, pitch: -0.06, h: Math.min(1.5, scene.ceiling - 0.3), fov: 68 };
      }
      touch(scene);
      const L = [`Structure set: ${walls.length} walls, ${walls.reduce((s, w) => s + w.ops.length, 0)} openings.`];
      if (skipped.length) L.push(`Skipped openings at index ${skipped.join(', ')} (bad wall index, or outside their wall).`);
      L.push(roomsLine(scene, an));
      const unnamed = an.regions.filter(r => !r.name).length;
      if (unnamed) L.push(`${unnamed} enclosed room(s) have no name: add a room label inside each, or check for walls that should not close them off.`);
      const lost = scene.rooms.filter(t => !an.regionAt(t.x, t.y));
      if (lost.length) L.push(`These room labels are not inside any enclosed room (walls probably do not meet): ${lost.map(t => t.name).join(', ')}.`);
      return L.join(' ');
    }
  }
];

function makeWall(a) {
  let x0 = snap(need(a.x0, 'x0')), y0 = snap(need(a.y0, 'y0')), x1 = snap(need(a.x1, 'x1')), y1 = snap(need(a.y1, 'y1'));
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) throw new Error('A wall needs a thickness: give a rectangle at least 0.05 m in both directions');
  const w = { id: uid('w'), x0: r2(x0), y0: r2(y0), x1: r2(x1), y1: r2(y1), ops: [] };
  if (a.divider) w.v = 1;
  return w;
}

/** Give a wall a new rectangle. Openings stay where they are in the world and are trimmed to fit. */
export function moveWall(w, x0, y0, x1, y1) {
  const ax = wallAxis(w);
  w.x0 = r2(Math.min(x0, x1)); w.x1 = r2(Math.max(x0, x1)); w.y0 = r2(Math.min(y0, y1)); w.y1 = r2(Math.max(y0, y1));
  if (wallAxis(w) !== ax) { w.ops = []; return; }
  const [lo, hi] = wallSpan(w);
  w.ops = w.ops.filter(op => op.b - op.a <= hi - lo - 0.1);
  for (const op of w.ops) {
    const len = op.b - op.a, a = clamp(op.a, lo + 0.05, hi - 0.05 - len);
    op.a = r2(a); op.b = r2(a + len);
  }
}

/** Translate a wall and carry its openings along. */
export function shiftWall(w, dx, dy) {
  const ax = wallAxis(w), d = ax === 'x' ? dx : dy;
  w.x0 = r2(w.x0 + dx); w.x1 = r2(w.x1 + dx); w.y0 = r2(w.y0 + dy); w.y1 = r2(w.y1 + dy);
  for (const op of w.ops) { op.a = r2(op.a + d); op.b = r2(op.b + d); }
}

function roomsLine(scene, an = analyze(scene)) {
  if (!an.regions.length) return 'The walls do not enclose any room yet.';
  return 'Enclosed rooms now: ' + an.regions.map(r => `${r.name || 'unnamed'} ${r.area.toFixed(1)} m²`).join(', ') + '.';
}

export const toolByName = name => TOOLS.find(t => t.name === name) || null;

/** Run a tool by name. Never throws: errors come back as text, the way a model expects. */
export function runTool(scene, name, args, ctx) {
  const t = toolByName(name);
  if (!t) return { ok: false, text: `Unknown tool "${name}"` };
  try { return { ok: true, text: t.run(scene, args || {}, ctx) }; }
  catch (e) { return { ok: false, text: 'Error: ' + (e && e.message ? e.message : String(e)) }; }
}
