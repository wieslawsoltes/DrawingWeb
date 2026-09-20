import test from 'node:test';
import assert from 'node:assert/strict';
import {DiagramEngine,createDocument,createShape,clone,MasterService,Formula,ShapeSheetService,TextFieldService,formatField,readVsdx,writeVsdx,readZip,writeZip} from '../dist/esm/index.js';
import {mergeVisioShape,resolveVisioStyle} from '../dist/esm/visio-inheritance.js';
import {parseXml,elements,first,serializeXml} from '../dist/esm/xml.js';
const cell=(node,name)=>elements(node,'Cell').find(c=>c.attributes.N===name);
const shapeWith=()=>{const e=new DiagramEngine(),p=e.document.pages[0].id;e.add(p,createShape('rectangle',{id:'s',width:96,height:96}));return {e,p,sheet:new ShapeSheetService(e)};};

test('master row overlays keep sibling cells, named row identity and base order',()=>{
 const base=parseXml('<Shape><Cell N="Width" V="2"/><Section N="Character"><Row IX="0"><Cell N="Color" V="#123456"/><Cell N="Size" V="0.25"/><Cell N="Style" V="3"/></Row></Section><Section N="User"><Row N="A" IX="0"><Cell N="Value" V="1"/></Row><Row N="B" IX="1"><Cell N="Value" V="2"/></Row></Section></Shape>');
 const local=parseXml('<Shape><Section N="Character"><Row IX="0"><Cell N="Color" V="#abcdef"/></Row></Section><Section N="User"><Row N="B" IX="0"><Cell N="Value" V="8"/></Row></Section></Shape>');
 const before=serializeXml(base),r=mergeVisioShape(local,base),row=first(first(r,'Section'),'Row');assert.equal(cell(row,'Size').attributes.V,'0.25');assert.equal(cell(row,'Style').attributes.V,'3');assert.equal(cell(row,'Color').attributes.V,'#abcdef');
 const users=elements(elements(r,'Section')[1],'Row');assert.deepEqual(users.map(r=>r.attributes.N),['A','B']);assert.equal(cell(users[1],'Value').attributes.V,'8');assert.equal(serializeXml(base),before);
});
test('F=Inh retains local evaluated cache and inherits formula; No Formula blocks inheritance',()=>{
 const base=parseXml('<Shape><Cell N="Width" V="2" F="Height*2"/></Shape>');
 const r=mergeVisioShape(parseXml('<Shape><Cell N="Width" V="6" F="Inh"/></Shape>'),base);assert.equal(cell(r,'Width').attributes.F,'Height*2');assert.equal(cell(r,'Width').attributes.V,'6');
 const blocked=mergeVisioShape(parseXml('<Shape><Cell N="Width" V="3" F="No Formula"/></Shape>'),base);assert.equal(cell(blocked,'Width').attributes.F,'No Formula');
});
test('deleted row tombstone survives an additional style overlay',()=>{
 const base=parseXml('<Shape><Section N="Geometry" IX="0"><Row IX="1" T="LineTo"><Cell N="X" V="1"/></Row></Section></Shape>');
 const r=mergeVisioShape(mergeVisioShape(parseXml('<Shape><Section N="Geometry" IX="0"><Row IX="1" Del="1"/></Section></Shape>'),base),base);
 assert.equal(first(first(r,'Section'),'Row').attributes.Del,'1');assert.equal(elements(first(r,'Section'),'Row').length,1);
});
test('style chains reject cycles and accept native no-style self references',()=>{
 const styles=new Map([['0',parseXml('<StyleSheet ID="0" FillStyle="0"/>')],['1',parseXml('<StyleSheet ID="1" FillStyle="2"/>')],['2',parseXml('<StyleSheet ID="2" FillStyle="1"/>')]]);
 assert.ok(resolveVisioStyle(styles,'0','FillStyle'));assert.throws(()=>resolveVisioStyle(styles,'1','FillStyle'),{code:'VISIO_STYLE_CYCLE'});
});
test('master updates propagate per channel; local override, restore and undo are atomic',()=>{
 const {e,p}=shapeWith(),service=new MasterService(e);const def=createShape('rectangle',{text:'Original',cells:{'User.X':{value:'1'}},style:{fill:'#112233',stroke:'#001122'}});
 const mid=e.registerMaster('M','Tests',def),id=e.instantiateMaster(mid,p,100,100);e.update(id,{style:{fill:'#abcdef'}});
 service.update(mid,{shape:{...clone(def),text:'Changed',style:{...def.style,fill:'#ffeeaa',stroke:'#aabbcc'},cells:{'User.X':{value:'2'}}}});
 assert.equal(e.getShape(id).text,'Changed');assert.equal(e.getShape(id).style.fill,'#abcdef');assert.equal(e.getShape(id).style.stroke,'#aabbcc');assert.equal(e.getShape(id).cells['User.X'].value,'2');
 e.undo();assert.equal(e.getShape(id).text,'Original');e.redo();service.restore(id,{style:['fill']});assert.equal(e.getShape(id).style.fill,'#ffeeaa');e.undo();assert.equal(e.getShape(id).style.fill,'#abcdef');
});
test('nested master instances retain source identity across copy and updates',()=>{
 const {e,p}=shapeWith(),service=new MasterService(e),child=createShape('text',{text:'Nested'}),def=createShape('group',{children:[child]}),mid=e.registerMaster('Nested','Tests',def),id=e.instantiateMaster(mid,p,0,0);
 const copy=e.duplicate([id])[0];service.update(mid,{shape:{...def,children:[{...child,text:'Updated'}]}});
 assert.equal(e.getShape(id).children[0].text,'Updated');assert.equal(e.getShape(copy).children[0].text,'Updated');assert.notEqual(e.getShape(id).children[0].id,e.getShape(copy).children[0].id);
 service.detach(id);service.update(mid,{shape:{...def,children:[{...child,text:'Again'}]}});assert.equal(e.getShape(id).children[0].text,'Updated');
});
test('removing a bound definition rolls back instead of silently orphaning instances',()=>{
 const {e,p}=shapeWith(),mid=e.registerMaster('M','Tests',createShape()),id=e.instantiateMaster(mid,p,0,0),before=e.document;
 assert.throws(()=>e.updateDocument({masters:[]}),{code:'MASTER_BINDING'});assert.equal(e.document,before);new MasterService(e).detach(id);e.updateDocument({masters:[]});
});
test('master inheritance survives JSON normalization',()=>{
 const {e,p}=shapeWith(),def=createShape('text',{text:'A'}),mid=e.registerMaster('M','Tests',def),id=e.instantiateMaster(mid,p,0,0);
 const restored=new DiagramEngine(JSON.parse(JSON.stringify(e.document)));new MasterService(restored).update(mid,{shape:{...def,text:'B'}});assert.equal(restored.getShape(id).text,'B');
});
test('SETATREF read does not eagerly evaluate its write expression',()=>{
 assert.equal(new Formula('SETATREF(User.X,UNSUPPORTED(),TRUE)').evaluate(()=>{throw Error('Not needed');}),0);
 assert.equal(new Formula('SETATREF(User.X,1/0)').evaluate(()=>3),3);
});
test('GUARD rejects UI resize and preserves both document and history',()=>{
 const {e,sheet}=shapeWith();sheet.setCell('s','Width',1,'GUARD(2)');const before=e.document,revision=e.revision;
 assert.throws(()=>e.resize('s',400,96),{code:'FORMULA_GUARD'});assert.equal(e.document,before);assert.equal(e.revision,revision);
 sheet.setCell('s','Width',3);assert.equal(e.getShape('s').width,288);sheet.dispose();
});
test('UI resize redirects to Prop.Width and undo restores value and derived geometry',()=>{
 const {e,sheet}=shapeWith();sheet.setCell('s','Prop.Width',2);sheet.setCell('s','Width',2,'SETATREF(Prop.Width)');const before=e.document;
 e.resize('s',384,96);assert.equal(e.getShape('s').cells.Width.formula,'SETATREF(Prop.Width)');assert.equal(e.getShape('s').data.Width,4);assert.equal(e.getShape('s').width,384);
 e.undo();assert.deepEqual(e.document,before);sheet.dispose();
});
test('SETATREFEXPR standalone stores writes without losing its snapping expression',()=>{
 const {e,sheet}=shapeWith();sheet.setCell('s','User.Grid',2);sheet.setCell('s','Width',2,'INT(SETATREFEXPR(2)/User.Grid+0.5)*User.Grid');
 sheet.setUserValue('s','Width',3.2);assert.equal(e.getShape('s').width,384);assert.match(e.getShape('s').cells.Width.formula,/SETATREFEXPR\(3.2\)/);sheet.dispose();
});
test('SETATREFEVAL folds assignments at write time while preserving host formula',()=>{
 const {e,sheet}=shapeWith();sheet.setCell('s','User.Offset',1);sheet.setCell('s','User.Base',2);sheet.setCell('s','Width',3,'SETATREF(User.Offset,SETATREFEVAL(SETATREFEXPR()-User.Base))+User.Base');
 sheet.setUserValue('s','Width',6);assert.equal(sheet.evaluate('s','User.Offset'),4);assert.equal(e.getShape('s').width,576);sheet.setCell('s','User.Base',3);assert.equal(e.getShape('s').width,672);sheet.dispose();
});
test('redirect cycles roll back partial writes and enrollment',()=>{
 const {e,sheet}=shapeWith();e.update('s',{cells:{'User.A':{value:'1',formula:'SETATREF(User.B)'},'User.B':{value:'1',formula:'SETATREF(User.A)'}}});const before=e.document;
 assert.throws(()=>sheet.setUserValue('s','User.A',2),{code:'FORMULA_WRITE_CYCLE'});assert.equal(e.document,before);sheet.dispose();
});
test('ParentShape references work in child cells',()=>{
 const {e,p,sheet}=shapeWith(),group=createShape('group',{id:'g',width:384,children:[createShape('rectangle',{id:'c'})]});e.add(p,group);sheet.setCell('c','Width',0,'ParentShape!Width/2');assert.equal(e.getShape('c').width,192);sheet.dispose();
});
test('conditional write redirection is explicitly rejected',()=>{
 assert.throws(()=>new Formula('IF(TRUE,SETATREF(User.X),2)').planWrite(4,()=>1),{code:'FORMULA_WRITE_UNSUPPORTED'});
});
test('native Field rows and fld markers retain formulas on rebuild and reload',async()=>{
 const {e}=shapeWith();e.update('s',{richText:{paragraphs:[{runs:[{text:'Width: '},{text:'1',field:{formula:'Width',value:'1',unit:'IN'}}]}]}});
 const bytes=await writeVsdx(e.document),z=await readZip(bytes);assert.match(new TextDecoder().decode(z.get('visio/pages/page1.xml')),/<fld IX="0">1<\/fld>/);
 const r=await readVsdx(bytes),run=r.document.pages[0].shapes[0].richText.paragraphs[0].runs[1];assert.equal(run.field.formula,'Width');assert.equal(run.field.unit,'IN');assert.deepEqual(await r.save(),bytes);
});
test('live fields refresh with data and page edits and remain inert after document replacement',()=>{
 const {e,p,sheet}=shapeWith();e.update('s',{data:{Count:3},richText:{paragraphs:[{runs:[{text:'cached',field:{formula:'PAGENAME()&" "&FORMAT(Prop.Count,"0.00")'}}]}]}});
 const fields=new TextFieldService(e,sheet);assert.equal(e.getShape('s').text,'cached');assert.deepEqual(fields.activate(),[]);assert.equal(e.getShape('s').text,'Page 1 3.00');
 e.update('s',{data:{Count:7}});assert.equal(e.getShape('s').text,'Page 1 7.00');e.undo();assert.equal(e.getShape('s').text,'Page 1 3.00');e.updatePage(p,{name:'Review'});assert.equal(e.getShape('s').text,'Review 3.00');
 e.replaceDocument(e.document);e.update('s',{data:{Count:10}});assert.equal(e.getShape('s').text,'Review 3.00');fields.dispose();sheet.dispose();
});
test('unsupported fields keep cached text and return structured diagnostics',()=>{
 const {e}=shapeWith();e.update('s',{richText:{paragraphs:[{runs:[{text:'retained',field:{formula:'RUNADDON("unsafe")'}}]}]}});const f=new TextFieldService(e);assert.equal(f.activate()[0].code,'FORMULA_FUNCTION');assert.equal(e.getShape('s').text,'retained');f.dispose();
});
test('numeric picture profile is deterministic and rejects unknown calendars/units',()=>{
 assert.equal(formatField(1234.5,'#,##0.00'),'1,234.50');assert.equal(formatField(.127,'0.0%'),'12.7%');assert.throws(()=>formatField(2,'0.00 u'),{code:'FIELD_FORMAT'});
});

test('evaluated field caches never sever inherited text or create no-op history',()=>{
 const e=new DiagramEngine(createDocument()),ms=new MasterService(e); const definition=createShape('rectangle',{id:'source',text:'cached',data:{Count:2},richText:{paragraphs:[{runs:[{text:'cached',field:{formula:'Prop.Count'}}]}]}});
 const mid=e.registerMaster('Counter','User',definition),sid=e.instantiateMaster(mid,e.document.pages[0].id,0,0); const f=new TextFieldService(e); f.activate([sid]);
 assert.equal(e.getShape(sid).text,'2');assert.equal(e.getShape(sid).masterBinding.text,true);
 e.update(sid,{data:{Count:3}});assert.equal(e.getShape(sid).text,'3');assert.equal(e.getShape(sid).masterBinding.text,true);
 const revision=e.revision;f.recalculate();assert.equal(e.revision,revision);
 const source=structuredClone(e.document.masters[0].shape);source.richText.paragraphs[0].runs[0].field.formula='Prop.Count*2';ms.update(mid,{shape:source});
 assert.equal(e.getShape(sid).text,'6');assert.equal(e.getShape(sid).masterBinding.text,true);f.dispose();
});
