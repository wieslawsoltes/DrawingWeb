import { DrawingError } from './model.js';
import type { Endpoint, Point, Rect, Shape } from './model.js';
import { DiagramEngine } from './core.js';
import { bounds, contains, inflate, transformPoint, transformedBounds } from './geometry.js';

interface HeapNode { key:string; cost:number }
class MinHeap {
  private items:HeapNode[]=[];
  get size():number{return this.items.length;}
  push(value:HeapNode):void{const a=this.items;a.push(value);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p]!.cost<=value.cost)break;a[i]=a[p]!;i=p;}a[i]=value;}
  pop():HeapNode|undefined{const a=this.items,first=a[0],last=a.pop();if(!a.length)return first;let i=0;while(true){let c=i*2+1;if(c>=a.length)break;if(c+1<a.length&&a[c+1]!.cost<a[c]!.cost)c++;if(a[c]!.cost>=last!.cost)break;a[i]=a[c]!;i=c;}a[i]=last!;return first;}
}
export interface RouteOptions { clearance?:number; bendPenalty?:number; maxNodes?:number }
export interface RouteResult { points:Point[]; obstructed:boolean; visited:number }
/** Orthogonal visibility-grid A*. Distinct direction states include a bend penalty. */
export function routeOrthogonal(start:Point,end:Point,obstacles:readonly Rect[],options:RouteOptions={}):RouteResult{
  const clearance=options.clearance??12,penalty=options.bendPenalty??20,maxNodes=options.maxNodes??40000;
  const boxes=obstacles.map(r=>inflate(r,clearance)).filter(r=>!contains(r,start)&&!contains(r,end));
  const xs=[...new Set([start.x,end.x,...boxes.flatMap(r=>[r.x-0.01,r.x+r.width+0.01])])].sort((a,b)=>a-b);
  const ys=[...new Set([start.y,end.y,...boxes.flatMap(r=>[r.y-0.01,r.y+r.height+0.01])])].sort((a,b)=>a-b);
  if(xs.length*ys.length*3>maxNodes)return {points:dogleg(start,end),obstructed:true,visited:0};
  const sx=xs.indexOf(start.x),sy=ys.indexOf(start.y),tx=xs.indexOf(end.x),ty=ys.indexOf(end.y);
  const key=(x:number,y:number,dir:number)=>`${x},${y},${dir}`,decode=(s:string)=>s.split(',').map(Number) as [number,number,number];
  const blocked=(a:Point,b:Point)=>boxes.some(r=>a.x===b.x?a.x>r.x&&a.x<r.x+r.width&&Math.max(a.y,b.y)>r.y&&Math.min(a.y,b.y)<r.y+r.height:a.y>r.y&&a.y<r.y+r.height&&Math.max(a.x,b.x)>r.x&&Math.min(a.x,b.x)<r.x+r.width);
  const heap=new MinHeap(),cost=new Map<string,number>(),previous=new Map<string,string>(),closed=new Set<string>(),initial=key(sx,sy,0);
  heap.push({key:initial,cost:0});cost.set(initial,0);let visited=0,final:string|undefined;
  while(heap.size&&visited<maxNodes){const current=heap.pop()!.key;if(closed.has(current))continue;closed.add(current);visited++;const [x,y,dir]=decode(current);if(x===tx&&y===ty){final=current;break;}
    for(const [nx,ny,nd] of [[x-1,y,1],[x+1,y,1],[x,y-1,2],[x,y+1,2]]){if(nx!<0||ny!<0||nx!>=xs.length||ny!>=ys.length)continue;const a={x:xs[x]!,y:ys[y]!},b={x:xs[nx!]!,y:ys[ny!]!};if(blocked(a,b))continue;
      const next=key(nx!,ny!,nd!),distance=cost.get(current)!+Math.abs(b.x-a.x)+Math.abs(b.y-a.y)+(dir&&dir!==nd?penalty:0);
      if(distance<(cost.get(next)??Infinity)){cost.set(next,distance);previous.set(next,current);heap.push({key:next,cost:distance+Math.abs(b.x-end.x)+Math.abs(b.y-end.y)});}
    }
  }
  if(!final)return {points:dogleg(start,end),obstructed:true,visited};
  const points:Point[]=[];for(let cursor:string|undefined=final;cursor;cursor=previous.get(cursor)){const[x,y]=decode(cursor);points.push({x:xs[x]!,y:ys[y]!});}points.reverse();return{points:simplify(points),obstructed:false,visited};
}
function dogleg(a:Point,b:Point):Point[]{return simplify([a,{x:(a.x+b.x)/2,y:a.y},{x:(a.x+b.x)/2,y:b.y},b]);}
export function simplify(points:readonly Point[]):Point[]{const result:Point[]=[];for(const p of points){if(result.length&&p.x===result.at(-1)!.x&&p.y===result.at(-1)!.y)continue;while(result.length>1){const a=result.at(-2)!,b=result.at(-1)!;if(Math.abs((b.x-a.x)*(p.y-b.y)-(b.y-a.y)*(p.x-b.x))>1e-8)break;result.pop();}result.push({...p});}return result;}
export function endpointPoint(engine:DiagramEngine,endpoint:Endpoint|undefined,towards:Point,fallback:Point):Point{
  if(!endpoint?.shapeId)return {x:endpoint?.x??fallback.x,y:endpoint?.y??fallback.y};
  const shape=engine.getShape(endpoint.shapeId),ref=engine.getRef(endpoint.shapeId);if(!shape||!ref)return fallback;
  const port=shape.ports.find(p=>p.id===endpoint.portId);if(port)return transformPoint(ref.matrix,{x:port.x*shape.width,y:port.y*shape.height});
  const candidates=[{x:shape.width/2,y:0},{x:shape.width,y:shape.height/2},{x:shape.width/2,y:shape.height},{x:0,y:shape.height/2}].map(p=>transformPoint(ref.matrix,p));
  return candidates.reduce((a,b)=>Math.hypot(a.x-towards.x,a.y-towards.y)<Math.hypot(b.x-towards.x,b.y-towards.y)?a:b);
}
export function connectorRoute(engine:DiagramEngine,shape:Shape,options:RouteOptions={}):RouteResult{
  const ref=engine.getRef(shape.id),matrix=ref?.matrix;
  const a=shape.points?.[0]??{x:0,y:shape.height/2},b=shape.points?.at(-1)??{x:shape.width,y:shape.height/2};
  const startFallback=matrix?transformPoint(matrix,a):a,endFallback=matrix?transformPoint(matrix,b):b;
  const targetShape=shape.target?.shapeId?engine.getShape(shape.target.shapeId):undefined,targetRef=shape.target?.shapeId?engine.getRef(shape.target.shapeId):undefined;
  const towards=targetShape&&targetRef?transformPoint(targetRef.matrix,{x:targetShape.width/2,y:targetShape.height/2}):endFallback;
  const start=endpointPoint(engine,shape.source,towards,startFallback),end=endpointPoint(engine,shape.target,start,endFallback);
  if(shape.routing==='manual'&&shape.points?.length){const points=shape.points.map(p=>matrix?transformPoint(matrix,p):p);if(shape.source)points[0]=start;if(shape.target)points[points.length-1]=end;return {points,obstructed:false,visited:0};}
  if(!shape.source&&!shape.target&&shape.points?.length)return {points:shape.points.map(p=>matrix?transformPoint(matrix,p):p),obstructed:false,visited:0};
  if(shape.routing==='straight')return {points:[start,end],obstructed:false,visited:0};
  const boxes=engine.allShapes(ref?.pageId).filter(s=>s.kind!=='connector'&&s.kind!=='group'&&s.id!==shape.source?.shapeId&&s.id!==shape.target?.shapeId&&s.visible!==false).map(s=>transformedBounds(s,engine.getRef(s.id)!.matrix));
  return routeOrthogonal(start,end,boxes,options);
}
export interface LayoutOptions { direction?:'right'|'down'; layerGap?:number; nodeGap?:number; margin?:number }
/** Deterministic layered layout. Cycles are condensed with Tarjan's SCC algorithm before ranking. */
export function layeredLayout(engine:DiagramEngine,pageId:string,options:LayoutOptions={}):void{
  const page=engine.getPage(pageId),nodes=page.shapes.filter(s=>s.kind!=='connector'&&!s.locked),ids=new Set(nodes.map(s=>s.id));
  const edges=page.shapes.filter(s=>s.kind==='connector'&&ids.has(s.source?.shapeId??'')&&ids.has(s.target?.shapeId??''));
  const adjacency=new Map(nodes.map(n=>[n.id,[] as string[]]));for(const e of edges)adjacency.get(e.source!.shapeId!)!.push(e.target!.shapeId!);
  const index=new Map<string,number>(),low=new Map<string,number>(),stack:string[]=[],active=new Set<string>(),components:string[][]=[];let next=0;
  const visit=(key:string,depth:number)=>{if(depth>4096)throw new DrawingError('LAYOUT_DEPTH','Graph depth exceeds the synchronous layout budget.');index.set(key,next);low.set(key,next++);stack.push(key);active.add(key);for(const target of adjacency.get(key)!){if(!index.has(target)){visit(target,depth+1);low.set(key,Math.min(low.get(key)!,low.get(target)!));}else if(active.has(target))low.set(key,Math.min(low.get(key)!,index.get(target)!));}if(low.get(key)===index.get(key)){const group:string[]=[];let current:string;do{current=stack.pop()!;active.delete(current);group.push(current);}while(current!==key);components.push(group.sort());}};
  nodes.forEach(n=>{if(!index.has(n.id))visit(n.id,0);});const componentOf=new Map<string,number>();components.forEach((c,i)=>c.forEach(key=>componentOf.set(key,i)));
  const ranks=new Array<number>(components.length).fill(0),incoming=new Array<number>(components.length).fill(0),out=components.map(()=>new Set<number>());
  for(const edge of edges){const a=componentOf.get(edge.source!.shapeId!)!,b=componentOf.get(edge.target!.shapeId!)!;if(a!==b&&!out[a]!.has(b)){out[a]!.add(b);incoming[b] = incoming[b]! + 1;}}
  const queue=incoming.flatMap((n,i)=>n===0?[i]:[]);for(let i=0;i<queue.length;i++){const a=queue[i]!;for(const b of out[a]!){ranks[b]=Math.max(ranks[b]!,ranks[a]!+1);if((incoming[b] = incoming[b]! - 1)===0)queue.push(b);}}
  const layers=new Map<number,Shape[]>();for(const node of nodes){const rank=ranks[componentOf.get(node.id)!]!;let layer=layers.get(rank);if(!layer)layers.set(rank,layer=[]);layer.push(node);}
  const down=options.direction==='down',gap=options.layerGap??110,nodeGap=options.nodeGap??40,margin=options.margin??80;
  let major=margin;engine.transaction('Automatic layout',()=>{for(const [,layer]of [...layers].sort((a,b)=>a[0]-b[0])){let minor=margin;let size=0;for(const node of layer){engine.update(node.id,{x:down?minor:major,y:down?major:minor,rotation:0,transform:undefined});minor+=(down?node.width:node.height)+nodeGap;size=Math.max(size,down?node.height:node.width);}major+=size+gap;}});
}
