import { DiagramEngine, createDocument, createShape, clone, DrawingError, id, parseDocument, Signal } from './core.js';
import type { DiagramDocument, Matrix, Page, Point, Rect, Shape, ShapeKind, Unsubscribe } from './model.js';
import { bounds, contains, distanceToSegment, IDENTITY, inflate, inverse, localMatrix, multiply, shapePath, SpatialIndex, transformPoint, transformedBounds, translation, union } from './geometry.js';
import { connectorRoute } from './layout.js';
import { parsePath, serializePath, transformSegments } from './path.js';

export interface Viewport { zoom: number; x: number; y: number }
export type DrawingTool = 'select' | 'pan' | 'connector' | 'pen' | Exclude<ShapeKind, 'connector' | 'group' | 'path'>;
export interface DrawingControlOptions {
  engine?: DiagramEngine; document?: DiagramDocument; pageId?: string; readOnly?: boolean;
  grid?: boolean; snap?: boolean; gridSize?: number; zoom?: number; minZoom?: number; maxZoom?: number;
  ariaLabel?: string; background?: string; selectionColor?: string; onError?: (error: unknown) => void;
}
export interface RenderStatistics { visibleShapes: number; totalShapes: number; renderMilliseconds: number }
interface RenderItem { shape: Shape; matrix: Matrix; rect: Rect; opacity: number; locked: boolean; parentId?: string; order: number; route?: Point[] }
interface DragState { pointer: number; mode: 'move' | 'pan' | 'marquee' | 'resize' | 'rotate' | 'create' | 'pen'; start: Point; current: Point; screen: Point; ids: string[]; viewport: Viewport; shape?: Shape; handle?: number; points?: Point[]; add?: boolean }
const handles = (r: Rect): Point[] => [{ x:r.x,y:r.y },{ x:r.x+r.width/2,y:r.y },{ x:r.x+r.width,y:r.y },{ x:r.x+r.width,y:r.y+r.height/2 },{ x:r.x+r.width,y:r.y+r.height },{ x:r.x+r.width/2,y:r.y+r.height },{ x:r.x,y:r.y+r.height },{ x:r.x,y:r.y+r.height/2 }];
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const inputTarget = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"]');
const transparent = (color: string): boolean => color === 'none' || color === 'transparent';

/** Retained display list shared by the editor and bitmap export. Browser globals are accessed only when instantiated. */
export class CanvasRenderer {
  private paths = new Map<string, { signature: string; value: Path2D }>();
  private index = new SpatialIndex<RenderItem>();
  private items: RenderItem[] = [];
  private byId = new Map<string, RenderItem>();
  private revision = -1;
  private pageId = '';
  statistics: RenderStatistics = { visibleShapes:0, totalShapes:0, renderMilliseconds:0 };
  constructor(readonly engine: DiagramEngine) {}
  prepare(pageId: string): void {
    if (this.revision === this.engine.revision && this.pageId === pageId) return;
    this.pageId = pageId; this.revision = this.engine.revision; this.items = []; this.index.clear(); this.byId.clear();
    const page = this.engine.getPage(pageId), layers = new Map(page.layers.map(layer => [layer.id,layer])); let order = 0;
    const walk = (shapes: Shape[], visible: boolean, opacity: number, locked: boolean, parentId?: string) => {
      for (const shape of shapes) {
        const layer = layers.get(shape.layerId ?? 'default'), shown = visible && shape.visible !== false && layer?.visible !== false;
        if (!shown) continue;
        const matrix = this.engine.getRef(shape.id)!.matrix, route = shape.kind === 'connector' ? connectorRoute(this.engine, shape).points : undefined;
        const rect = route ? bounds(route) : transformedBounds(shape,matrix);
        const item: RenderItem = { shape, matrix, rect, route, opacity:opacity*shape.style.opacity, locked:locked || !!shape.locked || !!layer?.locked, parentId, order:order++ };
        this.items.push(item); this.byId.set(shape.id,item); this.index.set(item,inflate(rect,Math.max(8,shape.style.strokeWidth*2)));
        if (shape.children) walk(shape.children,shown,item.opacity,item.locked,shape.id);
      }
    };
    walk(page.shapes,true,1,false);
    for (const key of this.paths.keys()) if (!this.byId.has(key)) this.paths.delete(key);
  }
  getItem(shapeId: string): Readonly<RenderItem> | undefined { return this.byId.get(shapeId); }
  get displayList(): readonly Readonly<RenderItem>[] { return this.items; }
  private path(shape: Shape): Path2D {
    const signature = shapePath(shape), cached = this.paths.get(shape.id); if (cached?.signature === signature) return cached.value;
    const value = new Path2D(signature); this.paths.set(shape.id,{signature,value}); return value;
  }
  query(rect: Rect): readonly Readonly<RenderItem>[] { return this.index.search(rect).sort((a,b) => a.order-b.order); }
  hit(context: CanvasRenderingContext2D, point: Point, tolerance: number, descend = false): string | undefined {
    const candidates = this.index.search(inflate({ ...point,width:0,height:0 },tolerance)).sort((a,b) => b.order-a.order);
    for (const item of candidates) {
      const {shape,matrix,route} = item; if (item.locked) continue;
      let hit = false;
      if (route) { for(let i=1;i<route.length;i++) if(distanceToSegment(point,route[i-1]!,route[i]!) <= tolerance + shape.style.strokeWidth/2) { hit=true;break; } }
      else {
        const inv = inverse(matrix); if (!inv) continue; const local = transformPoint(inv,point);
        if (shape.kind === 'text' || shape.kind === 'group') hit = contains({x:0,y:0,width:shape.width,height:shape.height},local);
        else { context.save(); context.setTransform(1,0,0,1,0,0); context.lineWidth=shape.style.strokeWidth+tolerance*2; const path=this.path(shape); hit=(!transparent(shape.style.fill) && context.isPointInPath(path,local.x,local.y)) || context.isPointInStroke(path,local.x,local.y); context.restore(); }
      }
      if (hit) { let result=item; if (!descend) while(result.parentId) { const parent=this.byId.get(result.parentId); if(!parent)break;result=parent; } return result.shape.id; }
    }
    return undefined;
  }
  draw(context: CanvasRenderingContext2D, pageId: string, viewport: Viewport, width: number, height: number, pixelRatio = 1, options: { grid?:boolean; gridSize?:number; background?:string; preview?:ReadonlyMap<string,Matrix> } = {}): void {
    const began = performance.now(); this.prepare(pageId); const page=this.engine.getPage(pageId);
    context.setTransform(pixelRatio,0,0,pixelRatio,0,0); context.clearRect(0,0,width,height);
    context.fillStyle=options.background??'#efedf3';context.fillRect(0,0,width,height);
    context.translate(viewport.x,viewport.y);context.scale(viewport.zoom,viewport.zoom);
    context.save();context.shadowColor='#2a204319';context.shadowBlur=20/viewport.zoom;context.shadowOffsetY=4/viewport.zoom;
    context.fillStyle=page.background;context.fillRect(0,0,page.width,page.height);context.restore();
    context.save(); context.beginPath();context.rect(0,0,page.width,page.height);context.clip();
    const view:Rect={x:-viewport.x/viewport.zoom,y:-viewport.y/viewport.zoom,width:width/viewport.zoom,height:height/viewport.zoom};
    if(options.grid && viewport.zoom*(options.gridSize??20)>=5){const step=options.gridSize??20;context.fillStyle='#c7c2d550';const r=.75/viewport.zoom;
      const left=Math.max(0,Math.floor(view.x/step)*step),top=Math.max(0,Math.floor(view.y/step)*step),right=Math.min(page.width,view.x+view.width),bottom=Math.min(page.height,view.y+view.height);
      for(let y=top;y<=bottom;y+=step)for(let x=left;x<=right;x+=step)context.fillRect(x-r,y-r,r*2,r*2);
    }
    const selected = this.index.search(inflate(view,30/viewport.zoom));
    // Moved items may enter the viewport from outside the broad-phase range.
    for(const key of options.preview?.keys()??[]) {const item=this.byId.get(key);if(item&&!selected.includes(item))selected.push(item);}
    selected.sort((a,b)=>a.order-b.order);let drawn=0;
    for(const item of selected){if(item.shape.kind==='group'&&!item.shape.text)continue;context.save();context.globalAlpha=clamp(item.opacity,0,1);
      let matrix=item.matrix;let ancestor:RenderItem|undefined=item;let preview:Matrix|undefined;
      while(ancestor){preview=options.preview?.get(ancestor.shape.id);if(preview)break;ancestor=ancestor.parentId?this.byId.get(ancestor.parentId):undefined;}
      if(preview)matrix=multiply(preview,matrix);
      this.drawItem(context,item,matrix,preview);context.restore();drawn++;
    }
    context.restore();this.statistics={visibleShapes:drawn,totalShapes:this.items.length,renderMilliseconds:performance.now()-began};
  }
  private drawItem(c: CanvasRenderingContext2D, item: RenderItem, matrix: Matrix, preview?: Matrix): void {
    const s=item.shape,style=s.style;c.strokeStyle=style.stroke;c.fillStyle=style.fill;c.lineWidth=style.strokeWidth;c.lineJoin='round';c.lineCap='round';c.setLineDash(style.dash);
    if(item.route){const p=preview?item.route.map(point=>transformPoint(preview,point)):item.route;if(!p.length)return;c.beginPath();c.moveTo(p[0]!.x,p[0]!.y);for(const point of p.slice(1))c.lineTo(point.x,point.y);if(!transparent(style.stroke))c.stroke();c.setLineDash([]);c.fillStyle=style.stroke;if(style.endArrow&&p.length>1)this.arrow(c,p.at(-2)!,p.at(-1)!,style.strokeWidth);if(style.startArrow&&p.length>1)this.arrow(c,p[1]!,p[0]!,style.strokeWidth);
      if(s.text){const middle=p[Math.floor((p.length-1)/2)]!,next=p[Math.min(p.length-1,Math.floor((p.length-1)/2)+1)]!;const x=(middle.x+next.x)/2,y=(middle.y+next.y)/2;c.font=`${style.italic?'italic ':''}${style.bold?'600 ':''}${style.fontSize}px ${style.fontFamily}`;const w=Math.min(320,Math.max(24,c.measureText(s.text).width+12)),h=style.fontSize*1.6;c.translate(x-w/2,y-h/2);c.fillStyle='#ffffffed';c.fillRect(0,0,w,h);this.drawText(c,s,w,h);}return;
    }
    c.transform(...matrix);const path=this.path(s);if(s.kind!=='text'&&s.kind!=='group'){if(!transparent(style.fill))c.fill(path);if(!transparent(style.stroke)&&style.strokeWidth>0)c.stroke(path);}this.drawText(c,s,s.width,s.height);
  }
  private arrow(c:CanvasRenderingContext2D,a:Point,b:Point,width:number):void{const angle=Math.atan2(b.y-a.y,b.x-a.x),length=Math.max(8,3*width);c.save();c.translate(b.x,b.y);c.rotate(angle);c.beginPath();c.moveTo(0,0);c.lineTo(-length,-length*.4);c.lineTo(-length,length*.4);c.closePath();c.fill();c.restore();}
  private drawText(c:CanvasRenderingContext2D,s:Shape,width:number,height:number):void{
    if(!s.text)return;const st=s.style,size=Math.max(1,st.fontSize),lineHeight=size*1.3;c.font=`${st.italic?'italic ':''}${st.bold?'bold ':''}${size}px ${st.fontFamily}`;c.fillStyle=st.color;c.textBaseline='middle';c.textAlign=st.align;
    const available=Math.max(1,width-16),lines:string[]=[];
    for(const paragraph of s.text.split('\n')){if(!paragraph){lines.push('');continue;}let line='';for(const word of paragraph.split(/\s+/)){const candidate=line?line+' '+word:word;if(line&&c.measureText(candidate).width>available){lines.push(line);line=word;}else line=candidate;}lines.push(line);}
    c.save();c.beginPath();c.rect(0,0,width,height);c.clip();const x=st.align==='left'?8:st.align==='right'?width-8:width/2,y=(height-(lines.length-1)*lineHeight)/2;
    lines.forEach((line,i)=>c.fillText(line,x,y+i*lineHeight));c.restore();
  }
  dispose():void{this.paths.clear();this.items=[];this.byId.clear();this.index.clear();}
}

/** Standalone keyboard/pointer editor. It never owns an engine supplied by the caller. */
export class DrawingControl {
  readonly engine: DiagramEngine;
  readonly renderer: CanvasRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly root: HTMLDivElement;
  readonly viewChanged = new Signal<Viewport>();
  readonly toolChanged = new Signal<DrawingTool>();
  readonly errors = new Signal<unknown>();
  readonly rendered = new Signal<RenderStatistics>();
  private readonly context: CanvasRenderingContext2D;
  private readonly owned: boolean;
  private readonly abort = new AbortController();
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly observer: ResizeObserver;
  private readonly accessibility: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private editor?: HTMLTextAreaElement;
  private options: DrawingControlOptions;
  private frame = 0;
  private disposed = false;
  private drag?: DragState;
  private space = false;
  private connectSource?: string;
  private _tool: DrawingTool = 'select';
  private _pageId: string;
  private _viewport: Viewport;
  private clipboard?: Shape[];
  constructor(readonly host: HTMLElement, options: DrawingControlOptions = {}) {
    if (!host?.ownerDocument) throw new DrawingError('HOST_REQUIRED','A browser HTMLElement host is required.');
    this.options={grid:true,snap:true,gridSize:20,minZoom:.05,maxZoom:16,...options};this.owned=!options.engine;this.engine=options.engine??new DiagramEngine(options.document??createDocument());this.renderer=new CanvasRenderer(this.engine);
    this._pageId=options.pageId??this.engine.document.pages[0]!.id;this.engine.getPage(this._pageId);this._viewport={zoom:options.zoom??1,x:32,y:32};
    const doc=host.ownerDocument;this.root=doc.createElement('div');this.root.className='drawingweb-control';this.root.style.cssText='position:relative;width:100%;height:100%;min-height:120px;overflow:hidden;isolation:isolate';
    this.canvas=doc.createElement('canvas');this.canvas.style.cssText='display:block;width:100%;height:100%;outline:none;touch-action:none';this.canvas.tabIndex=0;this.canvas.setAttribute('role','application');this.canvas.setAttribute('aria-label',options.ariaLabel??'Diagram editor. Tab to enter; use arrow keys to move selected shapes. Press F2 to edit text.');
    this.canvas.setAttribute('aria-describedby',`${id('help')}`);const help=doc.createElement('span');help.id=this.canvas.getAttribute('aria-describedby')!;help.textContent='Press Enter to select the first shape, then Alt+ArrowRight or Alt+ArrowLeft to navigate shapes. Hold Shift to add to selection. Escape cancels. Control+Z undoes. Tab leaves the drawing.';
    help.style.cssText='position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
    this.accessibility=doc.createElement('div');this.accessibility.setAttribute('role','listbox');this.accessibility.setAttribute('aria-label','Diagram shapes');this.accessibility.setAttribute('aria-multiselectable','true');this.accessibility.style.cssText=help.style.cssText;
    this.live=doc.createElement('div');this.live.setAttribute('aria-live','polite');this.live.style.cssText=help.style.cssText;
    this.root.append(this.canvas,help,this.accessibility,this.live);host.append(this.root);
    const context=this.canvas.getContext('2d');if(!context){this.root.remove();throw new DrawingError('CANVAS_UNAVAILABLE','Canvas 2D rendering is unavailable.');}this.context=context;
    this.observer=new ResizeObserver(()=>this.invalidate());this.observer.observe(this.root);
    const listen=<K extends keyof HTMLElementEventMap>(type:K,callback:(event:HTMLElementEventMap[K])=>void,options:AddEventListenerOptions={})=>this.canvas.addEventListener(type,callback as EventListener,{...options,signal:this.abort.signal});
    listen('pointerdown',e=>this.safe(()=>this.pointerDown(e)));listen('pointermove',e=>this.safe(()=>this.pointerMove(e)));listen('pointerup',e=>this.safe(()=>this.pointerUp(e)));listen('pointercancel',()=>this.cancelGesture());listen('lostpointercapture',()=>{if(this.drag)this.cancelGesture();});
    listen('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.metaKey)this.setZoom(this._viewport.zoom*Math.exp(-e.deltaY*.008),this.screenPoint(e));else{this._viewport={...this._viewport,x:this._viewport.x-e.deltaX,y:this._viewport.y-e.deltaY};this.viewportChanged();}},{passive:false});
    listen('keydown',e=>this.safe(()=>this.keyDown(e)));listen('keyup',e=>{if(e.code==='Space'){this.space=false;this.updateCursor();}});listen('blur',()=>{this.space=false;this.updateCursor();});
    listen('dblclick',e=>{if(this.options.readOnly)return;const hit=this.hitTest(this.worldPoint(e),true);if(hit)this.editText(hit);});
    listen('copy',e=>this.copyEvent(e));listen('cut',e=>{if(!this.options.readOnly){this.copyEvent(e);this.engine.remove(this.engine.selection);}});listen('paste',e=>this.safe(()=>this.pasteEvent(e)));
    listen('dragover',e=>{if(!this.options.readOnly&&e.dataTransfer?.types.includes('application/x-drawingweb-stencil')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
    listen('drop',e=>this.safe(()=>{if(this.options.readOnly)return;const kind=e.dataTransfer?.getData('application/x-drawingweb-stencil') as ShapeKind;if(kind&&STENCILS.includes(kind)){e.preventDefault();this.addShape(kind,this.worldPoint(e));}}));
    this.subscriptions.push(this.engine.changed.subscribe(()=>{if(!this.engine.document.pages.some(p=>p.id===this._pageId))this._pageId=this.engine.document.pages[0]!.id;this.updateAccessible();this.invalidate();}),this.engine.selectionChanged.subscribe(()=>{this.updateAccessible();this.live.textContent=`${this.engine.selection.length} shape${this.engine.selection.length===1?'':'s'} selected`;this.invalidate();}));
    this.updateAccessible();this.invalidate();
  }
  get isDisposed():boolean{return this.disposed;}
  get pageId():string{return this._pageId;}
  set pageId(value:string){this.engine.getPage(value);if(this._pageId===value)return;this.cancelGesture();this.finishText(true);this._pageId=value;this.engine.select([]);this.updateAccessible();this.fit();}
  get viewport():Readonly<Viewport>{return {...this._viewport};}
  get tool():DrawingTool{return this._tool;}
  set tool(value:DrawingTool){this.cancelGesture();this.connectSource=undefined;this._tool=value;this.updateCursor();this.toolChanged.emit(value);}
  get readOnly():boolean{return !!this.options.readOnly;}
  setOptions(options:Partial<Omit<DrawingControlOptions,'engine'|'document'>>):void{this.options={...this.options,...options};if(options.readOnly){this.cancelGesture();this.finishText(false);}if(options.pageId)this.pageId=options.pageId;if(options.zoom!==undefined)this.setZoom(options.zoom);if(options.ariaLabel)this.canvas.setAttribute('aria-label',options.ariaLabel);this.invalidate();}
  focus():void{this.canvas.focus({preventScroll:true});}
  fit(padding=32):void{const page=this.engine.getPage(this._pageId),r=this.root.getBoundingClientRect();const zoom=clamp(Math.min((r.width-2*padding)/page.width,(r.height-2*padding)/page.height),this.options.minZoom!,this.options.maxZoom!);this._viewport={zoom,x:(r.width-page.width*zoom)/2,y:(r.height-page.height*zoom)/2};this.viewportChanged();}
  fitSelection(padding=48):void{this.renderer.prepare(this.pageId);const items=this.engine.selection.map(key=>this.renderer.getItem(key)).filter((i):i is RenderItem=>!!i);if(!items.length){this.fit();return;}const b=union(items.map(i=>i.rect)),r=this.root.getBoundingClientRect(),zoom=clamp(Math.min((r.width-2*padding)/Math.max(1,b.width),(r.height-2*padding)/Math.max(1,b.height)),this.options.minZoom!,this.options.maxZoom!);this._viewport={zoom,x:r.width/2-(b.x+b.width/2)*zoom,y:r.height/2-(b.y+b.height/2)*zoom};this.viewportChanged();}
  setZoom(value:number,screen?:Point):void{if(!Number.isFinite(value))return;const r=this.root.getBoundingClientRect(),at=screen??{x:r.width/2,y:r.height/2},world=this.screenToWorld(at),zoom=clamp(value,this.options.minZoom!,this.options.maxZoom!);this._viewport={zoom,x:at.x-world.x*zoom,y:at.y-world.y*zoom};this.viewportChanged();}
  screenToWorld(point:Point):Point{return{x:(point.x-this._viewport.x)/this._viewport.zoom,y:(point.y-this._viewport.y)/this._viewport.zoom};}
  worldToScreen(point:Point):Point{return{x:point.x*this._viewport.zoom+this._viewport.x,y:point.y*this._viewport.zoom+this._viewport.y};}
  private screenPoint(event:MouseEvent):Point{const rect=this.canvas.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};}
  private worldPoint(event:MouseEvent):Point{return this.screenToWorld(this.screenPoint(event));}
  hitTest(point:Point,descend=false):string|undefined{this.renderer.prepare(this._pageId);return this.renderer.hit(this.context,point,5/this._viewport.zoom,descend);}
  addShape(kind:ShapeKind,point?:Point,text?:string):string{if(this.readOnly)throw new DrawingError('READ_ONLY','This diagram is read-only.');const r=this.root.getBoundingClientRect(),p=point??this.screenToWorld({x:r.width/2,y:r.height/2});const shape=createShape(kind,{x:this.snap(p.x-80),y:this.snap(p.y-35),text:text??(kind==='text'?'Text':STENCIL_NAMES[kind]??''),style:kind==='text'?{fill:'none',stroke:'none'}:undefined});this.engine.add(this.pageId,shape);this.engine.select([shape.id]);this.focus();return shape.id;}
  private snap(value:number):number{return this.options.snap?Math.round(value/this.options.gridSize!)*this.options.gridSize!:value;}
  private viewportChanged():void{this.invalidate();this.viewChanged.emit(this.viewport);}
  private updateCursor():void{this.canvas.style.cursor=this._tool==='pan'||this.space?'grab':this._tool==='select'?'default':this._tool==='text'?'text':'crosshair';}
  private safe(action:()=>void):void{try{action();}catch(error){this.options.onError?.(error);this.errors.emit(error);this.live.textContent=error instanceof Error?error.message:String(error);this.cancelGesture();}}
  private selectionRect():Rect|undefined{this.renderer.prepare(this.pageId);const rects=this.engine.selection.map(key=>this.renderer.getItem(key)?.rect).filter((r):r is Rect=>!!r);return rects.length?union(rects):undefined;}
  private pointerDown(event:PointerEvent):void{
    if(this.drag || event.button>1)return;this.finishText(true);this.focus();const screen=this.screenPoint(event),world=this.screenToWorld(screen);const base={pointer:event.pointerId,start:world,current:world,screen,ids:[...this.engine.selection],viewport:{...this._viewport}};
    if(event.button===1||this.space||this._tool==='pan'){event.preventDefault();this.drag={...base,mode:'pan'};}
    else if(this._tool==='connector'&&!this.readOnly){const hit=this.hitTest(world,true);if(hit&&this.engine.getShape(hit)?.kind!=='connector'){if(!this.connectSource){this.connectSource=hit;this.engine.select([hit]);this.live.textContent='Select a target shape.';}else{const connector=createShape('connector',{source:{shapeId:this.connectSource},target:{shapeId:hit},routing:'orthogonal',style:{fill:'none',stroke:'#8d82aa',strokeWidth:1.5,endArrow:true}});this.engine.add(this.pageId,connector);this.engine.select([connector.id]);this.connectSource=undefined;}}this.invalidate();return;}
    else if(this._tool==='pen'&&!this.readOnly){this.drag={...base,mode:'pen',points:[world]};}
    else if(this._tool!=='select'&&!this.readOnly){this.drag={...base,mode:'create'};}
    else {
      const rect=this.selectionRect(),single=this.engine.selection.length===1?this.engine.getShape(this.engine.selection[0]!):undefined;
      if(rect&&single&&!this.readOnly&&!single.locked&&single.kind!=='connector'){
        const at=handles(rect).findIndex(p=>Math.hypot(p.x-world.x,p.y-world.y)<7/this._viewport.zoom);
        if(at>=0){this.drag={...base,mode:'resize',shape:clone(single),handle:at};}
        else if(Math.hypot(world.x-(rect.x+rect.width/2),world.y-(rect.y-24/this._viewport.zoom))<8/this._viewport.zoom)this.drag={...base,mode:'rotate',shape:clone(single)};
      }
      if(!this.drag){const hit=this.hitTest(world,event.altKey);if(hit){const ids=event.shiftKey?this.engine.selection.includes(hit)?this.engine.selection.filter(key=>key!==hit):[...this.engine.selection,hit]:this.engine.selection.includes(hit)?[...this.engine.selection]:[hit];this.engine.select(ids);if(!this.readOnly&&ids.length)this.drag={...base,mode:'move',ids:[...ids]};}else{if(!event.shiftKey)this.engine.select([]);this.drag={...base,mode:'marquee',ids:[...this.engine.selection],add:event.shiftKey};}}
    }
    if(this.drag){this.canvas.setPointerCapture(event.pointerId);event.preventDefault();}this.invalidate();
  }
  private pointerMove(event:PointerEvent):void{const drag=this.drag;if(!drag||drag.pointer!==event.pointerId)return;drag.current=this.worldPoint(event);
    if(drag.mode==='pan'){const screen=this.screenPoint(event);this._viewport={...drag.viewport,x:drag.viewport.x+screen.x-drag.screen.x,y:drag.viewport.y+screen.y-drag.screen.y};this.viewportChanged();}
    if(drag.mode==='pen'&&Math.hypot(drag.current.x-drag.points!.at(-1)!.x,drag.current.y-drag.points!.at(-1)!.y)>1.5/this._viewport.zoom){if(drag.points!.length<100000)drag.points!.push(drag.current);}
    this.invalidate();
  }
  private pointerUp(event:PointerEvent):void{const drag=this.drag;if(!drag||drag.pointer!==event.pointerId)return;drag.current=this.worldPoint(event);this.drag=undefined;if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
    const dx=drag.current.x-drag.start.x,dy=drag.current.y-drag.start.y,moved=Math.hypot(dx,dy)>2/this._viewport.zoom;
    if(drag.mode==='move'&&moved&&!this.readOnly)this.engine.move(drag.ids,this.snap(dx),this.snap(dy));
    else if(drag.mode==='resize'&&moved&&!this.readOnly)this.resizeFromDrag(drag);
    else if(drag.mode==='rotate'&&moved&&!this.readOnly){const item=this.renderer.getItem(drag.shape!.id)!;const center={x:item.rect.x+item.rect.width/2,y:item.rect.y+item.rect.height/2};let angle=drag.shape!.rotation+Math.atan2(drag.current.y-center.y,drag.current.x-center.x)-Math.atan2(drag.start.y-center.y,drag.start.x-center.x);if(event.shiftKey)angle=Math.round(angle/(Math.PI/12))*(Math.PI/12);this.engine.update(drag.shape!.id,{rotation:angle});}
    else if(drag.mode==='marquee'){const r=bounds([drag.start,drag.current]);this.renderer.prepare(this.pageId);const matches=this.renderer.query(r).filter(item=>!item.locked&&!item.parentId&&contains(r,{x:item.rect.x,y:item.rect.y})&&contains(r,{x:item.rect.x+item.rect.width,y:item.rect.y+item.rect.height})).map(item=>item.shape.id);this.engine.select([...new Set([...drag.ids,...matches])]);}
    else if(drag.mode==='create'&&!this.readOnly){const r=bounds([drag.start,drag.current]);const shape=createShape(this._tool as ShapeKind,{x:this.snap(r.x),y:this.snap(r.y),width:moved?Math.max(20,this.snap(r.width)):160,height:moved?Math.max(20,this.snap(r.height)):70,text:this._tool==='text'?'Text':STENCIL_NAMES[this._tool as ShapeKind]??'',style:this._tool==='text'?{fill:'none',stroke:'none'}:undefined});this.engine.add(this.pageId,shape);this.engine.select([shape.id]);this.tool='select';if(shape.kind==='text')this.editText(shape.id);}
    else if(drag.mode==='pen'&&!this.readOnly&&drag.points!.length>1){const points=simplifyPolyline(drag.points!,1/this._viewport.zoom),r=bounds(points),path=points.map((p,i)=>`${i?'L':'M'} ${p.x-r.x} ${p.y-r.y}`).join(' ');const shape=createShape('path',{...r,path,style:{fill:'none',stroke:'#6d5895',strokeWidth:2}});this.engine.add(this.pageId,shape);this.engine.select([shape.id]);}
    this.updateCursor();this.invalidate();
  }
  private resizeFromDrag(drag:DragState):void{
    const shape=drag.shape!,ref=this.engine.getRef(shape.id)!;const inv=inverse(ref.matrix);if(!inv)throw new DrawingError('SINGULAR_TRANSFORM','Cannot resize a singular transform.');
    // Resizing uses the shape's local axes even when a parent group is rotated.
    const a=transformPoint(inv,drag.start),b=transformPoint(inv,drag.current),dx=b.x-a.x,dy=b.y-a.y,h=drag.handle!;
    const left=[0,6,7].includes(h),right=[2,3,4].includes(h),top=[0,1,2].includes(h),bottom=[4,5,6].includes(h);
    const width=Math.max(4,shape.width+(left?-dx:right?dx:0)),height=Math.max(4,shape.height+(top?-dy:bottom?dy:0));
    const localOffset={x:left?shape.width-width:0,y:top?shape.height-height:0};const worldOrigin=transformPoint(ref.matrix,localOffset),worldOld=transformPoint(ref.matrix,{x:0,y:0});
    this.engine.transaction('Resize shape',()=>{this.engine.resize(shape.id,width,height);const next=this.engine.getRef(shape.id)!;const changedOrigin=transformPoint(next.matrix,{x:0,y:0});this.engine.move([shape.id],worldOrigin.x-changedOrigin.x,worldOrigin.y-changedOrigin.y);});
    void worldOld;
  }
  private cancelGesture():void{const drag=this.drag;this.drag=undefined;if(drag&&this.canvas.hasPointerCapture(drag.pointer))this.canvas.releasePointerCapture(drag.pointer);this.connectSource=undefined;this.invalidate();}
  private keyDown(event:KeyboardEvent):void{
    if(inputTarget(event.target))return;const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(event.code==='Space'){event.preventDefault();this.space=true;this.updateCursor();return;}
    if(key==='escape'){this.cancelGesture();this.finishText(false);this.tool='select';event.preventDefault();return;}
    if(event.altKey&&(key==='arrowright'||key==='arrowleft')){const shapes=this.engine.allShapes(this.pageId).filter(s=>s.visible!==false&&!s.locked),index=shapes.findIndex(s=>s.id===this.engine.selection.at(-1)),next=shapes[(index+(key==='arrowright'?1:-1)+shapes.length)%shapes.length];if(next)this.engine.select(event.shiftKey?[...this.engine.selection,next.id]:[next.id]);event.preventDefault();return;}
    if(key==='enter'&&!this.engine.selection.length){const first=this.engine.getPage(this.pageId).shapes[0];if(first)this.engine.select([first.id]);event.preventDefault();return;}
    if(command&&key==='a'){this.engine.select(this.engine.getPage(this.pageId).shapes.filter(s=>!s.locked&&s.visible!==false).map(s=>s.id));event.preventDefault();return;}
    if(key==='0'&&command){this.fit();event.preventDefault();return;}
    if(this.readOnly)return;
    if(command&&key==='z'){event.shiftKey?this.engine.redo():this.engine.undo();event.preventDefault();}
    else if(command&&key==='y'){this.engine.redo();event.preventDefault();}
    else if(command&&key==='d'){this.engine.duplicate();event.preventDefault();}
    else if(command&&key==='g'){event.shiftKey?this.engine.ungroup():this.engine.group();event.preventDefault();}
    else if(key==='delete'||key==='backspace'){this.engine.remove(this.engine.selection);event.preventDefault();}
    else if(key==='f2'||key==='enter'){const first=this.engine.selection[0];if(first)this.editText(first);event.preventDefault();}
    else if(key.startsWith('arrow')&&!command){const step=event.shiftKey?this.options.gridSize!:1;this.engine.move(this.engine.selection,key==='arrowleft'?-step:key==='arrowright'?step:0,key==='arrowup'?-step:key==='arrowdown'?step:0);event.preventDefault();}
  }
  editText(shapeId:string):void{if(this.readOnly)return;this.finishText(true);const shape=this.engine.getShape(shapeId),ref=this.engine.getRef(shapeId);if(!shape||!ref)return;
    const textarea=this.host.ownerDocument.createElement('textarea');textarea.value=shape.text;textarea.setAttribute('aria-label',`Edit ${shape.text||shape.kind} text`);textarea.dataset.shapeId=shapeId;
    const m=multiply([this.viewport.zoom,0,0,this.viewport.zoom,this.viewport.x,this.viewport.y],ref.matrix);
    textarea.style.cssText='position:absolute;left:0;top:0;transform-origin:0 0;box-sizing:border-box;resize:none;border:0;border-radius:4px;padding:8px;background:#fff';
    // Imported style values are assigned as individual properties, never interpolated into a CSS declaration list.
    Object.assign(textarea.style,{outline:`2px solid ${this.options.selectionColor??'#8068bb'}`,color:shape.style.color,fontFamily:shape.style.fontFamily,fontWeight:shape.style.bold?'bold':'normal',fontStyle:shape.style.italic?'italic':'normal',fontSize:`${shape.style.fontSize}px`,textAlign:shape.style.align,width:`${Math.max(40,shape.width)}px`,height:`${Math.max(24,shape.height)}px`,transform:`matrix(${m.join(',')})`});
    textarea.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();this.finishText(false);this.focus();}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();this.finishText(true);this.focus();}e.stopPropagation();});
    textarea.addEventListener('blur',()=>this.finishText(true));this.editor=textarea;this.root.append(textarea);textarea.focus();textarea.select();
  }
  private finishText(commit:boolean):void{const editor=this.editor;if(!editor)return;this.editor=undefined;const shapeId=editor.dataset.shapeId!,value=editor.value;editor.remove();if(commit&&!this.readOnly&&this.engine.getShape(shapeId)&&this.engine.getShape(shapeId)!.text!==value)this.engine.update(shapeId,{text:value});}
  flush():void{this.finishText(true);}
  private copyEvent(event:ClipboardEvent):void{const selected=new Set(this.engine.selection),shapes=this.engine.selection.filter(key=>{let parent=this.engine.getRef(key)?.parentId;while(parent){if(selected.has(parent))return false;parent=this.engine.getRef(parent)?.parentId;}return true;}).map(key=>clone(this.engine.getShape(key)!));if(!shapes.length)return;this.clipboard=shapes;event.clipboardData?.setData('application/x-drawingweb-shapes',JSON.stringify(shapes));event.clipboardData?.setData('text/plain',shapes.map(s=>s.text).join('\n'));event.preventDefault();}
  private pasteEvent(event:ClipboardEvent):void{if(this.readOnly)return;const data=event.clipboardData?.getData('application/x-drawingweb-shapes');if(data){if(data.length>8*1024*1024)throw new DrawingError('CLIPBOARD_LIMIT','Clipboard data is too large.');const shapes=JSON.parse(data) as Shape[];const doc=createDocument();doc.pages[0]!.shapes=shapes;parseDocument(JSON.stringify(doc));this.pasteShapes(shapes);event.preventDefault();}else{const text=event.clipboardData?.getData('text/plain');if(text){this.addShape('text',undefined,text.slice(0,1_000_000));event.preventDefault();}}}
  pasteShapes(shapes:readonly Shape[]):string[]{if(this.readOnly)throw new DrawingError('READ_ONLY','This diagram is read-only.');const ids=new Map<string,string>();const reserve=(s:Shape)=>{ids.set(s.id,id());s.children?.forEach(reserve);};shapes.forEach(reserve);
    const copy=(s:Shape):Shape=>({...clone(s),id:ids.get(s.id)!,children:s.children?.map(copy),source:s.source?{...s.source,shapeId:ids.get(s.source.shapeId??'')??s.source.shapeId}:undefined,target:s.target?{...s.target,shapeId:ids.get(s.target.shapeId??'')??s.target.shapeId}:undefined});const additions=shapes.map(s=>{const result=copy(s);result.x+=24;result.y+=24;return result;});this.engine.addMany(this.pageId,additions);const result=additions.map(s=>s.id);this.engine.select(result);return result;
  }
  private updateAccessible():void{if(this.disposed)return;const doc=this.host.ownerDocument,fragment=doc.createDocumentFragment();const selected=new Set(this.engine.selection);this.renderer.prepare(this.pageId);
    for(const item of this.renderer.displayList.slice(0,5000)){const option=doc.createElement('div');option.id=`dw-${this.canvas.getAttribute('aria-describedby')}-${item.shape.id}`;option.setAttribute('role','option');option.setAttribute('aria-selected',String(selected.has(item.shape.id)));option.textContent=item.shape.text||`${item.shape.kind} ${item.shape.id}`;fragment.append(option);}this.accessibility.replaceChildren(fragment);
    const active=this.engine.selection.at(-1);if(active)this.canvas.setAttribute('aria-activedescendant',`dw-${this.canvas.getAttribute('aria-describedby')}-${active}`);else this.canvas.removeAttribute('aria-activedescendant');this.canvas.setAttribute('aria-owns',this.accessibility.id||(this.accessibility.id=id('shapes')));
  }
  invalidate():void{if(this.disposed||this.frame)return;this.frame=requestAnimationFrame(()=>{this.frame=0;this.safe(()=>this.render());});}
  render():void{if(this.disposed)return;const rect=this.root.getBoundingClientRect(),width=Math.max(1,rect.width),height=Math.max(1,rect.height),ratio=Math.min(3,globalThis.devicePixelRatio||1);
    if(this.canvas.width!==Math.round(width*ratio))this.canvas.width=Math.round(width*ratio);if(this.canvas.height!==Math.round(height*ratio))this.canvas.height=Math.round(height*ratio);
    const preview=new Map<string,Matrix>(),drag=this.drag;
    if(drag?.mode==='move'){const matrix=translation(this.snap(drag.current.x-drag.start.x),this.snap(drag.current.y-drag.start.y));for(const key of drag.ids)preview.set(key,matrix);}
    this.renderer.draw(this.context,this.pageId,this._viewport,width,height,ratio,{grid:this.options.grid,gridSize:this.options.gridSize,background:this.options.background,preview});
    const c=this.context;c.setTransform(ratio,0,0,ratio,0,0);c.translate(this._viewport.x,this._viewport.y);c.scale(this._viewport.zoom,this._viewport.zoom);const z=this._viewport.zoom;c.strokeStyle=this.options.selectionColor??'#8263ba';c.fillStyle='#fff';c.lineWidth=1.5/z;
    let r=this.selectionRect();if(r&&drag?.mode==='move')r={...r,x:r.x+this.snap(drag.current.x-drag.start.x),y:r.y+this.snap(drag.current.y-drag.start.y)};
    if(r){c.setLineDash([4/z,3/z]);c.strokeRect(r.x,r.y,r.width,r.height);c.setLineDash([]);if(!this.readOnly&&this.engine.selection.length===1&&this.engine.getShape(this.engine.selection[0]!)?.kind!=='connector'){for(const p of handles(r)){c.fillRect(p.x-3/z,p.y-3/z,6/z,6/z);c.strokeRect(p.x-3/z,p.y-3/z,6/z,6/z);}c.beginPath();c.moveTo(r.x+r.width/2,r.y);c.lineTo(r.x+r.width/2,r.y-20/z);c.stroke();c.beginPath();c.arc(r.x+r.width/2,r.y-24/z,4/z,0,2*Math.PI);c.fill();c.stroke();}}
    if(drag&&(drag.mode==='marquee'||drag.mode==='create'||drag.mode==='resize')){const box=drag.mode==='resize'?bounds([this.renderer.getItem(drag.shape!.id)!.rect,drag.current]):bounds([drag.start,drag.current]);c.fillStyle='#8563bc16';c.fillRect(box.x,box.y,box.width,box.height);c.setLineDash([4/z,3/z]);c.strokeRect(box.x,box.y,box.width,box.height);c.setLineDash([]);}
    if(drag?.mode==='pen'&&drag.points!.length){c.beginPath();c.moveTo(drag.points![0]!.x,drag.points![0]!.y);for(const p of drag.points!.slice(1))c.lineTo(p.x,p.y);c.lineWidth=2;c.stroke();}
    this.rendered.emit(this.renderer.statistics);
  }
  async exportPng(scale=2):Promise<Blob>{this.flush();if(!Number.isFinite(scale)||scale<=0)throw new DrawingError('EXPORT_SCALE','Export scale must be positive.');const page=this.engine.getPage(this.pageId);if(page.width*page.height*scale*scale>64_000_000)throw new DrawingError('EXPORT_LIMIT','Bitmap export exceeds 64 million pixels.');const canvas=this.host.ownerDocument.createElement('canvas');canvas.width=Math.ceil(page.width*scale);canvas.height=Math.ceil(page.height*scale);const context=canvas.getContext('2d')!;this.renderer.draw(context,this.pageId,{zoom:1,x:0,y:0},page.width,page.height,scale,{background:page.background});return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new DrawingError('EXPORT_FAILED','PNG encoding failed.')),'image/png'));}
  dispose():void{if(this.disposed)return;this.finishText(false);this.disposed=true;this.abort.abort();this.observer.disconnect();if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;for(const dispose of this.subscriptions)dispose();this.renderer.dispose();this.root.remove();this.viewChanged.clear();this.toolChanged.clear();this.errors.clear();this.rendered.clear();if(this.owned)this.engine.dispose();}
}

export const STENCILS:readonly ShapeKind[]=['rectangle','roundRect','ellipse','diamond','parallelogram','document','database','cloud','hexagon','triangle','text'];
export const STENCIL_NAMES:Partial<Record<ShapeKind,string>>={rectangle:'Process',roundRect:'Start / End',ellipse:'Ellipse',diamond:'Decision',parallelogram:'Data',document:'Document',database:'Database',cloud:'Cloud',hexagon:'Preparation',triangle:'Triangle',text:'Text'};
/** Iterative Douglas–Peucker simplification; no recursion proportional to freehand stroke length. */
export function simplifyPolyline(points:readonly Point[],tolerance:number):Point[]{if(points.length<=2)return [...points];const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;const stack:Array<[number,number]>=[[0,points.length-1]];while(stack.length){const [a,b]=stack.pop()!;let distance=tolerance,index=-1;for(let i=a+1;i<b;i++){const d=distanceToSegment(points[i]!,points[a]!,points[b]!);if(d>distance){distance=d;index=i;}}if(index>=0){keep[index]=1;stack.push([a,index],[index,b]);}}return points.filter((_,i)=>keep[i]===1);}
/** Explicit registration keeps ESM/CommonJS imports safe in Node, SSR and Blazor prerendering. */
export function registerDrawingElement(name='drawing-web'):void{
  if(!globalThis.customElements)throw new DrawingError('BROWSER_REQUIRED','Custom elements require a browser.');if(customElements.get(name))return;
  class DrawingElement extends HTMLElement{
    control?:DrawingControl;private value?:DiagramDocument;static get observedAttributes():string[]{return ['readonly','grid','snap','aria-label'];}
    get document():DiagramDocument|undefined{return this.control?.engine.document??this.value;}
    set document(value:DiagramDocument|undefined){this.value=value;if(value&&this.control)this.control.engine.replaceDocument(value);}
    connectedCallback():void{if(this.control)return;if(!this.style.display)this.style.display='block';if(!this.style.height)this.style.height='480px';this.control=new DrawingControl(this,{document:this.value,readOnly:this.hasAttribute('readonly'),grid:this.getAttribute('grid')!=='false',snap:this.getAttribute('snap')!=='false',ariaLabel:this.getAttribute('aria-label')??undefined});this.control.engine.changed.subscribe(change=>{this.value=change.document;this.dispatchEvent(new CustomEvent('documentchange',{detail:change,bubbles:true,composed:true}));});this.control.engine.selectionChanged.subscribe(selection=>this.dispatchEvent(new CustomEvent('selectionchange',{detail:selection,bubbles:true,composed:true})));this.control.fit();this.dispatchEvent(new CustomEvent('ready',{detail:this.control}));}
    disconnectedCallback():void{this.value=this.control?.engine.document;this.control?.dispose();this.control=undefined;}
    attributeChangedCallback():void{this.control?.setOptions({readOnly:this.hasAttribute('readonly'),grid:this.getAttribute('grid')!=='false',snap:this.getAttribute('snap')!=='false',ariaLabel:this.getAttribute('aria-label')??undefined});}
  }
  customElements.define(name,DrawingElement);
}
