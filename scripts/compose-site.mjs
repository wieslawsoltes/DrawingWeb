import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
const base=process.env.PAGES_BASE_PATH??'/DrawingWeb/';if(!/^\/[A-Za-z0-9_/-]*\/$/.test(base))throw Error('Invalid Pages base path');
await mkdir('site/blazor',{recursive:true});await cp('artifacts/wasm/wwwroot','site/blazor',{recursive:true});
const html=await readFile('site/blazor/index.html','utf8');await writeFile('site/blazor/index.html',html.replace('<base href="/">',`<base href="${base}blazor/">`));
await rm('artifacts/pages-root',{recursive:true,force:true});await mkdir('artifacts/pages-root'+base,{recursive:true});await cp('site','artifacts/pages-root'+base,{recursive:true});
console.log(`Composed studio + package-restored WASM at ${base}; browser test fixture: artifacts/pages-root.`);
