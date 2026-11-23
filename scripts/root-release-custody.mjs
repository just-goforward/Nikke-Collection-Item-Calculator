import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createPublicKey,hash,verify} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import target from './root-conditional-target.json' with {type:'json'};
import legacy from '../site-worker/production-forecast.proposed.json' with {type:'json'};
import preview from '../preview-gateway/trust.json' with {type:'json'};
const sha=b=>hash('sha256',b), hex=/^[0-9a-f]{64}$/, uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const capSha='309a82cf66d479fd0a8af64eec4a36ea270480feba144ee2ff22eaf88495eb46', recoverySha='6d456522bd0c1be8151ee484e59fddde2aa7d855fbdb5b5d2a8690dc69061d99';
export function assertProductionKey(s){assert(typeof s==='string'&&Buffer.from(s,'base64').length===32&&Buffer.from(s,'base64').toString('base64')===s);assert(![target.isolatedCandidatePublicKeyBase64,legacy.publicKeyBase64,preview.publicKeyBase64].includes(s),'reserved public key');return createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(s,'base64').toString('base64url')}});}
function git(root,...args){return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();}
function clean(root,source){assert(/^[0-9a-f]{40}$/.test(source)&&git(root,'rev-parse','HEAD')===source,'approved source SHA mismatch');assert.equal(git(root,'status','--porcelain','--untracked-files=all'),'','clean reviewed checkout required');}
// The approved full SHA is obtained independently from the existing human source review.
// A local packet, SHA or successful private run is never an upload authorization.
export async function readReleaseReview(root,contractPath,source,wirePath,enrollmentPath){
  clean(root,source);const path='site-worker/production-root-release-v1.json';assert.equal(await realpath(contractPath),join(root,path));
  const raw=await readFile(contractPath,'utf8');assert.equal(raw.trim(),git(root,'show',`${source}:${path}`));const r=JSON.parse(raw);
  assert.equal(r.profile,'private-production-root-v1');assert.equal(r.siteWorker,'collection-kit-site-production');assert.equal(r.origin,'https://nikkecollection.com');
  assert.equal(r.domain,target.domain);assert.equal(r.keyId,target.keyId);assert.equal(r.read,target.read);assert.equal(r.publisherWorker,'collection-kit-conditional-production');assert(uuid.test(r.publisherVersion));assert.equal(r.priorSiteVersion,'741e68d9-cd5c-400a-83ce-21757315bcc8');
  for(const k of ['nativeWasmSha256','nativeSourceHash','serviceCodeHash','enrollmentEvidenceSha256'])assert(hex.test(r[k]),k);
  const enrolled=await readFile(enrollmentPath);assert.equal(sha(enrolled),r.enrollmentEvidenceSha256,'unreviewed publisher enrollment evidence');
  const key=assertProductionKey(r.publicKeyBase64);const wire=JSON.parse(await readFile(wirePath));assert.deepEqual(Object.keys(wire).sort(),['remainingMs','signature','statement']);assert(Number.isSafeInteger(wire.remainingMs)&&wire.remainingMs>0&&wire.remainingMs<=60000);
  assert(verify(null,Buffer.from(wire.statement),key,Buffer.from(wire.signature,'base64')),'producer signature mismatch');const d=JSON.parse(wire.statement),now=Date.now();assert(d.domain===r.domain&&d.keyId===r.keyId&&d.environment==='production'&&d.status==='partial'&&d.version==='certified-daily-v4');assert(Number.isSafeInteger(d.issuedAt)&&Number.isSafeInteger(d.expiresAt)&&d.sequence===d.issuedAt&&d.issuedAt<=now&&now<d.expiresAt&&d.expiresAt-d.issuedAt<=900000,'expired or invalid signed head');
  return {...r,source,contractSha256:sha(raw),statementSha256:sha(wire.statement)};
}
const doc=p=>/^(?:(?:en|ja)\/)?index\.html$/.test(p);
async function pinned(dir,p,pin){assert(/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(p)&&!p.startsWith('preview/')&&!p.startsWith('api/'));const f=join(dir,p);assert.equal(await realpath(f),f);const b=await readFile(f);assert.equal(sha(b),pin,p);return b;}
async function put(dir,p,b){const f=join(dir,p);await mkdir(dirname(f),{recursive:true});await writeFile(f,b,{flag:'wx'});}
export async function assemblePair(output,rollback,manifest,archive){
  const validated=await readFile(join(archive,'validated.json')),capture=await readFile(join(archive,'capture.json'));assert.equal(sha(validated),recoverySha);assert.equal(sha(capture),capSha);
  const old=JSON.parse(validated).recovery.pins,runtime=JSON.parse(capture).rows.filter(r=>r.runtime);assert.equal(runtime.length,77);
  const forward={...manifest},back={};let retained=0;
  for(const [p,h] of Object.entries(old)){const b=await pinned(join(archive,'recovery'),p,h),url='/'+p;back[url]={bytes:b.length,sha256:h};await put(rollback,p,b);
    if(!forward[url]){assert(!doc(p));await put(output,p,b);forward[url]=back[url];}else if(!doc(p))assert.equal(forward[url].sha256,h,p);}
  for(const r of runtime){assert.equal(r.expected,r.observed);assert.equal(forward[r.url]?.sha256,r.observed);if(!manifest[r.url])retained++;}assert.equal(retained,66,'legacy closure changed: review required');
  for(const [url,pin] of Object.entries(manifest)){const p=url.slice(1),b=await pinned(output,p,pin.sha256);assert.equal(pin.bytes,b.length);if(!back[url]){assert(/^(?:assets\/[\w-]+-[\w-]{8}\.(?:js|css)|wasm\/service-fused-h14-[0-9a-f]{64}\.wasm|proofs\/[\w-]+-[0-9a-f]{64}\.bin|fonts\/pretendard-1\.3\.9\/[\w./-]+\.(?:css|woff2|txt))$/.test(p),p);await put(rollback,p,b);back[url]=pin;}}
  const immutable=runtime.filter(r=>r.url.startsWith('/assets/')).map(r=>r.url),format=paths=>paths.sort().map(p=>`${p}\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n');
  assert.equal(sha(format(immutable)),'0c713a5d956b36052396b0bdf21034caa04ad14bf11fce83a5240f032b208407','active header custody changed');
  for(const p of Object.keys(manifest))if(!old[p.slice(1)]&&/^\/assets\/[\w-]+-[\w-]{8}\.(?:js|css)$/.test(p))immutable.push(p);
  assert(immutable.length<=100);const headers=format(immutable),headersSha256=sha(headers);
  for(const dir of [output,rollback]){await put(dir,'_headers',headers);await put(dir,'.assetsignore','/.vite/\n');}
  return {forward,rollback:back,retained,headersSha256};
}
export async function sealReleasePair({review,identity,root,run,output,evidence,manifest,archive,worker}){
  assert.equal(identity.exactWasmHash,review.nativeWasmSha256);assert.equal(identity.nativeSourceHash,review.nativeSourceHash);assert.equal(identity.codeHash,review.serviceCodeHash);
  const rollback=join(run,'production-rollback'),files=await assemblePair(output,rollback,manifest,archive);clean(root,review.source);
  const receipt={profile:'private-production-root-v1',publicationApproved:false,productionDeployable:false,review,worker,output,rollback,files};await mkdir(evidence,{recursive:true});await writeFile(resolve(evidence,'private-root-pair.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
}
