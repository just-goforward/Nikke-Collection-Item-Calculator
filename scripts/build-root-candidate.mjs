import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,mkdtemp} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertServiceH14Node} from './service-h14-paths.ts';
import target from './root-conditional-target.json' with {type:'json'};
import legacy from '../site-worker/production-forecast.proposed.json' with {type:'json'};
import previewTrust from '../preview-gateway/trust.json' with {type:'json'};
import {portablePath,portablePins} from '../src/serviceH14/portablePins.ts';

import {readReleaseReview,sealReleasePair} from './root-release-custody.mjs';
const release = process.argv[2] === '--private-production-v1';
assert.equal(process.argv.length,release?9:3,'Usage: ... <evidence> OR --private-production-v1 <evidence> <reviewed-contract> <approved-full-sha> <wire> <enrollment-evidence> <archive>');
assertServiceH14Node();
const root=resolve(fileURLToPath(new URL('../',import.meta.url))), evidence=resolve(process.argv[release?3:2]);
assert.equal(process.cwd(),root);
const review=release?await readReleaseReview(root,...process.argv.slice(4,8)):null;
const publicKey=review?.publicKeyBase64??target.isolatedCandidatePublicKeyBase64;
const run=await mkdtemp(join(root,'.artifacts/service-h14-run.')), build=join(run,'root-build'),output=join(run,release?'production-forward':'isolated-root');
const env={...(process.env.CARGO_HOME?{CARGO_HOME:process.env.CARGO_HOME}:{}),...(process.env.RUSTUP_HOME?{RUSTUP_HOME:process.env.RUSTUP_HOME}:{}),HOME:process.env.HOME,PATH:process.env.PATH,SERVICE_H14_RUN:run,VITE_SERVICE_CERTIFIED_SOLVER:'true',VITE_FORECAST_RUNTIME:'bundled',VITE_ROOT_CONDITIONAL_PUBLIC_KEY:publicKey,GITHUB_SHA:review?.source??'isolated-production-root-candidate'};
function invoke(label,...args){const r=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024});if(r.error||r.status!==0)throw Error(`${label}: ${r.error??''} ${r.stdout} ${r.stderr}`);return r.stdout;}
for(const [label,args] of [['core',['scripts/service-h14-build.ts','--core']],['native',['scripts/service-h14-native-build.ts']],['service',['scripts/service-h14-build.ts','--identity']]])await writeFile(join(run,label+'.json'),invoke(label,...args));
const identity=JSON.parse(await readFile(join(run,'service.json')));
assert.equal(identity.status,'NONDEPLOYABLE_SERVICE_CANDIDATE');assert.equal(identity.policy,'adaptive-next-batch-balanced-v1');
await writeFile(join(run,'vite.log'),invoke('vite','node_modules/vite/bin/vite.js','build','--configLoader','native','--config',release?'scripts/root-release.vite.config.ts':'scripts/root-candidate.vite.config.ts','--outDir',build));
const graph=JSON.parse(await readFile(join(build,'.vite/worker-boundary/src_serviceH14_browserWorker.ts.json')));
for(const name of ['controller','binding','adaptiveDecision','source','aggregate','admission'])assert(graph.modules.includes(`src/serviceH14/${name}.ts`));
for(const name of ['previewJoint','forecastRead','certifiedForecastTrust'])assert(graph.modules.includes(`src/lib/${name}.ts`));
if(release){assert(graph.modules.includes('src/lib/productionRootOrigin.ts'));assert(!graph.modules.includes('src/lib/rootCandidate.ts'));}
const assets=await readdir(join(build,'assets')), orphans=assets.filter(s=>/^(?:worker|previewCalendar|previewTimedSupplyReader)-[\w-]+\.js$/.test(s));
const wasm=`wasm/service-fused-h14-${identity.exactWasmHash}.wasm`;
const files=[...assets.filter(s=>!orphans.includes(s)).map(s=>'assets/'+s),...['','en/','ja/'].flatMap(d=>(release?['index']:['index','privacy','terms','licenses']).map(p=>d+p+'.html')),
  'robots.txt','llms.txt','sitemap.xml','decision-production-catalog.json','favicon-32.png','icon-192.png','third-party-licenses.md',...['ko','en','ja'].map(l=>`og/collection-calculator-${l}.png`),wasm,...portablePins.map(portablePath)];
async function fonts(dir){for(const f of await readdir(join(build,dir),{withFileTypes:true})){const p=join(dir,f.name);if(f.isDirectory())await fonts(p);else if(f.isFile()&&/\.(css|woff2|txt)$/i.test(p))files.push(p);}}
await fonts('fonts');assert(files.includes(graph.entryFile));
// Vite emits these dynamic entries even when the only importers are tree-shaken.
// No retained executable or HTML may refer to any omitted filename.
const manifest={},hash=b=>createHash('sha256').update(b).digest('hex');
for(const file of files.sort()){
  let bytes=await readFile(join(build,file));
  // The shared Node renderer defaults to preview. Restore canonical public-root page policy.
  if(/\.(html|xml)$/.test(file))bytes=Buffer.from(bytes.toString().replaceAll('/preview/','/'));
  if(file.endsWith('.html')){
    const robots=file.endsWith('index.html')?'index,follow,max-image-preview:large':'index,follow';
    const html=bytes.toString().replace('content="noindex,nofollow"',`content="${robots}"`).replaceAll('preview:collectionThemeMode','collectionThemeMode');
    assert.deepEqual([...html.matchAll(/<meta name="robots" content="([^"]+)"/g)].map(m=>m[1]),[robots],file);
    assert(html.includes('"collectionThemeMode"')&&!html.includes('preview:collectionThemeMode'),file);
    const canonical='https://nikkecollection.com/'+file.replace(/index\.html$/,'').replace(/\.html$/,'');
    assert(html.includes(`<link rel="canonical" href="${canonical}"`),file);
    bytes=Buffer.from(html);
  }
  if(file==='robots.txt')assert.equal(bytes.toString().trim(),'User-agent: *\nAllow: /\nSitemap: https://nikkecollection.com/sitemap.xml');
  if(/\.(html|js|xml)$/.test(file)){
    const s=bytes.toString();for(const bad of [...orphans,'preview:nikke:legacy-reload-input:v1','preview:collectionThemeMode',previewTrust.publicKeyBase64,'/preview/','nikke.preview.conditional-joint-supply.v2'])assert(!s.includes(bad),`unexpected ${bad} in ${file}`);
    if(release)assert(!s.includes(target.isolatedCandidatePublicKeyBase64)&&!s.includes('root_candidate_local_origin_required'));
  }
  const sha256=hash(bytes);if(file===wasm)assert.equal(sha256,identity.exactWasmHash);
  if(file.endsWith('.bin'))assert.equal(sha256,portablePins.find(x=>portablePath(x)===file)?.sha256);
  await mkdir(dirname(join(output,file)),{recursive:true});await writeFile(join(output,file),bytes,{flag:'wx'});manifest['/'+file]={bytes:bytes.length,sha256};
}
if(release){
  assert(Object.keys(manifest).some(p=>p.endsWith('.js')&&p.includes('/assets/')));
  const js=await Promise.all(Object.keys(manifest).filter(p=>p.endsWith('.js')).map(p=>readFile(join(output,p),'utf8')));
  for(const required of [publicKey,target.domain,target.read,'production_root_origin_required'])assert(js.some(text=>text.includes(required)),required);
  await sealReleasePair({review,identity,root,run,output,evidence,manifest,archive:resolve(process.argv[8]),worker:graph.entryFile});
}else{
const receipt={status:'ISOLATED_LOCAL_ROOT_CANDIDATE',productionDeployable:false,scope:'/',environment:'production',policy:identity.policy,serviceCodeHash:identity.codeHash,nativeWasmSha256:identity.exactWasmHash,nativeSourceHash:identity.nativeSourceHash,worker:graph.entryFile,conditionalJoint:{read:target.read,domain:target.domain,keyId:target.keyId,publicKeyBase64:target.isolatedCandidatePublicKeyBase64,enrolled:false},currentOnly:{read:'/api/forecast',keyId:legacy.keyId,publicKeyBase64:legacy.publicKeyBase64},files:manifest,output,run};
await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'root-assets.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({output,run,count:files.length,serviceCodeHash:identity.codeHash}));
}
