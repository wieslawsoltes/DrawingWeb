import { DrawingError } from './model.js';
export interface XmlElement { name:string; attributes:Record<string,string>; children:XmlChild[] }
export interface XmlRaw { raw:string }
export type XmlChild = XmlElement | XmlRaw | string;
export function isElement(value:XmlChild):value is XmlElement{return typeof value==='object'&&'name'in value;}
export function localName(name:string):string{return name.slice(name.lastIndexOf(':')+1);}
export function elements(node:XmlElement,name?:string):XmlElement[]{return node.children.filter(isElement).filter(child=>!name||localName(child.name)===name);}
export function first(node:XmlElement,name:string):XmlElement|undefined{return elements(node,name)[0];}
export function descendants(node:XmlElement,name:string):XmlElement[]{const result:XmlElement[]=[];const walk=(current:XmlElement)=>{for(const child of elements(current)){if(localName(child.name)===name)result.push(child);walk(child);}};walk(node);return result;}
export function textContent(node:XmlElement):string{return node.children.map(child=>typeof child==='string'?child:isElement(child)?textContent(child):'').join('');}
export function element(name:string,attributes:Record<string,string|number>={},children:XmlChild[]=[]):XmlElement{return{name,attributes:Object.fromEntries(Object.entries(attributes).map(([key,value])=>[key,String(value)])),children};}
export function escapeXml(value:unknown):string{return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
function decode(value:string):string{
  if(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value))throw new DrawingError('XML_ENTITY','Unknown or unterminated XML entity.');
  return value.replace(/&([^;]+);/g,(_,name:string)=>{const standard:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(standard[name]!==undefined)return standard[name]!;const code=name.startsWith('#x')?parseInt(name.slice(2),16):parseInt(name.slice(1),10);if(!(code===9||code===10||code===13||code>=32&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)&&code!==0xfffe&&code!==0xffff))throw new DrawingError('XML_CHARACTER','Invalid XML character reference.');return String.fromCodePoint(code);});
}
/** A bounded, non-validating XML parser. DTDs/entities/network resolution are deliberately unavailable. */
export function parseXml(input:string,maxCharacters=32*1024*1024):XmlElement{
  if(input.length>maxCharacters)throw new DrawingError('XML_LIMIT','XML exceeds the configured limit.');if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(input))throw new DrawingError('XML_DTD','DTDs and custom entities are disabled.');
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input))throw new DrawingError('XML_CHARACTER','Invalid XML control character.');
  const stack:XmlElement[]=[],roots:XmlElement[]=[];let i=0,count=0;
  const append=(child:XmlChild)=>{if(stack.length)stack.at(-1)!.children.push(child);else if(typeof child==='string'&&child.trim())throw new DrawingError('XML_ROOT','Text outside the document element.');};
  while(i<input.length){if(input[i]!=='<'){const end=input.indexOf('<',i);append(decode(input.slice(i,end<0?input.length:end)));i=end<0?input.length:end;continue;}
    if(input.startsWith('<!--',i)){const end=input.indexOf('-->',i+4);if(end<0)throw new DrawingError('XML_COMMENT','Unterminated comment.');const raw=input.slice(i,end+3);if(raw.slice(4,-3).includes('--'))throw new DrawingError('XML_COMMENT','Invalid double hyphen in comment.');append({raw});i=end+3;continue;}
    if(input.startsWith('<![CDATA[',i)){const end=input.indexOf(']]>',i+9);if(end<0)throw new DrawingError('XML_CDATA','Unterminated CDATA.');append(input.slice(i+9,end));i=end+3;continue;}
    if(input.startsWith('<?',i)){const end=input.indexOf('?>',i+2);if(end<0)throw new DrawingError('XML_PI','Unterminated processing instruction.');append({raw:input.slice(i,end+2)});i=end+2;continue;}
    let end=i+1,quote='';for(;end<input.length;end++){const c=input[end]!;if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
    if(end===input.length)throw new DrawingError('XML_TAG','Unterminated XML tag.');let tag=input.slice(i+1,end);i=end+1;
    if(tag.startsWith('/')){const name=tag.slice(1).trim();if(!stack.length||stack.pop()!.name!==name)throw new DrawingError('XML_NESTING',`Mismatched closing tag: ${name}`);continue;}
    const selfClosing=/\/\s*$/.test(tag);if(selfClosing)tag=tag.replace(/\/\s*$/,'');const match=tag.match(/^([A-Za-z_][\w.:-]*)/);if(!match)throw new DrawingError('XML_TAG','Invalid XML element name.');
    const name=match[1]!,attributes:Record<string,string>=Object.create(null);let rest=tag.slice(match[0].length);
    while(rest.trim()){const attribute=rest.match(/^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/);if(!attribute)throw new DrawingError('XML_ATTRIBUTE',`Malformed attributes on ${name}.`);if(Object.prototype.hasOwnProperty.call(attributes,attribute[1]!))throw new DrawingError('XML_ATTRIBUTE','Duplicate XML attribute.');if(attribute[3]!.includes('<'))throw new DrawingError('XML_ATTRIBUTE','Raw < is forbidden in attributes.');attributes[attribute[1]!]=decode(attribute[3]!);rest=rest.slice(attribute[0].length);}
    const node={name,attributes,children:[]} satisfies XmlElement;if(stack.length)append(node);else roots.push(node);if(++count>1000000)throw new DrawingError('XML_LIMIT','Too many XML elements.');if(!selfClosing){stack.push(node);if(stack.length>128)throw new DrawingError('XML_DEPTH','XML nesting exceeds the configured limit.');}
  }
  if(stack.length||roots.length!==1)throw new DrawingError('XML_ROOT','XML must have one complete root element.');return roots[0]!;
}
export function serializeXml(node:XmlElement,declaration=true):string{
  const write=(child:XmlChild):string=>{if(typeof child==='string')return escapeXml(child);if(!isElement(child))return child.raw;const attributes=Object.entries(child.attributes).map(([key,value])=>` ${key}="${escapeXml(value)}"`).join('');return child.children.length?`<${child.name}${attributes}>${child.children.map(write).join('')}</${child.name}>`:`<${child.name}${attributes}/>`;};
  return(declaration?'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>':'')+write(node);
}
