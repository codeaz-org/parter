// Materials shared by the plan symbols (tint `t`) and the 3D model (colour `c`, roughness `r`,
// metalness `m`, emissive `e`, opacity `op`). Colours are sRGB hex.
export const MATS = {
  fabric:{c:0xd9cebe,r:.95,t:'#e6ded1'}, fabricLight:{c:0xebe3d6,r:.95,t:'#f3eee5'},
  accent:{c:0x41658f,r:.9,t:'#9ab7d6'}, accentSoft:{c:0x8ba6c3,r:.95,t:'#c3d4e6'},
  wood:{c:0xba8e60,r:.6,t:'#e4cba9'}, woodDark:{c:0x5b4737,r:.6,t:'#b9a28c'},
  white:{c:0xf4f2ee,r:.7,t:'#ffffff'}, ceramic:{c:0xf7f7f5,r:.25,t:'#ffffff'},
  stone:{c:0xe6e0d6,r:.35,t:'#efebe3'}, stoneDark:{c:0x3b4149,r:.2,m:.2,t:'#a3acb5'},
  cabinet:{c:0xd8cfc2,r:.5,t:'#efe9df'}, cabinetBlue:{c:0x47607d,r:.5,t:'#a3b8ce'},
  metal:{c:0xb9bcc0,r:.3,m:.8,t:'#d8dbde'}, dark:{c:0x2c3034,r:.5,t:'#7b838b'}, black:{c:0x0e1114,r:.15,t:'#4a5057'},
  glass:{c:0xcfe3ee,r:.05,op:.22,t:null}, mirror:{c:0xdfe8ee,r:.05,m:.9,t:'#e3ecf2'},
  green:{c:0x5f8a55,r:.9,t:'#aecda5'}, rug:{c:0xe7ded1,r:1,t:'#eee8de'}, shade:{c:0xfff3d6,r:.8,e:0xffc56a,t:'#fff2cc'},
  books:{c:0x8c7460,r:.9,t:'#c9b8a8'}, car:{c:0x7e8895,r:.3,m:.5,t:'#c5ccd4'}
};
