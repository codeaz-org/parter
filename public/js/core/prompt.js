// Writes the text prompt that goes to an image generator together with the exported view.
// The wording is deliberately strict about geometry: the picture carries the layout, the prompt
// carries the style, and the generator is told not to move anything.
import { CAT } from './catalog.js';
import { roomPhrase } from './rooms.js';

export const STYLES = {
  warm: ['Warm contemporary', 'warm contemporary interior in beige and greige with dusty-blue accents; large-format matt beige floor tiles; glossy white stretch ceiling with hidden LED cove lighting; ring-shaped LED pendants, slim wall sconces, warm backlighting behind the TV wall and shelves; linen and bouclé upholstery, vertical oak slat panelling'],
  scandi: ['Scandinavian', 'Scandinavian interior: white walls, light oak floor, pale grey and natural linen textiles, thin black metal details, simple pendant lamps, plenty of daylight'],
  japandi: ['Japandi', 'Japandi interior: warm off-white plaster walls, pale ash wood, low furniture, paper-lantern pendants, muted earth tones, very little clutter'],
  classic: ['Modern classic', 'modern classic interior: soft ivory walls with slim mouldings, herringbone oak floor, brass details, velvet upholstery, an elegant unfussy chandelier'],
  loft: ['Industrial loft', 'industrial loft interior: micro-cement floor, one exposed-concrete feature wall, black steel, cognac leather, track lighting and filament pendants']
};

const WORDS = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const plural = s => { const i = s.indexOf(' with '), h = i < 0 ? s : s.slice(0, i), t = i < 0 ? '' : s.slice(i); return (/shelf$/.test(h) ? h.replace(/shelf$/, 'shelves') : h + 's') + t; };
const article = s => (/^[aeiou]/i.test(s) ? 'an ' : 'a ') + s;

export function furnitureList(items) {
  const count = {};
  for (const i of items) { const s = CAT[i.t].say; count[s] = (count[s] || 0) + 1; }
  return Object.keys(count).map(s => (count[s] > 1 ? (WORDS[count[s]] || count[s]) + ' ' + plural(s) : article(s))).join(', ');
}

/**
 * @param mode 'eye' for the camera view, 'doll' for the roof-off overview
 * @param style a key of STYLES, or free text describing the look
 */
export function buildPrompt(scene, an, mode = 'eye', style = 'warm') {
  const look = STYLES[style] ? STYLES[style][1] : String(style || '').trim() || STYLES.warm[1];
  if (mode !== 'eye') {
    return 'Photorealistic 3D floor plan of a home, seen from above at an angle with the roof and ceiling removed. ' +
      'Use the attached image as the exact layout: keep every wall, door, window and piece of furniture exactly where it is, with the same proportions and the same viewing angle. Do not add, remove or move anything.\n\n' +
      'Style: ' + look + '.\n\nSoft daylight, gentle shadows, realistic materials, clean architectural visualisation.';
  }
  const room = an.regionAt(scene.cam.x, scene.cam.y);
  const inRoom = scene.items.filter(i => !room || an.regionAt(i.x, i.y) === room);
  const furn = furnitureList(inRoom);
  const ceil = scene.ceiling.toFixed(2).replace(/0$/, '');
  return 'Photorealistic interior photograph of ' + article(roomPhrase(room)) + ', ceiling height ' + ceil + ' m.\n\n' +
    'Use the attached image as the exact layout. Keep the room proportions, walls, door and window positions, camera position and angle, and every piece of furniture exactly where it is. Do not add, remove, resize or move furniture, windows or doors.\n\n' +
    (furn ? 'Furniture in the room: ' + furn + '.\n\n' : '') + 'Style: ' + look + '.\n\n' +
    'Lighting: late-afternoon daylight through the windows plus warm 3000 K artificial light. Shot at eye level with a wide-angle lens, straight verticals, natural colours, realistic materials and reflections, high detail.';
}
