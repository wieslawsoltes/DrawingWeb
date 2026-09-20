/** Self-contained vector export using the same rich-text layout projection as Canvas. */
import { DiagramEngine } from './core.js';
import type { DiagramDocument, Page, Point, Shape } from './model.js';
import { safeHyperlink } from './model.js';
import { shapePath, transformPoint, transformedBounds } from './geometry.js';
import { connectorRoute } from './layout.js';
import { evaluateDataGraphic } from './features.js';
import { layoutText } from './text.js';
import type { TextMeasurer } from './text.js';
import { escapeXml } from './xml.js';
export interface SvgExportOptions { measureText?:TextMeasurer; hyperlinks?:boolean }
const n=(v:number)=>+v.toFixed(5),esc=escapeXml;
/** Imported strings are values, never a CSS declaration list or an external paint URL. */
export function safePaint(color:string,fallback='none'):string {
  return /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\))$/i.test(color)&&!color.toLowerCase().includes('url')?color:fallback;
}
export function exportSvg(document:DiagramDocument,pageId=document.pages[0]!.id,options:SvgExportOptions={}):string {
  const engine=new DiagramEngine(document,{historyLimit:0}),page=engine.getPage(pageId),output:string[]=[],defs:string[]=[];let clipId=0;
  const text=(shape:Shape):string=>{
    if(!shape.text)return '';const layout=layoutText(shape,options.measureText),b=layout.block,id=`dw-text-${++clipId}`;
    defs.push(`<clipPath id="${id}"><rect width="${n(b.width)}" height="${n(b.height)}"/></clipPath>`);
    return `<g transform="translate(${n(b.x+b.width/2)} ${n(b.y+b.height/2)}) rotate(${n((b.rotation??0)*180/Math.PI)}) translate(${-n(b.width/2)} ${-n(b.height/2)})" clip-path="url(#${id})">`+
      layout.fragments.map(run=>`<text xml:space="preserve" x="${n(run.x)}" y="${n(run.y)}" fill="${esc(safePaint(run.style.color,'#000000'))}" font-family="${esc(run.style.fontFamily)}" font-size="${n(run.style.fontSize)}" font-weight="${run.style.bold?'700':'400'}" font-style="${run.style.italic?'italic':'normal'}" text-decoration="${[run.style.underline?'underline':'',run.style.strike?'line-through':''].filter(Boolean).join(' ')||'none'}">${esc(run.text)}</text>`).join('')+'</g>';
  };
  const arrow=(a:Point,b:Point,color:string,width:number)=>{const angle=Math.atan2(b.y-a.y,b.x-a.x),size=Math.max(8,3*width),c=Math.cos(angle),s=Math.sin(angle);return `<path d="M ${n(b.x)} ${n(b.y)} L ${n(b.x-size*c+size*.4*s)} ${n(b.y-size*s-size*.4*c)} L ${n(b.x-size*c-size*.4*s)} ${n(b.y-size*s+size*.4*c)} Z" fill="${esc(color)}"/>`;};
  const visit=(source:Page,shapes:Shape[],visible=true,parentOpacity=1)=>{for(const shape of shapes){
    const layer=source.layers.find(l=>l.id===(shape.layerId??'default')),shown=visible&&shape.visible!==false&&layer?.visible!==false&&layer?.printable!==false;if(!shown)continue;
    const graphic=evaluateDataGraphic(shape,document.dataGraphics??[]),style=graphic.style,opacity=parentOpacity*style.opacity,ref=engine.getRef(shape.id)!,color=safePaint(style.stroke,'#000000');
    const address=options.hyperlinks===false?undefined:shape.hyperlinks?.map(link=>link.address?safeHyperlink(link.address):undefined).find(Boolean);
    if(address)output.push(`<a href="${esc(address)}" target="_blank" rel="noopener noreferrer">`);
    output.push(`<g opacity="${n(opacity)}">`);
    if(shape.kind==='connector'){
      const points=connectorRoute(engine,shape).points;
      output.push(`<polyline points="${points.map(p=>`${n(p.x)},${n(p.y)}`).join(' ')}" fill="none" stroke="${esc(color)}" stroke-width="${style.strokeWidth}" stroke-linejoin="round"${style.dash.length?` stroke-dasharray="${style.dash.join(' ')}"`:''}/>`);
      if(points.length>1){if(style.endArrow)output.push(arrow(points.at(-2)!,points.at(-1)!,color,style.strokeWidth));if(style.startArrow)output.push(arrow(points[1]!,points[0]!,color,style.strokeWidth));}
      if(shape.text&&points.length>1){const i=Math.floor((points.length-1)/2),a=points[i]!,b=points[i+1]!,x=(a.x+b.x)/2,y=(a.y+b.y)/2;
        output.push(`<text x="${n(x)}" y="${n(y)}" text-anchor="middle" dominant-baseline="middle" fill="${esc(safePaint(style.color,'#000000'))}" font-family="${esc(style.fontFamily)}" font-size="${style.fontSize}" paint-order="stroke" stroke="white" stroke-width="5" stroke-linejoin="round">${esc(shape.text)}</text>`);
      }
    }else{
      if(shape.calloutTargetId){const target=engine.getShape(shape.calloutTargetId),targetRef=engine.getRef(shape.calloutTargetId);if(target&&targetRef){const r=transformedBounds(target,targetRef.matrix),a=transformPoint(ref.matrix,{x:shape.width/2,y:shape.height/2});output.push(`<path d="M ${n(a.x)} ${n(a.y)} L ${n(r.x+r.width/2)} ${n(r.y+r.height/2)}" fill="none" stroke="${esc(color)}" stroke-width="${style.strokeWidth}"/>`);}}
      output.push(`<g transform="matrix(${ref.matrix.map(n).join(' ')})">`);
      const path=shapePath(shape);if(path)output.push(`<path d="${esc(path)}" fill="${esc(safePaint(style.fill))}" stroke="${esc(color)}" stroke-width="${style.strokeWidth}" stroke-linejoin="round"${style.dash.length?` stroke-dasharray="${style.dash.join(' ')}"`:''}/>`);
      if(shape.container){const h=shape.container.headerSize,v=shape.container.orientation==='vertical';output.push(`<rect width="${n(v?h:shape.width)}" height="${n(v?shape.height:h)}" fill="${esc(color)}" opacity="0.09"/><path d="${v?`M ${h} 0 V ${shape.height}`:`M 0 ${h} H ${shape.width}`}" stroke="${esc(color)}" stroke-width="${style.strokeWidth}"/>`);}
      if(shape.image){const id=`dw-image-${++clipId}`;defs.push(`<clipPath id="${id}"><rect width="${n(shape.width)}" height="${n(shape.height)}"/></clipPath>`);output.push(`<image href="${esc(shape.image.source)}" width="${n(shape.width)}" height="${n(shape.height)}" preserveAspectRatio="${shape.image.fit==='stretch'?'none':shape.image.fit==='cover'?'xMidYMid slice':'xMidYMid meet'}" clip-path="url(#${id})"><title>${esc(shape.image.alt)}</title></image>`);}
      output.push(text({...shape,style}));
      for(const rule of graphic.items){if(rule.type==='bar')output.push(`<rect y="${rule.y}" width="${shape.width}" height="16" fill="${esc(safePaint(rule.background))}"/><rect y="${rule.y}" width="${n(shape.width*(rule.fraction??0))}" height="16" fill="${esc(safePaint(rule.color))}"/>`);output.push(`<text x="${rule.type==='bar'?5:0}" y="${rule.y+12}" font-family="Arial, sans-serif" font-size="12" fill="${esc(safePaint(rule.type==='bar'?'#172b4d':rule.color,'#000000'))}">${esc((rule.type==='icon'?'● ':'')+rule.text)}</text>`);}
      output.push('</g>');
    }
    output.push('</g>');if(address)output.push('</a>');if(shape.children)visit(source,shape.children,shown,opacity);
  }};
  try{const chain:Page[]=[];let current:Page|undefined=page;while(current){chain.unshift(current);current=current.backgroundPageId?engine.getPage(current.backgroundPageId):undefined;}for(const source of chain)visit(source,source.shapes);
    return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}" role="img" aria-label="${esc(page.name)}"><title>${esc(document.title+' — '+page.name)}</title><defs>${defs.join('')}</defs><rect width="100%" height="100%" fill="${esc(safePaint(page.background,'#ffffff'))}"/>${output.join('')}</svg>`;
  }finally{engine.dispose();}
}
