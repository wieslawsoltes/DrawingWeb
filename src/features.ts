/** Higher-level diagram semantics. No browser, database driver, network or renderer dependency. */
import { DiagramEngine } from './core.js';
import { clone, createShape, DrawingError, id, rowIdentity, safeHyperlink } from './model.js';
import type { ContainerProperties, DataGraphic, DataRecordset, DiagramComment, DiagramTheme, Hyperlink, Json, Matrix, Point, Shape, ShapeDataLink, ShapeStyle } from './model.js';
import { inverse, localMatrix, multiply, transformedBounds, translation, union } from './geometry.js';

export interface ContainerOptions extends Partial<Omit<ContainerProperties, 'memberIds'>> {
  name?: string; x?: number; y?: number; width?: number; height?: number;
}
export interface RefreshResult { updated: string[]; missing: string[] }
export const THEMES: readonly DiagramTheme[] = [
  { id:'office', name:'Office', fontFamily:'Arial, sans-serif', colors:{ accent:'#185abd', fill:'#eaf2ff', line:'#7799c4', text:'#20334e', surface:'#ffffff' } },
  { id:'slate', name:'Slate', fontFamily:'Arial, sans-serif', colors:{ accent:'#475569', fill:'#f1f5f9', line:'#94a3b8', text:'#1e293b', surface:'#ffffff' } },
  { id:'forest', name:'Forest', fontFamily:'Arial, sans-serif', colors:{ accent:'#237b5f', fill:'#eaf6ef', line:'#78ac94', text:'#1d4b37', surface:'#ffffff' } },
  { id:'warm', name:'Warm', fontFamily:'Arial, sans-serif', colors:{ accent:'#ad5b23', fill:'#fff3e6', line:'#d6a47a', text:'#633b20', surface:'#fffefa' } },
];
const same = (a:unknown,b:unknown):boolean => JSON.stringify(a)===JSON.stringify(b);
const shapeRequired = (engine:DiagramEngine,key:string):Shape => {
  const shape=engine.getShape(key); if(!shape)throw new DrawingError('SHAPE_NOT_FOUND',key);return shape;
};
const containerRequired = (engine:DiagramEngine,key:string):Shape & {container:ContainerProperties} => {
  const shape=shapeRequired(engine,key);if(!shape.container)throw new DrawingError('CONTAINER_REQUIRED','Select a container or swimlane.');return shape as Shape & {container:ContainerProperties};
};
/** Application commands with transaction/history guarantees shared by native JS and Blazor. */
export class DiagramOperations {
  constructor(readonly engine:DiagramEngine) {}
  createContainer(pageId:string,memberIds:readonly string[]=this.engine.selection,options:ContainerOptions={}):string {
    const e=this.engine, members=[...new Set(memberIds)], first=members.length?e.getRef(members[0]!):undefined;
    if(members.some(key=>{const ref=e.getRef(key);return !ref||ref.pageId!==pageId||ref.parentId!==first?.parentId;}))
      throw new DrawingError('CONTAINER_MEMBER','Container members must share a page and transform parent.');
    const padding=options.padding??24,headerSize=options.headerSize??32;
    const bounds=members.length?union(members.map(key=>transformedBounds(shapeRequired(e,key)))):{x:options.x??120,y:options.y??120,width:options.width??360,height:options.height??220};
    const shape=createShape('container',{ x:bounds.x-padding,y:bounds.y-padding-headerSize,width:bounds.width+2*padding,height:bounds.height+2*padding+headerSize,text:options.name??'Container',
      style:{fill:'#ffffff',stroke:'#7892b5',strokeWidth:1.25,bold:true,color:'#304967',align:'left'},
      container:{memberIds:members,padding,headerSize,autoResize:options.autoResize??false,locked:options.locked??false,orientation:options.orientation??'horizontal',layout:options.layout} });
    e.transaction('Insert container',()=>{e.add(pageId,shape,first?.parentId);e.reorder([shape.id],'back');});e.select([shape.id]);return shape.id;
  }
  setContainerMembers(containerId:string,members:readonly string[]):void {
    const e=this.engine,c=containerRequired(e,containerId),next=[...new Set(members)];
    if(c.container.locked&&!same(next,c.container.memberIds))throw new DrawingError('CONTAINER_LOCKED','Container membership is locked.');
    e.transaction('Change container membership',()=>{e.update(containerId,{container:{...c.container,memberIds:next}});if(c.container.autoResize)this.fitContainer(containerId);});
  }
  addToContainer(containerId:string,members:readonly string[]):void {
    const c=containerRequired(this.engine,containerId);this.setContainerMembers(containerId,[...c.container.memberIds,...members]);
  }
  removeFromContainer(containerId:string,members:readonly string[]):void {
    const remove=new Set(members),c=containerRequired(this.engine,containerId);this.setContainerMembers(containerId,c.container.memberIds.filter(key=>!remove.has(key)));
  }
  setContainerLocked(containerId:string,locked:boolean):void {
    const c=containerRequired(this.engine,containerId);this.engine.update(containerId,{container:{...c.container,locked}});
  }
  selectContainerContents(containerId:string):void {this.engine.select(containerRequired(this.engine,containerId).container.memberIds);}
  disbandContainer(containerId:string):void {
    const e=this.engine,c=containerRequired(e,containerId),members=[...c.container.memberIds];
    e.transaction('Disband container',()=>{
      // A container can itself be a member. Explicitly disbanding honors an enclosing membership lock.
      e.update(containerId,{container:{...c.container,memberIds:[],locked:false}});e.remove([containerId]);
    });e.select(members);
  }
  fitContainer(containerId:string):void {
    const e=this.engine,c=containerRequired(e,containerId);if(!c.container.memberIds.length)return;
    const matrix=localMatrix(c),inv=inverse(matrix);if(!inv)throw new DrawingError('TRANSFORM','Cannot fit a singular container.');
    const b=union(c.container.memberIds.map(key=>{const member=shapeRequired(e,key);return transformedBounds(member,multiply(inv,localMatrix(member)));}));
    const p=c.container.padding,h=c.container.headerSize,vertical=c.container.orientation==='vertical';
    const x=b.x-p-(vertical?h:0),y=b.y-p-(vertical?0:h),width=b.width+p*2+(vertical?h:0),height=b.height+p*2+(vertical?0:h);
    e.update(containerId,{x:0,y:0,rotation:0,transform:multiply(matrix,translation(x,y)),width,height});
  }
  createSwimlanes(pageId:string,names:readonly string[]=['Customer','Operations','Fulfillment'],orientation:'horizontal'|'vertical'='horizontal'):string {
    if(!names.length||names.length>128)throw new DrawingError('SWIMLANE','Supply 1–128 lane names.');
    const e=this.engine, horizontal=orientation==='horizontal',pool=createShape('container',{x:80,y:80,width:horizontal?960:Math.max(600,names.length*240),height:horizontal?names.length*170+42:650,text:'Cross-functional process',
      style:{fill:'#ffffff',stroke:'#54749b',bold:true,color:'#20334e',align:'left'},
      container:{memberIds:[],padding:0,headerSize:42,autoResize:false,locked:false,orientation:'horizontal',layout:'pool'}});
    const lanes=names.map((name,i)=>createShape('swimlane',{text:name,style:{fill:i%2?'#f6f9ff':'#ffffff',stroke:'#b7c9de',color:'#354e6d',bold:true},
      container:{memberIds:[],padding:20,headerSize:horizontal?110:38,autoResize:false,locked:false,orientation:horizontal?'vertical':'horizontal'}}));
    pool.container!.memberIds=lanes.map(s=>s.id);
    e.transaction('Insert cross-functional flowchart',()=>{e.addMany(pageId,[pool,...lanes]);this.layoutSwimlanes(pool.id,orientation);});e.select([pool.id]);return pool.id;
  }
  layoutSwimlanes(poolId:string,orientation:'horizontal'|'vertical'='horizontal'):void {
    const e=this.engine,pool=containerRequired(e,poolId);if(pool.container.layout!=='pool')throw new DrawingError('SWIMLANE','Select a swimlane pool.');
    const ids=pool.container.memberIds,n=ids.length;if(!n)return;const top=pool.container.headerSize,vertical=orientation==='vertical',matrix=localMatrix(pool);
    e.transaction('Arrange swimlanes',()=>{ids.forEach((key,i)=>{
      const lane=containerRequired(e,key),old=localMatrix(lane),inv=inverse(old);if(!inv)throw new DrawingError('TRANSFORM','Singular lane transform.');
      const width=vertical?pool.width/n:pool.width,height=vertical?pool.height-top:(pool.height-top)/n;
      const next=multiply(matrix,translation(vertical?i*width:0,top+(vertical?0:i*height)));
      const delta=multiply(next,inv);
      // Moving/reordering a lane moves each semantic member exactly once without scaling its contents.
      const roots=e.operationRoots(lane.container.memberIds);
      for(const memberId of roots){const member=shapeRequired(e,memberId);e.update(memberId,{x:0,y:0,rotation:0,transform:multiply(delta,localMatrix(member))});}
      e.update(key,{x:0,y:0,rotation:0,transform:next,width,height,container:{...lane.container,orientation:vertical?'horizontal':'vertical',headerSize:vertical?38:110}});
    });});
  }
  reorderLane(poolId:string,laneId:string,offset:number):void {
    const pool=containerRequired(this.engine,poolId),ids=[...pool.container.memberIds],old=ids.indexOf(laneId),at=Math.min(ids.length-1,Math.max(0,old+Math.trunc(offset)));
    if(old<0)throw new DrawingError('SWIMLANE','Lane is not in this pool.');
    if(pool.container.locked)throw new DrawingError('CONTAINER_LOCKED','Pool membership is locked.');
    ids.splice(old,1);ids.splice(at,0,laneId);
    const lane=containerRequired(this.engine,laneId),orientation=lane.container.orientation==='vertical'?'horizontal':'vertical';
    this.engine.transaction('Reorder swimlane',()=>{this.setContainerMembers(poolId,ids);this.layoutSwimlanes(poolId,orientation);});
  }
  createCallout(pageId:string,targetId:string,text='Add a note'):string {
    const e=this.engine,target=shapeRequired(e,targetId),ref=e.getRef(targetId)!;
    if(ref.pageId!==pageId)throw new DrawingError('CALLOUT','Callout and target must share a page.');
    const r=transformedBounds(target,ref.matrix),shape=createShape('callout',{x:r.x+r.width+40,y:r.y-70,width:190,height:65,text,calloutTargetId:targetId,style:{fill:'#fff7d6',stroke:'#d2ae44',color:'#604d1b'}});
    e.add(pageId,shape);e.select([shape.id]);return shape.id;
  }
  addHyperlink(shapeId:string,link:Omit<Hyperlink,'id'>):string {
    if(link.address&&!safeHyperlink(link.address))throw new DrawingError('HYPERLINK_SCHEME','Use an absolute HTTP(S), mailto or tel URL.');
    if(!link.address&&!link.pageId&&!link.subAddress)throw new DrawingError('HYPERLINK','Supply an address or internal destination.');
    const e=this.engine,s=shapeRequired(e,shapeId),key=id('link');e.update(shapeId,{hyperlinks:[...(s.hyperlinks??[]),{...clone(link),id:key}]});return key;
  }
  removeHyperlink(shapeId:string,linkId:string):void {const s=shapeRequired(this.engine,shapeId);this.engine.update(shapeId,{hyperlinks:s.hyperlinks?.filter(l=>l.id!==linkId)});}
  addComment(pageId:string,text:string,author='Author',shapeId?:string,position?:Point):string {
    if(!text.trim())throw new DrawingError('COMMENT','A comment cannot be empty.');
    const comment:DiagramComment={id:id('comment'),pageId,shapeId,position,author,text,createdUtc:new Date().toISOString(),resolved:false,replies:[]};
    this.engine.updateDocument({comments:[...(this.engine.document.comments??[]),comment]});return comment.id;
  }
  replyComment(commentId:string,text:string,author='Author'):void {
    if(!text.trim())throw new DrawingError('COMMENT','A reply cannot be empty.');
    this.editComment(commentId,c=>({...c,replies:[...c.replies,{id:id('reply'),author,text,createdUtc:new Date().toISOString()}]}));
  }
  resolveComment(commentId:string,resolved=true):void {this.editComment(commentId,c=>({...c,resolved}));}
  deleteComment(commentId:string):void {this.engine.updateDocument({comments:this.engine.document.comments?.filter(c=>c.id!==commentId)});}
  private editComment(commentId:string,edit:(c:DiagramComment)=>DiagramComment):void {
    if(!this.engine.document.comments?.some(c=>c.id===commentId))throw new DrawingError('COMMENT','Comment not found.');
    this.engine.updateDocument({comments:this.engine.document.comments.map(c=>c.id===commentId?edit(c):c)});
  }
  applyTheme(theme:DiagramTheme,shapeIds?:readonly string[]):void {
    const e=this.engine;
    e.transaction('Apply theme',()=>{e.updateDocument({theme:clone(theme)});for(const s of shapeIds?shapeIds.map(key=>shapeRequired(e,key)):e.allShapes()){
      const binding=s.theme??{fill:'fill',stroke:'line',color:'text',font:true},style={...s.style};
      for(const key of ['fill','stroke','color'] as const){const token=binding[key];if(token&&theme.colors[token]&&style[key]!=='none')style[key]=theme.colors[token]!;}
      if(binding.font)style.fontFamily=theme.fontFamily;e.update(s.id,{theme:binding,style});
    }});
  }
  registerDataGraphic(graphic:DataGraphic):void {
    const graphics=this.engine.document.dataGraphics??[];this.engine.updateDocument({dataGraphics:[...graphics.filter(g=>g.id!==graphic.id),clone(graphic)]});
  }
  applyDataGraphic(shapeIds:readonly string[],graphicId?:string):void {
    this.engine.transaction('Apply data graphic',()=>{for(const key of shapeIds)this.engine.update(key,{dataGraphicId:graphicId});});
  }
  upsertRecordset(recordset:DataRecordset):RefreshResult {
    const e=this.engine;let result:RefreshResult={updated:[],missing:[]};
    e.transaction('Refresh linked data',()=>{
      e.updateDocument({recordsets:[...(e.document.recordsets??[]).filter(s=>s.id!==recordset.id),clone(recordset)]});
      result=this.refreshLinks(recordset.id);
    },'data');return result;
  }
  linkShape(shapeId:string,link:ShapeDataLink):void {
    const e=this.engine,s=shapeRequired(e,shapeId);
    e.transaction('Link shape to data',()=>{e.update(shapeId,{dataLinks:[...(s.dataLinks??[]).filter(l=>l.recordsetId!==link.recordsetId),clone(link)]});this.refreshLinks(link.recordsetId,[shapeId]);});
  }
  unlinkShape(shapeId:string,recordsetId?:string):void {
    const e=this.engine,s=shapeRequired(e,shapeId);e.update(shapeId,{dataLinks:recordsetId?s.dataLinks?.filter(l=>l.recordsetId!==recordsetId):[]});
  }
  autoLink(pageId:string,recordsetId:string,shapeField:string,column:string,mappings:Record<string,string>):number {
    const e=this.engine,set=e.document.recordsets?.find(s=>s.id===recordsetId);if(!set)throw new DrawingError('RECORDSET','Recordset not found.');
    const rows=new Map<string,Record<string,Json>>();
    for(const row of set.rows){if(!Object.hasOwn(row,column))throw new DrawingError('AUTOLINK_COLUMN',`Missing matching column: ${column}`);const match=JSON.stringify(row[column]);if(rows.has(match))throw new DrawingError('AUTOLINK_AMBIGUOUS','The matching column contains duplicate values.');rows.set(match,row);}
    let count=0;e.transaction('Automatically link shapes',()=>{for(const shape of e.allShapes(pageId)){
      const value=shapeField==='text'?shape.text:shape.data[shapeField.replace(/^data\./,'')],row=rows.get(JSON.stringify(value));
      if(row){this.linkShape(shape.id,{recordsetId,rowKey:row[set.keyField] as string|number,mappings});count++;}
    }});return count;
  }
  refreshLinks(recordsetId:string,shapeIds?:readonly string[]):RefreshResult {
    const e=this.engine,set=e.document.recordsets?.find(s=>s.id===recordsetId);if(!set)throw new DrawingError('RECORDSET','Recordset not found.');
    const rows=new Map(set.rows.map(row=>[rowIdentity(row[set.keyField]),row])),result:RefreshResult={updated:[],missing:[]};
    e.transaction('Update linked shapes',()=>{for(const s of shapeIds?shapeIds.map(key=>shapeRequired(e,key)):e.allShapes()){
      for(const link of s.dataLinks??[]){if(link.recordsetId!==recordsetId)continue;const row=rows.get(rowIdentity(link.rowKey));
        if(!row){result.missing.push(s.id);continue;}
        const patch:Partial<Shape>={data:{...s.data}};
        for(const [target,field] of Object.entries(link.mappings)){
          const value=row[field];if(value===undefined)continue;
          if(target==='text')patch.text=String(value??'');
          else if(['x','y','width','height','rotation'].includes(target)){
            if(typeof value!=='number'||!Number.isFinite(value))throw new DrawingError('DATA_BINDING',`${field} must be numeric.`);
            (patch as Record<string,unknown>)[target]=value;
          }else if(target.startsWith('data.'))patch.data![safeField(target.slice(5))]=clone(value);
          else if(['style.fill','style.stroke','style.color'].includes(target)){
            if(typeof value!=='string')throw new DrawingError('DATA_BINDING','Style bindings require strings.');
            patch.style={...s.style,...patch.style,[target.slice(6)]:value};
          }else throw new DrawingError('DATA_BINDING',`Unsupported mapping: ${target}`);
        }
        if(Object.entries(patch).some(([key,value])=>!same((s as unknown as Record<string,unknown>)[key],value))){e.update(s.id,patch);result.updated.push(s.id);}
      }
    }},'data');return result;
  }
  distribute(shapeIds:readonly string[],axis:'horizontal'|'vertical'):void {
    const e=this.engine,items=e.selectionRoots(shapeIds).map(key=>({key,rect:transformedBounds(shapeRequired(e,key),e.getRef(key)!.matrix)})),horizontal=axis==='horizontal';
    if(items.length<3)return;items.sort((a,b)=>(horizontal?a.rect.x-b.rect.x:a.rect.y-b.rect.y)||a.key.localeCompare(b.key));
    const start=horizontal?items[0]!.rect.x:items[0]!.rect.y,last=items.at(-1)!.rect;
    const extent=(horizontal?last.x+last.width:last.y+last.height)-start,total=items.reduce((n,i)=>n+(horizontal?i.rect.width:i.rect.height),0),gap=(extent-total)/(items.length-1);
    e.transaction('Distribute shapes',()=>{let at=start;for(const item of items){e.move([item.key],horizontal?at-item.rect.x:0,horizontal?0:at-item.rect.y);at+=(horizontal?item.rect.width:item.rect.height)+gap;}});
  }
  flip(shapeIds:readonly string[],axis:'horizontal'|'vertical'):void {
    const e=this.engine,roots=e.operationRoots(shapeIds);if(!roots.length)return;
    const b=union(roots.map(key=>transformedBounds(shapeRequired(e,key),e.getRef(key)!.matrix))),horizontal=axis==='horizontal';
    const reflect:Matrix=horizontal?[-1,0,0,1,b.x*2+b.width,0]:[1,0,0,-1,0,b.y*2+b.height];
    e.transaction('Flip shapes',()=>{for(const key of roots){const r=e.getRef(key)!,inv=inverse(r.parentMatrix);if(!inv)throw new DrawingError('TRANSFORM','Cannot flip a singular parent.');e.update(key,{x:0,y:0,rotation:0,transform:multiply(inv,multiply(reflect,r.matrix))});}});
  }
  duplicatePage(pageId:string):string {
    const e=this.engine,page=e.getPage(pageId),map=new Map<string,string>();for(const shape of e.allShapes(pageId))map.set(shape.id,id());
    let newId='';
    e.transaction('Duplicate page',()=>{
      newId=e.addPage(page.name+' copy');
      const {id:_,shapes:__,...settings}=clone(page);e.updatePage(newId,{...settings,name:page.name+' copy'});
      const copy=(s:Shape):Shape=>({...clone(s),id:map.get(s.id)!,children:s.children?.map(copy),
        container:s.container?{...s.container,memberIds:s.container.memberIds.map(key=>map.get(key)!)}:undefined,
        calloutTargetId:map.get(s.calloutTargetId??''),source:s.source?{...s.source,shapeId:map.get(s.source.shapeId??'')}:undefined,target:s.target?{...s.target,shapeId:map.get(s.target.shapeId??'')}:undefined,
        hyperlinks:s.hyperlinks?.map(l=>({...l,id:id('link'),pageId:l.pageId===pageId?newId:l.pageId,shapeId:map.get(l.shapeId??'')??l.shapeId}))});
      e.addMany(newId,page.shapes.map(copy));
      const comments=(e.document.comments??[]).filter(c=>c.pageId===pageId).map(c=>({...clone(c),id:id('comment'),pageId:newId,shapeId:map.get(c.shapeId??'')}));
      if(comments.length)e.updateDocument({comments:[...(e.document.comments??[]),...comments]});
    });return newId;
  }
}
function safeField(name:string):string {if(!name||['__proto__','constructor','prototype'].includes(name)||name.includes('.'))throw new DrawingError('DATA_BINDING','A mapping must use a safe flat shape-data field.');return name;}

export interface DataGraphicItem { type:'text'|'bar'|'icon'; text:string; color:string; background:string; fraction?:number; y:number }
export interface ShapePresentation { style:ShapeStyle; items:DataGraphicItem[] }
/** Pure rendering projection. It never writes evaluated colors or badges back into shape data. */
export function evaluateDataGraphic(shape:Shape,graphics:readonly DataGraphic[]=[]):ShapePresentation {
  const style={...shape.style},items:DataGraphicItem[]=[],graphic=graphics.find(g=>g.id===shape.dataGraphicId);if(!graphic)return{style,items};
  let y=shape.height+6;
  for(const rule of graphic.rules){
    const value=shape.data[rule.field.replace(/^data\./,'')];if(value===undefined||value===null)continue;
    const match=rule.cases?.find(c=>same(c.value,value))??(typeof value==='number'?[...(rule.thresholds??[])].sort((a,b)=>a.max-b.max).find(t=>value<=t.max):undefined);
    const color=match?.color??rule.color??'#185abd',label=match?.label??String(typeof value==='object'?JSON.stringify(value):value),text=rule.label?`${rule.label}: ${label}`:label;
    if(rule.type==='color'){if(match||rule.color)style.fill=color;continue;}
    if(rule.type==='bar'&&(typeof value!=='number'||!Number.isFinite(value)))continue;
    items.push({type:rule.type,text,color,background:rule.background??'#e6eaf0',fraction:rule.type==='bar'?Math.max(0,Math.min(1,((value as number)-(rule.min??0))/((rule.max??100)-(rule.min??0)))):undefined,y});y+=22;
  }
  return{style,items};
}
