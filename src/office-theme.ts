/** DrawingML theme palette/font import. This does not infer Visio Quick Style/effect matrices. */
import { DrawingError } from './model.js';
import type { Diagnostic, DiagramTheme } from './model.js';
import { parseXml, first, elements, localName } from './xml.js';
import type { XmlElement } from './xml.js';
import { readZip } from './zip.js';

export interface OfficeThemeResult { theme: DiagramTheme; majorFont?: string; minorFont?: string; diagnostics: Diagnostic[]; part?: string }
const slots = ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
const drawingNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main','http://purl.oclc.org/ooxml/drawingml/main']);
const fail = (message: string): never => { throw new DrawingError('OFFICE_THEME', message); };
/** Resolve sRGB/system cached colors with ordered tint, shade and opacity transforms. */
export function resolveOfficeColor(node: XmlElement): string {
  const name = localName(node.name), raw = name === 'srgbClr' ? node.attributes['val'] : name === 'sysClr' ? node.attributes['lastClr'] : undefined;
  if (!raw || !/^[\da-f]{6}$/i.test(raw)) return fail(`Unsupported color ${name}; a six-digit sRGB or cached system color is required.`);
  let rgb = [0,2,4].map(offset => parseInt(raw.slice(offset,offset+2),16)/255), alpha = 1;
  for (const transform of elements(node)) {
    const type = localName(transform.name), text = transform.attributes['val'] ?? '';
    if (!/^(?:\d+(?:\.\d+)?%|\d+)$/.test(text)) return fail(`Invalid ${type} percentage.`);
    const value = text.endsWith('%') ? Number(text.slice(0,-1))/100 : Number(text)/100000;
    if (!Number.isFinite(value) || value<0 || value>1) return fail(`${type} percentage is outside 0..100%.`);
    if (type === 'tint') rgb = rgb.map(channel => channel*value+1-value);
    else if (type === 'shade') rgb = rgb.map(channel => channel*value);
    else if (type === 'alpha') alpha = value;
    else if (type === 'alphaMod') alpha *= value;
    else return fail(`Color transform ${type} is not supported; the original package remains authoritative.`);
  }
  const hex = (v:number) => Math.round(v*255).toString(16).padStart(2,'0');
  return '#'+rgb.map(hex).join('')+(alpha<1?hex(alpha):'');
}
export function readOfficeTheme(xml: string): OfficeThemeResult {
  if (xml.length>4*1024*1024) return fail('Theme XML exceeds 4 MiB.');
  const root = parseXml(xml), prefix = root.name.includes(':') ? root.name.split(':')[0]+':' : '';
  const ns = root.attributes[prefix ? 'xmlns:'+prefix.slice(0,-1) : 'xmlns'];
  if (localName(root.name)!=='theme' || !drawingNamespaces.has(ns??'')) return fail('Expected a DrawingML theme root and namespace.');
  const content = first(root,'themeElements'), palette = content && first(content,'clrScheme');
  if (!palette) return fail('Missing themeElements/clrScheme.');
  const colors: Record<string,string> = {}, diagnostics:Diagnostic[] = [];
  for (const slot of slots) {
    if (elements(palette,slot).length>1) return fail(`Duplicate palette slot ${slot}.`);
    const entry = first(palette,slot), node = entry && elements(entry)[0];
    if (entry && elements(entry).length>1) return fail(`Ambiguous palette slot ${slot}.`);
    if (!node) { diagnostics.push({code:'OFFICE_THEME_SLOT',severity:'warning',message:`Missing color slot ${slot}.`}); continue; }
    try { colors[slot] = resolveOfficeColor(node); }
    catch(error) { diagnostics.push({code:'OFFICE_THEME_COLOR',severity:'warning',message:`${slot}: ${error instanceof Error?error.message:String(error)}`}); }
  }
  // Do not pretend a skipped/unsupported color is a successfully reconstructed theme.
  if (!colors['dk1'] || !colors['lt1'] || !colors['accent1']) return fail('Theme must contain supported dk1, lt1 and accent1 colors.');
  const fontScheme = content && first(content,'fontScheme');
  const font = (name:string) => { const group = fontScheme && first(fontScheme,name); return group && first(group,'latin')?.attributes['typeface']; };
  const majorFont=font('majorFont'),minorFont=font('minorFont');
  colors['dark']=colors['dk1']; colors['light']=colors['lt1']; colors['accent']=colors['accent1'];
  colors['fill']=colors['lt1'];colors['stroke']=colors['accent1'];colors['text']=colors['dk1'];
  diagnostics.push({code:'OFFICE_THEME_PALETTE',severity:'info',message:'Imported the explicit color palette and Latin font names. Visio Quick Styles, variants, effects and script-specific font mapping are not inferred.'});
  return {theme:{id:'office-theme',name:root.attributes['name']??palette.attributes['name']??'Imported Office theme',colors,fontFamily:minorFont||majorFont||'Arial, sans-serif'},majorFont,minorFont,diagnostics};
}
/** Return all explicit theme parts; callers must choose when a package contains several themes. */
export async function readOfficeThemePackage(bytes: Uint8Array): Promise<OfficeThemeResult[]> {
  const entries = await readZip(bytes,{maxEntries:4096,maxTotalBytes:64*1024*1024}), results:OfficeThemeResult[] = [];
  for (const [part,data] of entries) {
    if (!/(?:^|\/)theme\d*\.xml$/i.test(part)) continue;
    if (data.length>4*1024*1024) return fail('Theme part exceeds 4 MiB.');
    const result = readOfficeTheme(new TextDecoder('utf-8',{fatal:true}).decode(data));result.part=part;results.push(result);
  }
  if (!results.length) return fail('No supported DrawingML theme parts were found.');
  return results;
}
