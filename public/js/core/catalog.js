// Furniture catalogue. One list of simple parts per piece drives BOTH the plan symbol and the 3D model,
// so the two can never disagree.
//
// Local space of a piece: x across its width, z across its depth with the BACK at -z, y up (metres).
// A part is a box  B(x, z, width, depth, y0, height, material),
// a cylinder       C(x, z, radius, y0, height, material)
// or a sphere      S(x, z, radius, yCentre, material).
//
// To add a piece: add an entry to CAT with a name `n`, a group `g`, default width `w` and depth `d`,
// a parts function `f(w, d)`, and a phrase `say` used when writing image prompts.
// Optional: `round` (one size control), `flat` (rugs: drawn under everything), `tag` (label on the plan).
import { MATS } from './materials.js';
export { MATS };

export const B=(x,z,w,d,y,h,m)=>({t:'b',x,z,w,d,y,h,m});
export const C=(x,z,r,y,h,m)=>({t:'c',x,z,r,y,h,m});
export const S=(x,z,r,y,m)=>({t:'s',x,z,r,y,h:r,m});
export const partTop=p=>p.y+p.h;

function sofaParts(w,d){
  const p=[],arm=.18,bk=.22;
  p.push(B(0,0,w,d,.05,.27,'fabric'),B(0,-d/2+bk/2,w,bk,.32,.48,'fabric'),
    B(-w/2+arm/2,0,arm,d,.32,.3,'fabric'),B(w/2-arm/2,0,arm,d,.32,.3,'fabric'));
  const inner=w-2*arm,n=Math.max(1,Math.round(inner/.75)),cw=inner/n;
  for(let i=0;i<n;i++){const x=-inner/2+cw*(i+.5);
    p.push(B(x,bk/2,cw-.02,d-bk-.02,.32,.13,'fabricLight'),B(x,-d/2+bk+.09,cw-.08,.16,.45,.3,i%2?'accent':'fabricLight'))}
  return p;
}
function sofaLParts(w,d){
  const p=[],arm=.18,bk=.22,sd=Math.min(.95,d),ch=Math.min(1.05,w/2),zs=-d/2+sd/2;
  p.push(B(0,zs,w,sd,.05,.27,'fabric'),B(w/2-ch/2,0,ch,d,.05,.27,'fabric'),B(0,-d/2+bk/2,w,bk,.32,.48,'fabric'),
    B(-w/2+arm/2,zs,arm,sd,.32,.3,'fabric'),B(w/2-arm/2,zs,arm,sd,.32,.3,'fabric'));
  const x0=-w/2+arm,x1=w/2-ch,inner=x1-x0,n=Math.max(1,Math.round(inner/.75)),cw=inner/n;
  for(let i=0;i<n;i++){const x=x0+cw*(i+.5);
    p.push(B(x,zs+bk/2,cw-.02,sd-bk-.02,.32,.13,'fabricLight'),B(x,-d/2+bk+.09,cw-.08,.16,.45,.3,i%2?'fabricLight':'accent'))}
  const cx=(x1+w/2-arm)/2,cwd=w/2-arm-x1;
  p.push(B(cx,bk/2,cwd-.02,d-bk-.02,.32,.13,'fabricLight'),B(cx,-d/2+bk+.09,cwd-.08,.16,.45,.3,'accent'));
  return p;
}
function tableParts(w,d,h=.75,top='wood'){
  const p=[B(0,0,w,d,h-.04,.04,top)];
  for(const sx of[-1,1])for(const sz of[-1,1])p.push(B(sx*(w/2-.08),sz*(d/2-.08),.06,.06,0,h-.04,'woodDark'));
  return p;
}
function chairParts(cx,cz,dir,m='accent'){
  const v=[[0,-1],[1,0],[0,1],[-1,0]][dir],p=[B(cx,cz,.44,.44,.4,.07,m)];
  p.push(B(cx+v[0]*.2,cz+v[1]*.2,v[0]?.05:.44,v[0]?.44:.05,.47,.4,m));
  for(const sx of[-1,1])for(const sz of[-1,1])p.push(B(cx+sx*.18,cz+sz*.18,.035,.035,0,.4,'woodDark'));
  return p;
}
function diningParts(w,d,ends){
  const tw=ends?Math.max(.8,w-1):w,td=Math.max(.7,d-1.1),p=tableParts(tw,td);
  const n=Math.max(1,Math.round(tw/.65)),st=tw/n;
  for(let i=0;i<n;i++){const x=-tw/2+st*(i+.5);p.push(...chairParts(x,-td/2-.2,0),...chairParts(x,td/2+.2,2))}
  if(ends)p.push(...chairParts(-tw/2-.2,0,3),...chairParts(tw/2+.2,0,1));
  return p;
}
function shelfParts(w,d){
  const h=2.1,p=[B(-w/2+.015,0,.03,d,0,h,'wood'),B(w/2-.015,0,.03,d,0,h,'wood'),B(0,-d/2+.01,w,.02,0,h,'wood')];
  for(let i=0;i<6;i++){const y=.05+i*.4;p.push(B(0,0,w-.06,d,y,.03,'wood'));
    if(i<5)p.push(B((i%2?1:-1)*w*.18,.02,w*.45,d*.6,y+.03,.25,i%3?'books':'accentSoft'))}
  return p;
}
function bedParts(w,d){
  const p=[B(0,0,w,d,.08,.24,'fabric'),B(0,-d/2+.05,w,.1,0,1.05,'fabric'),B(0,.05,w-.1,d-.2,.32,.2,'white'),
    B(0,.33,w-.06,d-.8,.52,.04,'accentSoft')];
  if(w>1.3)p.push(B(-w/4,-d/2+.42,w/2-.2,.4,.52,.12,'white'),B(w/4,-d/2+.42,w/2-.2,.4,.52,.12,'white'));
  else p.push(B(0,-d/2+.42,w-.3,.4,.52,.12,'white'));
  return p;
}
const fronts=(w,zf,y0,h,hy,x0)=>{const p=[],n=Math.max(1,Math.round(w/.6)),cw=w/n,xo=x0||0;
  for(let i=0;i<n;i++){if(i)p.push(B(xo-w/2+cw*i,zf+.003,.008,.006,y0,h,'dark'));p.push(B(xo-w/2+cw*(i+.5),zf+.016,Math.min(.2,cw-.12),.018,hy,.016,'metal'))}return p};
const kbase=(w,d)=>[B(0,-.03,w,d-.06,0,.1,'dark'),B(0,0,w,d,.1,.78,'cabinetBlue'),B(0,.01,w,d+.02,.88,.04,'stone'),...fronts(w,d/2,.12,.74,.8)];
const kwall=(w,d)=>[B(0,-d/2+.175,w,.35,1.45,.72,'cabinet'),...fronts(w,-d/2+.35,1.47,.68,1.5)];
function sinkParts(w,d){const bw=Math.min(.5,w*.42),xb=w>=1?-Math.min(.22,w*.16):0,p=[...kbase(w,d),B(xb,.03,bw,d*.62,.92,.012,'metal'),B(xb,.03,bw-.08,d*.62-.08,.925,.01,'dark'),
    C(xb,-d/2+.1,.018,.92,.3,'metal'),B(xb,-d/2+.19,.03,.2,1.2,.025,'metal')];
  if(w>=1){const xd=xb+bw/2+.2;p.push(B(xd,.03,.32,d*.62,.92,.008,'metal'));for(let i=0;i<4;i++)p.push(B(xd-.105+i*.07,.03,.012,d*.5,.928,.003,'dark'))}return p}
function hobParts(w,d){const hw=Math.min(.8,w-.1),p=[...kbase(w,d),B(0,0,hw,d*.8,.92,.006,'black')];
  for(const sx of[-1,1])for(const sz of[-1,1])p.push(C(sx*hw*.24,sz*d*.19,.075,.926,.003,'stoneDark'));
  p.push(B(0,-d/2+.22,w,.44,1.55,.12,'metal'),B(0,-d/2+.15,.3,.3,1.67,.6,'metal'));return p}
const deskParts=(w,d)=>[B(0,0,w,d,.72,.03,'wood'),B(-w/2+.02,0,.04,d,0,.72,'woodDark'),B(w/2-.02,0,.04,d,0,.72,'woodDark')];
function benchParts(w,d){const p=[B(0,0,w,d,0,.4,'wood'),B(0,.02,w-.04,d-.06,.4,.1,'fabricLight')],n=Math.max(2,Math.round(w/.6)),cw=w/n;
  for(let i=0;i<n;i++)p.push(B(-w/2+cw*(i+.5),-d/2+.09,cw-.08,.14,.5,.32,i%2?'fabricLight':'accent'));return p}
function rackParts(w,d){const p=[];for(const sx of[-1,1])for(const sz of[-1,1])p.push(B(sx*(w/2-.02),sz*(d/2-.02),.03,.03,0,1.9,'metal'));
  for(const y of[.1,.55,1,1.45,1.87])p.push(B(0,0,w,d,y,.03,'metal'));
  p.push(B(-w*.22,0,w*.36,d*.7,.58,.3,'books'),B(w*.2,0,w*.3,d*.7,1.03,.28,'accentSoft'),B(-w*.1,0,w*.5,d*.7,.13,.3,'cabinet'));return p}
export const CAT = {
  sofaL:{n:'Corner sofa',g:'Living',w:2.8,d:1.7,mir:1,f:sofaLParts,say:'corner sofa with a chaise'},
  sofa3:{n:'Sofa, 3 seats',g:'Living',w:2.2,d:.95,f:sofaParts,say:'three-seat sofa'},
  sofa2:{n:'Sofa, 2 seats',g:'Living',w:1.6,d:.95,f:sofaParts,say:'two-seat sofa'},
  arm:{n:'Armchair',g:'Living',w:.9,d:.88,f:sofaParts,say:'armchair'},
  coffeeR:{n:'Round coffee table',g:'Living',w:.9,d:.9,round:1,f:w=>[C(0,0,w/2-.07,0,.3,'fabricLight'),C(0,0,w/2,.3,.06,'stoneDark')],say:'round coffee table'},
  coffee:{n:'Coffee table',g:'Living',w:1.2,d:.6,f:(w,d)=>tableParts(w,d,.4),say:'coffee table'},
  tv:{n:'TV wall unit',g:'Living',w:2.2,d:.42,f:(w,d)=>[B(0,0,w,d,.25,.32,'cabinetBlue'),B(0,-d/2+.04,Math.min(1.65,w-.3),.05,.95,.93,'black')],say:'low TV unit with a wall-mounted TV'},
  rug:{n:'Rug',g:'Living',w:3,d:2.2,flat:1,f:(w,d)=>[B(0,0,w,d,0,.015,'rug')],say:'area rug'},
  shelf:{n:'Bookshelf',g:'Living',w:1.2,d:.35,f:shelfParts,say:'tall bookshelf'},
  side:{n:'Sideboard',g:'Living',w:1.6,d:.45,f:(w,d)=>{const p=[B(0,0,w,d,.14,.66,'wood')];for(const sx of[-1,1])for(const sz of[-1,1])p.push(B(sx*(w/2-.08),sz*(d/2-.07),.04,.04,0,.14,'woodDark'));return p},say:'sideboard'},
  lamp:{n:'Floor lamp',g:'Living',w:.42,d:.42,round:1,f:()=>[C(0,0,.15,0,.03,'metal'),C(0,0,.015,.03,1.38,'metal'),C(0,0,.2,1.36,.28,'shade')],say:'floor lamp'},
  plant:{n:'Plant',g:'Living',w:.6,d:.6,round:1,f:w=>[C(0,0,w*.3,0,.36,'ceramic'),C(0,0,.02,.36,.4,'woodDark'),S(0,0,w*.5,.95,'green'),S(w*.18,w*.12,w*.34,1.3,'green')],say:'large potted plant'},
  bench:{n:'Window seat',g:'Living',w:2,d:.55,f:benchParts,say:'cushioned window seat'},
  chaise:{n:'Chaise longue',g:'Living',w:.8,d:1.65,f:(w,d)=>[B(0,0,w,d,.1,.22,'fabric'),B(0,-d/2+.12,w,.24,.32,.5,'fabric'),B(0,.1,w-.06,d-.3,.32,.1,'fabricLight'),B(0,-d/2+.38,w-.2,.3,.42,.12,'accent')],say:'chaise longue'},
  pouf:{n:'Pouf',g:'Living',w:.55,d:.55,round:1,f:w=>[C(0,0,w/2,0,.4,'accentSoft')],say:'pouf'},
  sideT:{n:'Side table',g:'Living',w:.45,d:.45,round:1,f:w=>[C(0,0,.14,0,.02,'metal'),C(0,0,.015,.02,.5,'metal'),C(0,0,w/2,.52,.03,'wood')],say:'small side table'},
  lowshelf:{n:'Low bookcase',g:'Living',w:1,d:.3,f:(w,d)=>[B(0,0,w,d,0,.05,'wood'),B(-w/2+.015,0,.03,d,0,.9,'wood'),B(w/2-.015,0,.03,d,0,.9,'wood'),B(0,-d/2+.01,w,.02,0,.9,'wood'),
    B(0,0,w,d,.44,.03,'wood'),B(0,0,w,d,.87,.03,'wood'),B(-w*.18,.02,w*.45,d*.6,.08,.25,'books'),B(w*.15,.02,w*.5,d*.6,.47,.25,'accentSoft')],say:'low bookcase'},
  dine6:{n:'Dining table, 6 chairs',g:'Dining',w:1.8,d:2,f:(w,d)=>diningParts(w,d,0),say:'dining table with six chairs'},
  dine8:{n:'Dining table, 8 chairs',g:'Dining',w:3.2,d:2,f:(w,d)=>diningParts(w,d,1),say:'dining table with eight chairs'},
  table:{n:'Table',g:'Dining',w:1.6,d:.9,f:(w,d)=>tableParts(w,d),say:'table'},
  chair:{n:'Chair',g:'Dining',w:.46,d:.5,f:()=>chairParts(0,.02,0),say:'chair'},
  stool:{n:'Bar stool',g:'Dining',w:.4,d:.4,round:1,f:()=>[C(0,0,.2,0,.03,'metal'),C(0,0,.025,.03,.69,'metal'),C(0,0,.18,.72,.05,'accent')],say:'bar stool'},
  kit:{n:'Units with wall cabinets',g:'Kitchen',w:2.4,d:.6,tag:'Units',f:(w,d)=>[...kbase(w,d),...kwall(w,d)],say:'run of kitchen units with worktop and wall cabinets'},
  kitBase:{n:'Base units',g:'Kitchen',w:1.2,d:.6,tag:'Units',f:kbase,say:'run of kitchen base units with worktop'},
  kitSink:{n:'Sink unit',g:'Kitchen',w:1.2,d:.6,tag:'Sink',f:sinkParts,say:'kitchen sink unit'},
  kitHob:{n:'Hob with extractor',g:'Kitchen',w:.9,d:.6,tag:'Hob',f:hobParts,say:'hob unit with extractor hood'},
  oven:{n:'Oven column',g:'Kitchen',w:.6,d:.6,tag:'Oven',f:(w,d)=>[B(0,0,w,d,0,2.17,'cabinet'),B(0,d/2+.006,w-.06,.012,.72,.58,'black'),B(0,d/2+.014,w-.2,.006,.8,.36,'stoneDark'),B(0,d/2+.03,w-.16,.02,1.22,.02,'metal'),
    B(0,d/2+.006,w-.06,.012,1.38,.38,'black'),B(0,d/2+.003,w,.006,.66,.008,'dark'),B(0,d/2+.003,w,.006,1.82,.008,'dark'),B(0,d/2+.016,.2,.018,.6,.016,'metal'),B(0,d/2+.016,.2,.018,1.88,.016,'metal')],say:'tall oven column with built-in oven and microwave'},
  island:{n:'Kitchen island',g:'Kitchen',w:2,d:.9,tag:'Island',f:(w,d)=>[B(0,-.1,w-.1,d-.3,0,.88,'cabinetBlue'),B(0,0,w,d,.88,.05,'stone'),...fronts(w-.1,d/2-.25,.02,.84,.78)],say:'kitchen island'},
  fridge:{n:'Fridge',g:'Kitchen',w:.6,d:.65,tag:'Fridge',f:(w,d)=>[B(0,0,w,d,0,2,'metal'),B(0,d/2+.003,w,.006,.7,.008,'dark'),B(-w/2+.07,d/2+.02,.02,.03,.85,.7,'dark'),B(-w/2+.07,d/2+.02,.02,.03,.3,.32,'dark')],say:'tall fridge'},
  fridge2:{n:'Double-door fridge',g:'Kitchen',w:.9,d:.7,tag:'Fridge',f:(w,d)=>[B(0,0,w,d,0,1.8,'metal'),B(0,d/2+.003,.008,.006,.02,1.76,'dark'),B(-.045,d/2+.02,.02,.03,.7,.75,'dark'),B(.045,d/2+.02,.02,.03,.7,.75,'dark')],say:'double-door fridge'},
  tall:{n:'Tall cabinet',g:'Kitchen',w:.6,d:.6,tag:'Tall unit',f:(w,d)=>{const p=[B(0,0,w,d,0,2.17,'cabinet'),B(0,d/2+.003,w,.006,1.25,.008,'dark')],n=Math.max(1,Math.round(w/.6)),cw=w/n;
    for(let i=0;i<n;i++){if(i)p.push(B(-w/2+cw*i,d/2+.003,.008,.006,.02,2.13,'dark'));p.push(B(-w/2+cw*(i+1)-.07,d/2+.016,.016,.018,.95,.22,'metal'),B(-w/2+cw*(i+1)-.07,d/2+.016,.016,.018,1.33,.22,'metal'))}return p},say:'tall cabinet'},
  bed2:{n:'Double bed',g:'Bedroom',w:1.7,d:2.1,f:bedParts,say:'double bed'},
  bed1:{n:'Single bed',g:'Bedroom',w:1,d:2.1,f:bedParts,say:'single bed'},
  night:{n:'Bedside table',g:'Bedroom',w:.45,d:.4,f:(w,d)=>[B(0,0,w,d,.1,.4,'wood'),C(0,0,.05,.5,.2,'metal'),C(0,0,.12,.68,.16,'shade')],say:'bedside table with lamp'},
  ward:{n:'Wardrobe',g:'Bedroom',w:1.8,d:.6,tag:'Wardrobe',f:(w,d)=>{const p=[B(0,0,w,d,0,2.3,'cabinet')],n=Math.max(1,Math.round(w/.6));for(let i=1;i<n;i++)p.push(B(-w/2+w/n*i,d/2,.008,.006,.05,2.2,'dark'));return p},say:'full-height wardrobe'},
  desk:{n:'Desk',g:'Bedroom',w:1.4,d:.65,f:deskParts,say:'desk'},
  deskS:{n:'Small desk',g:'Bedroom',w:1,d:.55,f:deskParts,say:'small desk'},
  ochair:{n:'Office chair',g:'Bedroom',w:.6,d:.6,f:()=>[C(0,0,.28,.03,.05,'metal'),C(0,0,.03,.08,.37,'metal'),B(0,0,.5,.5,.45,.08,'dark'),B(0,-.24,.48,.06,.55,.5,'dark')],say:'office chair'},
  tub:{n:'Bathtub',g:'Bathroom',w:1.7,d:.75,f:(w,d)=>[B(0,0,w,d,0,.56,'ceramic'),B(0,0,w-.16,d-.16,.5,.062,'stone')],say:'bathtub'},
  shower:{n:'Shower',g:'Bathroom',w:.9,d:.9,f:(w,d)=>[B(0,0,w,d,0,.06,'ceramic'),B(0,d/2-.01,w,.015,.06,1.95,'glass'),B(w/2-.01,0,.015,d,.06,1.95,'glass'),C(-w/2+.08,-d/2+.08,.015,.06,2,'metal')],say:'glass walk-in shower'},
  wc:{n:'Toilet',g:'Bathroom',w:.38,d:.68,f:(w,d)=>[B(0,-d/2+.09,w,.18,.35,.42,'ceramic'),C(0,.09,w/2-.01,0,.4,'ceramic'),C(0,.09,w/2,.4,.025,'white')],say:'toilet'},
  vanity:{n:'Washbasin unit',g:'Bathroom',w:.8,d:.48,f:(w,d)=>[B(0,0,w,d,.3,.5,'wood'),B(0,0,w,d,.8,.03,'stone'),B(0,.02,w*.55,d*.6,.83,.1,'ceramic'),B(0,-d/2+.01,w*.9,.02,1.1,.8,'mirror')],say:'washbasin unit with mirror'},
  washer:{n:'Washing machine',g:'Laundry and utility',w:.6,d:.6,tag:'Washer',f:(w,d)=>[B(0,0,w,d,0,.85,'white'),B(0,d/2,.3,.01,.3,.3,'dark')],say:'washing machine'},
  dryer:{n:'Dryer',g:'Laundry and utility',w:.6,d:.6,tag:'Dryer',f:(w,d)=>[B(0,0,w,d,0,.85,'white'),B(0,d/2,.34,.01,.28,.34,'metal'),B(0,d/2,w-.1,.008,.72,.08,'dark')],say:'tumble dryer'},
  stack:{n:'Washer and dryer stack',g:'Laundry and utility',w:.6,d:.65,tag:'Washer + dryer',f:(w,d)=>[B(0,0,w,d,0,1.72,'white'),B(0,d/2,.3,.01,.3,.3,'dark'),B(0,d/2,.3,.01,1.16,.3,'dark')],say:'stacked washer and dryer'},
  lsink:{n:'Utility sink',g:'Laundry and utility',w:.6,d:.5,f:(w,d)=>[B(0,0,w,d,.1,.75,'cabinet'),B(0,0,w,d,.85,.03,'stone'),B(0,.02,w-.14,d-.16,.885,.01,'metal'),C(0,-d/2+.08,.015,.88,.25,'metal')],say:'utility sink'},
  rack:{n:'Storage shelving',g:'Laundry and utility',w:1.2,d:.45,tag:'Shelves',f:rackParts,say:'metal storage shelving unit'},
  boiler:{n:'Wall boiler',g:'Laundry and utility',w:.45,d:.35,tag:'Boiler',f:(w,d)=>[B(0,0,w,d,1.25,.8,'white'),C(-.1,0,.015,.6,.65,'metal'),C(.1,0,.015,.6,.65,'metal'),C(0,0,.05,2.05,.4,'metal')],say:'wall-mounted gas boiler'},
  tank:{n:'Hot water tank',g:'Laundry and utility',w:.6,d:.6,tag:'Tank',round:1,f:w=>[C(0,0,w/2-.05,0,.05,'dark'),C(0,0,w/2,.05,1.5,'white')],say:'hot water cylinder'},
  panel:{n:'Electrical panel',g:'Laundry and utility',w:.6,d:.12,tag:'Electrics',f:(w,d)=>[B(0,0,w,d,1.2,.75,'metal'),B(0,d/2,w-.08,.008,1.25,.65,'white')],say:'wall-mounted electrical panel'},
  car:{n:'Car',g:'Garage',w:1.85,d:4.5,f:(w,d)=>{const p=[B(0,0,w,d,.25,.5,'car'),B(0,.2,w-.2,d*.5,.75,.5,'dark')];for(const sx of[-1,1])for(const sz of[-1,1])p.push(B(sx*(w/2-.1),sz*d*.32,.22,.66,0,.66,'black'));return p},say:'parked car'}
};
const _pc=new Map();
export function natH(t,w,d){return Math.max.apply(null,partsOf(t,w,d).map(partTop))}
export function partsOf(type,w,d){const k=type+'|'+w+'|'+d;let p=_pc.get(k);if(!p){p=CAT[type].f(w,d);_pc.set(k,p)}return p}

export const GROUPS = [...new Set(Object.values(CAT).map(c => c.g))];
export function catalogText() {
  return Object.entries(CAT).map(([k, c]) => `${k}: ${c.n} (${c.w} x ${c.d} m, ${natH(k, c.w, c.d).toFixed(2)} m high)`).join('\n');
}
