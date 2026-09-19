import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile('package.json','utf8'));
const target=process.argv[2];
async function query(url){const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(response.status===404)return null;if(!response.ok)throw Error(`Registry query failed: HTTP ${response.status} ${url}`);return response;}
function run(command,args){const result=spawnSync(command,args,{stdio:'inherit',env:process.env});if(result.error)throw result.error;if(result.status!==0)throw Error(`${command} exited ${result.status}`);}
async function only(directory,extension){const files=(await readdir(directory)).filter(p=>p.endsWith(extension));if(files.length!==1)throw Error(`Expected exactly one ${extension} in ${directory}`);return `${directory}/${files[0]}`;}
if(target==='npm'){
  if(!process.env.NODE_AUTH_TOKEN)throw Error('NPM_TOKEN is not configured for this job.');
  const archive=await only('artifacts/npm','.tgz');
  const previous=await query(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`);
  if(previous){const metadata=await previous.json();const integrity='sha512-'+createHash('sha512').update(await readFile(archive)).digest('base64');if(metadata.dist?.integrity!==integrity)throw Error('This npm version already exists with a different tarball. Bump the package version; do not overwrite it.');console.log('Exact tested npm package is already published.');}
  else run('npm',['publish',archive,'--access','public','--tag',manifest.version.includes('-')?'alpha':'latest','--provenance','--ignore-scripts']);
}else if(target==='nuget'){
  if(!process.env.NUGET_API_KEY)throw Error('NUGET_API_KEY is not configured for this job.');
  const archive=await only('artifacts/nuget','.nupkg');
  const name='drawingweb.blazor',version=manifest.version.toLowerCase();
  const previous=await query(`https://api.nuget.org/v3-flatcontainer/${name}/${version}/${name}.nuspec`);
  if(previous){const nuspec=await previous.text();if(process.env.GITHUB_SHA&&!nuspec.includes(`commit="${process.env.GITHUB_SHA}"`))throw Error('This NuGet version already exists from another source commit. Bump the version.');console.log('NuGet package from this source commit is already published.');}
  else run('dotnet',['nuget','push',archive,'--source','https://api.nuget.org/v3/index.json','--api-key',process.env.NUGET_API_KEY]);
}else throw Error('Usage: node scripts/publish.mjs npm|nuget');
