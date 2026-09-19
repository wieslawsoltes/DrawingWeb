import { DiagramEngine, Signal, type DiagramDocument, type DocumentChange, type Unsubscribe } from './core.js';
export class ObservableProperty<T> {
  readonly changed=new Signal<{oldValue:T;value:T}>();
  constructor(private current:T,private readonly equals:(a:T,b:T)=>boolean=Object.is){}
  get value():T{return this.current;}
  set value(value:T){if(this.equals(this.current,value))return;const oldValue=this.current;this.current=value;this.changed.emit({oldValue,value});}
  subscribe(listener:(value:T)=>void,emitCurrent=false):Unsubscribe{if(emitCurrent)listener(this.current);return this.changed.subscribe(change=>listener(change.value));}
}
export class Command<T=void> {
  readonly canExecuteChanged=new Signal<void>();readonly failed=new Signal<unknown>();private running=false;
  constructor(private readonly executeAction:(parameter:T)=>void|Promise<void>,private readonly predicate:(parameter:T)=>boolean=()=>true){}
  canExecute(parameter:T):boolean{return !this.running&&this.predicate(parameter);}
  async execute(parameter:T):Promise<boolean>{if(!this.canExecute(parameter))return false;this.running=true;this.canExecuteChanged.emit();try{await this.executeAction(parameter);return true;}catch(error){this.failed.emit(error);throw error;}finally{this.running=false;this.canExecuteChanged.emit();}}
  invalidate():void{this.canExecuteChanged.emit();}
}
export class DiagramViewModel {
  readonly title:ObservableProperty<string>;readonly selection=new ObservableProperty<readonly string[]>([]);readonly revision=new ObservableProperty(0);readonly changed=new Signal<DocumentChange>();
  readonly undo:Command;readonly redo:Command;readonly deleteSelection:Command;private subscriptions:Unsubscribe[]=[];
  constructor(readonly engine:DiagramEngine){this.title=new ObservableProperty(engine.document.title);this.revision.value=engine.revision;this.undo=new Command(()=>{engine.undo();},()=>engine.canUndo);this.redo=new Command(()=>{engine.redo();},()=>engine.canRedo);this.deleteSelection=new Command(()=>engine.remove(engine.selection),()=>engine.selection.length>0);
    this.subscriptions.push(engine.changed.subscribe(e=>{this.title.value=e.document.title;this.revision.value=e.revision;this.undo.invalidate();this.redo.invalidate();this.changed.emit(e);}),engine.selectionChanged.subscribe(ids=>{this.selection.value=ids;this.deleteSelection.invalidate();}),this.title.subscribe(title=>{if(engine.document.title!==title)engine.setTitle(title);}));}
  get document():DiagramDocument{return this.engine.document;}
  dispose():void{for(const unsubscribe of this.subscriptions)unsubscribe();this.subscriptions=[];this.changed.clear();}
}
