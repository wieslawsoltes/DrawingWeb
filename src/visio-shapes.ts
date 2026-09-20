/** Native Visio text, links and structural relationships. No expression is executed during import. */
import type { DiagramDocument, Diagnostic, Page, Shape, TextParagraph, TextRun } from './model.js';
import { DrawingError, plainText, validateJson } from './model.js';
import { element, elements, first, descendants, isElement, localName, textContent } from './xml.js';
import type { XmlElement, XmlChild } from './xml.js';
export const DW_NAMESPACE='urn:drawingweb:extensions:1';
type Report=(code:string,message:string)=>void;
const cell=(n:string,v:string|number,f?:string)=>element('Cell',{N:n,V:v,...(f?{F:f}:{})});
const section=(n:XmlElement,name:string)=>elements(n,'Section').find(s=>s.attributes['N']===name);
const val=(n:XmlElement|undefined,key:string,fallback='')=>n?elements(n,'Cell').find(c=>c.attributes['N']===key)?.attributes['V']??fallback:fallback;
const num=(n:XmlElement|undefined,key:string,fallback=0)=>{const v=Number(val(n,key,String(fallback)));return Number.isFinite(v)?v:fallback;};
const unquote=(s:string)=>s.startsWith('"')&&s.endsWith('"')?s.slice(1,-1).replaceAll('""','"'):s;
function user(node:XmlElement,name:string):string {return unquote(val(elements(section(node,'User')??element('none'),'Row').find(r=>r.attributes['N']===name),'Value'));}
function putUser(node:XmlElement,name:string,value:string,formula?:string,unit?:string):void {let s=section(node,'User');if(!s){s=element('Section',{N:'User'});node.children.push(s);}s.children=s.children.filter(c=>!isElement(c)||c.attributes['N']!==name);s.children.push(element('Row',{N:name},[element('Cell',{N:'Value',V:value,...(formula?{F:formula}:{}),...(unit?{U:unit}:{})})]));}
function replace(node:XmlElement,name:string,child:XmlElement):void{node.children=node.children.filter(c=>!isElement(c)||localName(c.name)!==name);node.children.push(child);}
function replaceSection(node:XmlElement,name:string,child:XmlElement):void{node.children=node.children.filter(c=>!isElement(c)||localName(c.name)!=='Section'||c.attributes['N']!==name);node.children.push(child);}
const structural=new WeakMap<Shape,Map<number,number[]>>();
export function structuralIndex(page:Page):Map<string,Map<number,string[]>> {
 const result=new Map<string,Map<number,string[]>>();const add=(key:string,kind:number,target:string)=>{let m=result.get(key);if(!m){m=new Map();result.set(key,m);}m.set(kind,[...(m.get(kind)??[]),target]);};
 const walk=(shapes:Shape[])=>{for(const s of shapes){for(const member of s.container?.memberIds??[])add(member,s.container?.layout?5:4,s.id);if(s.calloutTargetId)add(s.calloutTargetId,3,s.id);if(s.children)walk(s.children);}};walk(page.shapes);return result;
}
export function readShapeExtensions(node:XmlElement,s:Shape,font:(id:string)=>string,color:(value:string)=>string,report:Report):void {
 const sheetId=Number(node.attributes['ID']);if(Number.isSafeInteger(sheetId)&&sheetId>0)s.sheetId=sheetId;
 const relationships=elements(node,'Cell').find(c=>c.attributes['N']==='Relationships')?.attributes['F']??'';const deps=new Map<number,number[]>();
 for(const match of relationships.matchAll(/DEPENDSON\(\s*(\d+)\s*,([\s\S]*?)(?=DEPENDSON\(|$)/gi)){const ids=[...match[2]!.matchAll(/Sheet\.(\d+)!/gi)].map(m=>Number(m[1]));deps.set(Number(match[1]),ids);}structural.set(s,deps);
 const kind=user(node,'msvStructureType').toLowerCase();if(kind==='container'||kind==='list')s.container={memberIds:[],padding:24,headerSize:32,autoResize:false,locked:false,orientation:'horizontal',...(kind==='list'?{layout:'list' as const}:{})};
 if(s.container)s.kind='container';if(kind==='callout')s.kind='callout';
 const links=section(node,'Hyperlink');if(links)s.hyperlinks=elements(links,'Row').filter(r=>r.attributes['Del']!=='1').map((r,i)=>({id:r.attributes['N']??`link-${i}`,description:unquote(val(r,'Description')),address:unquote(val(r,'Address'))||undefined,subAddress:unquote(val(r,'SubAddress'))||undefined,newWindow:num(r,'NewWindow',1)!==0}));
 const text=first(node,'Text'),chars=elements(section(node,'Character')??element('none'),'Row'),paras=elements(section(node,'Paragraph')??element('none'),'Row');
 if(text){let ci='0',pi='0';const paragraphs:TextParagraph[]=[];let current:TextParagraph|undefined;
  const style=():NonNullable<TextRun['style']>=>{const r=chars.find(c=>(c.attributes['IX']??'0')===ci),flags=num(r,'Style');if(flags&8)report('SMALL_CAPS_APPROXIMATED','Small caps remain cached in the source and are displayed without case shaping.');return{fontFamily:font(val(r,'Font','0')),fontSize:num(r,'Size',s.style.fontSize/96)*96,color:color(val(r,'Color',s.style.color)),bold:!!(flags&1),italic:!!(flags&2),underline:!!(flags&4),strike:['1','true'].includes(val(r,'Strikethru').toLowerCase())};};
  const paragraph=()=>{const r=paras.find(p=>(p.attributes['IX']??'0')===pi);return{runs:[],align:(['left','center','right'] as const)[num(r,'HorzAlign',1)]??'left',indent:num(r,'IndLeft')*96,spaceBefore:num(r,'SpBefore')*96,spaceAfter:num(r,'SpAfter')*96} satisfies TextParagraph;};
  const append=(value:string)=>{const lines=value.split('\n');for(let i=0;i<lines.length;i++){if(!current){current=paragraph();paragraphs.push(current);}if(lines[i])current.runs.push({text:lines[i]!,style:style()});if(i<lines.length-1)current=undefined;}};
  for(const child of text.children){if(typeof child==='string')append(child);else if(isElement(child)){switch(localName(child.name)){case'cp':ci=child.attributes['IX']??'0';break;case'pp':pi=child.attributes['IX']??'0';break;case'fld':append(textContent(child));report('TEXT_FIELD_CACHED','A text field is displayed using its cached value.');break;default:append(textContent(child));}}}
  if(paragraphs.length&&elements(text).length){if(!current&&textContent(text).endsWith('\n'))paragraphs.push(paragraph());s.richText={paragraphs};s.text=plainText(s.richText);}
 }
 if(elements(node,'Cell').some(c=>c.attributes['N']==='TxtWidth')){const w=num(node,'TxtWidth',s.width/96)*96,h=num(node,'TxtHeight',s.height/96)*96;s.textBlock={x:num(node,'TxtPinX',s.width/192)*96-num(node,'TxtLocPinX',w/192)*96,y:s.height-num(node,'TxtPinY',s.height/192)*96-(h-num(node,'TxtLocPinY',h/192)*96),width:w,height:h,rotation:-num(node,'TxtAngle')};}
 for(const sec of ['User','Property'])for(const row of elements(section(node,sec)??element('none'),'Row')){const name=row.attributes['N'];if(!name||name==='DrawingWebMetadata'||row.attributes['Del']==='1')continue;const v=elements(row,'Cell').find(c=>c.attributes['N']==='Value');if(v)s.cells[(sec==='User'?'User.':'Prop.')+name]={value:v.attributes['V']??'',formula:v.attributes['F'],unit:v.attributes['U']};}
 // Supplement native text with application-only metadata only while cached text still matches.
 const extra=user(node,'DrawingWebMetadata');if(extra){try{if(extra.length>2_000_000)throw new Error('too large');const v=JSON.parse(extra) as Partial<Shape>;validateJson(v);if(v.richText&&s.richText&&plainText(v.richText)===s.text&&v.richText.paragraphs.length===s.richText.paragraphs.length){for(const [i,p]of s.richText.paragraphs.entries()){const extra=v.richText.paragraphs[i]!;p.bullet=extra.bullet;for(const [j,run]of p.runs.entries()){const cached=extra.runs[j];if(cached?.text===run.text&&cached.field)run.field=cached.field;}}}if(v.container&&s.container)s.container={...v.container,memberIds:[]};if(v.kind&&['container','swimlane','callout','image'].includes(v.kind))s.kind=v.kind;if(v.style)s.style={...s.style,...v.style};if(v.textBlock)s.textBlock=v.textBlock;}catch{report('DRAWINGWEB_METADATA','Invalid application metadata was ignored.');}}
}
export function readStructuralRelationships(page:Page,diagnostics:Diagnostic[]):void {
 const all:Shape[]=[];const parents=new Map<string,string|undefined>();const walk=(items:Shape[],parent?:string)=>{for(const s of items){all.push(s);parents.set(s.id,parent);if(s.children)walk(s.children,s.id);}};walk(page.shapes);const map=new Map<number,Shape>();for(const s of all)if(s.sheetId!==undefined)map.set(s.sheetId,s);
 const member=(container:Shape,item:Shape)=>{if(!container.container||container===item||parents.get(container.id)!==parents.get(item.id)){diagnostics.push({code:'STRUCTURAL_RELATIONSHIP',severity:'warning',shapeId:item.id,message:'Unsupported cross-parent or invalid container relationship was ignored.'});return;}if(!container.container.memberIds.includes(item.id))container.container.memberIds.push(item.id);};
 for(const s of all){const d=structural.get(s);for(const k of [1,2])for(const n of d?.get(k)??[]){const target=map.get(n);if(target)member(s,target);}for(const k of [4,5])for(const n of d?.get(k)??[]){const target=map.get(n);if(target)member(target,s);}const targetId=d?.get(6)?.[0],target=targetId===undefined?undefined:map.get(targetId);if(target&&target!==s)s.calloutTargetId=target.id;for(const n of d?.get(3)??[]){const callout=map.get(n);if(callout&&callout!==s)callout.calloutTargetId=s.id;}}
}
export function writeShapeExtensions(node:XmlElement,s:Shape,page:Page,ids:Map<string,number>,font:(family:string)=>number,report:Report,incoming:Map<string,Map<number,string[]>>,color:(value:string)=>string):void {
 const deps=new Map(incoming.get(s.id)??[]);if(s.container){putUser(node,'msvStructureType',s.container.layout?'List':'Container');deps.set(s.container.layout?2:1,s.container.memberIds);}if(s.calloutTargetId){putUser(node,'msvStructureType','Callout');deps.set(6,[s.calloutTargetId]);}
 if(deps.size)node.children.push(cell('Relationships',0,[...deps].map(([k,refs])=>`DEPENDSON(${k},${refs.filter(x=>ids.has(x)).map(x=>`Sheet.${ids.get(x)}!SheetRef()`).join(',')})`).join('+')));
 if(s.hyperlinks?.length)replaceSection(node,'Hyperlink',element('Section',{N:'Hyperlink'},s.hyperlinks.map((h,i)=>element('Row',{N:`Link${i}`},[cell('Description',h.description),cell('Address',h.address??''),cell('SubAddress',h.subAddress??(h.pageId??'')),cell('NewWindow',h.newWindow===false?0:1)]))));
 if(s.richText){const characterRows:XmlElement[]=[],paragraphRows:XmlElement[]=[],content:XmlChild[]=[];
  for(const [i,p]of s.richText.paragraphs.entries()){if(i)content.push('\n');content.push(element('pp',{IX:i}));paragraphRows.push(element('Row',{IX:i},[cell('HorzAlign',{left:0,center:1,right:2}[p.align??s.style.align]),cell('IndLeft',(p.indent??0)/96),cell('SpBefore',(p.spaceBefore??0)/96),cell('SpAfter',(p.spaceAfter??0)/96)]));
   for(const r of p.runs){const st={...s.style,...r.style},index=characterRows.length;characterRows.push(element('Row',{IX:index},[cell('Font',font(st.fontFamily)),cell('Size',st.fontSize/96),cell('Color',color(st.color)),cell('Style',(st.bold?1:0)+(st.italic?2:0)+(st.underline?4:0)),cell('Strikethru',st.strike?1:0)]));content.push(element('cp',{IX:index}),r.text);if(r.field)report('TEXT_FIELD_CACHED','Field formulas are retained as application metadata; native export uses cached text.');}
  }
  replaceSection(node,'Character',element('Section',{N:'Character'},characterRows));replaceSection(node,'Paragraph',element('Section',{N:'Paragraph'},paragraphRows));replace(node,'Text',element('Text',{},content));
 }
 if(s.textBlock){const b=s.textBlock;node.children.push(cell('TxtWidth',b.width/96),cell('TxtHeight',b.height/96),cell('TxtPinX',(b.x+b.width/2)/96),cell('TxtPinY',(s.height-b.y-b.height/2)/96),cell('TxtLocPinX',b.width/192),cell('TxtLocPinY',b.height/192),cell('TxtAngle',-(b.rotation??0)));}
 for(const [name,v]of Object.entries(s.cells)){if(name.startsWith('User.'))putUser(node,name.slice(5),v.value,v.formula,v.unit);else if(v.formula){const c=elements(node,'Cell').find(c=>c.attributes['N']===name);if(c)c.attributes['F']=v.formula;}}
 if(s.richText||s.container||s.textBlock||s.style.underline||s.style.strike||s.style.verticalAlign)putUser(node,'DrawingWebMetadata',JSON.stringify({kind:s.kind,richText:s.richText,container:s.container?{...s.container,memberIds:[]}:undefined,textBlock:s.textBlock,style:{underline:s.style.underline,strike:s.style.strike,verticalAlign:s.style.verticalAlign,padding:s.style.padding,lineSpacing:s.style.lineSpacing}}));
 if(s.dataGraphicId)report('DATA_GRAPHIC_NATIVE','DrawingWeb data graphic definitions are not native Visio data graphic masters.');
}
export function writeComments(document:DiagramDocument,ids:(page:Page)=>Map<string,number>,report:Report):XmlElement|undefined {
 if(!document.comments?.length)return;const names=[...new Set(document.comments.flatMap(c=>[c.author,...c.replies.map(r=>r.author)]))],entries:XmlElement[]=[];let next=1;
 for(const c of document.comments){const p=document.pages.find(p=>p.id===c.pageId);if(!p)continue;const attributes={AuthorID:names.indexOf(c.author)+1,PageID:document.pages.indexOf(p),Date:c.createdUtc,CommentID:next++,Done:c.resolved?1:0,...(c.shapeId&&ids(p).has(c.shapeId)?{ShapeID:ids(p).get(c.shapeId)!}:{})};entries.push(element('CommentEntry',attributes,[c.text]));for(const r of c.replies)entries.push(element('CommentEntry',{...attributes,AuthorID:names.indexOf(r.author)+1,Date:r.createdUtc,CommentID:next++},[`Reply to ${attributes.CommentID}: ${r.text}`]));if(c.replies.length)report('COMMENT_THREADS_FLATTENED','Replies are exported as separate native comments.');}
 return element('Comments',{},[element('AuthorList',{},names.map((name,i)=>element('AuthorEntry',{ID:i+1,Name:name,Initials:name.slice(0,2)}))),element('CommentList',{},entries)]);
}
export function readComments(root:XmlElement,document:DiagramDocument):void {
 const authors=new Map(descendants(root,'AuthorEntry').map(a=>[a.attributes['ID'],a.attributes['Name']??'Author']));const all=descendants(root,'CommentEntry');if(!all.length)return;
 const comments=document.comments??=[];
 for(const [i,n]of all.entries()){const p=document.pages.find(p=>p.id===`visio-p${n.attributes['PageID']}`);if(!p)continue;const shapeId=n.attributes['ShapeID']?`${p.id}:s${n.attributes['ShapeID']}`:undefined;const exists=(shapes:Shape[]):boolean=>shapes.some(s=>s.id===shapeId||!!s.children&&exists(s.children));const date=n.attributes['Date']??'';
 comments.push({id:`visio-comment-${n.attributes['CommentID']??i}`,pageId:p.id,shapeId:shapeId&&exists(p.shapes)?shapeId:undefined,author:authors.get(n.attributes['AuthorID'])??'Author',text:textContent(n),createdUtc:Number.isNaN(Date.parse(date))?'1970-01-01T00:00:00.000Z':date,resolved:['1','true'].includes(n.attributes['Done']??''),replies:[]});}
}
