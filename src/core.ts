export * from './model.js';
import { clone, createDocument, createPage, createShape, DrawingError, freeze, id, Signal, validateDocument, plainText } from './model.js';
import type { DiagramDocument, Matrix, Page, Shape } from './model.js';
import { parsePath, serializePath, transformSegments } from './path.js';
import { IDENTITY, inverse, localMatrix, multiply, transformPoint, transformedBounds, union, translation } from './geometry.js';

export interface ShapeRef { pageId: string; pageIndex: number; path: number[]; parentId?: string; matrix: Matrix; parentMatrix: Matrix }
export interface DocumentChange {
  revision: number; label: string; origin: string; ids: readonly string[];
  document: DiagramDocument; canUndo: boolean; canRedo: boolean;
}
interface HistoryEntry { before: DiagramDocument; after: DiagramDocument; label: string; ids: string[] }
export interface EngineOptions { historyLimit?: number; onError?: (error: unknown) => void }
/** Immutable snapshots, structurally shared history, atomic synchronous transactions and stable shape IDs. */
export class DiagramEngine {
  private value: DiagramDocument;
  private refs = new Map<string, ShapeRef>();
  private indexDirty = true;
  private depth = 0;
  private pending = new Set<string>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private selected = new Set<string>();
  private disposed = false;
  private events: DocumentChange[] = [];
  private delivering = false;
  private readonly limit: number;
  private _revision = 0;
  private readonly derivations = new Set<(engine: DiagramEngine, before: DiagramDocument, origin: string) => void>();
  /** Runs derived updates within the originating transaction, so one undo restores both inputs and results. */
  addDerivation(derive: (engine: DiagramEngine, before: DiagramDocument, origin: string) => void): () => void {
    this.assertAlive(); this.derivations.add(derive); return () => { this.derivations.delete(derive); };
  }
  updateDocument(patch: Partial<Omit<DiagramDocument, 'schema' | 'id' | 'pages'>>, origin = 'user'): void {
    this.run('Update document', () => {
      const safe = clone(patch) as Partial<DiagramDocument>;
      if ('schema' in safe || 'id' in safe || 'pages' in safe) throw new DrawingError('IMMUTABLE_DOCUMENT', 'Use page APIs to edit page topology.');
      this.value = { ...this.value, ...safe };
    }, origin);
  }
  /** Includes semantic container members; hierarchy children are included only for closure traversal. */
  operationRoots(ids: readonly string[]): string[] {
    const all = new Set<string>(), queue = [...ids];
    for (let cursor=0; cursor<queue.length; cursor++) {
      const key = queue[cursor]!; if (all.has(key)) continue;
      const shape = this.getShape(key); if (!shape) continue;
      all.add(key); queue.push(...(shape.container?.memberIds ?? []), ...(shape.children?.map(s => s.id) ?? []));
    }
    return this.roots([...all]);
  }
  /** Selection roots, excluding members already covered by another selected container. */
  selectionRoots(ids: readonly string[]): string[] {
    const roots=this.roots([...new Set(ids)]),covered=new Set<string>();
    for(const key of roots)for(const member of this.operationRoots([key]))if(member!==key)covered.add(member);
    return roots.filter(key=>!covered.has(key));
  }
  private fitAutomaticContainers(): boolean {
    const done=new Set<string>();let changed=false;
    const fit=(key:string)=>{
      if(done.has(key))return;done.add(key);
      const original=this.getShape(key);if(!original?.container)return;
      for(const member of original.container.memberIds)fit(member);
      const shape=this.getShape(key)!,container=shape.container!;
      if(!container.autoResize||container.layout==='pool'||!container.memberIds.length)return;
      const matrix=localMatrix(shape),inv=inverse(matrix);if(!inv)return;
      const box=union(container.memberIds.map(id=>{const member=this.getShape(id)!;return transformedBounds(member,multiply(inv,localMatrix(member)));}));
      const vertical=container.orientation==='vertical',p=container.padding,h=container.headerSize;
      const x=box.x-p-(vertical?h:0),y=box.y-p-(vertical?0:h),width=box.width+2*p+(vertical?h:0),height=box.height+2*p+(vertical?0:h);
      if(Math.max(Math.abs(x),Math.abs(y),Math.abs(width-shape.width),Math.abs(height-shape.height))<1e-8)return;
      changed=true;this.update(key,{x:0,y:0,rotation:0,transform:multiply(matrix,translation(x,y)),width,height});
    };
    for(const shape of this.allShapes())if(shape.container)fit(shape.id);return changed;
  }
  readonly changed: Signal<DocumentChange>;
  readonly selectionChanged: Signal<readonly string[]>;
  constructor(document: DiagramDocument = createDocument(), options: EngineOptions = {}) {
    validateDocument(document); this.value = freeze(clone(document)); this.limit = Math.max(0, options.historyLimit ?? 100);
    this.changed = new Signal(options.onError); this.selectionChanged = new Signal(options.onError); this.reindex();
  }
  get document(): DiagramDocument { return this.value; }
  get revision(): number { return this._revision; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get selection(): readonly string[] { return [...this.selected]; }
  get isDisposed(): boolean { return this.disposed; }
  private assertAlive(): void { if (this.disposed) throw new DrawingError('DISPOSED', 'The engine has been disposed.'); }
  private reindex(): void {
    this.refs.clear();
    const visit = (shapes: Shape[], pageId: string, pageIndex: number, path: number[], matrix: Matrix, parentId?: string) => {
      shapes.forEach((shape, index) => {
        const next = [...path, index], world = multiply(matrix, localMatrix(shape));
        if (this.refs.has(shape.id)) throw new DrawingError('DUPLICATE_ID', `Duplicate shape ID: ${shape.id}`);
        this.refs.set(shape.id, { pageId, pageIndex, path: next, parentId, matrix: world, parentMatrix: matrix });
        if (shape.children) visit(shape.children, pageId, pageIndex, next, world, shape.id);
      });
    };
    this.value.pages.forEach((page, index) => visit(page.shapes, page.id, index, [], IDENTITY)); this.indexDirty = false;
  }
  private index(): Map<string, ShapeRef> { if (this.indexDirty) this.reindex(); return this.refs; }
  getRef(shapeId: string): ShapeRef | undefined {
    const ref=this.index().get(shapeId); if(!ref)return undefined;
    let matrix:Matrix=IDENTITY,parentMatrix:Matrix=IDENTITY,shapes=this.value.pages[ref.pageIndex]!.shapes;
    for(const part of ref.path){const shape=shapes[part]!;parentMatrix=matrix;matrix=multiply(matrix,localMatrix(shape));shapes=shape.children??[];}
    return {...ref,matrix,parentMatrix};
  }
  getShape(shapeId: string): Shape | undefined {
    const ref = this.index().get(shapeId); if (!ref) return undefined;
    let shapes = this.value.pages[ref.pageIndex]!.shapes, shape: Shape | undefined;
    for (const part of ref.path) { shape = shapes[part]; if (!shape) return undefined; shapes = shape.children ?? []; }
    return shape;
  }
  getPage(pageId: string): Page { const page = this.value.pages.find(p => p.id === pageId); if (!page) throw new DrawingError('PAGE_NOT_FOUND', `Page ${pageId} was not found.`); return page; }
  allShapes(pageId?: string): Shape[] { return [...this.index()].filter(([, ref]) => !pageId || ref.pageId === pageId).map(([key]) => this.getShape(key)!); }
  /** Nested transactions have savepoint semantics. Awaiting inside a transaction is forbidden. */
  transaction<T>(label: string, action: () => T, origin = 'user'): T {
    this.assertAlive(); const before = this.value, oldPending = new Set(this.pending), outer = this.depth++ === 0;
    if (outer) this.pending.clear();
    let result: T;
    try {
      result = action();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new DrawingError('ASYNC_TRANSACTION', 'Complete asynchronous work before entering a transaction.');
      if (outer && this.value !== before) {
        for (const derive of this.derivations) {
          const derived = derive(this, before, origin) as unknown;
          if (derived && typeof (derived as { then?: unknown }).then === 'function') throw new DrawingError('ASYNC_DERIVATION', 'Derivations must be synchronous.');
        }
        validateDocument(this.value); if(this.fitAutomaticContainers())validateDocument(this.value); this.value = freeze(this.value); this.reindex(); }
    } catch (error) { this.value = before; this.pending = oldPending; this.indexDirty = true; this.depth--; throw error; }
    this.depth--;
    if (outer && this.value !== before) {
      const ids = [...this.pending];
      if (this.limit) { this.undoStack.push({ before, after: this.value, label, ids }); if (this.undoStack.length > this.limit) this.undoStack.shift(); }
      this.redoStack.length = 0; this._revision++; this.cleanSelection(); this.notify(label, origin, ids);
    }
    return result;
  }
  private run<T>(label: string, action: () => T, origin = 'user'): T { return this.depth ? action() : this.transaction(label, action, origin); }
  private setPageAt(index: number, page: Page, topologyChanged=true): void { const pages = this.value.pages.slice(); pages[index] = page; this.value = { ...this.value, pages }; this.indexDirty ||= topologyChanged; }
  private replaceAt(ref: ShapeRef, shape: Shape): void {
    const replace = (siblings: Shape[], depth: number): Shape[] => {
      const result = siblings.slice(), i = ref.path[depth]!;
      result[i] = depth === ref.path.length - 1 ? shape : { ...result[i]!, children: replace(result[i]!.children!, depth + 1) };
      return result;
    };
    const page = this.value.pages[ref.pageIndex]!;
    const old=this.getShape(shape.id); this.setPageAt(ref.pageIndex, { ...page, shapes: replace(page.shapes, 0) },old?.children!==shape.children);
  }
  update(shapeId: string, patch: Partial<Shape>, origin = 'user'): void {
    this.run('Update shape', () => {
      const ref = this.getRef(shapeId), shape = this.getShape(shapeId); if (!ref || !shape) throw new DrawingError('SHAPE_NOT_FOUND', `Shape ${shapeId} was not found.`);
      if (patch.id !== undefined && patch.id !== shapeId) throw new DrawingError('IMMUTABLE_ID', 'Shape IDs cannot be changed.');
      const safe = clone(patch);
      if (safe.richText) safe.text = plainText(safe.richText);
      else if (safe.text !== undefined && safe.text !== shape.text) safe.richText = undefined;
      this.replaceAt(ref, { ...shape, ...safe, id: shapeId,
        style: safe.style ? { ...shape.style, ...safe.style } : shape.style,
        data: safe.data ? { ...shape.data, ...safe.data } : shape.data }); this.pending.add(shapeId);
    }, origin);
  }
  add(pageId: string, shape: Shape, parentId?: string, origin = 'user'): string { this.addMany(pageId, [shape], parentId, origin); return shape.id; }
  addMany(pageId: string, shapes: readonly Shape[], parentId?: string, origin = 'user'): void {
    this.run('Add shapes', () => {
      const additions = clone([...shapes]);
      if (parentId) { const parent = this.getShape(parentId), ref = this.getRef(parentId); if (!parent || !ref || ref.pageId !== pageId || parent.kind !== 'group') throw new DrawingError('PARENT_NOT_FOUND', 'Shapes can only be added to a group on the same page.'); this.replaceAt(ref, { ...parent, children: [...(parent.children ?? []), ...additions] }); }
      else { const index = this.value.pages.findIndex(p => p.id === pageId); if (index < 0) throw new DrawingError('PAGE_NOT_FOUND', pageId); const page = this.value.pages[index]!; this.setPageAt(index, { ...page, shapes: [...page.shapes, ...additions] }); }
      const mark = (items: Shape[]) => { for (const shape of items) { this.pending.add(shape.id); if (shape.children) mark(shape.children); } }; mark(additions);
    }, origin);
  }
  remove(shapeIds: readonly string[], origin = 'user'): void {
    this.run('Delete shapes', () => {
      const ids = new Set<string>(), queue = [...shapeIds];
      while (queue.length) {
        const key = queue.pop()!; if (ids.has(key)) continue;
        const shape = this.getShape(key); if (!shape) continue;
        ids.add(key); queue.push(...(shape.children?.map(s => s.id) ?? []), ...(shape.container?.memberIds ?? []));
      }
      if (!ids.size) return;
      // Attached connectors cannot retain dangling endpoint references.
      let changed = true;
      while (changed) {
        changed = false;
        for (const shape of this.allShapes()) if (!ids.has(shape.id) && (ids.has(shape.source?.shapeId ?? '') || ids.has(shape.target?.shapeId ?? ''))) { ids.add(shape.id); changed = true; }
      }
      for (const shape of this.allShapes()) if (!ids.has(shape.id) && shape.container?.locked && shape.container.memberIds.some(key => ids.has(key)))
        throw new DrawingError('CONTAINER_LOCKED', 'Unlock container membership before deleting a member.');
      const filter = (shapes: Shape[]): Shape[] => shapes.filter(shape => !ids.has(shape.id)).map(shape => {
        let next = shape;
        if (shape.children) next = { ...next, children: filter(shape.children) };
        if (shape.container?.memberIds.some(key => ids.has(key))) next = { ...next, container: { ...shape.container, memberIds: shape.container.memberIds.filter(key => !ids.has(key)) } };
        if (ids.has(shape.calloutTargetId ?? '')) next = { ...next, calloutTargetId: undefined };
        return next;
      });
      this.value = { ...this.value, pages: this.value.pages.map(page => ({ ...page, shapes: filter(page.shapes) })),
        comments: this.value.comments?.filter(c => !c.shapeId || !ids.has(c.shapeId)) };
      this.indexDirty = true; for (const key of ids) this.pending.add(key);
    }, origin);
  }
  addPage(name?: string): string { const page = createPage(name ?? `Page ${this.value.pages.length + 1}`); this.run('Add page', () => { this.value = { ...this.value, pages: [...this.value.pages, page] }; this.indexDirty = true; }); return page.id; }
  updatePage(pageId: string, patch: Partial<Omit<Page, 'id' | 'shapes'>>): void {
    this.run('Update page', () => { const index = this.value.pages.findIndex(p => p.id === pageId); if (index < 0) throw new DrawingError('PAGE_NOT_FOUND', pageId); this.setPageAt(index, { ...this.value.pages[index]!, ...clone(patch) }); });
  }
  removePage(pageId: string): void { this.run('Delete page', () => { this.getPage(pageId); if (this.value.pages.length === 1) throw new DrawingError('LAST_PAGE', 'A document must retain one page.'); this.value = { ...this.value, pages: this.value.pages.filter(p => p.id !== pageId).map(p => p.backgroundPageId === pageId ? { ...p, backgroundPageId: undefined } : p), comments: this.value.comments?.filter(c => c.pageId !== pageId) }; this.indexDirty = true; }); }
  setTitle(title: string): void { this.run('Rename document', () => { this.value = { ...this.value, title }; }); }
  replaceDocument(document: DiagramDocument, expectedRevision?: number): void {
    this.assertAlive(); if (this.depth) throw new DrawingError('TRANSACTION_ACTIVE', 'Cannot replace a document inside a transaction.');
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new DrawingError('REVISION_CONFLICT', 'The document changed before the replacement completed.');
    validateDocument(document); this.value = freeze(clone(document)); this.reindex(); this.undoStack.length = this.redoStack.length = 0;
    this._revision++; this.select([]); this.notify('Load document', 'load', [...this.refs.keys()]);
  }
  select(ids: readonly string[]): void { this.assertAlive(); const next = new Set(ids.filter(key => this.getShape(key))); if (next.size === this.selected.size && [...next].every(key => this.selected.has(key))) return; this.selected = next; this.selectionChanged.emit(this.selection); }
  private cleanSelection(): void { this.select(this.selection); }
  private roots(ids: readonly string[]): string[] { const selected = new Set(ids); return ids.filter(key => { let parent = this.getRef(key)?.parentId; while (parent) { if (selected.has(parent)) return false; parent = this.getRef(parent)?.parentId; } return !!this.getShape(key); }); }
  move(ids: readonly string[], dx: number, dy: number, origin = 'user'): void {
    this.run('Move shapes', () => { for (const key of this.operationRoots(ids)) { const s = this.getShape(key)!, ref = this.getRef(key)!; const inv = inverse(ref.parentMatrix); if (!inv) continue; const a = transformPoint(inv, { x:0,y:0 }), b = transformPoint(inv, { x:dx,y:dy }); this.update(key, { x:s.x+b.x-a.x, y:s.y+b.y-a.y }); } }, origin);
  }
  resize(shapeId: string, width: number, height: number): void {
    this.run('Resize shape', () => {
      const shape = this.getShape(shapeId); if (!shape) throw new DrawingError('SHAPE_NOT_FOUND', shapeId);
      const patch: Partial<Shape> = { width: Math.max(1, width), height: Math.max(1, height) };
      if (shape.children) {
        const scale: Matrix = [patch.width!/Math.max(1,shape.width),0,0,patch.height!/Math.max(1,shape.height),0,0];
        patch.children = shape.children.map(child => ({ ...child, x:0,y:0,rotation:0, transform:multiply(scale,localMatrix(child)) }));
      }
      if (shape.path) { const sx=patch.width!/Math.max(1,shape.width),sy=patch.height!/Math.max(1,shape.height); patch.path=serializePath(transformSegments(parsePath(shape.path),[sx,0,0,sy,0,0])); }
      this.update(shapeId, patch);
    });
  }
  group(ids: readonly string[] = this.selection): string | undefined {
    const keys = this.operationRoots(ids); if (keys.length < 2) return undefined;
    let groupId: string | undefined;
    this.run('Group shapes', () => {
      const refs = keys.map(key => this.getRef(key)!); const first = refs[0]!;
      if (refs.some(ref => ref.parentId !== first.parentId || ref.pageId !== first.pageId)) throw new DrawingError('GROUP_PARENT', 'Grouped shapes must share a parent and page.');
      const selected = new Set(keys), shapes = keys.map(key => this.getShape(key)!);
      const rect = union(shapes.map(shape => transformedBounds(shape)));
      const group = createShape('group', { ...rect, children: shapes.map(shape => ({ ...shape, x:shape.x-rect.x, y:shape.y-rect.y })), text:'' }); groupId=group.id;
      const siblings = first.parentId ? this.getShape(first.parentId)!.children! : this.getPage(first.pageId).shapes;
      const index = Math.min(...refs.map(ref => ref.path.at(-1)!)); const result=siblings.filter(shape=>!selected.has(shape.id));result.splice(index,0,group);
      this.setSiblings(first.pageId, first.parentId, result);
      for(const container of this.allShapes(first.pageId))if(container.container&&!selected.has(container.id)&&container.container.memberIds.some(id=>selected.has(id))){
        if(container.container.locked)throw new DrawingError('CONTAINER_LOCKED','Grouping changes locked container membership.');
        if(container.container.layout==='pool')throw new DrawingError('GROUP_LIST_MEMBER','Swimlanes must remain direct list members. Disband the pool before grouping its lanes.');
        this.update(container.id,{container:{...container.container,memberIds:[...container.container.memberIds.filter(id=>!selected.has(id)),group.id]}});
      }
      keys.forEach(key=>this.pending.add(key));this.pending.add(group.id);
    });
    if(groupId)this.select([groupId]);return groupId;
  }
  private setSiblings(pageId:string,parentId:string|undefined,shapes:Shape[]):void {
    if(parentId){const parent=this.getShape(parentId)!;this.replaceAt(this.getRef(parentId)!,{...parent,children:shapes});}
    else {const index=this.value.pages.findIndex(p=>p.id===pageId);this.setPageAt(index,{...this.value.pages[index]!,shapes});}
  }
  ungroup(ids:readonly string[]=this.selection):void {
    const children:string[]=[];
    this.run('Ungroup shapes',()=>{for(const key of this.roots(ids)){
      const group=this.getShape(key),ref=this.getRef(key);if(!group?.children||!ref)continue;
      const siblings=ref.parentId?this.getShape(ref.parentId)!.children!:this.getPage(ref.pageId).shapes;
      const matrix=localMatrix(group),items=group.children.map(child=>({...child,x:0,y:0,rotation:0,transform:multiply(matrix,localMatrix(child))}));
      const result=siblings.slice();result.splice(ref.path.at(-1)!,1,...items);this.setSiblings(ref.pageId,ref.parentId,result);
      children.push(...items.map(s=>s.id));this.pending.add(key);items.forEach(s=>this.pending.add(s.id));
      const center=transformPoint(ref.matrix,{x:group.width/2,y:group.height/2});
      for(const shape of this.allShapes(ref.pageId)){const patch:Partial<Shape>={};
        if(shape.container?.memberIds.includes(key)){
          if(shape.container.locked)throw new DrawingError('CONTAINER_LOCKED','Ungrouping changes locked container membership.');
          patch.container={...shape.container,memberIds:shape.container.memberIds.flatMap(id=>id===key?items.map(s=>s.id):[id])};
        }
        if(shape.calloutTargetId===key)patch.calloutTargetId=undefined;
        if(shape.source?.shapeId===key)patch.source=center;if(shape.target?.shapeId===key)patch.target=center;if(Object.keys(patch).length)this.update(shape.id,patch);}
      if(this.value.comments?.some(comment=>comment.shapeId===key))this.value={...this.value,comments:this.value.comments.map(comment=>comment.shapeId===key?{...comment,shapeId:undefined,position:center}:comment)};
    }});this.select(children);
  }
  duplicate(ids:readonly string[]=this.selection,dx=24,dy=24):string[]{
    const result:string[]=[];this.run('Duplicate shapes',()=>{const roots=this.operationRoots(ids);const map=new Map<string,string>();
      const reserve=(s:Shape)=>{map.set(s.id,id());s.children?.forEach(reserve);};roots.forEach(key=>reserve(this.getShape(key)!));
      const copy=(s:Shape):Shape=>({...clone(s),id:map.get(s.id)!,sheetId:undefined,container:s.container?{...s.container,memberIds:s.container.memberIds.map(key=>map.get(key)??key)}:undefined,calloutTargetId:map.get(s.calloutTargetId??'')??s.calloutTargetId,children:s.children?.map(copy),source:s.source?{...s.source,shapeId:map.get(s.source.shapeId??'')??s.source.shapeId}:undefined,target:s.target?{...s.target,shapeId:map.get(s.target.shapeId??'')??s.target.shapeId}:undefined});
      for(const key of roots){const ref=this.getRef(key)!,shape=copy(this.getShape(key)!);shape.x+=dx;shape.y+=dy;this.add(ref.pageId,shape,ref.parentId);result.push(shape.id);}
    });this.select(result);return result;
  }
  align(ids:readonly string[],mode:'left'|'right'|'top'|'bottom'|'center'|'middle'):void{
    this.run('Align shapes',()=>{const roots=this.selectionRoots(ids),rects=roots.map(key=>transformedBounds(this.getShape(key)!,this.getRef(key)!.matrix)),all=union(rects);
      roots.forEach((key,i)=>{const r=rects[i]!;let dx=0,dy=0;switch(mode){case 'left':dx=all.x-r.x;break;case 'right':dx=all.x+all.width-r.x-r.width;break;case 'top':dy=all.y-r.y;break;case 'bottom':dy=all.y+all.height-r.y-r.height;break;case 'center':dx=all.x+all.width/2-r.x-r.width/2;break;case 'middle':dy=all.y+all.height/2-r.y-r.height/2;break;}this.move([key],dx,dy);});
    });
  }
  reorder(ids:readonly string[],position:'front'|'back'):void{this.run('Reorder shapes',()=>{const roots=this.roots(ids);if(!roots.length)return;const ref=this.getRef(roots[0]!)!;if(roots.some(key=>{const r=this.getRef(key)!;return r.pageId!==ref.pageId||r.parentId!==ref.parentId;}))throw new DrawingError('ORDER_PARENT','Reordered shapes must share a parent.');const selected=new Set(roots),siblings=ref.parentId?this.getShape(ref.parentId)!.children!:this.getPage(ref.pageId).shapes,picked=siblings.filter(s=>selected.has(s.id)),rest=siblings.filter(s=>!selected.has(s.id));this.setSiblings(ref.pageId,ref.parentId,position==='front'?[...rest,...picked]:[...picked,...rest]);roots.forEach(key=>this.pending.add(key));});}
  registerMaster(name:string,category:string,shape:Shape):string{const masterId=id('m');this.run('Register master',()=>{this.value={...this.value,masters:[...this.value.masters,{id:masterId,name,category,shape:clone(shape)}]};});return masterId;}
  instantiateMaster(masterId:string,pageId:string,x:number,y:number):string{const master=this.value.masters.find(m=>m.id===masterId);if(!master)throw new DrawingError('MASTER_NOT_FOUND',masterId);const ids=new Map<string,string>();const reserve=(s:Shape)=>{ids.set(s.id,id());s.children?.forEach(reserve);};reserve(master.shape);const rename=(s:Shape):Shape=>({...clone(s),id:ids.get(s.id)!,sheetId:undefined,container:s.container?{...s.container,memberIds:s.container.memberIds.map(key=>ids.get(key)??key)}:undefined,calloutTargetId:ids.get(s.calloutTargetId??'')??s.calloutTargetId,children:s.children?.map(rename),source:s.source?{...s.source,shapeId:ids.get(s.source.shapeId??'')??s.source.shapeId}:undefined,target:s.target?{...s.target,shapeId:ids.get(s.target.shapeId??'')??s.target.shapeId}:undefined});const shape=rename(master.shape);shape.masterId=masterId;shape.x=x;shape.y=y;return this.add(pageId,shape);}
  undo():boolean{return this.restore(this.undoStack,this.redoStack,false);}
  redo():boolean{return this.restore(this.redoStack,this.undoStack,true);}
  private restore(source:HistoryEntry[],target:HistoryEntry[],redo:boolean):boolean{this.assertAlive();if(this.depth)throw new DrawingError('TRANSACTION_ACTIVE','History cannot change inside a transaction.');const entry=source.pop();if(!entry)return false;this.value=redo?entry.after:entry.before;target.push(entry);this.reindex();this._revision++;this.cleanSelection();this.notify(entry.label,redo?'redo':'undo',entry.ids);return true;}
  private notify(label:string,origin:string,ids:string[]):void{
    this.events.push({revision:this.revision,label,origin,ids,document:this.value,canUndo:this.canUndo,canRedo:this.canRedo});
    if(this.delivering)return;this.delivering=true;
    try{while(this.events.length)this.changed.emit(this.events.shift()!);}finally{this.delivering=false;}
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.changed.clear();this.selectionChanged.clear();this.refs.clear();this.derivations.clear();this.undoStack.length=this.redoStack.length=0;}
}
