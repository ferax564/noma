// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/presentation-tools.ts (MIT). Do not edit to add Noma host policy.
import type { CanvasElement, CanvasPage, Frame, PaperDOMDocument } from './paperdom-document-model.js';
import {effectiveLibrary} from './paperdom-starter-library.js';
import { baseStyle } from './paperdom-component-library.js';
export type TableData = { rows: string[][]; header: boolean };
export type ChartSeries = { name: string; values: number[] };
export type ChartData = { kind: 'bar'|'line'; labels: string[]; values: number[]; title: string; series?: ChartSeries[]; colors?: string[]; grid?: boolean };
export const clamp = (n:number,min:number,max:number) => Math.max(min,Math.min(max,n));
export function parseTable(text:string):string[][] {
  const rows=text.replace(/\r/g,'').split('\n').map(row=>row.split('\t'));
  if(!rows.length||rows.length>50||Math.max(...rows.map(r=>r.length))>20)throw new Error('Use at most 50 rows and 20 columns.');
  const width=Math.max(...rows.map(r=>r.length));return rows.map(row=>Array.from({length:width},(_,i)=>row[i]??''));
}
export function parseChart(text:string):Pick<ChartData,'labels'|'values'|'series'> {
  const rows=text.trim().split('\n').map(row=>row.split('\t'));
  if(!rows.length||rows.length>50)throw new Error('Use at most 50 lines.');
  if(rows.some(row=>row.length<2||!row[0].trim()||row.slice(1).some(cell=>!cell.trim()||!Number.isFinite(Number(cell)))))throw new Error('Use one label and one or more finite numbers per line, separated by tabs.');
  const labels=rows.map(r=>r[0]);
  if(rows[0].length===2)return {labels,values:rows.map(r=>Number(r[1]))};
  if(rows.some(row=>row.length!==rows[0].length))throw new Error('Use the same number of series in every line.');
  const series=Array.from({length:rows[0].length-1},(_,s)=>({name:`Series ${s+1}`,values:rows.map(r=>Number(r[s+1]))}));
  return {labels,values:series[0].values,series};
}
export function makeDataElement(type:'table'|'chart',id:string):CanvasElement {
  return {id,type,name:type==='table'?'Table':'Chart',frame:{x:100,y:180,w:640,h:320,rotation:0},z:10,style:{...baseStyle,fill:'#ffffff',stroke:'#cbd5e1',strokeWidth:1,padding:12,fontSize:20},...(type==='table'?{table:{header:true,rows:[['Metric','Current','Target'],['Revenue','120','150'],['Users','800','1000']]}}:{chart:{kind:'bar' as const,labels:['Q1','Q2','Q3','Q4'],values:[24,36,31,48],title:'Quarterly progress'}})};
}
/** Clipboard copies are independent; selected connectors are converted to local points when targets are omitted. */
export function copyElements(page:CanvasPage,ids:string[],prefix:string,offset=20):CanvasElement[] {
  const selected=page.elements.filter(e=>ids.includes(e.id));const mapping=new Map(selected.map((e,i)=>[e.id,`${prefix}_${i}`]));
  const groups=new Map(selected.filter(e=>e.groupId).map(e=>[e.groupId!,`${prefix}_group_${e.groupId}`]));
  return selected.map(raw=>{const e=structuredClone(raw);e.id=mapping.get(e.id)!;if(e.groupId)e.groupId=groups.get(e.groupId);e.frame.x+=offset;e.frame.y+=offset;
    for(const side of ['from','to'] as const){const p=e[side];if(!p)continue;if(p.elementId&&mapping.has(p.elementId))p.elementId=mapping.get(p.elementId);else {const point=endpointPoint(p,page.elements);e[side]={x:point.x+offset,y:point.y+offset};}}
    return e;});
}
export function endpointPoint(endpoint:CanvasElement['from'],elements:CanvasElement[]) {
  if(!endpoint)return{x:0,y:0};if(!endpoint.elementId)return{x:endpoint.x??0,y:endpoint.y??0};const e=elements.find(e=>e.id===endpoint.elementId);if(!e)return{x:0,y:0};
  const {x,y,w,h,rotation}=e.frame,cx=x+w/2,cy=y+h/2;
  const dx=endpoint.anchor==='left'?-w/2:endpoint.anchor==='right'?w/2:0,dy=endpoint.anchor==='top'?-h/2:endpoint.anchor==='bottom'?h/2:0,r=rotation*Math.PI/180;
  return{x:cx+dx*Math.cos(r)-dy*Math.sin(r),y:cy+dx*Math.sin(r)+dy*Math.cos(r)};
}
export function resizePage(page:CanvasPage,width:number,height:number):CanvasPage {
  const sx=width/page.size.width,sy=height/page.size.height;
  return {...page,size:{width,height},elements:page.elements.map(raw=>{const e=structuredClone(raw);e.frame={...e.frame,x:e.frame.x*sx,y:e.frame.y*sy,w:e.frame.w*sx,h:e.frame.h*sy};for(const p of[e.from,e.to])if(p&&!p.elementId){p.x=(p.x??0)*sx;p.y=(p.y??0)*sy;}return e;})};
}
export function findText(document:PaperDOMDocument,query:string) {
  if(!query)return[];const needle=query.toLocaleLowerCase();
  return document.pages.flatMap(page=>page.elements.filter(e=>{
    const definition=effectiveLibrary(document).components.find(c=>c.id===e.component?.definitionId);
    const properties=Object.entries(definition?.properties??{}).map(([key,p])=>e.component?.props[key]??p.default);
    return [e.name,...Object.values(e.content??{}),...properties,...(e.table?.rows.flat()??[])].some(t=>typeof t==='string'&&t.toLocaleLowerCase().includes(needle));
  }).map(e=>({pageId:page.id,elementId:e.id,name:e.name,text:e.content?.text??e.name})));
}
export function resizeWithAspect(frame:Frame,next:Frame,handle:string,page:CanvasPage):Frame {
  const ratio=frame.w/frame.h;let w=next.w,h=next.h;
  if(handle==='n'||handle==='s')w=h*ratio;else h=w/ratio;
  const factor=Math.min(1,page.size.width/w,page.size.height/h);w*=factor;h*=factor;
  return{...next,w,h,x:clamp(handle.includes('w')?frame.x+frame.w-w:frame.x,0,page.size.width-w),y:clamp(handle.includes('n')?frame.y+frame.h-h:frame.y,0,page.size.height-h)};
}

/** Moving free endpoints follows their object; attached endpoints follow their targets. */
export function translateElement(element:CanvasElement,dx:number,dy:number):CanvasElement {
  const result=structuredClone(element);result.frame.x+=dx;result.frame.y+=dy;
  for(const side of ['from','to']as const){const point=result[side];if(point&&!point.elementId){point.x=(point.x??0)+dx;point.y=(point.y??0)+dy;}}
  return result;
}
