import { DiagramOperations } from './features.js';
import { ShapeSheetService } from './shapesheet.js';
import type { ContainerOptions } from './features.js';
import type { DataRecordset, DataGraphic, DiagramTheme, Hyperlink, ShapeDataLink, RichText, Point } from './model.js';
import type { FormulaValue } from './formula.js';
/** Streaming, revision-aware Blazor interop. The native engine remains available through getControl(). */
import { DiagramEngine, createDocument, parseDocument, DrawingError, id } from './core.js';
import type { Diagnostic, Shape, ShapeKind, Unsubscribe } from './model.js';
import { DrawingControl } from './web.js';
import type { DrawingControlOptions, DrawingTool } from './web.js';
import { ObservableTable, DiagramBinding } from './data.js';
import type { DataRow } from './data.js';
import { exportSvg, readDrawing, writeVdx, writeVsdx, writeVisio } from './io.js';
import type { VisioPackage } from './io.js';
import { layeredLayout } from './layout.js';
export interface DotNetCallback { invokeMethodAsync<T=unknown>(method:string,...args:unknown[]):Promise<T> }
export interface DotNetReadStream { arrayBuffer():Promise<ArrayBuffer> }
interface DotNetRuntime { createJSStreamReference(data:Uint8Array|Blob):unknown }
interface Handle {
  control:DrawingControl; callback?:DotNetCallback; observer:MutationObserver; subscriptions:Unsubscribe[]; disposed:boolean;
  externalVersion:number; suppress:number; scheduled:boolean; pendingRevision:number; sentRevision:number; failed:boolean;
  sheet?:ShapeSheetService; source?:VisioPackage; table?:ObservableTable; binding?:DiagramBinding; dataSubscription?:Unsubscribe;
}
const handles=new Map<string,Handle>();const utf8=new TextEncoder();const decoder=new TextDecoder('utf-8',{fatal:true});
function requireHandle(key:string):Handle{const state=handles.get(key);if(!state||state.disposed)throw new DrawingError('DISPOSED','The native diagram handle no longer exists.');return state;}
function stream(data:Uint8Array|Blob):unknown{const runtime=(globalThis as unknown as {DotNet?:DotNetRuntime}).DotNet;if(!runtime)throw new DrawingError('BLAZOR_RUNTIME','The Blazor JavaScript runtime is not loaded.');return runtime.createJSStreamReference(data);}
function notify(key:string,state:Handle):void{
  state.pendingRevision=state.control.engine.revision;if(state.scheduled||state.suppress||state.failed||!state.callback||state.disposed)return;state.scheduled=true;
  queueMicrotask(async()=>{try{while(!state.disposed&&!state.suppress&&state.pendingRevision>state.sentRevision){const revision=state.pendingRevision;await state.callback!.invokeMethodAsync('OnDocumentChanged',revision);state.sentRevision=revision;}}
    catch(error){if(!state.disposed){state.failed=true;state.control.host.dispatchEvent(new CustomEvent('drawingweberror',{detail:error}));}}
    finally{state.scheduled=false;}});
}
function callback(state:Handle,method:string,...args:unknown[]):void{if(state.disposed||!state.callback||state.failed)return;void state.callback.invokeMethodAsync(method,...args).catch(error=>{if(!state.disposed)state.control.host.dispatchEvent(new CustomEvent('drawingweberror',{detail:error}));});}
export function create(host:HTMLElement,dotnet?:DotNetCallback,options:DrawingControlOptions={},initialJson?:string):{id:string;revision:number}{
  const key=id('bridge'),engine=new DiagramEngine(initialJson?parseDocument(initialJson):createDocument());let control:DrawingControl;
  try{control=new DrawingControl(host,{...options,engine});}catch(error){engine.dispose();throw error;}
  const state:Handle={control,callback:dotnet,observer:new MutationObserver(()=>{if(!host.isConnected)dispose(key);}),subscriptions:[],disposed:false,externalVersion:0,suppress:0,scheduled:false,pendingRevision:0,sentRevision:0,failed:false};handles.set(key,state);
  state.subscriptions.push(engine.changed.subscribe(()=>{if(!state.suppress)notify(key,state);}),engine.selectionChanged.subscribe(selection=>callback(state,'OnSelectionChanged',selection)),control.errors.subscribe(error=>callback(state,'OnNativeError',error instanceof DrawingError?error.code:'NATIVE_ERROR',error instanceof Error?error.message:String(error))));
  state.observer.observe(host.ownerDocument.documentElement,{childList:true,subtree:true});control.fit();return{id:key,revision:engine.revision};
}
export function getControl(key:string):DrawingControl{return requireHandle(key).control;}
export function getSnapshot(key:string):{revision:number;stream:unknown}{const state=requireHandle(key);state.control.flush();const engine=state.control.engine,revision=engine.revision,json=JSON.stringify(engine.document);return{revision,stream:stream(utf8.encode(json))};}
export function getDataSnapshot(key:string):{revision:number;stream:unknown}{const state=requireHandle(key);return{revision:state.table?.revision??0,stream:stream(utf8.encode(JSON.stringify(state.table?.values()??[])))};}
export function setValue(key:string,json:string,expectedRevision:number,externalVersion=0):{applied:boolean;revision:number}{
  const state=requireHandle(key),engine=state.control.engine;const force=externalVersion>state.externalVersion;
  if(!Number.isSafeInteger(externalVersion)||externalVersion<state.externalVersion)return{applied:false,revision:engine.revision};
  if(!force&&expectedRevision!==engine.revision)return{applied:false,revision:engine.revision};
  const document=json?parseDocument(json):createDocument();state.suppress++;
  try{state.binding?.dispose();state.binding=undefined;state.table?.dispose();state.table=undefined;state.dataSubscription?.();state.dataSubscription=undefined;engine.replaceDocument(document);state.source=undefined;state.externalVersion=externalVersion;state.sentRevision=state.pendingRevision=engine.revision;state.control.fit();return{applied:true,revision:engine.revision};}finally{state.suppress--;}
}
export async function setValueFromStream(key:string,input:DotNetReadStream,expectedRevision:number,externalVersion=0,maxBytes=64*1024*1024):Promise<{applied:boolean;revision:number}>{const bytes=await input.arrayBuffer();if(bytes.byteLength>maxBytes)throw new DrawingError('DOCUMENT_LIMIT','The streamed document exceeds the configured limit.');return setValue(key,decoder.decode(bytes),expectedRevision,externalVersion);}
export function setOptions(key:string,options:Partial<DrawingControlOptions>):void{requireHandle(key).control.setOptions(options);}
export function flush(key:string):number{const state=requireHandle(key);state.control.flush();return state.control.engine.revision;}
export function resumeCallbacks(key:string):void{const state=requireHandle(key);state.failed=false;notify(key,state);}
export function command(key:string,name:string,args:unknown[]=[]):unknown{
  const state=requireHandle(key),control=state.control,engine=control.engine,operations=new DiagramOperations(engine);
  const sheet=()=>state.sheet??=new ShapeSheetService(engine);
  switch(name){case 'fit':control.fit();return;case 'fitSelection':control.fitSelection();return;case 'focus':control.focus();return;case 'zoom':control.setZoom(Number(args[0]));return;case 'select':engine.select(args[0] as string[]);return;case 'page':control.pageId=String(args[0]);return;case 'tool':control.tool=args[0] as DrawingTool;return;}
  switch(name){
    case 'selectContents': operations.selectContainerContents(String(args[0])); return;
    case 'sheetCells': return sheet().cells(String(args[0]));
    case 'evaluateCell': return sheet().evaluate(String(args[0]),String(args[1]));
  }
  if(control.readOnly)throw new DrawingError('READ_ONLY','This diagram is read-only.');
  switch(name){
    case 'container': return operations.createContainer(control.pageId,(args[0]??engine.selection) as string[],(args[1]??{}) as ContainerOptions);
    case 'setMembers': operations.setContainerMembers(String(args[0]),args[1] as string[]); return;
    case 'containerLock': operations.setContainerLocked(String(args[0]),!!args[1]); return;
    case 'fitContainer': operations.fitContainer(String(args[0])); return;
    case 'disband': operations.disbandContainer(String(args[0])); return;
    case 'swimlanes': return operations.createSwimlanes(control.pageId,args[0] as string[],args[1] as 'horizontal'|'vertical');
    case 'reorderLane': operations.reorderLane(String(args[0]),String(args[1]),Number(args[2])); return;
    case 'callout': return operations.createCallout(control.pageId,String(args[0]),args[1] as string|undefined);
    case 'hyperlink': return operations.addHyperlink(String(args[0]),args[1] as Omit<Hyperlink,'id'>);
    case 'removeHyperlink': operations.removeHyperlink(String(args[0]),String(args[1])); return;
    case 'comment': return operations.addComment(control.pageId,String(args[0]),(args[1]??undefined) as string|undefined,(args[2]??undefined) as string|undefined,(args[3]??undefined) as Point|undefined);
    case 'replyComment': operations.replyComment(String(args[0]),String(args[1]),args[2] as string|undefined); return;
    case 'resolveComment': operations.resolveComment(String(args[0]),args[1]===undefined?true:!!args[1]); return;
    case 'deleteComment': operations.deleteComment(String(args[0])); return;
    case 'theme': operations.applyTheme(args[0] as DiagramTheme,args[1] as string[]|undefined); return;
    case 'registerDataGraphic': operations.registerDataGraphic(args[0] as DataGraphic); return;
    case 'applyDataGraphic': operations.applyDataGraphic(args[0] as string[],args[1] as string|undefined); return;
    case 'recordset': return operations.upsertRecordset(args[0] as DataRecordset);
    case 'linkData': operations.linkShape(String(args[0]),args[1] as ShapeDataLink); return;
    case 'unlinkData': operations.unlinkShape(String(args[0]),args[1] as string|undefined); return;
    case 'refreshData': return operations.refreshLinks(String(args[0]),args[1] as string[]|undefined);
    case 'autoLink': return operations.autoLink(control.pageId,String(args[0]),String(args[1]),String(args[2]),args[3] as Record<string,string>);
    case 'richText': engine.update(String(args[0]),{richText:args[1] as RichText}); return;
    case 'editRichText': control.editRichText(String(args[0])); return;
    case 'sheetCell': sheet().setCell(String(args[0]),String(args[1]),args[2] as FormulaValue,args[3] as string|undefined); return;
    case 'activateSheet': return sheet().activate((args[0]??undefined) as string[]|undefined);
    case 'deactivateSheet': sheet().deactivate(args[0] as string[]|undefined); return;
    case 'recalculate': sheet().recalculate(); return;
    case 'distribute': operations.distribute(engine.selection,args[0] as 'horizontal'|'vertical'); return;
    case 'flip': operations.flip(engine.selection,args[0] as 'horizontal'|'vertical'); return;
    case 'duplicatePage': return operations.duplicatePage(control.pageId);
    case 'updatePage': engine.updatePage(String(args[0]),args[1] as Parameters<DiagramEngine['updatePage']>[1]); return;
    case 'registerMaster': return engine.registerMaster(String(args[0]),String(args[1]),args[2] as Shape);
    case 'insertMaster': return engine.instantiateMaster(String(args[0]),control.pageId,Number(args[1]??100),Number(args[2]??100));
  }
  switch(name){case 'undo':return engine.undo();case 'redo':return engine.redo();case 'delete':engine.remove(engine.selection);return;case 'duplicate':return engine.duplicate();case 'group':return engine.group();case 'ungroup':engine.ungroup();return;case 'add':return control.addShape(args[0] as ShapeKind,args[1] as {x:number;y:number}|undefined,args[2] as string|undefined);case 'update':engine.update(String(args[0]),args[1] as Partial<Shape>);return;case 'align':engine.align(engine.selection,args[0] as 'left');return;case 'front':engine.reorder(engine.selection,'front');return;case 'back':engine.reorder(engine.selection,'back');return;case 'layout':layeredLayout(engine,control.pageId);return;case 'addPage':return engine.addPage(args[0] as string|undefined);default:throw new DrawingError('UNKNOWN_COMMAND',`Unknown diagram command: ${name}`);}
}
export async function importStream(key:string,input:DotNetReadStream,name:string,maxBytes=128*1024*1024):Promise<{revision:number;diagnostics:readonly Diagnostic[]}>{const state=requireHandle(key),engine=state.control.engine,revision=engine.revision,bytes=await input.arrayBuffer();if(bytes.byteLength>maxBytes)throw new DrawingError('IMPORT_LIMIT','The input exceeds the configured limit.');const result=await readDrawing(new Uint8Array(bytes),name);requireHandle(key);if(engine.revision!==revision)throw new DrawingError('REVISION_CONFLICT','The diagram changed while the import was in flight.');state.binding?.dispose();state.binding=undefined;state.dataSubscription?.();state.dataSubscription=undefined;state.table?.dispose();state.table=undefined;engine.replaceDocument(result.document,revision);state.source=result.source;state.control.fit();return{revision:engine.revision,diagnostics:result.diagnostics};}
export async function exportStream(key:string,format='json'):Promise<{revision:number;stream:unknown;diagnostics:Diagnostic[]}>{const state=requireHandle(key),control=state.control;control.flush();const engine=control.engine,document=engine.document,revision=engine.revision,diagnostics:Diagnostic[]=[];let bytes:Uint8Array|Blob;
  switch(format){case 'json':bytes=utf8.encode(JSON.stringify(document));break;case 'vsdx':bytes=state.source?await state.source.save(document):await writeVsdx(document,{onDiagnostic:d=>diagnostics.push(d)});break;case 'vsdx-rebuild':bytes=await writeVsdx(document,{onDiagnostic:d=>diagnostics.push(d)});break;case 'vstx':case 'vssx':bytes=await writeVisio(document,{kind:format==='vstx'?'template':'stencil',onDiagnostic:d=>diagnostics.push(d)});break;case 'vdx':bytes=utf8.encode(writeVdx(document,{onDiagnostic:d=>diagnostics.push(d)}));break;case 'svg':bytes=utf8.encode(exportSvg(document,control.pageId));break;case 'png':bytes=await control.exportPng();break;default:throw new DrawingError('EXPORT_FORMAT',`Unsupported format: ${format}`);}
  requireHandle(key);return{revision,stream:stream(bytes),diagnostics};
}
export async function bindRowsStream(key:string,input:DotNetReadStream,keyField:string,mappings:Record<string,string>,twoWay=true):Promise<void>{const state=requireHandle(key),revision=state.control.engine.revision,bytes=await input.arrayBuffer();if(bytes.byteLength>32*1024*1024)throw new DrawingError('DATA_LIMIT','Data source exceeds 32 MiB.');const rows=JSON.parse(decoder.decode(bytes)) as DataRow[];requireHandle(key);if(state.control.engine.revision!==revision)throw new DrawingError('REVISION_CONFLICT','The diagram changed while the data source was transferred.');const table=new ObservableTable(keyField,[],rows);state.binding?.dispose();state.dataSubscription?.();state.table?.dispose();const binding=new DiagramBinding(state.control.engine,table,{pageId:state.control.pageId,mappings,twoWay,removeRowsOnShapeDelete:true});state.table=table;state.binding=binding;state.dataSubscription=table.changed.subscribe(change=>callback(state,'OnDataChanged',change.revision));state.subscriptions.push(binding.errors.subscribe(error=>callback(state,'OnNativeError','DATA_BINDING',error instanceof Error?error.message:String(error))));}
export function dispose(key:string):void{const state=handles.get(key);if(!state||state.disposed)return;state.disposed=true;handles.delete(key);state.observer.disconnect();state.sheet?.dispose();state.binding?.dispose();state.table?.dispose();state.dataSubscription?.();for(const unsubscribe of state.subscriptions)unsubscribe();state.control.dispose();state.control.engine.dispose();state.callback=undefined;}
/** Useful to assert native teardown in package-restored hosting tests. */
export function activeHandleCount():number{return handles.size;}
