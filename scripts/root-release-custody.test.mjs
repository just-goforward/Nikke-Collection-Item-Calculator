import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {hash} from 'node:crypto';
import {assemblePair,assertProductionKey} from './root-release-custody.mjs';
import target from './root-conditional-target.json' with {type:'json'};
import legacy from '../site-worker/production-forecast.proposed.json' with {type:'json'};
import preview from '../preview-gateway/trust.json' with {type:'json'};
import release from './root-release.vite.config.ts';
import isolated from './root-candidate.vite.config.ts';
import {assertRootCandidateOrigin} from '../src/lib/productionRootOrigin.ts';

test('origin and key capabilities are disjoint',()=>{
  for(const key of [null,'',target.isolatedCandidatePublicKeyBase64,legacy.publicKeyBase64,preview.publicKeyBase64])assert.throws(()=>assertProductionKey(key));
  assert.equal(isolated.define.__ISOLATED_ROOT_CANDIDATE__,'true');assert.equal(release.define.__ISOLATED_ROOT_CANDIDATE__,'false');
  for(const ref of ['./lib/rootCandidate','../lib/rootCandidate','./rootCandidate'])assert(release.resolve.alias[0].find.test(ref));
  for(const origin of ['https://localhost','http://nikkecollection.com','https://nikkecollection.com:9443','https://staging.nikkecollection.com','https://nikkecollection.com']){Object.defineProperty(globalThis,'location',{value:{origin},configurable:true});try{if(origin==='https://nikkecollection.com')assertRootCandidateOrigin();else assert.throws(assertRootCandidateOrigin);}finally{delete globalThis.location;}}
});
test('compiled release and preview resolve all locale paths independently',async()=>{
  const {build}=await import('vite');
  for(const [name,define,base] of [['production',release.define,'/'],['preview',{__ISOLATED_ROOT_CANDIDATE__:'false'},'/preview/']]){
    const result=await build({configFile:false,logLevel:'silent',define,build:{write:false,minify:true,lib:{entry:resolve(import.meta.dirname,'../shared/siteLocales.ts'),formats:['es'],fileName:'site'}}});
    const [{output}]=Array.isArray(result)?result:[result];const code=output.find(x=>x.type==='chunk').code;
    if(name==='production')assert(!code.includes('/preview/'));
    const m=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    for(const locale of ['ko','en','ja']){const path=base+(locale==='ko'?'':locale+'/'),meta=m.SITE_LOCALES[locale];assert.equal(m.siteLocaleFromPathname(path),locale);assert.equal(meta.htmlLang,locale);assert.equal(meta.path,path);assert(meta.fontStylesheet.startsWith(`${base}fonts/`));assert(meta.ogImagePath.startsWith(`${base}og/`));}
  }
});
// Historical package is used only as a byte-collision test input, never relabelled or authorized.
const fixture=process.env.ROOT_RELEASE_HISTORICAL_ARTIFACTS;
if(fixture)test('both manifests cover the complete prior and candidate static trees',async()=>{
 const pkg=JSON.parse(await readFile(join(fixture,'production-root-candidate/final/root-assets.json')));assert.equal(pkg.productionDeployable,false);assert.equal(pkg.conditionalJoint.enrolled,false);
 for(const url of Object.keys(pkg.files))if(/\/(?:privacy|terms|licenses)\.html$/.test(url))delete pkg.files[url];
 const temp=await mkdtemp(join(tmpdir(),'root-pair-test-'));try{const dir=await import('node:fs/promises').then(fs=>fs.realpath(temp)),f=join(dir,'forward'),r=join(dir,'rollback');for(const [url,pin] of Object.entries(pkg.files)){const path=join(f,url);await mkdir(dirname(path),{recursive:true});const b=await readFile(join(pkg.output,url));assert.equal(hash('sha256',b),pin.sha256);await writeFile(path,b,{flag:'wx'});}
 const pair=await assemblePair(f,r,pkg.files,resolve(fixture,'site-v14-closure.aAAcEWVA'));assert.equal(pair.retained,66);assert.deepEqual(Object.keys(pair.forward).sort(),Object.keys(pair.rollback).sort());const different=[];for(const k of Object.keys(pair.forward)){for(const [d,files] of [[f,pair.forward],[r,pair.rollback]])assert.equal(hash('sha256',await readFile(join(d,k))),files[k].sha256);if(pair.forward[k].sha256!==pair.rollback[k].sha256)different.push(k);}assert.deepEqual(different.sort(),['/en/index.html','/index.html','/ja/index.html']);
 }finally{await rm(temp,{recursive:true,force:true});}
});
