import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const root=process.cwd(),temp=await mkdtemp(path.join(os.tmpdir(),'drawingweb-consumer-'));const npm=process.platform==='win32'?'npm.cmd':'npm';
function run(command,args,cwd=root){const result=spawnSync(command,args,{cwd,encoding:'utf8',shell:process.platform==='win32'});if(result.status!==0)throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);return result.stdout;}
try{
  await mkdir('artifacts/npm',{recursive:true});const packed=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination','artifacts/npm']))[0];
  const files=new Set(packed.files.map(file=>file.path));for(const expected of ['dist/esm/index.js','dist/cjs/index.js','dist/types/index.d.ts','dist/esm/bridge.js','dist/drawingweb.global.js','LICENSE','NOTICE','README.md'])assert(files.has(expected),`Missing packed file: ${expected}`);
  await writeFile(path.join(temp,'package.json'),'{}');run(npm,['install','--ignore-scripts','--offline','--no-audit','--no-fund',path.join(root,'artifacts/npm',packed.filename)],temp);
  const subpaths=['core','geometry','layout','formula','data','io','web','bridge','mvvm'];
  run(process.execPath,['--input-type=module','-e',`import {DiagramEngine,createShape} from '@wieslawsoltes/drawingweb';const e=new DiagramEngine();e.add(e.document.pages[0].id,createShape('rectangle'));if(e.allShapes().length!==1)throw Error('Consumer failure');for(const part of ${JSON.stringify(subpaths)})await import('@wieslawsoltes/drawingweb/'+part);`],temp);
  run(process.execPath,['-e',`const {DiagramEngine}=require('@wieslawsoltes/drawingweb');if(new DiagramEngine().document.schema!=='drawingweb/1')throw Error('CJS failure');for(const part of ${JSON.stringify(subpaths)})require('@wieslawsoltes/drawingweb/'+part);`],temp);
  await writeFile(path.join(temp,'usage.mts'),`import { DiagramEngine, createShape, ObservableTable, DiagramBinding } from '@wieslawsoltes/drawingweb';import {DrawingControl} from '@wieslawsoltes/drawingweb/web';import {readVsdx} from '@wieslawsoltes/drawingweb/io';const e=new DiagramEngine();const p=e.document.pages[0]!;e.add(p.id,createShape('rectangle',{style:{fill:'#fff'}}));const rows=new ObservableTable('id',[],[{id:'a',label:'Test'}]);new DiagramBinding(e,rows,{pageId:p.id,mappings:{text:'label'}});const c:typeof DrawingControl=DrawingControl;void c;void readVsdx;`);
  const localTsc=path.join(root,'node_modules/typescript/bin/tsc');let compiler;try{await readFile(localTsc);compiler=[process.execPath,[localTsc]];}catch{compiler=[process.platform==='win32'?'tsc.cmd':'tsc',[]];}
  run(compiler[0],[...compiler[1],'--noEmit','--strict','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--lib','es2022,dom','usage.mts'],temp);
  console.log(`Package consumer smoke passed: ESM + CJS, ${subpaths.length} subpaths, declarations, required assets. ${packed.filename}`);
}finally{await rm(temp,{recursive:true,force:true});}
