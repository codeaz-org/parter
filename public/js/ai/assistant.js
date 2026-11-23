// The two conversations Parter has with a language model:
//   runChat     "move the sofa to the other wall"  -> tool calls that edit the scene
//   importPlan  a photo or scan of a floor plan     -> walls, openings and rooms
// Both run the same tools from core/ops.js. No DOM in here, so node tests can drive it
// with a fake fetch.
import { TOOLS, GUIDE, describeScene, runTool } from '../core/ops.js';
import { catalogText } from '../core/catalog.js';
import { analyze } from '../core/rooms.js';
import { modelStep } from './providers.js';

const CHAT_TOOLS = TOOLS.filter(t => t.name !== 'set_structure');

export function chatSystem(scene) {
  return GUIDE + '\n\nFURNITURE CATALOGUE (type key: name, default size):\n' + catalogText() + '\n\nCURRENT PLAN\n' + describeScene(scene, analyze(scene));
}

/** Keep a conversation short enough to resend, without ever starting on an orphaned tool result. */
export function trimHistory(history, max = 24) {
  let h = history.slice(-max);
  while (h.length && h[0].role !== 'user') h = h.slice(1);
  return h;
}

/**
 * One user turn. Mutates `scene` through tools.
 * @returns {{ text: string, history: object[], changed: boolean, steps: number }}
 */
export async function runChat({ cfg, scene, history = [], userText, images, onStep, signal, fetchFn, maxSteps = 12 }) {
  const system = chatSystem(scene);
  const messages = trimHistory(history).concat([{ role: 'user', text: userText, images }]);
  let changed = false, text = '', steps = 0;
  for (; steps < maxSteps; steps++) {
    const step = await modelStep(cfg, { system, messages, tools: CHAT_TOOLS, signal, fetchFn });
    messages.push({ role: 'assistant', text: step.text, calls: step.calls });
    if (step.text) text = step.text;
    if (!step.calls.length) break;
    const results = step.calls.map(k => {
      const r = runTool(scene, k.name, k.args);
      if (r.ok && !/^(describe_scene|list_catalog)$/.test(k.name)) changed = true;
      return { id: k.id, name: k.name, text: r.text, ok: r.ok };
    });
    messages.push({ role: 'tool', results });
    if (onStep) onStep({ calls: step.calls, results, text: step.text });
  }
  if (steps >= maxSteps && !text) text = 'I stopped after ' + maxSteps + ' steps. Check the plan and tell me what is still wrong.';
  // images are not resent on later turns
  return { text, history: messages.map(m => (m.images ? { role: m.role, text: m.text } : m)), changed, steps };
}

export const IMPORT_GUIDE = `You transcribe a floor plan drawing into data by calling set_structure. Work like a careful draughtsman.

COORDINATES
- Metres. Origin at the outer bottom-left corner of the building as drawn. x runs to the right, y runs up the page.
- Keep the drawing's orientation exactly as it is in the image, whatever a north arrow says.

SCALE
- Use the printed dimension chains. Small numbers such as 15, 20, 25, 30, 40 beside walls are wall thicknesses in centimetres; numbers such as 3.30 or 5.00 are metres.
- Check your arithmetic: room widths plus wall thicknesses along one line must add up to the overall dimension printed for that side.
- If nothing is dimensioned, assume interior doors are 0.90 m wide, scale everything from that, and say so in notes.

WALLS
- One rectangle per straight wall run, with its real thickness. Round every coordinate to 0.05.
- Let outside walls run the full length of their side. Butt interior walls against the faces of the walls they meet. Walls must touch or overlap at every junction, or the rooms will leak into each other.
- Where two named spaces connect with no wall or door between them, add a wall with divider=true across the gap so they count as separate rooms.

OPENINGS
- Each opening belongs to one wall (index into your walls array) and runs from "from" to "to" along that wall, in world coordinates.
- Labels such as 150/130 mean width/height in centimetres. Windows usually sit 0.90 m above the floor; doors labelled 90/220 are 0.90 wide and 2.20 high.
- Use kind "opening" for a doorway with no door leaf, and "garage" for a garage door.

ROOMS
- Give each room the name printed on the drawing and a point well inside it.
- floor: "bath" for bathrooms, "wood" for bedrooms and studies, "conc" for garages and plant rooms, otherwise "tile".

ALSO
- image_refs: two points far apart (for example opposite outer corners of the building) with their pixel position in the image and their position in metres.
- notes: list everything you guessed or could not read.

After the first call, read the tool result. It lists the rooms your walls enclose and their areas. If the drawing prints room areas and yours differ by more than about 3 percent, or a room is missing or merged with another, fix the walls and call set_structure again with the complete corrected data. When it matches, reply with two or three plain sentences saying what you were unsure about.`;

/**
 * Read a plan image into the scene. Replaces the scene's structure.
 * @param image { mime, b64, w, h }
 */
export async function importPlan({ cfg, scene, image, hint, onStep, signal, fetchFn, maxSteps = 3 }) {
  const messages = [{
    role: 'user', images: [{ mime: image.mime, b64: image.b64 }],
    text: `Transcribe this floor plan. The image is ${image.w} x ${image.h} pixels.` + (hint ? '\nFrom the person who uploaded it: ' + hint : '')
  }];
  const tools = TOOLS.filter(t => t.name === 'set_structure');
  let notes = '', calls = 0, lastResult = '';
  for (let n = 0; n < maxSteps; n++) {
    const step = await modelStep(cfg, { system: IMPORT_GUIDE, messages, tools, forceTool: n === 0 ? 'set_structure' : undefined, maxTokens: 8000, signal, fetchFn });
    messages.push({ role: 'assistant', text: step.text, calls: step.calls });
    if (step.text) notes = step.text;
    if (!step.calls.length) break;
    const results = step.calls.map(k => {
      const r = runTool(scene, k.name, k.args, { image });
      if (r.ok) { calls++; lastResult = r.text; if (Array.isArray(k.args.notes) && k.args.notes.length && !notes) notes = k.args.notes.join(' '); }
      return { id: k.id, name: k.name, text: r.text, ok: r.ok };
    });
    messages.push({ role: 'tool', results });
    if (onStep) onStep({ pass: n + 1, results });
  }
  if (!calls) throw new Error('The model did not return a plan. ' + (notes || 'Try a clearer picture or a different model.'));
  return { notes, passes: calls, result: lastResult };
}
