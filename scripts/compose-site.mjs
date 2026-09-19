import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';

const base = process.env.PAGES_BASE_PATH ?? '/DrawingWeb/';
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw Error('Invalid Pages base path');
const destination = 'site/blazor';
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp('artifacts/wasm/wwwroot', destination, { recursive: true });
const html = await readFile(`${destination}/index.html`, 'utf8');
const bases = [...html.matchAll(/<base\b[^>]*>/gi)];
if (bases.length !== 1) throw Error('The WebAssembly host must contain exactly one base element');
const revised = html.replace(bases[0][0], `<base href="${base}blazor/">`);
await writeFile(`${destination}/index.html`, revised);
await writeFile('site/.nojekyll', '');
await rm('artifacts/pages-root', { recursive: true, force: true });
await mkdir(`artifacts/pages-root${base}`, { recursive: true });
await cp('site', `artifacts/pages-root${base}`, { recursive: true });
console.log(`Composed studio + package-restored WASM at ${base}; browser test fixture: artifacts/pages-root.`);
