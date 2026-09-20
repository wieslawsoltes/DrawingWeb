/** Bounded ADO XML snapshot and Visio DataRecordSet/PrimaryKey/RowMap interchange. */
import type { DataColumn, DataRecordset, DiagramDocument, Diagnostic, Json, Page, Shape } from './model.js';
import { createDocument, DrawingError, id, rowIdentity, validateDocument, validateJson } from './model.js';
import { descendants, element, elements, first, localName, parseXml, serializeXml } from './xml.js';
import type { XmlElement } from './xml.js';
const NS='http://schemas.microsoft.com/office/visio/2012/main',RID='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const attr=(n:XmlElement,name:string)=>Object.entries(n.attributes).find(([key])=>localName(key)===name)?.[1];
function checked(set:DataRecordset):DataRecordset {const d=createDocument();d.recordsets=[set];validateDocument(d);return set;}
function typeOf(type:string):DataColumn['type'] {return /^(?:int|i[1248]|ui[1248]|r[48]|float|number|fixed|decimal|double|currency)$/i.test(type)?'number':/^(boolean|bool)$/i.test(type)?'boolean':/^(date|datetime|datetime\.tz)$/i.test(type)?'date':'string';}
function convert(raw:string,type:DataColumn['type']):Json {if(type==='number'){const v=Number(raw);if(!raw.trim()||!Number.isFinite(v))throw new DrawingError('ADO_NUMBER',`Invalid numeric field: ${raw}`);return v;}if(type==='boolean'){if(!['true','false','1','0'].includes(raw.toLowerCase()))throw new DrawingError('ADO_BOOLEAN','Invalid boolean field.');return raw==='1'||raw.toLowerCase()==='true';}return raw;}
/** Missing attributes are null. Empty strings remain empty. Namespace prefixes are not hard-coded. */
export function readAdoRecordset(input:string|XmlElement,options:Partial<Pick<DataRecordset,'id'|'name'|'keyField'>>={}):DataRecordset {
 const root=typeof input==='string'?parseXml(input,16*1024*1024):input;const definitions=descendants(root,'AttributeType');
 if(!definitions.length)throw new DrawingError('ADO_SCHEMA','An ADO rowset schema is required.');
 const columns:DataColumn[]=definitions.map(c=>({name:attr(c,'name')??'',type:typeOf(attr(first(c,'datatype')??element('none'),'type')??'string'),required:attr(c,'keycolumn')==='true'}));
 let keyField=options.keyField??columns.find(c=>c.required)?.name;const rows=descendants(first(root,'data')??element('none'),'row').map(n=>Object.fromEntries(columns.map(c=>[c.name,n.attributes[c.name]===undefined?null:convert(n.attributes[c.name]!,c.type)])));
 if(rows.length>100000)throw new DrawingError('ADO_LIMIT','Rowsets are limited to 100,000 rows.');
 if(!keyField){keyField='_drawingweb_row';while(columns.some(c=>c.name===keyField))keyField+='_';columns.unshift({name:keyField,type:'number',required:true});rows.forEach((r,i)=>r[keyField!]=i+1);}
 return checked({id:options.id??id('recordset'),name:options.name??'ADO recordset',keyField,columns,rows});
}
export function writeAdoRecordset(recordset:DataRecordset):string {
 checked(recordset);const validName=/^[A-Za-z_][\w.-]*$/;
 if(recordset.columns.some(c=>!validName.test(c.name)))throw new DrawingError('ADO_COLUMN_NAME','ADO XML column names must be XML attribute names; rename unsupported columns explicitly.');
 const defs=recordset.columns.map((c,i)=>element('s:AttributeType',{name:c.name,'rs:number':i+1,...(c.name===recordset.keyField?{'rs:keycolumn':'true'}:{})},[element('s:datatype',{'dt:type':c.type==='number'?'r8':c.type==='boolean'?'boolean':c.type==='date'?'dateTime':'string','rs:maybenull':c.required?'false':'true'})]));
 const rows=recordset.rows.map(row=>element('z:row',Object.fromEntries(recordset.columns.filter(c=>row[c.name]!==undefined&&row[c.name]!==null).map(c=>[c.name,typeof row[c.name]==='object'?JSON.stringify(row[c.name]):String(row[c.name])]))));
 return serializeXml(element('xml',{'xmlns:s':'uuid:BDC6E3F0-6DA3-11d1-A2A3-00AA00C14882','xmlns:dt':'uuid:C2F41010-65B3-11d1-A29F-00AA00C14882','xmlns:rs':'urn:schemas-microsoft-com:rowset','xmlns:z':'#RowsetSchema'},[element('s:Schema',{id:'RowsetSchema'},[element('s:ElementType',{name:'row',content:'eltOnly'},[...defs,element('s:extends',{type:'rs:rowbase'})])]),element('rs:data',{},rows)]));
}
function shapes(page:Page):Shape[]{const result:Shape[]=[];const walk=(items:Shape[])=>{for(const s of items){result.push(s);if(s.children)walk(s.children);}};walk(page.shapes);return result;}
export function writeRecordsets(document:DiagramDocument,ids:(page:Page)=>Map<string,number>,report:(code:string,message:string)=>void):{root:XmlElement;snapshots:string[]} {
 const snapshots:string[]=[],sets:XmlElement[]=[];
 for(const [i,set]of (document.recordsets??[]).entries()){
  snapshots.push(writeAdoRecordset(set));const keyIds=new Map(set.rows.map((r,index)=>[rowIdentity(r[set.keyField]),index+1]));
  const columns=element('DataColumns',{},set.columns.map((c,index)=>element('DataColumn',{ColumnNameID:c.name,Name:c.name,Label:c.label??c.name,DisplayOrder:index,DataType:c.type==='number'?2:c.type==='boolean'?3:c.type==='date'?5:0})));
  const primary=element('PrimaryKey',{ColumnNameID:set.keyField},set.rows.map((r,index)=>element('RowKeyValue',{RowID:index+1,Value:String(r[set.keyField])})));
  const maps:XmlElement[]=[],mappedRows=new Set<number>();
  document.pages.forEach((p,pi)=>{for(const s of shapes(p))for(const link of s.dataLinks??[])if(link.recordsetId===set.id){const row=keyIds.get(rowIdentity(link.rowKey)),shape=ids(p).get(s.id);if(row===undefined||shape===undefined)continue;
   if(mappedRows.has(row)){report('RECORDSET_MULTIPLE_SHAPES','Multiple shapes linked to the same row cannot all be represented in this RowMap profile.');continue;}mappedRows.add(row);maps.push(element('RowMap',{PageID:pi,ShapeID:shape,RowID:row}));
   if(Object.entries(link.mappings).some(([path,column])=>path!==`data.${column}`))report('RECORDSET_MAPPING_PROJECTED','Native row links project Shape Data columns; DrawingWeb geometry/text mappings are not native data-column bindings.');
  }});
  if(set.columns.some(c=>c.type==='json'))report('RECORDSET_JSON_AS_TEXT','JSON columns are serialized as strings in native ADO snapshots.');
  sets.push(element('DataRecordSet',{ID:i+1,Name:set.name,NextRowID:set.rows.length+1,RowOrder:0,Checksum:0},[element('Rel',{'r:id':`rId${i+1}`}),columns,primary,...maps]));
 }
 return{root:element('DataRecordSets',{xmlns:NS,'xmlns:r':RID},sets),snapshots};
}
export function readRecordsets(root:XmlElement,document:DiagramDocument,resolve:(recordset:XmlElement)=>XmlElement|undefined,diagnostics:Diagnostic[]):void {
 const sets=document.recordsets??=[];
 for(const n of elements(root,'DataRecordSet')){try{
  const source=resolve(n)??first(n,'ADOData');if(!source)throw new DrawingError('RECORDSET_SOURCE','Recordset snapshot is missing; no external source is queried.');
  const primary=elements(n,'PrimaryKey');if(primary.length>1)throw new DrawingError('RECORDSET_COMPOSITE_KEY','Composite primary keys are not projected by this profile.');
  const keyField=primary[0]?.attributes['ColumnNameID'];const set=readAdoRecordset(source,{id:`visio-recordset-${n.attributes['ID']}`,name:n.attributes['Name']??'Visio data',keyField});
  sets.push(set);const rows=new Map(set.rows.map(r=>[String(r[set.keyField]),r]));const rowKeys=new Map(elements(primary[0]??element('none'),'RowKeyValue').map(r=>[r.attributes['RowID'],r.attributes['Value']]));
  const nativeColumns=elements(first(n,'DataColumns')??element('none'),'DataColumn');const mappings=Object.fromEntries(nativeColumns.filter(c=>set.columns.some(s=>s.name===c.attributes['ColumnNameID'])).map(c=>[`data.${c.attributes['Name']??c.attributes['ColumnNameID']}`,c.attributes['ColumnNameID']!]));validateJson(mappings);
  for(const map of elements(n,'RowMap')){const p=document.pages.find(p=>p.id===`visio-p${map.attributes['PageID']}`),s=p?shapes(p).find(s=>s.sheetId===Number(map.attributes['ShapeID'])):undefined;
   const rowKey=rowKeys.get(map.attributes['RowID']),row=rowKey!==undefined?rows.get(rowKey):n.attributes['RowOrder']==='1'?set.rows[Number(map.attributes['RowID'])-1]:undefined;
   if(s&&row)s.dataLinks=[...(s.dataLinks??[]),{recordsetId:set.id,rowKey:row[set.keyField] as string|number,mappings}];else diagnostics.push({code:'RECORDSET_ROW_MAP',severity:'warning',message:'A row map could not be resolved; no positional match was guessed.'});
  }
 }catch(error){diagnostics.push({code:error instanceof DrawingError?error.code:'RECORDSET',severity:'warning',message:error instanceof Error?error.message:String(error)});}}
}
