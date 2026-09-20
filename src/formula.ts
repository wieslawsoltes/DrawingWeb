import { DrawingError } from './model.js';
export type FormulaValue = number | string | boolean;
export type FormulaResolver = (reference: string) => FormulaValue;
export interface FormulaContext { call?: (name: string, arguments_: readonly FormulaValue[]) => FormulaValue | undefined }
export interface FormulaWritePlan { formula: string; assignments: { reference: string; formula: string }[] }
const printAst = (node: Ast): string => {
  switch (node.type) {
    case 'literal': return typeof node.value === 'string' ? '"' + node.value.replaceAll('"', '""') + '"' : String(node.value);
    case 'ref': return node.name;
    case 'unary': return '(' + node.op + printAst(node.value) + ')';
    case 'binary': return '(' + printAst(node.left) + node.op + printAst(node.right) + ')';
    case 'call': return node.name + '(' + node.args.map(printAst).join(',') + ')';
  }
};
type Ast = {type:'literal';value:FormulaValue}|{type:'ref';name:string}|{type:'unary';op:string;value:Ast}|{type:'binary';op:string;left:Ast;right:Ast}|{type:'call';name:string;args:Ast[]};
interface Token { text:string; type:'number'|'string'|'name'|'op'|'end' }
const precedence:Record<string,number>={'=':1,'==':1,'<>':1,'!=':1,'<':1,'>':1,'<=':1,'>=':1,'&':2,'+':3,'-':3,'*':4,'/':4,'%':4,'^':5};
const units:Record<string,number>={in:96,mm:96/25.4,cm:96/2.54,pt:96/72,px:1,deg:Math.PI/180,rad:1};
function tokenize(input:string):Token[]{
  if(input.length>65536)throw new DrawingError('FORMULA_LIMIT','Formula is too long.');
  const result:Token[]=[];let i=0;
  while(i<input.length){if(/\s/.test(input[i]!)){i++;continue;}const rest=input.slice(i);let match:RegExpMatchArray|null;
    if((match=rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/))){result.push({text:match[0],type:'number'});i+=match[0].length;}
    else if(input[i]==='"'){i++;let value='';let ended=false;while(i<input.length){if(input[i]==='"'){if(input[i+1]==='"'){value+='"';i+=2;}else{i++;ended=true;break;}}else value+=input[i++];}if(!ended)throw new DrawingError('FORMULA_SYNTAX','Unterminated string.');result.push({text:value,type:'string'});}
    else if((match=rest.match(/^[A-Za-z_$][\w.$]*(?:![A-Za-z_$][\w.$]*)?/))){result.push({text:match[0],type:'name'});i+=match[0].length;}
    else if((match=rest.match(/^(?:<=|>=|<>|!=|==|[+\-*/%^&=<>(),])/))){result.push({text:match[0],type:'op'});i+=match[0].length;}
    else throw new DrawingError('FORMULA_SYNTAX',`Unexpected token at offset ${i}.`);
    if(result.length>4096)throw new DrawingError('FORMULA_LIMIT','Too many formula tokens.');
  }result.push({text:'',type:'end'});return result;
}
export class Formula {
  private readonly ast:Ast;
  readonly dependencies:ReadonlySet<string>;
  constructor(public readonly source:string,options:{lengthScale?:number}={}){
    const tokens=tokenize(source.startsWith('=')?source.slice(1):source);let index=0,depth=0;const refs=new Set<string>();
    const peek=()=>tokens[index]!,take=()=>tokens[index++]!;
    const expression=(min=0):Ast=>{if(++depth>128)throw new DrawingError('FORMULA_DEPTH','Formula nesting is too deep.');let node:Ast;const token=take();
      if(token.type==='number'){let value=Number(token.text);if(peek().type==='name'&&units[peek().text.toLowerCase()]!==undefined){const unit=take().text.toLowerCase();value*=units[unit]!*(unit==='deg'||unit==='rad'?1:options.lengthScale??1);};node={type:'literal',value};}
      else if(token.type==='string')node={type:'literal',value:token.text};
      else if(token.text==='+'||token.text==='-')node={type:'unary',op:token.text,value:expression(5)};
      else if(token.text==='('){node=expression();if(take().text!==')')throw new DrawingError('FORMULA_SYNTAX','Expected closing parenthesis.');}
      else if(token.type==='name'){
        const name=token.text.toUpperCase();
        if(peek().text==='('){take();const args:Ast[]=[];if(peek().text!==')'){do{args.push(expression());if(peek().text!==',')break;take();}while(true);}if(take().text!==')')throw new DrawingError('FORMULA_SYNTAX','Expected closing parenthesis.');node={type:'call',name,args};}
        else if(name==='TRUE'||name==='FALSE')node={type:'literal',value:name==='TRUE'};
        else if(name==='PI')node={type:'literal',value:Math.PI};
        else{refs.add(token.text);node={type:'ref',name:token.text};}
      }else throw new DrawingError('FORMULA_SYNTAX',`Unexpected ${token.text||'end of input'}.`);
      while(peek().type==='op'&&precedence[peek().text]!==undefined&&precedence[peek().text]!>=min){const op=take().text,p=precedence[op]!;node={type:'binary',op,left:node,right:expression(op==='^'?p:p+1)};}
      depth--;return node;
    };
    this.ast=expression();if(peek().type!=='end')throw new DrawingError('FORMULA_SYNTAX','Unexpected trailing input.');this.dependencies=refs;
  }
  /** Plan an Automation/UI write without mutating any cells or executing host code.
   * Values are in the same internal units used to parse this formula. Assignment expressions
   * are canonicalized; SETATREFEVAL is reduced at write time and SETATREFEXPR stores the write.
   */
  planWrite(value: FormulaValue, resolve: FormulaResolver): FormulaWritePlan | undefined {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new DrawingError('FORMULA_VALUE', 'A cell write must be finite.');
    const assignments: FormulaWritePlan['assignments'] = []; let stores = false, budget = 8192;
    const literal: Ast = { type: 'literal', value };
    const substitute = (node: Ast): Ast => {
      if (--budget < 0) throw new DrawingError('FORMULA_BUDGET', 'Write planning exceeded the operation budget.');
      if (node.type === 'call') {
        if (node.name === 'SETATREFEXPR') return literal;
        const result: Ast = { ...node, args: node.args.map(substitute) };
        return node.name === 'SETATREFEVAL' ? { type: 'literal', value: new Formula(printAst(result)).evaluate(resolve) } : result;
      }
      if (node.type === 'unary') return { ...node, value: substitute(node.value) };
      if (node.type === 'binary') return { ...node, left: substitute(node.left), right: substitute(node.right) };
      return node;
    };
    const visit = (node: Ast, inAssignment = false): Ast => {
      if (--budget < 0) throw new DrawingError('FORMULA_BUDGET', 'Write planning exceeded the operation budget.');
      if (node.type === 'call') {
        if (node.name === 'GUARD' && !inAssignment) throw new DrawingError('FORMULA_GUARD', 'The cell is guarded. Use an explicit formula edit to replace its expression.');
        if (node.name === 'SETATREF') {
          if (inAssignment) throw new DrawingError('FORMULA_WRITE_UNSUPPORTED', 'Nested SETATREF inside an assignment expression is unsupported.');
          if (node.args.length < 1 || node.args.length > 3 || node.args[0]?.type !== 'ref') throw new DrawingError('FORMULA_REFERENCE', 'SETATREF requires a cell reference.');
          const expression = node.args[1] ? substitute(node.args[1]) : literal;
          assignments.push({ reference: node.args[0].name, formula: printAst(expression) });
          return { ...node, args: node.args.map((arg, i) => i === 1 ? visit(arg, true) : arg) };
        }
        if (node.name === 'SETATREFEXPR') { stores = true; return { ...node, args: [literal] }; }
        // Conditional write targets need branch-selection semantics, not an eager walk.
        if (['IF', 'IFERROR', 'AND', 'OR'].includes(node.name) && /SETATREF(?:EXPR)?\(/.test(printAst(node)))
          throw new DrawingError('FORMULA_WRITE_UNSUPPORTED', 'Conditional write routing must be authored as an unconditional SETATREF expression.');
        return { ...node, args: node.args.map(arg => visit(arg, inAssignment)) };
      }
      if (node.type === 'unary') return { ...node, value: visit(node.value, inAssignment) };
      if (node.type === 'binary') return { ...node, left: visit(node.left, inAssignment), right: visit(node.right, inAssignment) };
      return node;
    };
    const result = visit(this.ast);
    return assignments.length || stores ? { formula: stores ? printAst(result) : this.source, assignments } : undefined;
  }

  evaluate(resolve:FormulaResolver=reference=>{throw new DrawingError('FORMULA_REFERENCE',`Unknown reference: ${reference}`);}, context:FormulaContext={}):FormulaValue{
    let budget=16384;const num=(v:FormulaValue)=>{const n=Number(v);if(!Number.isFinite(n))throw new DrawingError('FORMULA_VALUE','Expected a finite number.');return n;};
    const run=(node:Ast):FormulaValue=>{if(--budget<0)throw new DrawingError('FORMULA_BUDGET','Formula operation budget exceeded.');
      switch(node.type){
        case 'literal':return node.value;
        case 'ref':return resolve(node.name);
        case 'unary':return node.op==='-'?-num(run(node.value)):num(run(node.value));
        case 'binary':{const a=run(node.left),b=run(node.right);switch(node.op){case '+':return num(a)+num(b);case '-':return num(a)-num(b);case '*':return num(a)*num(b);case '/':if(num(b)===0)throw new DrawingError('FORMULA_DIV0','Division by zero.');return num(a)/num(b);case '%':if(num(b)===0)throw new DrawingError('FORMULA_DIV0','Modulo by zero.');return num(a)%num(b);case '^':return num(a)**num(b);case '&':return String(a)+String(b);case '=':case '==':return a===b;case '<>':case '!=':return a!==b;case '<':return a<b;case '>':return a>b;case '<=':return a<=b;case '>=':return a>=b;}throw new DrawingError('FORMULA_OPERATOR',node.op);}
        case 'call':{
          const args=node.args,need=(min:number,max=min)=>{if(args.length<min||args.length>max)throw new DrawingError('FORMULA_ARITY',`${node.name} requires ${min}${min!==max?`..${max}`:''} arguments.`);};
          if(node.name==='IFERROR'){need(2);try{return run(args[0]!);}catch(error){if(error instanceof DrawingError)return run(args[1]!);throw error;}}
          if(node.name==='IF'){need(3);return run(args[run(args[0]!)?1:2]!);}
          if(node.name==='AND'){need(1,256);return args.every(arg=>Boolean(run(arg)));}
          if(node.name==='OR'){need(1,256);return args.some(arg=>Boolean(run(arg)));}
          if(node.name==='GUARD'){need(1);return run(args[0]!);}
          if(node.name==='SETATREF'){need(1,3);return args[2]&&run(args[2])?0:run(args[0]!);}
          if(node.name==='SETATREFEXPR'){need(0,1);return args[0]?run(args[0]):0;}
          if(node.name==='SETATREFEVAL'){need(1);return run(args[0]!);}
          if(context.call){const extension=context.call(node.name,args.map(run));if(extension!==undefined)return extension;}

          if(node.name==='NOT'){need(1);return !run(args[0]!);}
          if(node.name==='CONCAT'||node.name==='CONCATENATE'){need(1,256);return args.map(arg=>String(run(arg))).join('');}
          if(node.name==='LEN'){need(1);return String(run(args[0]!)).length;}
          if(node.name==='RGB'){need(3);return '#'+args.map(arg=>Math.max(0,Math.min(255,Math.round(num(run(arg))))).toString(16).padStart(2,'0')).join('');}
          if(['LOWER','UPPER','TRIM','LEFT','RIGHT','MID','FIND','SUBSTITUTE','STRSAME'].includes(node.name)){
            const a=String(run(args[0]??{type:'literal',value:''}));
            switch(node.name){case 'LOWER':need(1);return a.toLowerCase();case 'UPPER':need(1);return a.toUpperCase();case 'TRIM':need(1);return a.trim().replace(/\s+/g,' ');
              case 'LEFT':case 'RIGHT':{need(2);const count=Math.max(0,Math.trunc(num(run(args[1]!))));return node.name==='LEFT'?a.slice(0,count):count?a.slice(-count):'';}
              case 'MID':{need(3);const start=Math.max(0,Math.trunc(num(run(args[1]!)))-1),count=Math.max(0,Math.trunc(num(run(args[2]!))));return a.slice(start,start+count);}
              case 'FIND':{need(2,3);const index=String(run(args[1]!)).indexOf(a,args[2]?Math.max(0,num(run(args[2]))-1):0);if(index<0)throw new DrawingError('FORMULA_VALUE','Substring not found.');return index+1;}
              case 'SUBSTITUTE':{need(3);const find=String(run(args[1]!)),replace=String(run(args[2]!));if(!find)return a;const result=a.split(find).join(replace);if(result.length>1_000_000)throw new DrawingError('FORMULA_LIMIT','String result exceeds one million characters.');return result;}
              case 'STRSAME':need(2);return a===String(run(args[1]!));
            }
          }
          const extra:Record<string,(...v:number[])=>number>={ACOS:Math.acos,ASIN:Math.asin,ATAN:Math.atan,EXP:Math.exp,LN:Math.log,LOG10:Math.log10,INT:Math.floor,SIGN:Math.sign};
          if(extra[node.name]){need(1);return extra[node.name]!(num(run(args[0]!)));}
          if(node.name==='MOD'){need(2);const a=num(run(args[0]!)),b=num(run(args[1]!));if(!b)throw new DrawingError('FORMULA_DIV0','Modulo by zero.');return a-b*Math.floor(a/b);}
          const f:Record<string,{min:number;max?:number;fn:(...values:number[])=>number}>={ABS:{min:1,fn:Math.abs},SQRT:{min:1,fn:Math.sqrt},SIN:{min:1,fn:Math.sin},COS:{min:1,fn:Math.cos},TAN:{min:1,fn:Math.tan},ATAN2:{min:2,fn:Math.atan2},FLOOR:{min:1,fn:Math.floor},CEILING:{min:1,fn:Math.ceil},ROUND:{min:1,max:2,fn:(n,d=0)=>Math.round(n*10**d)/10**d},MIN:{min:1,max:256,fn:Math.min},MAX:{min:1,max:256,fn:Math.max},SUM:{min:1,max:256,fn:(...v)=>v.reduce((a,b)=>a+b,0)}};
          const function_=f[node.name];if(!function_)throw new DrawingError('FORMULA_FUNCTION',`Unsupported function: ${node.name}`);need(function_.min,function_.max??function_.min);return function_.fn(...args.map(arg=>num(run(arg))));
        }
      }
    };const result=run(this.ast);if(typeof result==='number'&&!Number.isFinite(result))throw new DrawingError('FORMULA_NUMBER','Formula produced a non-finite result.');return result;
  }
}
export function evaluateFormula(source:string,resolve?:FormulaResolver):FormulaValue{return new Formula(source).evaluate(resolve);}
/** Dependency-aware cell cache with transitive invalidation and cycle detection. */
export class FormulaSheet {
  private cells=new Map<string,FormulaValue|Formula>();private cache=new Map<string,FormulaValue>();private dependents=new Map<string,Set<string>>();
  set(name:string,value:FormulaValue,formula?:string):void{
    const old=this.cells.get(name);if(old instanceof Formula)for(const dependency of old.dependencies)this.dependents.get(dependency)?.delete(name);
    const cell=formula?new Formula(formula):value;this.cells.set(name,cell);
    if(cell instanceof Formula)for(const dependency of cell.dependencies){let set=this.dependents.get(dependency);if(!set)this.dependents.set(dependency,set=new Set());set.add(name);}
    const visit=(key:string,seen=new Set<string>())=>{if(seen.has(key))return;seen.add(key);this.cache.delete(key);for(const dependent of this.dependents.get(key)??[])visit(dependent,seen);};visit(name);
  }
  get(name:string):FormulaValue{
    const stack=new Set<string>();const evaluate=(key:string):FormulaValue=>{if(this.cache.has(key))return this.cache.get(key)!;if(stack.has(key))throw new DrawingError('FORMULA_CYCLE',`Circular cell reference: ${[...stack,key].join(' -> ')}`);const cell=this.cells.get(key);if(cell===undefined)throw new DrawingError('FORMULA_REFERENCE',`Unknown cell: ${key}`);stack.add(key);try{const value=cell instanceof Formula?cell.evaluate(evaluate):cell;this.cache.set(key,value);return value;}finally{stack.delete(key);}};return evaluate(name);
  }
}
