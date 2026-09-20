/** Shared rich-text projection and layout. Measurements can be supplied by Canvas, Skia or a host. */
import type { RichText, Shape, ShapeStyle, TextBlock, TextParagraph, TextRun } from './model.js';
import { clone, DrawingError } from './model.js';
export type RunStyle = Pick<ShapeStyle,'fontFamily'|'fontSize'|'bold'|'italic'|'color'|'underline'|'strike'>;
export type TextMeasurer = (text:string,style:RunStyle)=>number;
export interface TextFragment { text:string; x:number; y:number; width:number; style:RunStyle }
export interface TextLayout { fragments:TextFragment[]; block:TextBlock; contentHeight:number; clipped:boolean }
export function textFont(style:RunStyle):string {return `${style.italic?'italic ':''}${style.bold?'700':'400'} ${Math.max(.1,style.fontSize)}px ${style.fontFamily}`;}
/** Deterministic headless fallback. Browser callers should supply actual font measurements. */
export const approximateTextMeasure:TextMeasurer=(text,style)=>Array.from(text).reduce((w,c)=>w+(/\s/.test(c)?.32:/[ilI.,:;'!|]/.test(c)?.28:/[MW@#]/.test(c)?.85:/[\u2e80-\uffff]/.test(c)?1:.56),0)*style.fontSize;
export function richTextFromString(text:string):RichText {return{paragraphs:text.split('\n').map(line=>({runs:[{text:line}]}))};}
export function formatTextRange(text:RichText,start:number,end:number,patch:TextRun['style']):RichText {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw new DrawingError('TEXT_RANGE','Invalid text range.');
  let offset=0;
  const paragraphs=text.paragraphs.map(p=>{const runs:TextRun[]=[];for(const run of p.runs){const from=Math.max(0,start-offset),to=Math.min(run.text.length,end-offset);
    if(from<to){if(from>0)runs.push({...clone(run),text:run.text.slice(0,from)});runs.push({...clone(run),text:run.text.slice(from,to),style:{...run.style,...patch}});if(to<run.text.length)runs.push({...clone(run),text:run.text.slice(to)});}
    else runs.push(clone(run));offset+=run.text.length;
  }offset++;return{...clone(p),runs};});return{paragraphs};
}
export function layoutText(shape:Shape,measure:TextMeasurer=approximateTextMeasure,maxFragments=20000):TextLayout {
  const style=shape.style,padding=style.padding??10;
  const verticalHeader=!!shape.container&&shape.container.orientation==='vertical';
  const block:TextBlock=shape.textBlock??(shape.container?
    verticalHeader?{x:0,y:0,width:shape.container.headerSize,height:shape.height,rotation:0}:
      {x:0,y:0,width:shape.width,height:shape.container.headerSize,rotation:0}:
    {x:0,y:0,width:shape.width,height:shape.height,rotation:0});
  const available=Math.max(0,block.width-padding*2),maxHeight=Math.max(0,block.height-padding*2),fragments:TextFragment[]=[];
  if(available<=0||maxHeight<=0)return{fragments,block,contentHeight:0,clipped:shape.text.length>0};
  const paragraphs=shape.richText?.paragraphs??richTextFromString(shape.text).paragraphs;
  interface Pending {text:string;width:number;style:RunStyle}
  interface Line {runs:Pending[];height:number;width:number;align:'left'|'center'|'right';indent:number;y:number}
  const lines:Line[]=[];let y=0,fragmentCount=0,clipped=false,number=0;
  const measureSafe=(text:string,s:RunStyle)=>{const w=measure(text,s);return Number.isFinite(w)&&w>=0?w:approximateTextMeasure(text,s);};
  paragraphLoop:for(const p of paragraphs){
    const indent=Math.max(0,p.indent??0)+(p.bullet&&p.bullet!=='none'?16:0),width=Math.max(1,available-indent),align=p.align??style.align;
    y+=Math.max(0,p.spaceBefore??0);
    let current:Pending[]=[],used=0,lineHeight=style.fontSize*(style.lineSpacing??1.3);
    const flush=()=>{lines.push({runs:current,height:lineHeight,width:used,align,indent,y});y+=lineHeight;current=[];used=0;lineHeight=style.fontSize*(style.lineSpacing??1.3);};
    if(p.bullet&&p.bullet!=='none'){
      const bullet=p.bullet==='number'?`${++number}.`:'•';
      // A bullet occupies the indentation gutter rather than changing the first word's measurement.
      current.push({text:bullet+' ',width:0,style});
    }else number=0;
    for(const run of p.runs){const s={...style,...run.style};for(let token of run.text.split(/(\n|\s+)/).filter(Boolean)){
      if(++fragmentCount>maxFragments){clipped=true;break paragraphLoop;}
      if(token==='\n'){flush();continue;}
      if(used===0&&/^\s+$/.test(token))continue;
      let w=measureSafe(token,s);
      if(used+w>width&&used>0){flush();if(/^\s+$/.test(token))continue;}
      while(w>width&&token.length){
        const chars=Array.from(token);let low=1,high=chars.length;
        while(low<high){const mid=Math.ceil((low+high)/2);if(measureSafe(chars.slice(0,mid).join(''),s)<=width)low=mid;else high=mid-1;}
        const piece=chars.slice(0,low).join('');current.push({text:piece,width:measureSafe(piece,s),style:s});used+=current.at(-1)!.width;lineHeight=Math.max(lineHeight,s.fontSize*(style.lineSpacing??1.3));flush();
        token=chars.slice(low).join('');w=measureSafe(token,s);if(++fragmentCount>maxFragments){clipped=true;break paragraphLoop;}
      }
      if(token){current.push({text:token,width:w,style:s});used+=w;lineHeight=Math.max(lineHeight,s.fontSize*(style.lineSpacing??1.3));}
    }}
    flush();y+=Math.max(0,p.spaceAfter??0);
  }
  const contentHeight=y,alignment=shape.container?'middle':style.verticalAlign??'middle',offset=alignment==='top'?0:alignment==='bottom'?Math.max(0,maxHeight-y):Math.max(0,(maxHeight-y)/2);
  for(const line of lines){
    if(line.y+offset>=maxHeight){clipped=true;break;}
    let x=padding+line.indent+(line.align==='center'?(available-line.indent-line.width)/2:line.align==='right'?available-line.indent-line.width:0);
    for(const run of line.runs){const bullet=run.width===0&&run.text.trim().length>0;fragments.push({text:run.text,x:bullet?padding:x,y:padding+offset+line.y+line.height*.78,width:run.width,style:run.style});x+=run.width;}
    if(line.y+line.height+offset>maxHeight)clipped=true;
  }
  return{fragments,block,contentHeight,clipped};
}

/** Native contenteditable implementation, importing only text/style data from its own DOM. */
export class RichTextEditor {
  readonly element:HTMLDivElement;
  private readonly abort=new AbortController();
  constructor(readonly host:HTMLElement,shape:Shape,readonly commit:(value:RichText)=>void,readonly cancel:()=>void){
    const doc=host.ownerDocument,root=this.element=doc.createElement('div');root.contentEditable='true';root.setAttribute('role','textbox');root.setAttribute('aria-multiline','true');root.setAttribute('aria-label','Edit shape text');
    root.style.cssText='position:absolute;box-sizing:border-box;background:white;border:2px solid #185abd;border-radius:2px;outline:none;overflow:auto;padding:8px;z-index:20;white-space:pre-wrap;word-break:break-word';
    root.style.color=shape.style.color;root.style.font=textFont(shape.style);root.style.textAlign=shape.style.align;
    for(const p of shape.richText?.paragraphs??richTextFromString(shape.text).paragraphs){const paragraph=doc.createElement('div');paragraph.dataset.paragraph='true';paragraph.style.margin='0';paragraph.style.textAlign=p.align??shape.style.align;
      if(p.bullet)paragraph.dataset.bullet=p.bullet;for(const key of ['indent','spaceBefore','spaceAfter'] as const)if(p[key]!==undefined)paragraph.dataset[key]=String(p[key]);paragraph.style.paddingLeft=`${p.indent??0}px`;paragraph.style.marginTop=`${p.spaceBefore??0}px`;paragraph.style.marginBottom=`${p.spaceAfter??0}px`;
      for(const run of p.runs){const span=doc.createElement('span');span.textContent=run.text;applyCss(span,run.style??{});paragraph.append(span);}if(!paragraph.textContent)paragraph.append(doc.createElement('br'));root.append(paragraph);}
    host.append(root);
    root.addEventListener('paste',event=>{event.preventDefault();this.insertText(event.clipboardData?.getData('text/plain')??'');},{signal:this.abort.signal});
    root.addEventListener('drop',event=>event.preventDefault(),{signal:this.abort.signal});
    root.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='Escape'){event.preventDefault();cancel();}
      else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();commit(this.value);}
      else if((event.ctrlKey||event.metaKey)&&['b','i','u'].includes(event.key.toLowerCase())){event.preventDefault();const key=({b:'bold',i:'italic',u:'underline'} as const)[event.key.toLowerCase() as 'b'|'i'|'u'];this.format({[key]:true});}
    },{signal:this.abort.signal});
    root.focus();const range=doc.createRange();range.selectNodeContents(root);const selection=doc.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  }
  get value():RichText {
    const paragraphs:TextParagraph[]=[];
    const read=(node:Node,inherited:TextRun['style'],runs:TextRun[]):void=>{
      if(node.nodeType===3){if(node.textContent)runs.push({text:node.textContent,style:{...inherited}});return;}
      if(node.nodeType!==1)return;const el=node as HTMLElement,style={...inherited,...readCss(el)};
      if(el.tagName==='BR'){runs.push({text:'\n',style});return;}
      for(const child of el.childNodes)read(child,style,runs);
    };
    let pending:TextRun[]=[];
    const append=(runs:TextRun[],el?:HTMLElement)=>{
      if(runs.length===1&&runs[0]!.text==='\n')runs=[];
      const align=el?.style.textAlign,bullet=el?.dataset.bullet;
      paragraphs.push({runs:runs.length?runs:[{text:''}],...(align==='left'||align==='center'||align==='right'?{align}:{}),...(bullet==='bullet'||bullet==='number'?{bullet}:{}),...Object.fromEntries(['indent','spaceBefore','spaceAfter'].filter(key=>el?.dataset[key]!==undefined&&Number.isFinite(Number(el.dataset[key]))).map(key=>[key,Number(el!.dataset[key])]))});
    };
    for(const node of this.element.childNodes){
      if(node.nodeType===1&&['DIV','P','LI'].includes((node as Element).tagName)){
        if(pending.length){append(pending);pending=[];}const runs:TextRun[]=[];read(node,{},runs);append(runs,node as HTMLElement);
      }else read(node,{},pending);
    }
    if(pending.length||!paragraphs.length)append(pending);return{paragraphs};
  }
  format(style:NonNullable<TextRun['style']>):void {
    const selection=this.host.ownerDocument.getSelection();if(!selection?.rangeCount)return;
    const range=selection.getRangeAt(0);if(!this.element.contains(range.commonAncestorContainer)||range.collapsed)return;
    const doc=this.host.ownerDocument,walker=doc.createTreeWalker(this.element,4),selected:Array<{node:Text;start:number;end:number}>=[];
    while(walker.nextNode()){const node=walker.currentNode as Text;if(range.intersectsNode(node)){const start=node===range.startContainer?range.startOffset:0,end=node===range.endContainer?range.endOffset:node.length;if(end>start)selected.push({node,start,end});}}
    const spans:HTMLElement[]=[];
    for(const item of selected.reverse()){const piece=doc.createRange();piece.setStart(item.node,item.start);piece.setEnd(item.node,item.end);const span=doc.createElement('span');applyCss(span,style);piece.surroundContents(span);spans.unshift(span);}
    if(spans.length){range.setStartBefore(spans[0]!);range.setEndAfter(spans.at(-1)!);selection.removeAllRanges();selection.addRange(range);}this.element.focus();
  }
  insertText(text:string):void {
    if(text.length>1_000_000)throw new DrawingError('TEXT_LIMIT','Pasted text exceeds one million characters.');
    const doc=this.host.ownerDocument,selection=doc.getSelection();if(!selection?.rangeCount)return;
    const range=selection.getRangeAt(0);if(!this.element.contains(range.commonAncestorContainer))return;
    range.deleteContents();const node=doc.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
  }
  dispose():void{this.abort.abort();this.element.remove();}
}
function applyCss(el:HTMLElement,style:NonNullable<TextRun['style']>):void {
  if(style.fontFamily!==undefined)el.style.fontFamily=style.fontFamily;
  if(style.fontSize!==undefined)el.style.fontSize=`${style.fontSize}px`;
  if(style.color!==undefined)el.style.color=style.color;
  if(style.bold!==undefined)el.style.fontWeight=style.bold?'700':'400';
  if(style.italic!==undefined)el.style.fontStyle=style.italic?'italic':'normal';
  if(style.underline!==undefined||style.strike!==undefined)el.style.textDecoration=[style.underline?'underline':'',style.strike?'line-through':''].filter(Boolean).join(' ')||'none';
}
function readCss(el:HTMLElement):NonNullable<TextRun['style']>{
  const s:NonNullable<TextRun['style']>={},c=el.style;
  if(c.fontFamily)s.fontFamily=c.fontFamily;if(c.fontSize){const n=Number.parseFloat(c.fontSize);if(Number.isFinite(n)&&n>0)s.fontSize=n;}if(c.color)s.color=c.color;
  if(c.fontWeight)s.bold=c.fontWeight==='bold'||Number(c.fontWeight)>=600;else if(['B','STRONG'].includes(el.tagName))s.bold=true;
  if(c.fontStyle)s.italic=c.fontStyle==='italic';else if(['I','EM'].includes(el.tagName))s.italic=true;
  if(c.textDecoration){s.underline=c.textDecoration.includes('underline');s.strike=c.textDecoration.includes('line-through');}
  else{if(el.tagName==='U')s.underline=true;if(['S','DEL','STRIKE'].includes(el.tagName))s.strike=true;}
  return s;
}
