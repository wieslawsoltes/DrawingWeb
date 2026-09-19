import type { Matrix, Point, Rect, Shape } from './model.js';
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function transformPoint(m: Matrix, p: Point): Point { return { x: m[0]*p.x+m[2]*p.y+m[4], y: m[1]*p.x+m[3]*p.y+m[5] }; }
export function inverse(m: Matrix): Matrix | undefined {
  const d = m[0]*m[3]-m[1]*m[2]; if (Math.abs(d) < 1e-12) return undefined;
  return [m[3]/d, -m[1]/d, -m[2]/d, m[0]/d, (m[2]*m[5]-m[3]*m[4])/d, (m[1]*m[4]-m[0]*m[5])/d];
}
export function translation(x: number, y: number): Matrix { return [1,0,0,1,x,y]; }
export function localMatrix(s: Shape): Matrix {
  const c = Math.cos(s.rotation), n = Math.sin(s.rotation), x = s.width/2, y = s.height/2;
  return multiply([c,n,-n,c,s.x+x-c*x+n*y,s.y+y-n*x-c*y], s.transform ?? IDENTITY);
}
export function intersects(a: Rect, b: Rect): boolean { return a.x <= b.x+b.width && a.x+a.width >= b.x && a.y <= b.y+b.height && a.y+a.height >= b.y; }
export function contains(r: Rect, p: Point): boolean { return p.x >= r.x && p.x <= r.x+r.width && p.y >= r.y && p.y <= r.y+r.height; }
export function inflate(r: Rect, amount: number): Rect { return { x:r.x-amount, y:r.y-amount, width:r.width+amount*2, height:r.height+amount*2 }; }
export function bounds(points: readonly Point[]): Rect {
  if (!points.length) return { x:0,y:0,width:0,height:0 };
  let x=Infinity,y=Infinity,r=-Infinity,b=-Infinity;
  for (const p of points) { x=Math.min(x,p.x); y=Math.min(y,p.y); r=Math.max(r,p.x); b=Math.max(b,p.y); }
  return { x,y,width:r-x,height:b-y };
}
export function transformedBounds(s: Shape, matrix: Matrix = localMatrix(s)): Rect {
  return bounds([{x:0,y:0},{x:s.width,y:0},{x:s.width,y:s.height},{x:0,y:s.height}].map(p=>transformPoint(matrix,p)));
}
export function union(rects: readonly Rect[]): Rect { return bounds(rects.flatMap(r=>[{x:r.x,y:r.y},{x:r.x+r.width,y:r.y+r.height}])); }
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy;
  const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
/** Mutable broad-phase spatial hash; oversized items avoid unbounded bucket insertion. */
export class SpatialIndex<T> {
  private cells = new Map<string, Set<T>>();
  private items = new Map<T,{bounds:Rect; keys:string[]}>();
  private large = new Set<T>();
  constructor(public readonly cellSize = 256, private readonly maxCells = 64) { if (!(cellSize>0)) throw new RangeError('cellSize must be positive.'); }
  private keys(r: Rect): string[] {
    const l=Math.floor(r.x/this.cellSize), t=Math.floor(r.y/this.cellSize), right=Math.floor((r.x+r.width)/this.cellSize), bottom=Math.floor((r.y+r.height)/this.cellSize);
    if ((right-l+1)*(bottom-t+1)>this.maxCells) return [];
    const result:string[]=[]; for(let y=t;y<=bottom;y++) for(let x=l;x<=right;x++) result.push(`${x}:${y}`); return result;
  }
  set(item:T, rect:Rect):void { this.delete(item); const keys=this.keys(rect); this.items.set(item,{bounds:{...rect},keys}); if(!keys.length)this.large.add(item); for(const key of keys){let bucket=this.cells.get(key);if(!bucket)this.cells.set(key,bucket=new Set());bucket.add(item);} }
  delete(item:T):void { const old=this.items.get(item); if(!old)return; for(const key of old.keys){const bucket=this.cells.get(key)!;bucket.delete(item);if(!bucket.size)this.cells.delete(key);}this.large.delete(item);this.items.delete(item); }
  search(rect:Rect):T[] { const keys=this.keys(rect);const candidates=new Set<T>(this.large); if(!keys.length)for(const item of this.items.keys())candidates.add(item); else for(const key of keys)for(const item of this.cells.get(key)??[])candidates.add(item);return [...candidates].filter(item=>intersects(rect,this.items.get(item)!.bounds)); }
  clear():void{this.cells.clear();this.items.clear();this.large.clear();}
  get size():number{return this.items.size;}
}
export function shapePath(shape: Shape): string {
  const w=shape.width,h=shape.height,r=Math.min(12,w/5,h/5),q=(n:number)=>+n.toFixed(5);
  if(shape.path)return shape.path;
  switch(shape.kind){
    case 'ellipse':return `M 0 ${h/2} A ${w/2} ${h/2} 0 1 0 ${w} ${h/2} A ${w/2} ${h/2} 0 1 0 0 ${h/2} Z`;
    case 'roundRect':return `M ${r} 0 H ${w-r} Q ${w} 0 ${w} ${r} V ${h-r} Q ${w} ${h} ${w-r} ${h} H ${r} Q 0 ${h} 0 ${h-r} V ${r} Q 0 0 ${r} 0 Z`;
    case 'diamond':return `M ${w/2} 0 L ${w} ${h/2} L ${w/2} ${h} L 0 ${h/2} Z`;
    case 'triangle':return `M ${w/2} 0 L ${w} ${h} L 0 ${h} Z`;
    case 'parallelogram':return `M ${w*.18} 0 H ${w} L ${w*.82} ${h} H 0 Z`;
    case 'hexagon':return `M ${w*.18} 0 H ${w*.82} L ${w} ${h/2} L ${w*.82} ${h} H ${w*.18} L 0 ${h/2} Z`;
    case 'document':return `M 0 0 H ${w} V ${h*.9} C ${w*.65} ${h*.65} ${w*.35} ${h*1.15} 0 ${h*.9} Z`;
    case 'database':return `M 0 ${h*.16} C 0 ${-h*.05} ${w} ${-h*.05} ${w} ${h*.16} V ${h*.84} C ${w} ${h*1.05} 0 ${h*1.05} 0 ${h*.84} Z M 0 ${h*.16} C 0 ${h*.37} ${w} ${h*.37} ${w} ${h*.16}`;
    case 'cloud':return `M ${q(w*.2)} ${q(h*.8)} C ${-w*.08} ${h*.8} ${-w*.06} ${h*.28} ${w*.2} ${h*.3} C ${w*.13} ${-h*.05} ${w*.55} ${-h*.12} ${w*.64} ${h*.22} C ${w*.96} ${-h*.04} ${w*1.15} ${h*.5} ${w*.86} ${h*.58} C ${w*1.09} ${h*.89} ${w*.73} ${h*1.08} ${w*.58} ${h*.83} C ${w*.43} ${h*1.09} ${w*.14} ${h*1.04} ${w*.2} ${h*.8} Z`;
    case 'text':case 'group':return '';
    default:return `M 0 0 H ${w} V ${h} H 0 Z`;
  }
}
