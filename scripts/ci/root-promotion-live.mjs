import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { assertProductionKey } from '../root-release-custody.mjs';
import legacy from '../../site-worker/production-forecast.proposed.json' with {type:'json'};
import { sha256 } from './root-promotion-custody.mjs';

export const account='15be33fd20ea78eb3d60b719be831148', site='collection-kit-site-production', hostname='nikkecollection.com';
const zone='2ed78e90cd4834066e079282aea4acb2', origin=`https://${hostname}`, moduleHash='17190d4c25d655580813944ae79821d898e4c6ed3b5774dbaee82ac87d4f916f';
const api=`https://api.cloudflare.com/client/v4`, worker=`/accounts/${account}/workers`, uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sortKeys=x=>Array.isArray(x)?x.map(sortKeys):x!==null&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sortKeys(x[k])])):x;
const by=(xs,key)=>[...xs].sort((a,b)=>a[key]<b[key]?-1:a[key]>b[key]?1:0);
async function get(url,limit,token) {
  const r=await fetch(url,{redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(12000),headers:token?{authorization:`Bearer ${token}`}:{'cache-control':'no-cache'}});
  assert.equal(r.status,200,`read failed: ${new URL(url).pathname}`);const chunks=[];let size=0;
  for await(const c of r.body){size+=c.length;assert(size<=limit,'response size exceeded');chunks.push(c);}
  return {bytes:Buffer.concat(chunks,size),headers:r.headers};
}
async function cf(path,token){assert(token);const {bytes}=await get(api+path,8*1024*1024,token);const v=JSON.parse(bytes);assert.equal(v.success,true);return v.result;}
async function active(script,token){const {deployments}=await cf(`${worker}/scripts/${script}/deployments?per_page=1`,token);assert.equal(deployments.length,1);const [d]=deployments;
  assert.match(d.id,uuid);assert.equal(d.versions.length,1,'split deployment not supported');assert.equal(d.versions[0].percentage,100);assert.match(d.versions[0].version_id,uuid);return {deployment:d.id,version:d.versions[0].version_id};}
export async function observeSite(enrolled,token){
  const [live,producer,domains,routes,subdomain,schedules,settings]=await Promise.all([active(site,token),active(enrolled.publisherWorker,token),cf(`${worker}/domains?zone_id=${zone}&hostname=${hostname}`,token),cf(`/zones/${zone}/workers/routes`,token),cf(`${worker}/scripts/${site}/subdomain`,token),cf(`${worker}/scripts/${site}/schedules`,token),cf(`${worker}/scripts/${site}/settings`,token)]);
  assert.equal(producer.version,enrolled.publisherVersion);assert.equal(domains.length,1);const [domain]=domains;
  assert.equal(domain.service,site);assert.equal(domain.environment,'production');assert.equal(domain.hostname,hostname);assert.equal(domain.zone_id,zone);assert.equal(domain.enabled,true);
  for(const p of ['/api/calendar',enrolled.read])assert(routes.some(r=>r.pattern===hostname+p&&r.script===enrolled.publisherWorker&&r.request_limit_fail_open===false));
  assert.equal(subdomain.enabled,false);assert.equal(subdomain.previews_enabled,false);
  const v=await cf(`${worker}/workers/${site}/versions/${live.version}?include=modules`,token);assert.equal(v.id,live.version);assert.equal(v.main_module,'worker.js');
  assert(Array.isArray(v.modules)&&v.modules.every(m=>m.name==='worker.js'||m.name==='_headers'));const js=v.modules.filter(m=>m.name==='worker.js');assert.equal(js.length,1);
  assert.equal(sha256(Buffer.from(js[0].content_base64,'base64')),moduleHash,'active immutable Site module drift');
  const cfg=v.assets?.config;assert.equal(cfg?.base_path,'/');assert.equal(cfg.not_found_handling,'404-page');assert.deepEqual([...cfg.run_worker_first].sort(),['/api','/api/*','/auth','/auth/*','/v1','/v1/*','/account','/account/*','/admin','/admin/*','/robots.txt'].sort());
  const bindings=by(settings.bindings,'name');assert.deepEqual(bindings.map(b=>b.name),['ASSETS','FORECAST_DB','FORECAST_RATE_LIMITER','FORECAST_RUNTIME_MODE','SITE_ENV','STATS','STATS_HEALTH_PROBE_TOKEN','STATS_HEALTH_RATE_LIMITER','USAGE_GUARD_DB']);
  const b=Object.fromEntries(bindings.map(x=>[x.name,x]));
  assert.equal(b.ASSETS.type,'assets');assert.equal(b.STATS.type,'service');assert.equal(b.STATS.service,'collection-kit-stats');assert.equal(b.STATS_HEALTH_PROBE_TOKEN.type,'secret_text');
  for(const [k,value] of [['SITE_ENV','production'],['FORECAST_RUNTIME_MODE','enabled']]){assert.equal(b[k].type,'plain_text');assert.equal(b[k].text,value);}
  for(const [k,value] of [['FORECAST_DB','2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853'],['USAGE_GUARD_DB','49b7f966-f4e8-4c2d-8453-279415737054']]){assert.equal(b[k].type,'d1');assert.equal(b[k].id,value);}
  for(const [k,ns,limit] of [['FORECAST_RATE_LIMITER','419201',60],['STATS_HEALTH_RATE_LIMITER','419105',320]]){assert.equal(b[k].type,'ratelimit');assert.equal(String(b[k].namespace_id),ns);assert.deepEqual(b[k].simple,{limit,period:60});}
  // Strip version annotations only. In particular keep binding values/IDs, asset routing, operational settings and zone routes.
  const {annotations:_annotations,...stable}=settings;
  const control={account,zone,site,domain,routes:by(routes,'id'),subdomain,schedules,assetConfig:cfg,
    activeBindings:by(v.bindings??[],'name'),activeEnv:v.env??{},settings:{...stable,bindings}};
  return {...live,controlSha256:sha256(JSON.stringify(sortKeys(control))),producerVersion:producer.version,moduleSha256:moduleHash,annotations:v.annotations??{}};
}
const verifyDoc=(signed,key)=>{assert.equal(typeof signed.statement,'string');assert(verify(null,Buffer.from(signed.statement),key,Buffer.from(signed.signature,'base64')),'bad producer signature');return JSON.parse(signed.statement);};
export function checkFresh(enrolled, wires, sent, now){
  const k=assertProductionKey(enrolled.publicKeyBase64),legacyKey=createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(legacy.publicKeyBase64,'base64').toString('base64url')}});
  for(const w of wires)assert(Number.isSafeInteger(w.remainingMs)&&w.remainingMs>0&&w.remainingMs<=60000&&now<sent+w.remainingMs,'expired response lease');
  const p=verifyDoc(wires[2].pointer,legacyKey);assert.equal(p.domain,'nikke.forecast.pointer.v1');assert.equal(p.environment,'production');assert.equal(p.keyId,legacy.keyId);assert.equal(p.sequence,10);assert.equal(p.contentHash,'b864b3864756c47317cd4d1b910bc120e351e83040be51d2dd929f7b9adc1c70');
  const [joint,calendar]=wires.slice(0,2).map((w,i)=>{assert.deepEqual(Object.keys(w).sort(),['remainingMs','signature','statement']);const d=verifyDoc(w,k);
    assert.equal(d.domain,i?'nikke.production.collected-calendar.v1':enrolled.domain);assert.equal(d.keyId,enrolled.keyId);assert.equal(d.environment,'production');assert.equal(d.status,'partial');
    assert(Number.isSafeInteger(d.issuedAt)&&d.sequence===d.issuedAt&&d.issuedAt<=sent&&Number.isSafeInteger(d.expiresAt)&&now<d.expiresAt&&d.expiresAt<=d.issuedAt+900000);return d;});
  assert.equal(joint.version,'certified-daily-v4');assert.equal(joint.sequence,calendar.sequence);assert.equal(joint.expiresAt,calendar.expiresAt);assert.equal(joint.gameDay,calendar.gameDay);
  assert.equal(joint.gameDay,new Date(now+14400000).toISOString().slice(0,10));assert.deepEqual(joint.events,calendar.events);assert(joint.events.length>0);
  for(const x of ['sequence','candidateId','contentHash'])assert.equal(joint.basis[x],p[x]);assert.deepEqual(joint.days.map(d=>d.day),Array.from({length:15},(_,i)=>i));
  return {sequence:joint.sequence,expiresAt:Math.min(joint.expiresAt,...wires.map(w=>sent+w.remainingMs))};
}
export async function freshProducer(enrolled){const sent=Date.now();const wires=await Promise.all([enrolled.read,'/api/calendar','/api/forecast/version'].map(async path=>{
  const {bytes,headers}=await get(origin+path,524288);assert.equal(headers.get('cache-control'),'no-store');assert.equal(headers.get('content-type')?.split(';')[0],'application/json');return JSON.parse(bytes);}));return checkFresh(enrolled,wires,sent,Date.now());}
export async function served(files, documentsOnly=false, immutable=new Set()){
  const urls=documentsOnly?['/index.html','/en/index.html','/ja/index.html']:Object.keys(files).sort();
  for(let i=0;i<urls.length;i+=4)await Promise.all(urls.slice(i,i+4).map(async p=>{
    assert(/^\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(p)&&!/^\/(api|auth|preview|admin|account|v1)\//.test(p));
    const pin=files[p];assert(Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=64*1024*1024);
    const url=p.endsWith('/index.html')?p.slice(0,-10):p.replace(/\.html$/,'');const {bytes,headers}=await get(origin+url,pin.bytes);
    assert.equal(bytes.length,pin.bytes,p);assert.equal(sha256(bytes),pin.sha256,p);
    if(immutable.has(p))assert.deepEqual(headers.get('cache-control')?.toLowerCase().split(',').map(x=>x.trim()).sort(),['immutable','max-age=31536000','public'],p);
  }));
}
export const versionMessage=(role,manifest)=>`root-${role}:${manifest}`;
export function assertStartingState(g,live,h){
  assert.equal(live.controlSha256,g.controlSha256,'Site control plane changed');assert.equal(live.version,g.fromVersion,'unexpected active Site version');assert.equal(live.deployment,g.fromDeployment,'unexpected active Site deployment');
  if(g.operation!=='root-install-bridge') { const from=g.operation==='root-activate-forward'?'rollback':'forward';assert.equal(live.annotations['workers/tag'],g.source);assert.equal(live.annotations['workers/message'],versionMessage(from,h.directions[from].manifestSha256)); }
}
