// Only named presentations cross the renderer boundary. Window geometry remains
// native-owned and is fitted to the display; no arbitrary window controls.
export const ASSISTANT_FLOAT_SIZES=Object.freeze({pill:{width:298,height:104},threads:{width:298,height:354},chat:{width:360,height:600},menu:{width:298,height:320},minimized:{width:76,height:76}});
function fit(bounds,areas){
 if(!areas.length)return null;
 let area=areas[0],overlap=-1;
 for(const a of areas){const n=Math.max(0,Math.min(bounds.x+bounds.width,a.x+a.width)-Math.max(bounds.x,a.x))*Math.max(0,Math.min(bounds.y+bounds.height,a.y+a.height)-Math.max(bounds.y,a.y));if(n>overlap){overlap=n;area=a}}
 const width=Math.min(bounds.width,area.width),height=Math.min(bounds.height,area.height);
 return{x:Math.round(Math.max(area.x,Math.min(bounds.x,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(bounds.y,area.y+area.height-height))),width,height};
}
export function assistantFloatBounds(current,presentation,areas){
 const size=typeof presentation==='string'&&Object.hasOwn(ASSISTANT_FLOAT_SIZES,presentation)?ASSISTANT_FLOAT_SIZES[presentation]:null;if(!size||!current||!['x','y','width','height'].every(k=>Number.isFinite(current[k])))return null;
 return fit({...size,x:current.x+current.width-size.width,y:current.y+current.height-size.height},areas);
}
export function movedAssistantFloatBounds(current,delta,areas){
 if(!delta||!['dx','dy'].every(k=>Number.isFinite(delta[k])&&Math.abs(delta[k])<=2000))return null;
 return fit({...current,x:current.x+delta.dx,y:current.y+delta.dy},areas);
}
