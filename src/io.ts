import { DiagramEngine } from './core.js';
import { clone, createDocument, createPage, createShape, DEFAULT_STYLE, DrawingError, parseDocument, validateDocument } from './model.js';
import type { Diagnostic, DiagramDocument, Json, Matrix, Page, Point, Shape, ShapeStyle } from './model.js';
import { bounds, IDENTITY, localMatrix, multiply, shapePath, transformPoint, transformedBounds, translation } from './geometry.js';
import { connectorRoute } from './layout.js';
import { parsePath, serializePath, transformSegments } from './path.js';
import type { PathSegment } from './path.js';
import { readZip, writeZip } from './zip.js';
import type { ZipLimits } from './zip.js';
import { descendants, element, elements, escapeXml, first, isElement, localName, parseXml, serializeXml, textContent } from './xml.js';
import type { XmlElement } from './xml.js';
export { readZip, writeZip, crc32 } from './zip.js';
export { parseXml, serializeXml } from './xml.js';
export { parsePath, serializePath } from './path.js';
export type { ZipLimits } from './zip.js';

const VISIO='http://schemas.microsoft.com/office/visio/2012/main';
const VDX='http://schemas.microsoft.com/visio/2003/core';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const RID='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const VREL='http://schemas.microsoft.com/visio/2010/relationships/';
const CT='http://schemas.openxmlformats.org/package/2006/content-types';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const cell=(name:string,value:string|number,formula?:string)=>element('Cell',{N:name,V:String(value),...(formula?{F:formula}:{})});
const cells=(node:XmlElement|undefined):Map<string,XmlElement>=>new Map(node?elements(node,'Cell').map(c=>[c.attributes['N']??'',c]):[]);
function value(node:XmlElement|undefined,name:string,fallback=''):string{return cells(node).get(name)?.attributes['V']??fallback;}
function numberCell(node:XmlElement|undefined,name:string,fallback=0):number{const n=Number(value(node,name,String(fallback)));return Number.isFinite(n)?n:fallback;}
function qualified(parent:XmlElement,name:string):string{const i=parent.name.indexOf(':');return i<0?name:parent.name.slice(0,i+1)+name;}
function setCell(parent:XmlElement,name:string,v:string|number):void{let c=cells(parent).get(name);if(!c){c=element(qualified(parent,'Cell'),{N:name,V:String(v)});parent.children.unshift(c);}else{c.attributes['V']=String(v);delete c.attributes['F'];}}
function section(node:XmlElement|undefined,name:string):XmlElement|undefined{return node?elements(node,'Section').find(s=>s.attributes['N']===name):undefined;}
function numeric(value_:string|undefined,fallback:number):number{const n=Number(value_);return value_!==undefined&&Number.isFinite(n)?n:fallback;}
function same(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b);}
export interface VisioReadOptions extends ZipLimits{allowMacroPreservation?:boolean}
export interface VisioExportOptions{onDiagnostic?:(diagnostic:Diagnostic)=>void;strict?:boolean}
export interface DrawingReadResult{document:DiagramDocument;diagnostics:Diagnostic[];source?:VisioPackage}
interface Relationship{id:string;type:string;target:string;external:boolean}
function relationshipPart(part:string):string{if(!part)return'_rels/.rels';const i=part.lastIndexOf('/');return part.slice(0,i+1)+'_rels/'+part.slice(i+1)+'.rels';}
function resolvePart(source:string,target:string):string{
  if(/^[a-z][a-z0-9+.-]*:/i.test(target)||target.includes('\\')||/[?#\x00-\x1f]/.test(target))throw new DrawingError('OPC_TARGET',`Invalid internal relationship target: ${target}`);
  const parts=target.startsWith('/')?[]:source.split('/').slice(0,-1);
  for(const part of target.replace(/^\//,'').split('/')){if(part==='..'){if(!parts.length)throw new DrawingError('OPC_TARGET','Relationship escapes the package root.');parts.pop();}else if(part&&part!=='.')parts.push(part);}
  return parts.join('/');
}
function relationships(entries:ReadonlyMap<string,Uint8Array>,part:string):Relationship[]{
  const bytes=entries.get(relationshipPart(part));if(!bytes)return[];const root=parseXml(dec.decode(bytes));if(localName(root.name)!=='Relationships')throw new DrawingError('OPC_RELATIONSHIPS','Invalid relationship root.');
  const seen=new Set<string>();return elements(root,'Relationship').map(node=>{const id=node.attributes['Id']??'',external=node.attributes['TargetMode']==='External';if(!id||seen.has(id))throw new DrawingError('OPC_RELATIONSHIP_ID','Duplicate or missing relationship ID.');seen.add(id);return{id,type:node.attributes['Type']??'',external,target:external?node.attributes['Target']??'':resolvePart(part,node.attributes['Target']??'')};});
}
function readPart(entries:ReadonlyMap<string,Uint8Array>,part:string):XmlElement{const bytes=entries.get(part);if(!bytes)throw new DrawingError('OPC_MISSING_PART',`Missing package part: ${part}`);return parseXml(dec.decode(bytes));}
interface MasterXml{metadata:XmlElement;root:XmlElement;byId:Map<string,XmlElement>}
interface ShapeSource{part:string;visioId:string;parentHeight:number;width:number;height:number;locPinX:number;locPinY:number;flipX:number;flipY:number;richText:boolean}
interface PageSource{part:string;visioId:string}
interface ReadContext{
  document:XmlElement;diagnostics:Diagnostic[];styles:Map<string,XmlElement>;masters:Map<string,MasterXml>;
  colors:Map<string,string>;fonts:Map<string,string>;shapeSources:Map<string,ShapeSource>;pageSources:Map<string,PageSource>;
}
function diagnostic(ctx:ReadContext,code:string,message:string,part?:string,shapeId?:string):void{ctx.diagnostics.push({code,severity:'warning',message,part,shapeId});}
function effectiveShape(source:XmlElement,master:XmlElement|undefined):XmlElement{
  if(!master)return source;const direct=new Set(elements(source,'Cell').map(c=>c.attributes['N']));
  const localSections=elements(source,'Section');const inheritedSections=elements(master,'Section').map(base=>{
    const local=localSections.find(s=>s.attributes['N']===base.attributes['N']&&(s.attributes['IX']??'0')===(base.attributes['IX']??'0'));
    if(!local)return base;const rows=elements(base,'Row').filter(r=>!elements(local,'Row').some(s=>s.attributes['IX']===r.attributes['IX']||(s.attributes['N']&&s.attributes['N']===r.attributes['N'])));return{...local,children:[...rows,...local.children]};
  });
  return{...source,attributes:{...master.attributes,...source.attributes},children:[...elements(master,'Cell').filter(c=>!direct.has(c.attributes['N'])),...source.children.filter(c=>!isElement(c)||localName(c.name)!=='Section'),...inheritedSections,...localSections.filter(s=>!elements(master,'Section').some(b=>b.attributes['N']===s.attributes['N']&&(b.attributes['IX']??'0')===(s.attributes['IX']??'0'))),...(!first(source,'Text')&&first(master,'Text')?[first(master,'Text')!]:[])]};
}
function inheritedStyle(ctx:ReadContext,node:XmlElement,role:'FillStyle'|'LineStyle'|'TextStyle'):XmlElement|undefined{
  const style=ctx.styles.get(node.attributes[role]??'0');if(!style)return;let result=style,current=style;const seen=new Set<string>();
  for(let i=0;i<32;i++){const parent=current.attributes[role];if(!parent||seen.has(parent)||!ctx.styles.has(parent))break;seen.add(parent);const base=ctx.styles.get(parent)!;result=effectiveShape(result,base);current=base;}return result;
}
function resolveColor(ctx:ReadContext,input:string,fallback:string):string{const color=ctx.colors.get(input)??input;if(/^#[\da-fA-F]{6}$/.test(color)||/^#[\da-fA-F]{3}$/.test(color))return color;const rgb=color.match(/^RGB\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);return rgb?'#'+rgb.slice(1).map(v=>Math.min(255,Number(v)).toString(16).padStart(2,'0')).join(''):fallback;}
function readStyle(ctx:ReadContext,node:XmlElement,part:string,shapeId:string):ShapeStyle{
  const fill=effectiveShape(node,inheritedStyle(ctx,node,'FillStyle')),line=effectiveShape(node,inheritedStyle(ctx,node,'LineStyle')),text=effectiveShape(node,inheritedStyle(ctx,node,'TextStyle'));
  const character=elements(section(text,'Character')??element('none'),'Row')[0],paragraph=elements(section(text,'Paragraph')??element('none'),'Row')[0];const fontStyle=numberCell(character,'Style');
  if(numberCell(fill,'FillPattern',1)>1)diagnostic(ctx,'FILL_PATTERN_APPROXIMATED','Pattern/gradient fill is rendered as its foreground color; source data is retained.',part,shapeId);
  return{...DEFAULT_STYLE,fill:numberCell(fill,'FillPattern',1)===0?'none':resolveColor(ctx,value(fill,'FillForegnd','#ffffff'),'#ffffff'),stroke:numberCell(line,'LinePattern',1)===0?'none':resolveColor(ctx,value(line,'LineColor','#000000'),'#000000'),strokeWidth:numberCell(line,'LineWeight',0.0104167)*96,opacity:Math.max(0,Math.min(1,1-numberCell(fill,'FillForegndTrans',0))),color:resolveColor(ctx,value(character,'Color','#000000'),'#000000'),fontFamily:ctx.fonts.get(value(character,'Font','0'))??'Arial, sans-serif',fontSize:numberCell(character,'Size',0.125)*96,bold:!!(fontStyle&1),italic:!!(fontStyle&2),align:({0:'left',1:'center',2:'right'} as const)[numberCell(paragraph,'HorzAlign',1) as 0|1|2]??'center',dash:numberCell(line,'LinePattern',1)>1?[6,4]:[],startArrow:numberCell(line,'BeginArrow')>0,endArrow:numberCell(line,'EndArrow')>0};
}
function readGeometry(ctx:ReadContext,node:XmlElement,width:number,height:number,part:string,shapeId:string):string{
  const segments:string[]=[];let previous:Point={x:0,y:0};const n=(v:number)=>+v.toFixed(6);
  for(const geometry of elements(node,'Section').filter(s=>s.attributes['N']==='Geometry'&&s.attributes['Del']!=='1')){
    if(numberCell(geometry,'NoShow')===1)continue;
    for(const row of elements(geometry,'Row').filter(r=>r.attributes['Del']!=='1')){
      const type=row.attributes['T']??'',relative=type.startsWith('Rel'),px=(name:string)=>numberCell(row,name)*(relative?width:96),py=(name:string)=>height-numberCell(row,name)*(relative?height:96),x=px('X'),y=py('Y');
      if(type==='MoveTo'||type==='RelMoveTo')segments.push(`M ${n(x)} ${n(y)}`);
      else if(type==='LineTo'||type==='RelLineTo')segments.push(`L ${n(x)} ${n(y)}`);
      else if(type==='RelCubBezTo')segments.push(`C ${n(px('A'))} ${n(py('B'))} ${n(px('C'))} ${n(py('D'))} ${n(x)} ${n(y)}`);
      else if(type==='RelQuadBezTo')segments.push(`Q ${n(px('A'))} ${n(py('B'))} ${n(x)} ${n(y)}`);
      else if(type==='ArcTo'){
        const sagitta=numberCell(row,'A')*96,chord=Math.hypot(x-previous.x,y-previous.y);if(Math.abs(sagitta)<1e-8||chord<1e-8)segments.push(`L ${n(x)} ${n(y)}`);else{const radius=Math.abs(chord*chord/(8*sagitta)+sagitta/2);segments.push(`A ${n(radius)} ${n(radius)} 0 ${Math.abs(sagitta)>chord/2?1:0} ${sagitta<0?1:0} ${n(x)} ${n(y)}`);}
      }else if(type==='Ellipse'){
        const cx=x,cy=y,ax=px('A')-cx,ay=py('B')-cy,bx=px('C')-cx,by=py('D')-cy,rx=Math.hypot(ax,ay),ry=Math.hypot(bx,by),angle=Math.atan2(ay,ax)*180/Math.PI;
        segments.push(`M ${n(cx+ax)} ${n(cy+ay)} A ${n(rx)} ${n(ry)} ${n(angle)} 0 1 ${n(cx-ax)} ${n(cy-ay)} A ${n(rx)} ${n(ry)} ${n(angle)} 0 1 ${n(cx+ax)} ${n(cy+ay)} Z`);
      }else{diagnostic(ctx,'GEOMETRY_UNSUPPORTED',`${type||'Unnamed'} geometry row is not evaluated; its source XML is retained.`,part,shapeId);if(Number.isFinite(x)&&Number.isFinite(y))segments.push(`L ${n(x)} ${n(y)}`);}
      previous={x,y};
    }
  }
  const path=segments.join(' ');return path&&!path.startsWith('M')?`M 0 ${n(height)} ${path}`:path;
}
function readShape(ctx:ReadContext,source:XmlElement,pageId:string,part:string,parentHeight:number,inheritedMaster?:MasterXml,instanceScope?:string):Shape{
  const visioId=source.attributes['ID']??String(ctx.shapeSources.size+1),shapeId=instanceScope?`${instanceScope}:master-s${visioId}`:`${pageId}:s${visioId}`;
  const master=ctx.masters.get(source.attributes['Master']??'')??inheritedMaster,masterShape=master?(source.attributes['MasterShape']?master.byId.get(source.attributes['MasterShape']):master.root):undefined;
  const node=effectiveShape(source,masterShape),width=Math.max(0,numberCell(node,'Width',1.6666667)*96),height=Math.max(0,numberCell(node,'Height',0.7291667)*96);
  const pinX=numberCell(node,'PinX',width/192)*96,pinY=numberCell(node,'PinY',height/192)*96,locPinX=numberCell(node,'LocPinX',width/192)*96,locPinY=numberCell(node,'LocPinY',height/192)*96,angle=numberCell(node,'Angle'),flipX=numberCell(node,'FlipX')?-1:1,flipY=numberCell(node,'FlipY')?-1:1,c=Math.cos(angle),s=Math.sin(angle);
  const centerX=pinX+c*flipX*(width/2-locPinX)-s*flipY*(height/2-locPinY),centerY=parentHeight-pinY-s*flipX*(width/2-locPinX)-c*flipY*(height/2-locPinY);
  const text=first(node,'Text'),hasChildren=!!first(source,'Shapes')||source.attributes['Type']==='Group';
  const shape=createShape(hasChildren?'group':'path',{id:shapeId,x:centerX-width/2,y:centerY-height/2,width,height,rotation:-angle,text:text?textContent(text):'',style:readStyle(ctx,node,part,shapeId),masterId:source.attributes['Master']?`master:${source.attributes['Master']}`:undefined});
  if(flipX<0||flipY<0)shape.transform=[flipX,0,0,flipY,flipX<0?width:0,flipY<0?height:0];
  shape.cells=Object.fromEntries([...cells(node)].map(([name,cell_])=>[name,{value:cell_.attributes['V']??'',formula:cell_.attributes['F'],unit:cell_.attributes['U']}]).filter(([name])=>!['__proto__','constructor','prototype'].includes(name as string)));
  shape.path=readGeometry(ctx,node,width,height,part,shapeId)||undefined;
  if(!shape.path&&!hasChildren){shape.kind=shape.text?'text':'rectangle';if(first(node,'ForeignData'))diagnostic(ctx,'FOREIGN_OBJECT_PLACEHOLDER','Embedded raster/OLE/foreign graphics are preserved, but currently displayed as a frame.',part,shapeId);}
  const properties=section(node,'Property');if(properties)for(const row of elements(properties,'Row')){let key=row.attributes['N']??value(row,'Label',`Property${row.attributes['IX']??''}`);if(['__proto__','constructor','prototype'].includes(key))key=`property_${key}`;const raw=value(row,'Value');const type=numberCell(row,'Type');shape.data[key]=type===2?numeric(raw,0):type===3?raw==='1'||raw.toLowerCase()==='true':raw.replace(/^"(.*)"$/s,'$1');}
  const layer=value(node,'LayerMember');if(layer)shape.layerId=`layer:${layer.split(';')[0]}`;shape.locked=numberCell(node,'LockMoveX')===1&&numberCell(node,'LockMoveY')===1;
  const connection=section(node,'Connection');if(connection)shape.ports=elements(connection,'Row').map((row,index)=>({id:row.attributes['N']??row.attributes['IX']??String(index),x:numberCell(row,'X')*96/Math.max(1,width),y:1-numberCell(row,'Y')*96/Math.max(1,height)}));
  const textMarkers=text?elements(text):[];if(textMarkers.length>1||textMarkers.some(mark=>localName(mark.name)==='fld'))diagnostic(ctx,'RICH_TEXT_APPROXIMATED','Mixed character/paragraph formatting is flattened for display; original formatting remains in the source package.',part,shapeId);
  if(numberCell(node,'TxtAngle')!==0)diagnostic(ctx,'TEXT_TRANSFORM_APPROXIMATED','Independent text-block rotation is not applied by this renderer.',part,shapeId);
  if(source.attributes['OneD']==='1'||cells(node).has('BeginX')&&cells(node).has('EndX')){
    shape.kind='connector';shape.routing='manual';
    if(shape.path){const segments=parsePath(shape.path);shape.points=segments.filter(segment=>segment.kind!=='close').map(segment=>segment.end);if(segments.some(segment=>segment.kind==='cubic'))diagnostic(ctx,'CURVED_CONNECTOR_APPROXIMATED','Curved connector controls are retained in XML but displayed as a polyline.',part,shapeId);}
    if(!shape.points?.length){shape.x=0;shape.y=0;shape.rotation=0;shape.transform=undefined;shape.points=[{x:numberCell(node,'BeginX')*96,y:parentHeight-numberCell(node,'BeginY')*96},{x:numberCell(node,'EndX',1)*96,y:parentHeight-numberCell(node,'EndY')*96}];}
  }
  if(!instanceScope)ctx.shapeSources.set(shapeId,{part,visioId,parentHeight,width,height,locPinX,locPinY,flipX,flipY,richText:!!textMarkers.length});
  const children=first(source,'Shapes')??(hasChildren&&masterShape?first(masterShape,'Shapes'):undefined);
  if(children)shape.children=elements(children,'Shape').map(child=>readShape(ctx,child,pageId,part,height,master,first(source,'Shapes')?undefined:shapeId));return shape;
}
function makeContext(document:XmlElement):ReadContext{
  return{document,diagnostics:[],styles:new Map(elements(first(document,'StyleSheets')??element('none'),'StyleSheet').map(s=>[s.attributes['ID']??'',s])),masters:new Map(),colors:new Map([['0','#000000'],['1','#ffffff'],['2','#ff0000'],['3','#00ff00'],['4','#0000ff'],['5','#ffff00'],['6','#ff00ff'],['7','#00ffff'],...elements(first(document,'Colors')??element('none'),'ColorEntry').map(c=>[c.attributes['IX']??'',c.attributes['RGB']??'#000000'] as [string,string])]),fonts:new Map(elements(first(document,'FaceNames')??element('none'),'FaceName').map(f=>[f.attributes['ID']??'',f.attributes['NameU']??f.attributes['Name']??'Arial'])),shapeSources:new Map(),pageSources:new Map()};
}
function readPage(ctx:ReadContext,metadata:XmlElement,contents:XmlElement,part:string,index:number):Page{
  const visioId=metadata.attributes['ID']??String(index),pageId=`visio-p${visioId}`,sheet=first(metadata,'PageSheet');
  const page=createPage(metadata.attributes['Name']??metadata.attributes['NameU']??`Page ${index+1}`,{id:pageId,width:numberCell(sheet,'PageWidth',11.7)*96,height:numberCell(sheet,'PageHeight',8.3)*96});
  const layers=section(sheet,'Layer');if(layers)page.layers=elements(layers,'Row').map((row,i)=>({id:`layer:${row.attributes['IX']??i}`,name:value(row,'Name',`Layer ${i+1}`),visible:numberCell(row,'Visible',1)!==0,locked:numberCell(row,'Lock')!==0,printable:numberCell(row,'Print',1)!==0}));
  page.shapes=elements(first(contents,'Shapes')??element('none'),'Shape').map(shape=>readShape(ctx,shape,pageId,part,page.height));
  const indexShapes=new Map<string,Shape>();const visit=(shapes:Shape[])=>{for(const shape of shapes){indexShapes.set(shape.id,shape);if(shape.children)visit(shape.children);}};visit(page.shapes);
  for(const connect of elements(first(contents,'Connects')??element('none'),'Connect')){const source=indexShapes.get(`${pageId}:s${connect.attributes['FromSheet']}`),target=`${pageId}:s${connect.attributes['ToSheet']}`;if(!source||!indexShapes.has(target))continue;const from=connect.attributes['FromCell']??'';const endpoint={shapeId:target};if(from==='BeginX'||from==='BeginY')source.source=endpoint;else if(from==='EndX'||from==='EndY')source.target=endpoint;}
  ctx.pageSources.set(pageId,{part,visioId});return page;
}
function relationId(node:XmlElement):string|undefined{const rel=first(node,'Rel');if(!rel)return;return Object.entries(rel.attributes).find(([name])=>localName(name)==='id')?.[1];}
/** Original package and normalized model travel together. Unsupported edits are rejected in preserve mode. */
export class VisioPackage{
  readonly document:DiagramDocument;readonly diagnostics:readonly Diagnostic[];
  private baseline:DiagramDocument;
  constructor(document:DiagramDocument,diagnostics:Diagnostic[],private readonly original:Uint8Array,private readonly entries:Map<string,Uint8Array>,private readonly context:ReadContext,private readonly pagesPart:string){this.document=document;this.baseline=clone(document);this.diagnostics=diagnostics;}
  get partNames():readonly string[]{return [...this.entries.keys()];}
  getPart(name:string):Uint8Array|undefined{return this.entries.get(name)?.slice();}
  /** Untouched files return the original bytes. Edited ZIPs preserve every untouched part's uncompressed bytes. */
  async save(document:DiagramDocument=this.document,options:{mode?:'preserve'|'rebuild'}={}):Promise<Uint8Array>{
    validateDocument(document);if(same(document,this.baseline))return this.original.slice();if(options.mode==='rebuild')return writeVsdx(document);
    if([...this.entries.keys()].some(name=>name.startsWith('_xmlsignatures/')))throw new DrawingError('SIGNED_PACKAGE_EDIT','Editing a signed package would invalidate its signature. Export a new drawing explicitly.');
    const unsupported=(message:string):never=>{throw new DrawingError('PRESERVATION_UNSUPPORTED',message+' Use explicit rebuild export only after reviewing the compatibility report.');};
    if(document.title!==this.baseline.title||!same(document.metadata,this.baseline.metadata)||!same(document.masters,this.baseline.masters)||document.pages.length!==this.baseline.pages.length)unsupported('Preserve mode does not rebuild document metadata, masters, or page topology.');
    const modified=new Map<string,XmlElement>(),get=(part:string)=>{let node=modified.get(part);if(!node){node=readPart(this.entries,part);modified.set(part,node);}return node;};
    const compareShapes=(before:Shape[],after:Shape[])=>{
      if(before.length!==after.length||before.some((shape,i)=>shape.id!==after[i]!.id))unsupported('Shape insertion, deletion, regrouping and z-order changes require a new-package export.');
      for(let i=0;i<before.length;i++){
        const old=before[i]!,next=after[i]!;if(same(old,next))continue;
        const permitted=new Set(['x','y','rotation','text','style','data','children']);for(const key of new Set([...Object.keys(old),...Object.keys(next)]))if(!permitted.has(key)&&!same((old as unknown as Record<string,unknown>)[key],(next as unknown as Record<string,unknown>)[key]))unsupported(`Changing ${key} on ${old.id} cannot be preserved safely.`);
        const source=this.context.shapeSources.get(old.id);if(!source)unsupported(`Shape ${old.id} has no source mapping.`);const page=get(source!.part),node=descendants(page,'Shape').find(s=>s.attributes['ID']===source!.visioId);if(!node)unsupported(`Source shape ${old.id} is unavailable.`);
        if(old.x!==next.x||old.y!==next.y||old.rotation!==next.rotation){
          if(old.kind==='connector')unsupported('Connector transform edits require reconstruction of endpoint constraints.');
          const angle=-next.rotation,c=Math.cos(angle),s=Math.sin(angle),dx=source!.flipX*(source!.width/2-source!.locPinX),dy=source!.flipY*(source!.height/2-source!.locPinY);
          setCell(node!,'PinX',(next.x+next.width/2-c*dx+s*dy)/96);setCell(node!,'PinY',(source!.parentHeight-next.y-next.height/2-s*dx-c*dy)/96);setCell(node!,'Angle',angle);
        }
        if(old.text!==next.text){let text=first(node!,'Text');if(!text){text=element(qualified(node!,'Text'));node!.children.push(text);}const markers=elements(text);const counts=new Map<string,Set<string>>();for(const marker of markers){const name=localName(marker.name);if(!['cp','pp','tp'].includes(name))unsupported(`Dynamic/rich text fields on ${old.id} cannot be flattened implicitly.`);let set=counts.get(name);if(!set)counts.set(name,set=new Set());set.add(marker.attributes['IX']??'0');}if([...counts.values()].some(set=>set.size>1))unsupported(`Mixed formatting on ${old.id} requires an explicit rich-text reconstruction.`);const unique=markers.filter((marker,index)=>markers.findIndex(m=>m.name===marker.name&&same(m.attributes,marker.attributes))===index);text.children=[...unique,next.text];}
        if(!same(old.style,next.style)){const allowed=new Set(['fill','stroke','strokeWidth','opacity','color','fontSize','bold','italic','align','dash','startArrow','endArrow']);for(const key of Object.keys(next.style))if(!allowed.has(key)&&!same((old.style as unknown as Record<string,unknown>)[key],(next.style as unknown as Record<string,unknown>)[key]))unsupported(`Changing style.${key} requires explicit reconstruction.`);applyStyle(node!,next.style,old.style);}
        if(!same(old.data,next.data)){let properties=section(node!,'Property');if(!properties){properties=element(qualified(node!,'Section'),{N:'Property'});node!.children.push(properties);}for(const[key,v]of Object.entries(next.data)){if(same(old.data[key],v))continue;let row=elements(properties,'Row').find(r=>r.attributes['N']===key);if(!row){row=element(qualified(properties,'Row'),{N:key,IX:elements(properties,'Row').length});properties.children.push(row);}setCell(row,'Value',typeof v==='object'?JSON.stringify(v):String(v));setCell(row,'Type',typeof v==='number'?2:typeof v==='boolean'?3:0);}for(const key of Object.keys(old.data))if(!(key in next.data))unsupported('Deleting shape-data definitions is not a preserve-mode operation.');}
        if(old.children||next.children)compareShapes(old.children??[],next.children??[]);
      }
    };
    for(let i=0;i<document.pages.length;i++){
      const old=this.baseline.pages[i]!,page=document.pages[i]!;if(old.id!==page.id||old.width!==page.width||old.height!==page.height||old.background!==page.background||!same(old.layers,page.layers))unsupported('Page identity, size, background and layer changes require reconstruction.');
      if(old.name!==page.name){const source=this.context.pageSources.get(old.id),root=get(this.pagesPart),meta=elements(root,'Page').find(p=>p.attributes['ID']===source?.visioId);if(!meta)unsupported('Page metadata is unavailable.');meta!.attributes['Name']=page.name;meta!.attributes['NameU']=page.name;}
      compareShapes(old.shapes,page.shapes);
    }
    const result=new Map(this.entries);for(const[part,node]of modified)result.set(part,enc.encode(serializeXml(node)));return writeZip(result);
  }
}
export async function readVsdx(bytes:Uint8Array,options:VisioReadOptions={}):Promise<VisioPackage>{
  const entries=await readZip(bytes,options);if(!entries.has('[Content_Types].xml'))throw new DrawingError('OPC_CONTENT_TYPES','The archive is not an OPC document.');
  const contentTypes=readPart(entries,'[Content_Types].xml');if(localName(contentTypes.name)!=='Types')throw new DrawingError('OPC_CONTENT_TYPES','Invalid content-type document.');
  const macros=[...entries.keys()].some(name=>/vbaProject\.bin$/i.test(name));if(macros&&!options.allowMacroPreservation)throw new DrawingError('VISIO_MACROS','Macro-enabled drawings require explicit allowMacroPreservation; macros are never executed.');
  const rootRels=relationships(entries,''),docRel=rootRels.find(rel=>rel.type===VREL+'document'&&!rel.external);if(!docRel)throw new DrawingError('VISIO_DOCUMENT_REL','No internal Visio document relationship was found.');
  const documentRoot=readPart(entries,docRel.target),ctx=makeContext(documentRoot);if(localName(documentRoot.name)!=='VisioDocument')throw new DrawingError('VISIO_ROOT','Expected a VisioDocument part.');
  const docRels=relationships(entries,docRel.target);for(const rel of [...rootRels,...docRels])if(rel.external)diagnostic(ctx,'EXTERNAL_RELATIONSHIP','An external relationship was retained without being fetched.',docRel.target);
  const mastersRel=docRels.find(rel=>rel.type===VREL+'masters'&&!rel.external);
  if(mastersRel){const masters=readPart(entries,mastersRel.target),rels=relationships(entries,mastersRel.target);for(const metadata of elements(masters,'Master')){const relation=rels.find(r=>r.id===relationId(metadata)&&!r.external);if(!relation)continue;const contents=readPart(entries,relation.target),root=elements(first(contents,'Shapes')??element('none'),'Shape')[0];if(root){const byId=new Map([root,...descendants(root,'Shape')].map(s=>[s.attributes['ID']??'',s]));ctx.masters.set(metadata.attributes['ID']??'',{metadata,root,byId});}}}
  const pagesRel=docRels.find(rel=>rel.type===VREL+'pages'&&!rel.external);if(!pagesRel)throw new DrawingError('VISIO_PAGES','This drawing profile requires a pages part. Stencil-only packages need explicit instantiation into a drawing.');
  const pages=readPart(entries,pagesRel.target),pageRels=relationships(entries,pagesRel.target),document=createDocument('Imported Visio drawing');document.id='visio-document';document.pages=[];
  for(const[pageIndex,metadata]of elements(pages,'Page').entries()){const rel=pageRels.find(r=>r.id===relationId(metadata)&&!r.external);if(!rel)throw new DrawingError('VISIO_PAGE_REL','A page relationship is missing.');document.pages.push(readPage(ctx,metadata,readPart(entries,rel.target),rel.target,pageIndex));}
  const coreRel=rootRels.find(r=>r.type.endsWith('/metadata/core-properties')&&!r.external);if(coreRel){const core=readPart(entries,coreRel.target),title=first(core,'title');if(title)document.title=textContent(title)||document.title;}
  const dataParts=[...entries.keys()].filter(name=>/data(recordsets?|connections?)?/i.test(name)&&/\.xml$/i.test(name));if(dataParts.length){document.metadata['visioDataParts']=dataParts;diagnostic(ctx,'EXTERNAL_DATA_PRESERVED','Visio recordsets/connections are retained in the package. Database refresh uses DrawingWeb DataSource adapters, not native Visio drivers.');}
  if(macros)diagnostic(ctx,'MACROS_PRESERVED','VBA bytes are retained and are never executed. Keep the macro-enabled file extension when saving.');
  for(const[id_,master]of ctx.masters){const sourceCount=ctx.shapeSources.size;const shape=readShape(ctx,master.root,`master-${id_}`,`masters/${id_}`,numberCell(master.root,'Height',1)*96,master);document.masters.push({id:`master:${id_}`,name:master.metadata.attributes['Name']??master.metadata.attributes['NameU']??`Master ${id_}`,category:'Imported Visio',shape});if(ctx.shapeSources.size>sourceCount)for(const key of [...ctx.shapeSources.keys()])if(key.startsWith(`master-${id_}:`))ctx.shapeSources.delete(key);}
  validateDocument(document);return new VisioPackage(document,ctx.diagnostics,bytes.slice(),entries,ctx,pagesRel.target);
}
function applyStyle(node:XmlElement,style:ShapeStyle,before?:ShapeStyle):void{
  const changed=(key:keyof ShapeStyle)=>!before||!same(style[key],before[key]);
  if(changed('fill')){if(!before||before.fill==='none'||style.fill==='none')setCell(node,'FillPattern',style.fill==='none'?0:1);setCell(node,'FillForegnd',visioColor(style.fill,'#ffffff'));}
  if(changed('opacity')){setCell(node,'FillForegndTrans',1-style.opacity);setCell(node,'LineColorTrans',1-style.opacity);}
  if(changed('stroke'))setCell(node,'LineColor',visioColor(style.stroke,'#000000'));
  if(changed('dash')||!before||before.stroke==='none'&&style.stroke!=='none'||style.stroke==='none')setCell(node,'LinePattern',style.stroke==='none'?0:style.dash.length?2:1);
  if(changed('strokeWidth'))setCell(node,'LineWeight',style.strokeWidth/96);
  if(changed('startArrow'))setCell(node,'BeginArrow',style.startArrow?4:0);if(changed('endArrow'))setCell(node,'EndArrow',style.endArrow?4:0);
  if(['color','fontSize','bold','italic'].some(key=>changed(key as keyof ShapeStyle))){
    let character=section(node,'Character');if(!character){character=element(qualified(node,'Section'),{N:'Character'});node.children.push(character);}let row=elements(character,'Row')[0];if(!row){row=element(qualified(character,'Row'),{IX:0});character.children.push(row);}
    if(changed('color'))setCell(row,'Color',visioColor(style.color,'#000000'));if(changed('fontSize'))setCell(row,'Size',style.fontSize/96);
    if(changed('bold')||changed('italic')){const oldFlags=numberCell(row,'Style');setCell(row,'Style',(oldFlags&~3)|(style.bold?1:0)|(style.italic?2:0));}
    if(!before)setCell(row,'Font',0);
  }
  if(changed('align')){let paragraph=section(node,'Paragraph');if(!paragraph){paragraph=element(qualified(node,'Section'),{N:'Paragraph'});node.children.push(paragraph);}let para=elements(paragraph,'Row')[0];if(!para){para=element(qualified(paragraph,'Row'),{IX:0});paragraph.children.push(para);}setCell(para,'HorzAlign',style.align==='left'?0:style.align==='right'?2:1);}
  if(!before)setCell(node,'VerticalAlign',1);
}
function visioColor(color:string,fallback:string):string{
  const value=color.trim().toLowerCase();if(/^#[\da-f]{6}$/.test(value))return value;
  if(/^#[\da-f]{3}$/.test(value))return '#'+[...value.slice(1)].map(c=>c+c).join('');
  const named:Record<string,string>={black:'#000000',white:'#ffffff',red:'#ff0000',green:'#008000',blue:'#0000ff',yellow:'#ffff00',gray:'#808080',grey:'#808080',purple:'#800080',orange:'#ffa500',pink:'#ffc0cb',navy:'#000080',teal:'#008080',lime:'#00ff00',silver:'#c0c0c0',maroon:'#800000',aqua:'#00ffff',fuchsia:'#ff00ff',olive:'#808000',rebeccapurple:'#663399'};
  if(named[value])return named[value]!;
  const rgb=value.match(/^rgba?\(\s*([\d.]+)(%)?[, ]+([\d.]+)(%)?[, ]+([\d.]+)(%)?(?:[, /]+[\d.%]+)?\s*\)$/);
  if(rgb)return '#'+[1,3,5].map(i=>Math.round(Math.min(255,Math.max(0,Number(rgb[i])*(rgb[i+1]?2.55:1)))).toString(16).padStart(2,'0')).join('');
  return fallback;
}
function safeColor(color:string,fallback:string):string{return /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(color)&&!color.toLowerCase().includes('url')?color:fallback;}
interface ExportPage{metadata:XmlElement;contents:XmlElement;part:string}
function exportDiagnostic(options:VisioExportOptions,code:string,message:string):void{const report:Diagnostic={code,severity:'warning',message};if(options.strict)throw new DrawingError(code,message);options.onDiagnostic?.(report);}
function decompose(matrix:Matrix):{sx:number;sy:number;rotation:number;shear:number}{const sx=Math.hypot(matrix[0],matrix[1]);return{sx,sy:sx?(matrix[0]*matrix[3]-matrix[1]*matrix[2])/sx:0,rotation:Math.atan2(matrix[1],matrix[0]),shear:sx?(matrix[0]*matrix[2]+matrix[1]*matrix[3])/sx:0};}
function geometrySection(segments:PathSegment[],width:number,height:number):XmlElement{
  const rows:XmlElement[]=[];let index=1;const pointCells=(point:Point)=>[cell('X',point.x/96),cell('Y',(height-point.y)/96)];
  for(const segment of segments){if(segment.kind==='cubic')rows.push(element('Row',{T:'RelCubBezTo',IX:index++},[cell('X',segment.end.x/Math.max(width,1)),cell('Y',1-segment.end.y/Math.max(height,1)),cell('A',segment.a.x/Math.max(width,1)),cell('B',1-segment.a.y/Math.max(height,1)),cell('C',segment.b.x/Math.max(width,1)),cell('D',1-segment.b.y/Math.max(height,1))]));else rows.push(element('Row',{T:segment.kind==='move'?'MoveTo':'LineTo',IX:index++},pointCells(segment.end)));}
  return element('Section',{N:'Geometry',IX:0},[cell('NoFill',0),cell('NoLine',0),...rows]);
}
function buildExportPages(document:DiagramDocument,options:VisioExportOptions):ExportPage[]{
  const engine=new DiagramEngine(document,{historyLimit:0});try{return document.pages.map((page,pageIndex)=>{
    const numericIds=new Map<string,number>();let nextId=1;const reserve=(shapes:Shape[])=>shapes.forEach(s=>{numericIds.set(s.id,nextId++);if(s.children)reserve(s.children);});reserve(page.shapes);
    const connections:XmlElement[]=[];
    const emit=(shape:Shape,parentHeight:number,pre:Matrix=IDENTITY):XmlElement=>{
      let matrix=multiply(pre,localMatrix(shape)),d=decompose(matrix),width=shape.width*Math.abs(d.sx),height=shape.height*Math.abs(d.sy),center=transformPoint(matrix,{x:shape.width/2,y:shape.height/2});let rotation=d.rotation,flipY=d.sy<0;
      let geometry=shape.kind==='group'?[]:parsePath(shapePath(shape));let geometryMatrix:Matrix=[Math.abs(d.sx),0,0,Math.abs(d.sy),0,0];let childPre:Matrix=geometryMatrix;
      if(Math.abs(d.shear)>1e-7){const rect=transformedBounds(shape,matrix);width=Math.max(1,rect.width);height=Math.max(1,rect.height);center={x:rect.x+width/2,y:rect.y+height/2};rotation=0;flipY=false;geometryMatrix=multiply(translation(-rect.x,-rect.y),matrix);childPre=geometryMatrix;if(shape.text)exportDiagnostic(options,'SHEARED_TEXT_APPROXIMATED','Sheared text is exported into its axis-aligned frame.');}
      const node=element('Shape',{ID:numericIds.get(shape.id)!,NameU:`DrawingWeb.${numericIds.get(shape.id)}`,Name:shape.text||shape.id,Type:shape.children?'Group':'Shape',LineStyle:0,FillStyle:0,TextStyle:0},[
        cell('PinX',center.x/96),cell('PinY',(parentHeight-center.y)/96),cell('Width',Math.max(width,0.01)/96),cell('Height',Math.max(height,0.01)/96),cell('LocPinX',width/192),cell('LocPinY',height/192),cell('Angle',-rotation),cell('FlipX',0),cell('FlipY',flipY?1:0),cell('ObjType',shape.kind==='connector'?2:1),
      ]);
      applyStyle(node,shape.style);
      if(shape.kind==='connector'){
        const route=connectorRoute(engine,shape);if(route.obstructed)exportDiagnostic(options,'ROUTE_BUDGET','A connector exceeded the obstacle-routing budget; its fallback route is exported.');
        const ref=engine.getRef(shape.id)!,parentInverse=inverseForExport(ref.parentMatrix);const points=route.points.map(p=>transformPoint(pre,transformPoint(parentInverse,p))),rect=bounds(points);width=Math.max(rect.width,0.01);height=Math.max(rect.height,0.01);
        setCell(node,'PinX',(rect.x+width/2)/96);setCell(node,'PinY',(parentHeight-rect.y-height/2)/96);setCell(node,'Width',width/96);setCell(node,'Height',height/96);setCell(node,'LocPinX',width/192);setCell(node,'LocPinY',height/192);setCell(node,'Angle',0);setCell(node,'FlipY',0);node.attributes['OneD']='1';
        const a=points[0]??{x:rect.x,y:rect.y},b=points.at(-1)??a;setCell(node,'BeginX',a.x/96);setCell(node,'BeginY',(parentHeight-a.y)/96);setCell(node,'EndX',b.x/96);setCell(node,'EndY',(parentHeight-b.y)/96);setCell(node,'FillPattern',0);
        geometry=points.map((p,index)=>({kind:index?'line':'move',end:{x:p.x-rect.x,y:p.y-rect.y}}));node.children.push(geometrySection(geometry,width,height));
        for(const[from,endpoint]of [['BeginX',shape.source],['EndX',shape.target]] as const){if(endpoint?.shapeId&&numericIds.has(endpoint.shapeId))connections.push(element('Connect',{FromSheet:numericIds.get(shape.id)!,FromCell:from,FromPart:from==='BeginX'?9:12,ToSheet:numericIds.get(endpoint.shapeId)!,ToCell:'PinX',ToPart:3}));}
      }else if(shape.kind==='ellipse'&&!shape.path&&Math.abs(d.shear)<=1e-7){node.children.push(element('Section',{N:'Geometry',IX:0},[cell('NoFill',0),cell('NoLine',0),element('Row',{T:'Ellipse',IX:1},[cell('X',width/192),cell('Y',height/192),cell('A',width/96),cell('B',height/192),cell('C',width/192),cell('D',height/96)])]));}
      else if(geometry.length)node.children.push(geometrySection(transformSegments(geometry,geometryMatrix),width,height));
      if(shape.text)node.children.push(element('Text',{},[shape.text]));
      if(shape.layerId){const index=page.layers.findIndex(layer=>layer.id===shape.layerId);if(index>=0)setCell(node,'LayerMember',String(index));}
      if(shape.locked){setCell(node,'LockMoveX',1);setCell(node,'LockMoveY',1);}
      if(shape.visible===false)exportDiagnostic(options,'SHAPE_VISIBILITY','Per-shape visibility is not a standard Visio display flag; use an invisible layer for interchange.');
      if(Object.keys(shape.data).length)node.children.push(element('Section',{N:'Property'},Object.entries(shape.data).map(([key,value_],index)=>element('Row',{N:key,IX:index},[cell('Label',key),cell('Type',typeof value_==='number'?2:typeof value_==='boolean'?3:0),cell('Value',typeof value_==='object'?JSON.stringify(value_):String(value_))]))));
      if(shape.ports.length)node.children.push(element('Section',{N:'Connection'},shape.ports.map((port,index)=>element('Row',{N:port.id,IX:index},[cell('X',port.x*width/96),cell('Y',(1-port.y)*height/96),cell('DirX',0),cell('DirY',0),cell('Type',0)]))));
      if(shape.children)node.children.push(element('Shapes',{},shape.children.map(child=>emit(child,height,childPre))));return node;
    };
    const sheet=element('PageSheet',{LineStyle:0,FillStyle:0,TextStyle:0},[cell('PageWidth',page.width/96),cell('PageHeight',page.height/96),cell('PageScale',1),cell('DrawingScale',1),element('Section',{N:'Layer'},page.layers.map((layer,index)=>element('Row',{IX:index},[cell('Name',layer.name),cell('Visible',layer.visible?1:0),cell('Lock',layer.locked?1:0),cell('Print',layer.printable?1:0)])))]);
    const contents=element('PageContents',{xmlns:VISIO,'xmlns:r':RID},[element('Shapes',{},page.shapes.map(shape=>emit(shape,page.height))),element('Connects',{},connections)]);
    return{metadata:element('Page',{ID:pageIndex,Name:page.name,NameU:page.name,ViewScale:1,ViewCenterX:page.width/192,ViewCenterY:page.height/192},[sheet,element('Rel',{'r:id':`rId${pageIndex+1}`})]),contents,part:`visio/pages/page${pageIndex+1}.xml`};
  });}finally{engine.dispose();}
}
function inverseForExport(m:Matrix):Matrix{const determinant=m[0]*m[3]-m[1]*m[2];if(Math.abs(determinant)<1e-12)throw new DrawingError('SINGULAR_TRANSFORM','Cannot export a connector in a singular coordinate system.');return[m[3]/determinant,-m[1]/determinant,-m[2]/determinant,m[0]/determinant,(m[2]*m[5]-m[3]*m[4])/determinant,(m[1]*m[4]-m[0]*m[5])/determinant];}
function defaultDocumentRoot():XmlElement{return element('VisioDocument',{xmlns:VISIO,'xmlns:r':RID},[element('DocumentSettings',{TopPage:0,DefaultTextStyle:0,DefaultLineStyle:0,DefaultFillStyle:0,DefaultGuideStyle:0}),element('Colors',{},[element('ColorEntry',{IX:0,RGB:'#000000'}),element('ColorEntry',{IX:1,RGB:'#ffffff'})]),element('FaceNames',{},[element('FaceName',{ID:0,NameU:'Arial',UnicodeRanges:'-1 -1 -1 -1',CharSets:'0 0',Panose:'2 11 6 4 2 2 2 2 2 4',Flags:325})]),element('StyleSheets',{},[element('StyleSheet',{ID:0,NameU:'No Style',Name:'No Style'},[cell('LineWeight',0.01),cell('LineColor','#000000'),cell('LinePattern',1),cell('FillForegnd','#ffffff'),cell('FillPattern',1)])]),element('DocumentSheet',{NameU:'TheDoc',Name:'TheDoc',LineStyle:0,FillStyle:0,TextStyle:0})]);}
function rels(items:{id:string;type:string;target:string}[]):XmlElement{return element('Relationships',{xmlns:REL},items.map(r=>element('Relationship',{Id:r.id,Type:r.type,Target:r.target})));}
/** Produces a fresh OPC/VSDX drawing. Unsupported imported features must not use this path implicitly. */
export async function writeVsdx(document:DiagramDocument,options:VisioExportOptions={}):Promise<Uint8Array>{
  validateDocument(document);const pages=buildExportPages(document,options),entries=new Map<string,Uint8Array>();const put=(path:string,node:XmlElement)=>entries.set(path,enc.encode(serializeXml(node)));
  put('[Content_Types].xml',element('Types',{xmlns:CT},[element('Default',{Extension:'rels',ContentType:'application/vnd.openxmlformats-package.relationships+xml'}),element('Default',{Extension:'xml',ContentType:'application/xml'}),element('Override',{PartName:'/visio/document.xml',ContentType:'application/vnd.ms-visio.drawing.main+xml'}),element('Override',{PartName:'/visio/pages/pages.xml',ContentType:'application/vnd.ms-visio.pages+xml'}),...pages.map(page=>element('Override',{PartName:'/'+page.part,ContentType:'application/vnd.ms-visio.page+xml'})),element('Override',{PartName:'/docProps/core.xml',ContentType:'application/vnd.openxmlformats-package.core-properties+xml'}),element('Override',{PartName:'/docProps/app.xml',ContentType:'application/vnd.openxmlformats-officedocument.extended-properties+xml'})]));
  put('_rels/.rels',rels([{id:'rId1',type:VREL+'document',target:'visio/document.xml'},{id:'rId2',type:'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',target:'docProps/core.xml'},{id:'rId3',type:RID+'/extended-properties',target:'docProps/app.xml'}]));
  put('visio/document.xml',defaultDocumentRoot());put('visio/_rels/document.xml.rels',rels([{id:'rId1',type:VREL+'pages',target:'pages/pages.xml'}]));
  put('visio/pages/pages.xml',element('Pages',{xmlns:VISIO,'xmlns:r':RID},pages.map(page=>page.metadata)));put('visio/pages/_rels/pages.xml.rels',rels(pages.map((page,index)=>({id:`rId${index+1}`,type:VREL+'page',target:page.part.split('/').at(-1)!}))));for(const page of pages)put(page.part,page.contents);
  put('docProps/core.xml',element('cp:coreProperties',{'xmlns:cp':'http://schemas.openxmlformats.org/package/2006/metadata/core-properties','xmlns:dc':'http://purl.org/dc/elements/1.1/'},[element('dc:title',{},[document.title]),element('dc:creator',{},['DrawingWeb'])]));put('docProps/app.xml',element('Properties',{xmlns:'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'},[element('Application',{},['DrawingWeb']),element('AppVersion',{},['0.1'])]));
  if(document.masters.length)exportDiagnostic(options,'MASTER_INSTANCES_EXPANDED','Placed master instances are exported as editable shapes; unplaced library definitions are not emitted in this profile.');
  return writeZip(entries);
}
function vdxToModern(node:XmlElement):XmlElement{
  const result=element(localName(node.name),{...node.attributes},[]);const singletonGroups=new Set(['XForm','XForm1D','Line','Fill','TextBlock','Misc','Protection','Layout','PageProps']);
  for(const child of node.children){if(!isElement(child)){result.children.push(child);continue;}const name=localName(child.name);
    if(singletonGroups.has(name)){if(name==='PageProps'){const sheet=element('PageSheet');for(const c of elements(child))sheet.children.push(cell(localName(c.name),textContent(c),c.attributes['F']));result.children.push(sheet);}else for(const c of elements(child))result.children.push(cell(localName(c.name),textContent(c),c.attributes['F']));}
    else if(name==='Geom'){const geometry=element('Section',{N:'Geometry',IX:child.attributes['IX']??0});for(const r of elements(child)){const members=elements(r);if(!members.length)geometry.children.push(cell(localName(r.name),textContent(r),r.attributes['F']));else geometry.children.push(element('Row',{T:localName(r.name),IX:r.attributes['IX']??geometry.children.length},members.map(c=>cell(localName(c.name),textContent(c),c.attributes['F']))));}result.children.push(geometry);}
    else if(['Char','Para','Prop','Connection','Layer'].includes(name)){const names:Record<string,string>={Char:'Character',Para:'Paragraph',Prop:'Property',Connection:'Connection',Layer:'Layer'},sectionName=names[name]!;let target=section(result,sectionName);if(!target){target=element('Section',{N:sectionName});result.children.push(target);}target.children.push(element('Row',{IX:child.attributes['IX']??target.children.length,...(child.attributes['NameU']?{N:child.attributes['NameU']}:{})},elements(child).map(c=>cell(localName(c.name),textContent(c),c.attributes['F']))));}
    else result.children.push(vdxToModern(child));
  }return result;
}
export function readVdx(text:string):DrawingReadResult{
  const root=parseXml(text);if(localName(root.name)!=='VisioDocument')throw new DrawingError('VDX_ROOT','Expected a VisioDocument XML root.');const modern=vdxToModern(root),ctx=makeContext(modern),document=createDocument('Imported VDX drawing');document.id='vdx-document';
  for(const metadata of elements(first(modern,'Masters')??element('none'),'Master')){const shape=elements(first(metadata,'Shapes')??element('none'),'Shape')[0];if(shape)ctx.masters.set(metadata.attributes['ID']??'',{metadata,root:shape,byId:new Map([shape,...descendants(shape,'Shape')].map(s=>[s.attributes['ID']??'',s]))});}
  document.pages=elements(first(modern,'Pages')??element('none'),'Page').map((page,index)=>readPage(ctx,page,page,'document.vdx',index));validateDocument(document);return{document,diagnostics:ctx.diagnostics};
}
function modernToVdxShape(node:XmlElement):XmlElement{
  const result=element(localName(node.name),{...node.attributes},[]);const groups:Record<string,string[]>={XForm:['PinX','PinY','Width','Height','LocPinX','LocPinY','Angle','FlipX','FlipY'],XForm1D:['BeginX','BeginY','EndX','EndY'],Line:['LineWeight','LineColor','LinePattern','BeginArrow','EndArrow','LineColorTrans'],Fill:['FillForegnd','FillPattern','FillForegndTrans'],TextBlock:['VerticalAlign'],Misc:['ObjType'],Protection:['LockMoveX','LockMoveY']};
  const plainCell=(c:XmlElement)=>element(c.attributes['N']??'Value',c.attributes['F']?{F:c.attributes['F']}:{},[c.attributes['V']??'']);
  for(const[group,names]of Object.entries(groups)){const members=elements(node,'Cell').filter(c=>names.includes(c.attributes['N']??''));if(members.length)result.children.push(element(group,{},members.map(plainCell)));}
  for(const child of elements(node)){
    const name=localName(child.name);if(name==='Shapes'){result.children.push(element('Shapes',{},elements(child,'Shape').map(modernToVdxShape)));continue;}if(name==='Text'){result.children.push(clone(child));continue;}if(name!=='Section')continue;
    const sectionName=child.attributes['N'];if(sectionName==='Geometry'){
      const geometry=element('Geom',{IX:child.attributes['IX']??0});for(const c of elements(child,'Cell'))geometry.children.push(plainCell(c));let ix=1;let previous:Point={x:0,y:0};const width=numberCell(node,'Width')*96,height=numberCell(node,'Height')*96;
      for(const row of elements(child,'Row')){if(row.attributes['T']==='RelCubBezTo'){
        const a={x:numberCell(row,'A')*width,y:numberCell(row,'B')*height},b={x:numberCell(row,'C')*width,y:numberCell(row,'D')*height},end={x:numberCell(row,'X')*width,y:numberCell(row,'Y')*height};
        for(let step=1;step<=24;step++){const t=step/24,u=1-t,p={x:u*u*u*previous.x+3*u*u*t*a.x+3*u*t*t*b.x+t*t*t*end.x,y:u*u*u*previous.y+3*u*u*t*a.y+3*u*t*t*b.y+t*t*t*end.y};geometry.children.push(element('LineTo',{IX:ix++},[element('X',{},[String(p.x/96)]),element('Y',{},[String(p.y/96)])]));}previous=end;
      }else{geometry.children.push(element(row.attributes['T']??'LineTo',{IX:ix++},elements(row,'Cell').map(plainCell)));previous={x:numberCell(row,'X')*96,y:numberCell(row,'Y')*96};}}
      result.children.push(geometry);
    }else{const map:Record<string,string>={Character:'Char',Paragraph:'Para',Property:'Prop',Connection:'Connection',Layer:'Layer'},tag=map[sectionName??''];if(tag)for(const row of elements(child,'Row'))result.children.push(element(tag,{IX:row.attributes['IX']??0,...(row.attributes['N']?{NameU:row.attributes['N']}:{})},elements(row,'Cell').map(plainCell)));}
  }return result;
}
export function writeVdx(document:DiagramDocument,options:VisioExportOptions={}):string{
  validateDocument(document);const pages=buildExportPages(document,options);if(pages.some(page=>descendants(page.contents,'Row').some(row=>row.attributes['T']==='RelCubBezTo')))exportDiagnostic(options,'VDX_CURVES_FLATTENED','VDX export uses 24-segment cubic flattening; use VSDX to retain cubic curve controls.');
  const root=element('VisioDocument',{xmlns:VDX,'xmlns:xlink':'http://www.w3.org/1999/xlink'},[element('DocumentProperties',{},[element('Title',{},[document.title]),element('Creator',{},['DrawingWeb'])]),element('DocumentSettings',{TopPage:0,DefaultTextStyle:0,DefaultLineStyle:0,DefaultFillStyle:0}),element('StyleSheets',{},[element('StyleSheet',{ID:0,NameU:'No Style',Name:'No Style'})]),element('Pages',{},pages.map(page=>{
    const sheet=first(page.metadata,'PageSheet')!,props=element('PageProps',{},elements(sheet,'Cell').map(c=>element(c.attributes['N']!,{},[c.attributes['V']??''])));
    return element('Page',{ID:page.metadata.attributes['ID']!,Name:page.metadata.attributes['Name']!,NameU:page.metadata.attributes['NameU']!},[props,element('Shapes',{},elements(first(page.contents,'Shapes')!,'Shape').map(modernToVdxShape)),clone(first(page.contents,'Connects')!)]);
  }))]);return serializeXml(root);
}
export function exportSvg(document:DiagramDocument,pageId=document.pages[0]!.id):string{
  const engine=new DiagramEngine(document,{historyLimit:0}),page=engine.getPage(pageId);const output:string[]=[];const n=(v:number)=>+v.toFixed(5);
  const arrow=(a:Point,b:Point,color:string,width:number)=>{const angle=Math.atan2(b.y-a.y,b.x-a.x),size=8+width*1.5,c=Math.cos(angle),s=Math.sin(angle);return `<path d="M ${n(b.x)} ${n(b.y)} L ${n(b.x-size*c+size*.45*s)} ${n(b.y-size*s-size*.45*c)} L ${n(b.x-size*c-size*.45*s)} ${n(b.y-size*s+size*.45*c)} Z" fill="${escapeXml(color)}"/>`;};
  const visit=(shapes:Shape[],visible=true,parentOpacity=1)=>{for(const shape of shapes){const layer=page.layers.find(l=>l.id===shape.layerId),shown=visible&&shape.visible!==false&&layer?.visible!==false&&layer?.printable!==false;if(!shown)continue;const opacity=parentOpacity*shape.style.opacity;const ref=engine.getRef(shape.id)!;if(shape.kind==='connector'){
    const points=connectorRoute(engine,shape).points,color=safeColor(shape.style.stroke,'#000000');output.push(`<g opacity="${opacity}"><polyline points="${points.map(p=>`${n(p.x)},${n(p.y)}`).join(' ')}" fill="none" stroke="${escapeXml(color)}" stroke-width="${shape.style.strokeWidth}"${shape.style.dash.length?` stroke-dasharray="${shape.style.dash.join(' ')}"`:''}/>`);if(points.length>1){if(shape.style.endArrow)output.push(arrow(points.at(-2)!,points.at(-1)!,color,shape.style.strokeWidth));if(shape.style.startArrow)output.push(arrow(points[1]!,points[0]!,color,shape.style.strokeWidth));}
    if(shape.text&&points.length>1){const i=Math.floor((points.length-1)/2),a=points[i]!,b=points[i+1]!,x=(a.x+b.x)/2,y=(a.y+b.y)/2,style=shape.style;output.push(`<text x="${n(x)}" y="${n(y)}" text-anchor="middle" dominant-baseline="middle" fill="${escapeXml(safeColor(style.color,'#000000'))}" font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.bold?'700':'400'}" font-style="${style.italic?'italic':'normal'}" paint-order="stroke" stroke="#ffffff" stroke-width="5" stroke-linejoin="round">${escapeXml(shape.text)}</text>`);}
    output.push('</g>');
  }else{
    const style=shape.style;output.push(`<g transform="matrix(${ref.matrix.map(n).join(' ')})" opacity="${opacity}">`);const path=shapePath(shape);if(path)output.push(`<path d="${escapeXml(path)}" fill="${escapeXml(safeColor(style.fill,'none'))}" stroke="${escapeXml(safeColor(style.stroke,'#000000'))}" stroke-width="${style.strokeWidth}"${style.dash.length?` stroke-dasharray="${style.dash.join(' ')}"`:''}/>`);
    if(shape.text){const lines=shape.text.split('\n'),x=style.align==='left'?10:style.align==='right'?shape.width-10:shape.width/2,y=shape.height/2-(lines.length-1)*style.fontSize*.65;output.push(`<text fill="${escapeXml(safeColor(style.color,'#000000'))}" font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.bold?'700':'400'}" font-style="${style.italic?'italic':'normal'}" text-anchor="${style.align==='left'?'start':style.align==='right'?'end':'middle'}" dominant-baseline="middle">${lines.map((line,i)=>`<tspan x="${n(x)}" y="${n(y+i*style.fontSize*1.3)}">${escapeXml(line)}</tspan>`).join('')}</text>`);}output.push('</g>');
  }if(shape.children)visit(shape.children,shown,opacity);}};
  try{visit(page.shapes);return`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${escapeXml(page.name)}"><title>${escapeXml(document.title+' — '+page.name)}</title><rect width="100%" height="100%" fill="${escapeXml(safeColor(page.background,'#ffffff'))}"/>${output.join('')}</svg>`;}finally{engine.dispose();}
}
export async function readDrawing(input:Uint8Array|string,name=''):Promise<DrawingReadResult>{
  if(typeof input==='string'){if(input.trimStart().startsWith('<'))return readVdx(input);return{document:parseDocument(input),diagnostics:[]};}
  if(input[0]===0xd0&&input[1]===0xcf)throw new DrawingError('LEGACY_VSD_UNSUPPORTED','Binary VSD is not an XML/OPC drawing. Convert it using a trusted VSD-capable application before importing.');
  if(input[0]===0x50&&input[1]===0x4b){const source=await readVsdx(input);return{document:source.document,diagnostics:[...source.diagnostics],source};}
  if(/\.vsd$/i.test(name))throw new DrawingError('LEGACY_VSD_UNSUPPORTED','Binary VSD is not supported by this decoder.');return readDrawing(dec.decode(input),name);
}
