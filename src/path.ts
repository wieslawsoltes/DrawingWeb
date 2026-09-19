import { DrawingError } from './model.js';
import type { Matrix, Point } from './model.js';
import { transformPoint } from './geometry.js';
export type PathSegment={kind:'move';end:Point}|{kind:'line';end:Point}|{kind:'cubic';a:Point;b:Point;end:Point}|{kind:'close';end:Point};
const counts:Record<string,number>={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};
/** Parses SVG path syntax into move/line/cubic/close segments without DOM APIs or evaluation. */
export function parsePath(path:string,maxSegments=100000):PathSegment[]{
  if(path.length>8*1024*1024)throw new DrawingError('PATH_LIMIT','Path input exceeds the limit.');const tokens=path.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)??[];
  if(path.replace(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g,''))throw new DrawingError('PATH_SYNTAX','Invalid SVG path characters.');
  let index=0,command='',point:Point={x:0,y:0},start={...point},lastCubic:Point|undefined,lastQuad:Point|undefined,previous='';const result:PathSegment[]=[];
  const number=()=>{const value=Number(tokens[index++]);if(!Number.isFinite(value))throw new DrawingError('PATH_NUMBER','Missing or invalid path coordinate.');return value;};
  while(index<tokens.length){if(/^[A-Za-z]$/.test(tokens[index]!))command=tokens[index++]!;else if(!command)throw new DrawingError('PATH_SYNTAX','A path must begin with a command.');
    const upper=command.toUpperCase(),relative=command!==upper;if(counts[upper]===undefined)throw new DrawingError('PATH_COMMAND',`Unsupported SVG path command: ${command}`);
    if(index+counts[upper]!>tokens.length)throw new DrawingError('PATH_SYNTAX','Incomplete SVG path command.');const origin={...point};const pair=():Point=>{const x=number(),y=number();return{x:x+(relative?origin.x:0),y:y+(relative?origin.y:0)};};
    if(upper==='Z'){point={...start};result.push({kind:'close',end:point});command='';}
    else if(upper==='M'){point=pair();start={...point};result.push({kind:'move',end:point});command=relative?'l':'L';}
    else if(upper==='L'){point=pair();result.push({kind:'line',end:point});}
    else if(upper==='H'){point={x:number()+(relative?origin.x:0),y:origin.y};result.push({kind:'line',end:point});}
    else if(upper==='V'){point={x:origin.x,y:number()+(relative?origin.y:0)};result.push({kind:'line',end:point});}
    else if(upper==='C'){const a=pair(),b=pair();point=pair();result.push({kind:'cubic',a,b,end:point});lastCubic=b;}
    else if(upper==='S'){const a=(previous==='C'||previous==='S')&&lastCubic?{x:2*origin.x-lastCubic.x,y:2*origin.y-lastCubic.y}:origin,b=pair();point=pair();result.push({kind:'cubic',a,b,end:point});lastCubic=b;}
    else if(upper==='Q'||upper==='T'){const q=upper==='Q'?pair():(previous==='Q'||previous==='T')&&lastQuad?{x:2*origin.x-lastQuad.x,y:2*origin.y-lastQuad.y}:origin;point=pair();const a={x:origin.x+(q.x-origin.x)*2/3,y:origin.y+(q.y-origin.y)*2/3},b={x:point.x+(q.x-point.x)*2/3,y:point.y+(q.y-point.y)*2/3};result.push({kind:'cubic',a,b,end:point});lastQuad=q;}
    else if(upper==='A'){const rx=number(),ry=number(),angle=number(),large=number(),sweep=number();if((large!==0&&large!==1)||(sweep!==0&&sweep!==1))throw new DrawingError('PATH_ARC','Arc flags must be zero or one.');point=pair();result.push(...arcToCubics(origin,point,rx,ry,angle,!!large,!!sweep));}
    previous=upper;if(upper!=='C'&&upper!=='S')lastCubic=undefined;if(upper!=='Q'&&upper!=='T')lastQuad=undefined;if(result.length>maxSegments)throw new DrawingError('PATH_LIMIT','Too many path segments.');
  }return result;
}
/** SVG endpoint-parameterized ellipse conversion, split into at most 45-degree cubic spans. */
function arcToCubics(start:Point,end:Point,rx:number,ry:number,degrees:number,large:boolean,sweep:boolean):PathSegment[]{
  rx=Math.abs(rx);ry=Math.abs(ry);if(!rx||!ry)return[{kind:'line',end}];if(start.x===end.x&&start.y===end.y)return[];
  const angle=degrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),dx=(start.x-end.x)/2,dy=(start.y-end.y)/2,x=c*dx+s*dy,y=-s*dx+c*dy;
  const lambda=x*x/(rx*rx)+y*y/(ry*ry);if(lambda>1){rx*=Math.sqrt(lambda);ry*=Math.sqrt(lambda);}
  const denominator=rx*rx*y*y+ry*ry*x*x,coefficient=(large===sweep?-1:1)*Math.sqrt(Math.max(0,(rx*rx*ry*ry-denominator)/Math.max(denominator,Number.MIN_VALUE)));
  const cxp=coefficient*rx*y/ry,cyp=-coefficient*ry*x/rx,cx=c*cxp-s*cyp+(start.x+end.x)/2,cy=s*cxp+c*cyp+(start.y+end.y)/2;
  const signed=(ux:number,uy:number,vx:number,vy:number)=>Math.atan2(ux*vy-uy*vx,ux*vx+uy*vy);
  let theta=signed(1,0,(x-cxp)/rx,(y-cyp)/ry),delta=signed((x-cxp)/rx,(y-cyp)/ry,(-x-cxp)/rx,(-y-cyp)/ry);
  if(!sweep&&delta>0)delta-=Math.PI*2;if(sweep&&delta<0)delta+=Math.PI*2;const spans=Math.max(1,Math.ceil(Math.abs(delta)/(Math.PI/4))),step=delta/spans,result:PathSegment[]=[];
  const at=(t:number):Point=>({x:cx+rx*c*Math.cos(t)-ry*s*Math.sin(t),y:cy+rx*s*Math.cos(t)+ry*c*Math.sin(t)});
  const derivative=(t:number):Point=>({x:-rx*c*Math.sin(t)-ry*s*Math.cos(t),y:-rx*s*Math.sin(t)+ry*c*Math.cos(t)});
  for(let i=0;i<spans;i++){const next=theta+step,p=at(theta),q=at(next),dp=derivative(theta),dq=derivative(next),k=4/3*Math.tan(step/4);result.push({kind:'cubic',a:{x:p.x+k*dp.x,y:p.y+k*dp.y},b:{x:q.x-k*dq.x,y:q.y-k*dq.y},end:i===spans-1?end:q});theta=next;}return result;
}
export function transformSegments(segments:readonly PathSegment[],matrix:Matrix):PathSegment[]{return segments.map(segment=>segment.kind==='cubic'?{kind:'cubic',a:transformPoint(matrix,segment.a),b:transformPoint(matrix,segment.b),end:transformPoint(matrix,segment.end)}:{kind:segment.kind,end:transformPoint(matrix,segment.end)});}
export function serializePath(segments:readonly PathSegment[]):string{const n=(v:number)=>+v.toFixed(6);return segments.map(segment=>segment.kind==='move'?`M ${n(segment.end.x)} ${n(segment.end.y)}`:segment.kind==='line'?`L ${n(segment.end.x)} ${n(segment.end.y)}`:segment.kind==='close'?'Z':`C ${n(segment.a.x)} ${n(segment.a.y)} ${n(segment.b.x)} ${n(segment.b.y)} ${n(segment.end.x)} ${n(segment.end.y)}`).join(' ');}
