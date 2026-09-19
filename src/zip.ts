import { DrawingError } from './model.js';
export interface ZipLimits { maxBytes?:number; maxEntries?:number; maxEntryBytes?:number; maxTotalBytes?:number; maxRatio?:number }
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
export function crc32(data:Uint8Array):number{let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&255]!^(crc>>>8);return(crc^0xffffffff)>>>0;}
export function safePartName(name:string):string{
  if(!name||name.includes('\\')||name.startsWith('/')||/^[a-z]:/i.test(name)||/[\x00-\x1f]/.test(name)||name.split('/').some(part=>part==='..'||part==='.'))throw new DrawingError('ZIP_PATH',`Unsafe package part name: ${name}`);return name;
}
function checked(view:DataView,offset:number,size:number):void{if(offset<0||offset+size>view.byteLength)throw new DrawingError('ZIP_TRUNCATED','ZIP structure extends beyond the input.');}
async function inflateRaw(data:Uint8Array,expected:number,limit:number):Promise<Uint8Array>{
  let stream:DecompressionStream;try{stream=new DecompressionStream('deflate-raw');}catch{throw new DrawingError('DEFLATE_UNAVAILABLE','This runtime must support DecompressionStream(deflate-raw).');}
  const readable=new Blob([data]).stream().pipeThrough(stream),reader=readable.getReader(),parts:Uint8Array[]=[];let size=0;
  try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>limit||size>expected){await reader.cancel();throw new DrawingError('ZIP_BOMB','Decompressed content exceeds its declared or configured size.');}parts.push(result.value);}}
  catch(error){if(error instanceof DrawingError)throw error;throw new DrawingError('ZIP_DEFLATE','The compressed entry is invalid.',error);}finally{reader.releaseLock();}
  if(size!==expected)throw new DrawingError('ZIP_SIZE','The decompressed entry size does not match its directory record.');const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
/** Bounded OPC ZIP reader. Encryption, multi-disk and ZIP64 are rejected rather than partially decoded. */
export async function readZip(input:Uint8Array,limits:ZipLimits={}):Promise<Map<string,Uint8Array>>{
  const maxBytes=limits.maxBytes??128*1024*1024,maxEntries=limits.maxEntries??4096,maxEntry=limits.maxEntryBytes??32*1024*1024,maxTotal=limits.maxTotalBytes??128*1024*1024,maxRatio=limits.maxRatio??2000;
  if(input.length>maxBytes)throw new DrawingError('ZIP_LIMIT','The ZIP input exceeds the configured limit.');const view=new DataView(input.buffer,input.byteOffset,input.byteLength);let eocd=-1;
  for(let i=input.length-22;i>=Math.max(0,input.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===input.length){eocd=i;break;}
  if(eocd<0)throw new DrawingError('ZIP_EOCD','No valid ZIP end-of-directory record was found.');
  if(view.getUint16(eocd+4,true)||view.getUint16(eocd+6,true))throw new DrawingError('ZIP_MULTIDISK','Multi-disk ZIP archives are unsupported.');
  const count=view.getUint16(eocd+10,true),centralSize=view.getUint32(eocd+12,true),centralOffset=view.getUint32(eocd+16,true);
  if(count===65535||centralOffset===0xffffffff||centralSize===0xffffffff)throw new DrawingError('ZIP64_UNSUPPORTED','ZIP64 is outside this package profile.');
  if(count!==view.getUint16(eocd+8,true)||count>maxEntries)throw new DrawingError('ZIP_ENTRIES','Invalid or excessive ZIP entry count.');if(centralOffset+centralSize>eocd)throw new DrawingError('ZIP_DIRECTORY','The central directory overlaps the end record.');
  let position=centralOffset,total=0;const entries=new Map<string,Uint8Array>();const ranges:{start:number;end:number}[]=[];
  for(let i=0;i<count;i++){
    checked(view,position,46);if(view.getUint32(position,true)!==0x02014b50)throw new DrawingError('ZIP_DIRECTORY','Invalid central directory entry.');
    const flags=view.getUint16(position+8,true),method=view.getUint16(position+10,true),crc=view.getUint32(position+16,true),compressed=view.getUint32(position+20,true),uncompressed=view.getUint32(position+24,true),nameLength=view.getUint16(position+28,true),extraLength=view.getUint16(position+30,true),commentLength=view.getUint16(position+32,true),offset=view.getUint32(position+42,true);
    checked(view,position+46,nameLength+extraLength+commentLength);const name=safePartName(decoder.decode(input.subarray(position+46,position+46+nameLength)));
    if(entries.has(name))throw new DrawingError('ZIP_DUPLICATE',`Duplicate package part: ${name}`);if(flags&1)throw new DrawingError('ZIP_ENCRYPTED','Encrypted ZIP entries are unsupported.');if(method!==0&&method!==8)throw new DrawingError('ZIP_METHOD',`Unsupported ZIP method: ${method}`);
    if(offset===0xffffffff||compressed===0xffffffff||uncompressed===0xffffffff)throw new DrawingError('ZIP64_UNSUPPORTED','ZIP64 entries are unsupported.');
    total+=uncompressed;if(uncompressed>maxEntry||total>maxTotal||uncompressed>Math.max(1,compressed)*maxRatio)throw new DrawingError('ZIP_BOMB','ZIP expansion exceeds configured limits.');
    checked(view,offset,30);if(view.getUint32(offset,true)!==0x04034b50)throw new DrawingError('ZIP_LOCAL_HEADER','Invalid local file header.');
    if(view.getUint16(offset+8,true)!==method||(view.getUint16(offset+6,true)&1)!==(flags&1))throw new DrawingError('ZIP_HEADER_MISMATCH','Local and central ZIP headers disagree.');
    const localNameLength=view.getUint16(offset+26,true),localExtraLength=view.getUint16(offset+28,true);checked(view,offset+30,localNameLength+localExtraLength);
    if(decoder.decode(input.subarray(offset+30,offset+30+localNameLength))!==name)throw new DrawingError('ZIP_NAME_MISMATCH','Local and central ZIP names disagree.');
    const start=offset+30+localNameLength+localExtraLength,end=start+compressed;checked(view,start,compressed);if(end>centralOffset)throw new DrawingError('ZIP_OVERLAP','ZIP data overlaps the central directory.');
    if(ranges.some(r=>offset<r.end&&end>r.start))throw new DrawingError('ZIP_OVERLAP','ZIP entries overlap.');ranges.push({start:offset,end});
    const bytes=method===0?input.slice(start,end):await inflateRaw(input.subarray(start,end),uncompressed,maxEntry);
    if(bytes.length!==uncompressed||crc32(bytes)!==crc)throw new DrawingError('ZIP_CRC',`Size or CRC validation failed: ${name}`);
    entries.set(name,bytes);position+=46+nameLength+extraLength+commentLength;
  }
  if(position!==centralOffset+centralSize)throw new DrawingError('ZIP_DIRECTORY_SIZE','The central directory size is inconsistent.');return entries;
}
/** Deterministic stored ZIP output: no platform codecs, timestamps or native dependencies. */
export function writeZip(entries:ReadonlyMap<string,Uint8Array>):Uint8Array{
  if(entries.size>=65535)throw new DrawingError('ZIP_ENTRIES','Too many ZIP entries.');const local:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0,centralSize=0;
  for(const[name,data]of entries){safePartName(name);const bytes=encoder.encode(name);if(bytes.length>65535)throw new DrawingError('ZIP_NAME','ZIP entry name is too long.');const crc=crc32(data),header=new Uint8Array(30+bytes.length),h=new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,bytes.length,true);header.set(bytes,30);local.push(header,data);
    const record=new Uint8Array(46+bytes.length),c=new DataView(record.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,bytes.length,true);c.setUint32(42,offset,true);record.set(bytes,46);central.push(record);centralSize+=record.length;offset+=header.length+data.length;
    if(offset+centralSize>=0xffffffff)throw new DrawingError('ZIP64_UNSUPPORTED','ZIP64 output is unsupported.');
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.size,true);e.setUint16(10,entries.size,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  const output=new Uint8Array(offset+centralSize+22);let position=0;for(const part of [...local,...central,end]){output.set(part,position);position+=part.length;}return output;
}
