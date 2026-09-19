import { DiagramEngine } from './core.js';
import { clone, createShape, DrawingError, freeze, id, Signal, validateJson } from './model.js';
import type { DiagramDocument, Json, Shape, ShapeStyle, Unsubscribe } from './model.js';

export type DataRow = Record<string, Json>;
export type RowKey = string | number;
export interface DataField { name:string; type:'string'|'number'|'boolean'|'date'|'json'; nullable?:boolean; readonly?:boolean }
export interface RowChange<T extends DataRow = DataRow> { type:'upsert'|'delete'; key:RowKey; before?:T; after?:T }
export interface TableChange<T extends DataRow = DataRow> { revision:number; origin:string; changes:readonly RowChange<T>[] }
function equal(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b);}
function keyOf(value:Json|undefined):RowKey{if((typeof value!=='string'&&typeof value!=='number')||value===''||(typeof value==='number'&&!Number.isFinite(value)))throw new DrawingError('ROW_KEY','Each row needs a nonempty string or finite numeric key.');return value;}
/** Typed observable rows. Batch replacement validates first, then publishes one atomic change set. */
export class ObservableTable<T extends DataRow = DataRow> {
  private rows=new Map<RowKey,T>();private _revision=0;private depth=0;
  readonly changed=new Signal<TableChange<T>>();
  constructor(public readonly keyField:string,public readonly fields:readonly DataField[]=[],rows:readonly T[]=[]){this.replace(rows,'initial');}
  get revision():number{return this._revision;}
  get size():number{return this.rows.size;}
  get(key:RowKey):T|undefined{return this.rows.get(key);}
  values():T[]{return [...this.rows.values()];}
  key(row:T):RowKey{return keyOf(row[this.keyField]);}
  private validate(row:T):void{
    validateJson(row);this.key(row);
    for(const field of this.fields){const value=row[field.name];if(value===null||value===undefined){if(!field.nullable)throw new DrawingError('FIELD_REQUIRED',`${field.name} is required.`);continue;}
      const valid=field.type==='json'||field.type==='date'?(field.type==='json'||typeof value==='string'&&Number.isFinite(Date.parse(value))):typeof value===field.type;
      if(!valid)throw new DrawingError('FIELD_TYPE',`${field.name} must be ${field.type}.`);
    }
  }
  transaction<R>(action:()=>R,origin='user'):R{
    const before=this.rows,outer=this.depth++===0;this.rows=new Map(before);let result:R;
    try{result=action();if(result&&typeof(result as {then?:unknown}).then==='function')throw new DrawingError('ASYNC_TRANSACTION','Table transactions are synchronous.');}
    catch(error){this.rows=before;this.depth--;throw error;}this.depth--;
    if(outer){const changes:RowChange<T>[]=[];for(const[key,row]of before)if(!this.rows.has(key))changes.push({type:'delete',key,before:row});for(const[key,row]of this.rows){const old=before.get(key);if(!equal(old,row))changes.push({type:'upsert',key,before:old,after:row});}if(changes.length){this._revision++;this.changed.emit({revision:this.revision,origin,changes});}}
    return result;
  }
  private run(action:()=>void,origin:string):void{if(this.depth)action();else this.transaction(action,origin);}
  upsert(row:T,origin='user'):void{this.validate(row);this.run(()=>this.rows.set(this.key(row),freeze(clone(row))),origin);}
  update(key:RowKey,patch:Partial<T>,origin='user'):void{
    const old=this.get(key);if(!old)throw new DrawingError('ROW_NOT_FOUND',String(key));
    for(const field of this.fields)if(field.readonly&&Object.prototype.hasOwnProperty.call(patch,field.name)&&!equal(old[field.name],patch[field.name]))throw new DrawingError('FIELD_READONLY',`${field.name} is read-only.`);
    const next={...old,...patch};if(this.key(next)!==key)throw new DrawingError('IMMUTABLE_KEY','Use delete/add to change a row key.');this.upsert(next,origin);
  }
  delete(key:RowKey,origin='user'):void{this.run(()=>{this.rows.delete(key);},origin);}
  replace(rows:readonly T[],origin='user'):void{
    const next=new Map<RowKey,T>();for(const row of rows){this.validate(row);const key=this.key(row);if(next.has(key))throw new DrawingError('DUPLICATE_KEY',`Duplicate row key: ${key}`);next.set(key,freeze(clone(row)));}
    this.run(()=>{this.rows=next;},origin);
  }
  dispose():void{this.changed.clear();}
}
export interface BindingOptions<T extends DataRow> {
  pageId:string;
  /** Maps shape properties (e.g. text, x, style.fill, data.status) to row fields. */
  mappings:Readonly<Record<string,string>>;
  shapeId?:(row:T)=>string;
  factory?:(row:T,index:number)=>Shape;
  twoWay?:boolean;
  removeMissingShapes?:boolean;
  removeRowsOnShapeDelete?:boolean;
}
const properties=new Set(['text','kind','x','y','width','height','rotation','locked','visible']);
const styleProperties=new Set(['fill','stroke','strokeWidth','opacity','color','fontFamily','fontSize','bold','italic','align','dash','startArrow','endArrow']);
function checkPath(path:string):void{const parts=path.split('.');if(parts.length===1&&properties.has(path))return;if(parts.length===2&&(parts[0]==='style'&&styleProperties.has(parts[1]!)||parts[0]==='data'&&/^[A-Za-z_$][\w$-]*$/.test(parts[1]!)&&!['__proto__','prototype','constructor'].includes(parts[1]!)))return;throw new DrawingError('BINDING_PATH',`Unsupported or unsafe binding path: ${path}`);}
function readProperty(shape:Shape,path:string):Json{const[a,b]=path.split('.');return (b?(shape as unknown as Record<string,Record<string,Json>>)[a!]![b]:(shape as unknown as DataRow)[a!])??null;}
function writeProperty(patch:Partial<Shape>,path:string,value:Json):void{const[a,b]=path.split('.');const target=patch as unknown as DataRow;if(b){const object=(target[a!]??{}) as DataRow;target[a!]={...object,[b]:clone(value)};}else target[a!]=clone(value);}
/** Incremental, identity-stable two-way projection; binding-origin changes cannot feed back into themselves. */
export class DiagramBinding<T extends DataRow=DataRow> {
  readonly errors=new Signal<unknown>();
  readonly origin=id('binding');
  private disposeTable:Unsubscribe;private disposeEngine:Unsubscribe;private known=new Map<RowKey,string>();private disposed=false;
  constructor(public readonly engine:DiagramEngine,public readonly table:ObservableTable<T>,public readonly options:BindingOptions<T>){
    Object.keys(options.mappings).forEach(checkPath);engine.getPage(options.pageId);this.refresh();
    this.disposeTable=table.changed.subscribe(change=>{if(change.origin===this.origin)return;try{this.apply(change.changes);}catch(error){this.errors.emit(error);}});
    this.disposeEngine=engine.changed.subscribe(change=>{
      if(change.origin===this.origin||options.twoWay===false)return;
      try{table.transaction(()=>{
        for(const[key,shapeId]of this.known){if(change.ids.length&&!change.ids.includes(shapeId))continue;const shape=engine.getShape(shapeId),row=table.get(key);
          if(!shape){if(options.removeRowsOnShapeDelete)table.delete(key);continue;}if(!row)continue;
          const patch:Partial<T>={};let changed=false;
          for(const[path,field]of Object.entries(options.mappings)){const value=readProperty(shape,path);if(!equal(row[field],value)){(patch as DataRow)[field]=value;changed=true;}}
          if(changed)table.update(key,patch);
        }
      },this.origin);}catch(error){this.errors.emit(error);}
    });
  }
  private shapeId(row:T):string{return this.options.shapeId?.(row)??String(this.table.key(row));}
  refresh():void{this.apply(this.table.values().map(row=>({type:'upsert',key:this.table.key(row),after:row})));}
  private apply(changes:readonly RowChange<T>[]):void{
    if(this.disposed)return;const known=new Map(this.known),additions:Shape[]=[];
    this.engine.transaction('Apply data binding',()=>{
      for(const change of changes){const oldId=known.get(change.key);
        if(change.type==='delete'){if(oldId&&this.options.removeMissingShapes!==false)this.engine.remove([oldId]);known.delete(change.key);continue;}
        const row=change.after!,shapeId=this.shapeId(row);if(oldId&&oldId!==shapeId)throw new DrawingError('BINDING_ID','A bound shape ID cannot change without deleting its row.');
        const existing=this.engine.getShape(shapeId);if(existing&&this.engine.getRef(shapeId)!.pageId!==this.options.pageId)throw new DrawingError('BINDING_PAGE','A shape ID is already used on another page.');
        const patch:Partial<Shape>={};for(const[path,field]of Object.entries(this.options.mappings)){const value=row[field];if(value!==undefined)writeProperty(patch,path,value);}
        if(existing)this.engine.update(shapeId,patch);
        else{const base=this.options.factory?.(row,known.size)??createShape('rectangle',{x:80+(known.size%4)*230,y:100+Math.floor(known.size/4)*140,text:String(row['label']??change.key)});additions.push({...base,...patch,id:shapeId,style:{...base.style,...patch.style},data:{...base.data,...patch.data}});}
        known.set(change.key,shapeId);
      }
      if(additions.length)this.engine.addMany(this.options.pageId,additions);
    },this.origin);this.known=known;
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.disposeTable();this.disposeEngine();this.errors.clear();}
}
export interface DataSnapshot<T extends DataRow=DataRow>{rows:T[];revision:string}
export interface DataMutation<T extends DataRow=DataRow>{type:'upsert'|'delete';key:RowKey;row?:T}
export interface DataSource<T extends DataRow=DataRow>{read(signal?:AbortSignal):Promise<DataSnapshot<T>>;write(changes:readonly DataMutation<T>[],expectedRevision:string,signal?:AbortSignal):Promise<DataSnapshot<T>>}
export class RevisionConflict extends DrawingError{constructor(message='The remote data changed. Refresh and resolve the conflicting rows before retrying.',details?:unknown){super('REVISION_CONFLICT',message,details);}}
/** Uses an application-owned HTTP endpoint. Database credentials never belong in browser configuration. */
export class RestDataSource<T extends DataRow=DataRow> implements DataSource<T>{
  constructor(public readonly url:string,private readonly options:{fetch?:typeof fetch;headers?:Record<string,string>;credentials?:RequestCredentials}={}){}
  private async request(init:RequestInit):Promise<DataSnapshot<T>>{
    const response=await(this.options.fetch??globalThis.fetch)(this.url,{...init,credentials:this.options.credentials??'same-origin',headers:{Accept:'application/json',...this.options.headers,...init.headers}});
    if(response.status===409||response.status===412)throw new RevisionConflict();if(!response.ok)throw new DrawingError('DATA_HTTP',`Data request failed (${response.status}).`);
    const body=await response.json() as {rows:T[];revision?:string};validateJson(body);const revision=response.headers.get('ETag')??body.revision;
    if(!Array.isArray(body.rows)||typeof revision!=='string'||!revision)throw new DrawingError('DATA_PROTOCOL','The endpoint must return rows and a revision/ETag.');return{rows:body.rows,revision};
  }
  read(signal?:AbortSignal):Promise<DataSnapshot<T>>{return this.request({method:'GET',signal});}
  write(changes:readonly DataMutation<T>[],expectedRevision:string,signal?:AbortSignal):Promise<DataSnapshot<T>>{if(!expectedRevision)throw new RevisionConflict('Read a server revision before saving.');return this.request({method:'PATCH',headers:{'Content-Type':'application/json','If-Match':expectedRevision},body:JSON.stringify({changes}),signal});}
}
/** Optimistic refresh/save boundary. New local edits made during a save remain pending after acknowledgement. */
export class DataConnection<T extends DataRow=DataRow>{
  private baseline=new Map<RowKey,T>();private revision='';private generation=0;private saving?:Promise<void>;
  constructor(public readonly table:ObservableTable<T>,public readonly source:DataSource<T>){}
  get remoteRevision():string{return this.revision;}
  get pending():DataMutation<T>[]{const result:DataMutation<T>[]=[];for(const[key]of this.baseline)if(!this.table.get(key))result.push({type:'delete',key});for(const row of this.table.values()){const key=this.table.key(row);if(!equal(row,this.baseline.get(key)))result.push({type:'upsert',key,row});}return result;}
  async refresh(signal?:AbortSignal):Promise<void>{
    if(this.revision&&this.pending.length)throw new RevisionConflict('Unsaved local edits must be saved or explicitly discarded before refresh.');const generation=++this.generation,localRevision=this.table.revision,snapshot=await this.source.read(signal);
    if(generation!==this.generation)throw new DrawingError('STALE_REFRESH','A newer data refresh superseded this result.');if(localRevision!==this.table.revision)throw new RevisionConflict('Rows changed while a refresh was in flight.');this.table.replace(snapshot.rows,'remote');this.accept(snapshot);
  }
  private accept(snapshot:DataSnapshot<T>):void{this.revision=snapshot.revision;this.baseline=new Map(snapshot.rows.map(row=>[this.table.key(row),freeze(clone(row))]));}
  save(signal?:AbortSignal):Promise<void>{if(this.saving)return this.saving;const operation=this.saveOnce(signal);this.saving=operation.finally(()=>{this.saving=undefined;});return this.saving;}
  private async saveOnce(signal?:AbortSignal):Promise<void>{const changes=this.pending;if(!changes.length)return;if(!this.revision)throw new RevisionConflict('Load the remote data before saving.');const localRevision=this.table.revision,snapshot=await this.source.write(changes,this.revision,signal);if(localRevision===this.table.revision)this.table.replace(snapshot.rows,'remote');this.accept(snapshot);}
  async discardAndRefresh(signal?:AbortSignal):Promise<void>{const generation=++this.generation,snapshot=await this.source.read(signal);if(generation!==this.generation)throw new DrawingError('STALE_REFRESH','Superseded refresh.');this.table.replace(snapshot.rows,'remote');this.accept(snapshot);}
}
export interface CsvOptions{delimiter?:string;maxRows?:number;maxCharacters?:number;protectFormulas?:boolean}
export function parseCsv(text:string,options:CsvOptions={}):string[][]{
  const delimiter=options.delimiter??',';if(delimiter.length!==1||delimiter==='"'||delimiter==='\r'||delimiter==='\n')throw new DrawingError('CSV_DELIMITER','The delimiter must be one ordinary character.');
  if(text.length>(options.maxCharacters??16*1024*1024))throw new DrawingError('CSV_LIMIT','CSV input exceeds the limit.');if(text.charCodeAt(0)===0xfeff)text=text.slice(1);if(!text)return[];
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
  const addField=()=>{row.push(field);field='';closed=false;};const addRow=()=>{addField();rows.push(row);row=[];if(rows.length>(options.maxRows??100000))throw new DrawingError('CSV_LIMIT','Too many CSV records.');};
  for(let i=0;i<text.length;i++){const c=text[i]!;
    if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c===delimiter){addField();continue;}if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;addRow();continue;}
    if(closed)throw new DrawingError('CSV_SYNTAX','Unexpected character after a closing quote.');if(c==='"'){if(field)throw new DrawingError('CSV_SYNTAX','Quotes must start a CSV field.');quoted=true;}else field+=c;
  }
  if(quoted)throw new DrawingError('CSV_SYNTAX','Unterminated quoted field.');if(field||row.length||closed||text.endsWith(delimiter))addRow();return rows;
}
export function stringifyCsv(rows:readonly(readonly Json[])[],options:CsvOptions={}):string{
  const delimiter=options.delimiter??',';return rows.map(row=>row.map(value=>{let text=value===null?'':typeof value==='object'?JSON.stringify(value):String(value);if(options.protectFormulas!==false&&/^[\s]*[=+\-@]/.test(text))text="'"+text;return text.includes(delimiter)||/["\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;}).join(delimiter)).join('\r\n');
}
export interface StoredDocument{key:string;revision:number;document:DiagramDocument;updatedAt:string}
/** IndexedDB read/compare/write occurs in a single transaction, including cross-tab writers. */
export class BrowserDocumentStore{
  private database?:Promise<IDBDatabase>;
  constructor(private readonly name='drawingweb',private readonly store='documents'){}
  private open():Promise<IDBDatabase>{return this.database??=new Promise((resolve,reject)=>{if(!globalThis.indexedDB){reject(new DrawingError('INDEXEDDB_UNAVAILABLE','IndexedDB is unavailable. Supply an application-owned persistence adapter.'));return;}const request=indexedDB.open(this.name,1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(this.store))request.result.createObjectStore(this.store,{keyPath:'key'});};request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();this.database=undefined;};resolve(request.result);};request.onerror=()=>{this.database=undefined;reject(request.error);};request.onblocked=()=>reject(new DrawingError('INDEXEDDB_BLOCKED','Close other tabs using the old database version.'));});}
  async load(key:string):Promise<StoredDocument|undefined>{const db=await this.open();return new Promise((resolve,reject)=>{const transaction=db.transaction(this.store,'readonly'),request=transaction.objectStore(this.store).get(key);let result:StoredDocument|undefined;request.onsuccess=()=>{result=request.result as StoredDocument|undefined;};transaction.oncomplete=()=>resolve(result);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error??new DrawingError('STORAGE_ABORT','Storage read aborted.'));});}
  async save(key:string,document:DiagramDocument,expectedRevision:number):Promise<number>{const db=await this.open();return new Promise((resolve,reject)=>{const transaction=db.transaction(this.store,'readwrite'),objectStore=transaction.objectStore(this.store),request=objectStore.get(key);let revision=0,error:unknown;
    request.onsuccess=()=>{const previous=request.result as StoredDocument|undefined;if((previous?.revision??0)!==expectedRevision){error=new RevisionConflict('Another browser tab saved this document. Reload or save a separate copy.');transaction.abort();return;}revision=expectedRevision+1;objectStore.put({key,revision,document:clone(document),updatedAt:new Date().toISOString()} satisfies StoredDocument);};transaction.oncomplete=()=>resolve(revision);transaction.onerror=()=>reject(error??transaction.error);transaction.onabort=()=>reject(error??transaction.error??new DrawingError('STORAGE_ABORT','Storage write aborted.'));});}
  async close():Promise<void>{const database=this.database;this.database=undefined;if(database)(await database).close();}
}
