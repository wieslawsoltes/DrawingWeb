import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
await rm('site',{recursive:true,force:true});await mkdir('site',{recursive:true});await cp('sample','site',{recursive:true});await cp('dist/esm','site/engine',{recursive:true});
const script=await readFile('site/studio.js','utf8');await writeFile('site/studio.js',script.replace('../dist/esm/index.js','./engine/index.js'));await writeFile('site/.nojekyll','');
await mkdir('site/docs',{recursive:true});await cp('docs','site/docs',{recursive:true});console.log('Built self-contained GitHub Pages studio in site/.');
