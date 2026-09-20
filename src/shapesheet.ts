/** Opt-in, sandboxed ShapeSheet projection. Unsupported functions never execute host code. */
import { DiagramEngine } from './core.js';
import { Formula } from './formula.js';
import type { FormulaValue } from './formula.js';
import type { Diagnostic, Shape } from './model.js';
import { DrawingError, clone } from './model.js';
export interface SheetCellResult { shapeId:string; name:string; value:FormulaValue; formula?:string; error?:Diagnostic }
const geometryCells=new Set(['width','height','pinx','piny','angle']);
const safeName=(name:string):boolean=>/^(?:[A-Za-z][\w]*|(?:User|Prop)\.[A-Za-z_][\w.]*)$/i.test(name)&&!/(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$)/i.test(name);
/** Formulas enrolled through this service derive inside the original engine transaction and undo entry. */
export class ShapeSheetService {
  private active=new Map<string,Set<string>>();
  private readonly unsubscribe:()=>void;
  private disposed=false;
  private readonly changed:()=>void;
  constructor(readonly engine:DiagramEngine){this.unsubscribe=engine.addDerivation(()=>this.calculate());this.changed=engine.changed.subscribe(change=>{if(change.origin==='load')this.active.clear();});}
  /** Stop live projection without discarding retained cell formulas or cached values. */
  deactivate(shapeIds?:readonly string[]):void {if(shapeIds)for(const key of shapeIds)this.active.delete(key);else this.active.clear();}
  setCell(shapeId:string,name:string,value:FormulaValue,formula?:string):void {
    if(this.disposed)throw new DrawingError('DISPOSED','ShapeSheet service disposed.');
    if(!safeName(name))throw new DrawingError('CELL_NAME','Use a scalar cell, User.name or Prop.name.');
    if(formula)new Formula(formula,{lengthScale:1/96});
    const shape=this.engine.getShape(shapeId);if(!shape)throw new DrawingError('SHAPE_NOT_FOUND',shapeId);
    const existing=Object.keys(shape.cells).find(key=>key.toLowerCase()===name.toLowerCase());name=existing??name;
    const enrolled=this.active.get(shapeId)??new Set<string>(),already=enrolled.has(name);enrolled.add(name);this.active.set(shapeId,enrolled);
    try{this.engine.transaction('Edit ShapeSheet cell',()=>{this.engine.update(shapeId,{cells:{...shape.cells,[name]:{value:typeof value==='string'?value:String(value),...(formula?{formula}:{})}}});});}
    catch(error){if(!already)enrolled.delete(name);throw error;}
  }
  /** Activate selected imported formulas deliberately; unsupported cells are diagnosed without replacing their caches. */
  activate(shapeIds:readonly string[]=this.engine.allShapes().map(shape=>shape.id)):Diagnostic[] {
    const diagnostics:Diagnostic[]=[];
    for(const shapeId of shapeIds){const shape=this.engine.getShape(shapeId);if(!shape)continue;
      for(const [name,cell]of Object.entries(shape.cells))if(cell.formula&&safeName(name)){
        try{this.evaluate(shapeId,name);const cells=this.active.get(shapeId)??new Set();cells.add(name);this.active.set(shapeId,cells);}
        catch(error){diagnostics.push({code:error instanceof DrawingError?error.code:'FORMULA',severity:'warning',shapeId,message:error instanceof Error?error.message:String(error)});}
      }
    }
    return diagnostics;
  }
  recalculate():void {this.engine.transaction('Recalculate ShapeSheet',()=>this.calculate());}
  evaluate(shapeId:string,name:string):FormulaValue{return this.evaluator()(shapeId,name);}
  cells(shapeId:string):SheetCellResult[]{const shape=this.engine.getShape(shapeId);if(!shape)throw new DrawingError('SHAPE_NOT_FOUND',shapeId);
    const names=new Set(['Width','Height','PinX','PinY','Angle',...Object.keys(shape.cells)]);
    const get=this.evaluator();return [...names].map(name=>{try{return{shapeId,name,value:get(shapeId,name),formula:shape.cells[name]?.formula};}catch(error){return{shapeId,name,value:parseCached(shape.cells[name]?.value??''),formula:shape.cells[name]?.formula,error:{code:error instanceof DrawingError?error.code:'FORMULA',severity:'warning' as const,message:error instanceof Error?error.message:String(error),shapeId}};}});
  }
  private evaluator(): (shapeId:string,name:string)=>FormulaValue {
    const cache=new Map<string,FormulaValue>(),stack=new Set<string>(),e=this.engine;let budget=20000;
    const sheets=new Map<string,Map<number,string>>();for(const page of e.document.pages){const map=new Map<number,string>();for(const shape of e.allShapes(page.id))if(shape.sheetId)map.set(shape.sheetId,shape.id);sheets.set(page.id,map);}
    const get=(shapeId:string,name:string):FormulaValue=>{
      const key=shapeId+'!'+name.toLowerCase();if(cache.has(key))return cache.get(key)!;
      if(--budget<0||stack.size>=128)throw new DrawingError('FORMULA_BUDGET','ShapeSheet evaluation budget exceeded.');
      if(stack.has(key))throw new DrawingError('FORMULA_CYCLE',`Circular dependency at ${name}.`);
      const shape=e.getShape(shapeId),ref=e.getRef(shapeId);if(!shape||!ref)throw new DrawingError('FORMULA_REFERENCE',shapeId);
      stack.add(key);
      try{
        const cellName=Object.keys(shape.cells).find(n=>n.toLowerCase()===name.toLowerCase()),cell=cellName?shape.cells[cellName]:undefined;
        let value:FormulaValue;
        if(cell?.formula){value=new Formula(cell.formula,{lengthScale:1/96}).evaluate(reference=>{
          const sheet=reference.match(/^Sheet\.(\d+)!(.+)$/i);if(sheet){const other=sheets.get(ref.pageId)?.get(Number(sheet[1]));if(!other)throw new DrawingError('FORMULA_REFERENCE',reference);return get(other,sheet[2]!);}
          const page=reference.match(/^ThePage!(PageWidth|PageHeight)$/i);if(page){const p=e.getPage(ref.pageId);return (page[1]!.toLowerCase()==='pagewidth'?p.width:p.height)/96;}
          return get(shapeId,reference);
        });}
        else if(cell&&(!geometryCells.has(name.toLowerCase())||this.active.get(shapeId)?.has(cellName!)))value=parseCached(cell.value);
        else {switch(name.toLowerCase()){
          case 'width':value=shape.width/96;break;case 'height':value=shape.height/96;break;case 'pinx':value=(shape.x+shape.width/2)/96;break;
          case 'piny':value=((ref.parentId?e.getShape(ref.parentId)!.height:e.getPage(ref.pageId).height)-shape.y-shape.height/2)/96;break;
          case 'angle':value=-shape.rotation;break;
          default:if(name.toLowerCase().startsWith('prop.')&&Object.hasOwn(shape.data,name.slice(5))) {const p=shape.data[name.slice(5)];if(typeof p==='number'||typeof p==='string'||typeof p==='boolean'){value=p;break;}}if(cell){value=parseCached(cell.value);break;}throw new DrawingError('FORMULA_REFERENCE',`Unknown cell ${name}.`);
        }}
        cache.set(key,value);return value;
      }finally{stack.delete(key);}
    };return get;
  }
  private calculate():void {
    if(this.disposed)return;const get=this.evaluator(),results:Array<{shapeId:string;name:string;value:FormulaValue}>=[];
    // Snapshot all results before mutating geometry so reference order cannot affect evaluation.
    for(const [shapeId,names]of this.active){const shape=this.engine.getShape(shapeId);if(!shape)continue;
      for(const name of names)if(shape.cells[name]){const cell=shape.cells[name]!,value=cell.formula?get(shapeId,name):parseCached(cell.value);results.push({shapeId,name,value});}
    }
    for(const shapeId of new Set(results.map(result=>result.shapeId))){const e=this.engine,s=e.getShape(shapeId)!,ref=e.getRef(shapeId)!,items=results.filter(result=>result.shapeId===shapeId),cells=clone(s.cells),patch:Partial<Shape>={};let changed=false;
      const values=new Map(items.map(item=>[item.name.toLowerCase(),item.value]));
      for(const result of items){const cell=cells[result.name]!;if(cell.value!==String(result.value)){cell.value=String(result.value);changed=true;}}
      if([...values.keys()].some(key=>geometryCells.has(key))){if(s.transform)throw new DrawingError('FORMULA_TRANSFORM','Geometry-cell projection on an extra affine transform is not supported; flatten the transform explicitly first.');
        const number=(name:string,fallback:number)=>{const v=values.get(name);if(v===undefined)return fallback;if(typeof v!=='number'||!Number.isFinite(v))throw new DrawingError('FORMULA_VALUE',`${name} requires a finite numeric result.`);return v;};
        const width=number('width',s.width/96)*96,height=number('height',s.height/96)*96;
        if(width<=0||height<=0)throw new DrawingError('FORMULA_GEOMETRY','ShapeSheet width and height must be positive.');
        if(width!==s.width||height!==s.height)e.resize(shapeId,width,height);
        patch.x=number('pinx',(s.x+s.width/2)/96)*96-width/2;
        const parentHeight=ref.parentId?e.getShape(ref.parentId)!.height:e.getPage(ref.pageId).height;
        patch.y=parentHeight-number('piny',(parentHeight-s.y-s.height/2)/96)*96-height/2;
        patch.rotation=-number('angle',-s.rotation);
        changed ||= patch.x!==s.x||patch.y!==s.y||patch.rotation!==s.rotation;
      }
      for(const result of items)if(result.name.toLowerCase().startsWith('prop.')){const key=result.name.slice(5);if(s.data[key]!==result.value){patch.data={...s.data,...patch.data,[key]:result.value};changed=true;}}
      if(changed)e.update(shapeId,{...patch,cells});
    }
  }
  dispose():void {if(this.disposed)return;this.disposed=true;this.unsubscribe();this.changed();this.active.clear();}
}
function parseCached(value:string):FormulaValue {if(/^"[\s\S]*"$/.test(value))return value.slice(1,-1).replace(/""/g,'"');if(/^(true|false)$/i.test(value))return value.toLowerCase()==='true';if(value.trim()&&Number.isFinite(Number(value)))return Number(value);return value;}
