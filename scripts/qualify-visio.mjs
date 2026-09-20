/** Consume a native Visio capture, verify its hashes, and compare the normalized import.
 * This is a geometry/text import gate, not a certificate for every Visio feature. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readVsdx, exportSvg} from '../dist/esm/index.js';

export function compareCapture(manifest, document, tolerance = 1e-7) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw Error('Tolerance must be finite and non-negative.');
  const differences = [];
  const compare = (location, actual, expected) => {
    const same = typeof expected === 'number' ? typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual-expected)<=tolerance : actual === expected;
    if (!same) differences.push({location, expected, actual: actual ?? null});
  };
  for (const page of manifest.pages) {
    const actual = document.pages.find(p => p.id === `visio-p${page.id}`);
    if (!actual) { differences.push({location:`page:${page.id}`,expected:'present',actual:null});continue; }
    compare(`${actual.id}/width`,actual.width/96,page.width);compare(`${actual.id}/height`,actual.height/96,page.height);
    const walk = (expectedShapes, actualShapes, where) => {
      compare(`${where}/shape-count`,actualShapes.length,expectedShapes.length);
      for (let i=0;i<expectedShapes.length;i++) {
        const expected=expectedShapes[i];
        // Never guess identity from array position, shape text or geometry. Unmapped inherited
        // master-local IDs are a coverage failure requiring an explicit identity mapping.
        const shape=actualShapes.find(s=>s.sheetId===expected.id);
        const location=`${where}/shape:${expected.id}`;
        if (!shape) {differences.push({location,expected:'present',actual:null});continue;}
        compare(location+'/text',shape.text.replace(/\r\n?/g,'\n'),expected.text.replace(/\r\n?/g,'\n'));
        if (shape.kind!=='connector' && !shape.transform) {
          for(const [name,value] of [['Width',shape.width/96],['Height',shape.height/96],['Angle',-shape.rotation]])
            if (typeof expected.cells[name]?.result==='number')compare(location+'/'+name,value,expected.cells[name].result);
        }
        walk(expected.children??[],shape.children??[],location);
      }
    };
    walk(page.shapes,actual.shapes,actual.id);
  }
  if(manifest.pages.length)compare('page-count',document.pages.length,manifest.pages.length);
  return differences;
}

async function main(args) {
  if(args.length!==1)throw Error('Usage: node scripts/qualify-visio.mjs <native-capture-directory>');
  const root=await fs.realpath(args[0]),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.schema!=='drawingweb-visio-capture/1'||!Array.isArray(manifest.pages)||manifest.pages.length>1000||!manifest.files||typeof manifest.converted!=='string')throw Error('Invalid capture manifest.');
  for(const [name,expected]of Object.entries(manifest.files)) {
    if(name!==path.basename(name)||/[\\/]/.test(name)||!name||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw Error('Invalid capture file identity.');
    const file=path.join(root,name),info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024*1024)throw Error('Invalid capture file.');
    const actual=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');if(actual!==expected)throw Error(`Capture hash mismatch: ${name}`);
  }
  if(!Object.hasOwn(manifest.files,manifest.converted))throw Error('Converted file must be in the verified manifest.');
  const source=await readVsdx(new Uint8Array(await fs.readFile(path.join(root,manifest.converted))));
  const differences=compareCapture(manifest,source.document);
  const report={schema:'drawingweb-visio-comparison/1',visioVersion:manifest.visioVersion,inputSha256:manifest.inputSha256,
    importedPages:source.document.pages.length,differences,diagnostics:source.diagnostics,
    coverage:'Import page size, shape counts, text, untransformed 2D dimensions and angle only. Not a rendering or complete semantic certification.'};
  const output=path.join(root,'drawingweb-comparison');await fs.mkdir(output); // Refuse overwrite.
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(output,'document.drawing.json'),JSON.stringify(source.document,null,2));
  for(const [i,p]of source.document.pages.entries())await fs.writeFile(path.join(output,`page-${String(i+1).padStart(4,'0')}.svg`),exportSvg(source.document,p.id));
  console.log(JSON.stringify({differences:differences.length,diagnostics:source.diagnostics.length,output}));
  // An import with unsupported diagnostics is not a clean interoperability pass.
  if(differences.length||source.diagnostics.some(d=>d.severity==='error'||d.severity==='warning'))process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
