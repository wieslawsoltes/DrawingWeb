import test from 'node:test';
import assert from 'node:assert/strict';
import {readOfficeTheme, readOfficeThemePackage, resolveOfficeColor, DiagramEngine, DiagramOperations} from '../dist/esm/index.js';
import {parseXml} from '../dist/esm/xml.js';
import {writeZip} from '../dist/esm/zip.js';
const xml='<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test theme"><a:themeElements><a:clrScheme name="User"><a:dk1><a:sysClr val="windowText" lastClr="102030"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="204080"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Example Sans"/></a:majorFont><a:minorFont><a:latin typeface="Example Text"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
test('DrawingML palette and cached system color import has explicit partial diagnostics',()=>{
 const r=readOfficeTheme(xml);assert.equal(r.theme.colors.dark,'#102030');assert.equal(r.theme.colors.accent,'#204080');assert.equal(r.majorFont,'Example Sans');assert.equal(r.theme.fontFamily,'Example Text');assert.ok(r.diagnostics.some(d=>d.code==='OFFICE_THEME_PALETTE'));
 const e=new DiagramEngine();new DiagramOperations(e).applyTheme(r.theme);assert.equal(e.document.theme.name,'Test theme');e.undo();assert.equal(e.document.theme,undefined);
});
test('DrawingML tint, shade and alpha transforms are ordered and rounded at output',()=>{
 assert.equal(resolveOfficeColor(parseXml('<srgbClr val="000000"><tint val="10000"/></srgbClr>')),'#e6e6e6');
 assert.equal(resolveOfficeColor(parseXml('<srgbClr val="ffffff"><shade val="10000"/></srgbClr>')),'#1a1a1a');
 assert.equal(resolveOfficeColor(parseXml('<srgbClr val="000000"><tint val="50%"/><shade val="50000"/><alpha val="50%"/></srgbClr>')),'#40404080');
});
test('unsupported colors, invalid transforms and ambiguous palettes never silently approximate',()=>{
 assert.throws(()=>resolveOfficeColor(parseXml('<schemeClr val="accent1"/>')),{code:'OFFICE_THEME'});
 assert.throws(()=>resolveOfficeColor(parseXml('<srgbClr val="FFFFFF"><lumMod val="60000"/></srgbClr>')),{code:'OFFICE_THEME'});
 assert.throws(()=>resolveOfficeColor(parseXml('<srgbClr val="FFFFFF"><tint val="NaN"/></srgbClr>')),{code:'OFFICE_THEME'});
 assert.throws(()=>readOfficeTheme(xml.replace('</a:clrScheme>','<a:dk1><a:srgbClr val="000000"/></a:dk1></a:clrScheme>')),{code:'OFFICE_THEME'});
 assert.throws(()=>readOfficeTheme(xml.replace('http://schemas.openxmlformats.org/drawingml/2006/main','urn:wrong')),{code:'OFFICE_THEME'});
});
test('Office theme packages return all candidate themes rather than guessing a page variant',async()=>{
 const data=await writeZip(new Map([['theme/theme/theme1.xml',new TextEncoder().encode(xml)],['theme/theme/theme2.xml',new TextEncoder().encode(xml.replace('Test theme','Second'))]]));
 const result=await readOfficeThemePackage(data);assert.equal(result.length,2);assert.equal(result[1].theme.name,'Second');assert.equal(result[0].part,'theme/theme/theme1.xml');
});
