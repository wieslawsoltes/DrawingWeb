import {mkdir,rm,writeFile,readdir,readFile,cp} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');process.chdir(root);
function run(args){const result=spawnSync(process.platform==='win32'?'tsc.cmd':'tsc',args,{stdio:'inherit',shell:process.platform==='win32'});if(result.status!==0)throw new Error(`TypeScript build failed (${result.status}): ${result.error??''}`);}
await rm('dist',{recursive:true,force:true});await mkdir('dist',{recursive:true});run(['-p','tsconfig.json']);
const base=JSON.parse(await readFile('tsconfig.json','utf8'));base.compilerOptions={...base.compilerOptions,module:'CommonJS',moduleResolution:'Node',outDir:'dist/cjs',declaration:false,declarationMap:false};delete base.compilerOptions.declarationDir;
await writeFile('tsconfig.cjs.generated.json',JSON.stringify(base));try{run(['-p','tsconfig.cjs.generated.json']);}finally{await rm('tsconfig.cjs.generated.json',{force:true});}
await writeFile('dist/cjs/package.json','{"type":"commonjs"}\n');
// A dependency-free CommonJS module registry produces the browser global from the same compiled modules.
const modules=[];for(const file of (await readdir('dist/cjs')).filter(file=>file.endsWith('.js')).sort()){const text=await readFile(`dist/cjs/${file}`,'utf8');modules.push(`${JSON.stringify('./'+file)}:function(module,exports,require){\n${text}\n}`);}
await writeFile('dist/drawingweb.global.js',`/* DrawingWeb — MIT. Generated from the same tested source modules. */\n(function(global){'use strict';const modules={${modules.join(',\n')}},cache={};function require(id){if(cache[id])return cache[id].exports;const fn=modules[id];if(!fn)throw Error('Unknown module '+id);const module=cache[id]={exports:{}};fn(module,module.exports,require);return module.exports;}global.DrawingWeb=require('./index.js');global.DrawingWebBridge=require('./bridge.js');})(globalThis);\n`);
const assets='blazor/DrawingWeb.Blazor/wwwroot/engine';await rm(assets,{recursive:true,force:true});await mkdir(assets,{recursive:true});await cp('dist/esm',assets,{recursive:true});
console.log('Built ESM, CommonJS, declarations, browser global and self-contained Blazor assets.');
