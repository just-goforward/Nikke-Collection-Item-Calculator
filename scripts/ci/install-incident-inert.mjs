// Create-only. Partial success deliberately requires independent operator reconciliation.
import assert from 'node:assert/strict';
import {hash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const env=process.env, sha=env.GITHUB_SHA, name='collection-kit-production-incidents';
const account='15be33fd20ea78eb3d60b719be831148', zone='2ed78e90cd4834066e079282aea4acb2';
const db='9a516350-d7d8-4a77-9cce-45d669fd3502', uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
assert.equal(env.GITHUB_REPOSITORY,'just-goforward/Nikke-Collection-Item-Calculator');
assert.equal(env.GITHUB_REF,'refs/heads/main'); assert.equal(env.GITHUB_REF_PROTECTED,'true');
assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch'); assert.equal(env.GITHUB_WORKFLOW_SHA,sha);
assert.equal(env.GITHUB_WORKFLOW_REF,`${env.GITHUB_REPOSITORY}/.github/workflows/incident-inert-install.yml@refs/heads/main`);
assert.match(sha,/^[a-f0-9]{40}$/); assert.equal(sha,env.INCIDENT_REVIEWED_MAIN);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha);
const record=JSON.parse(readFileSync('site-worker/production-root-release-v1.json'));
const build=record.serviceCodeHash; assert.match(build,/^[0-9a-f]{64}$/);
const namespace='419204';
const module=readFileSync(`${env.RUNNER_TEMP}/incident-bundle/worker.js`);
assert(module.length>0 && module.length<512*1024); assert.equal(hash('sha256',module),env.INCIDENT_MODULE_SHA256);
assert(env.CF_INCIDENT_INSTALL_TOKEN && env.GH_TOKEN);
async function request(url,token,method='GET',payload){
  const r=await fetch(url,{method,headers:{authorization:`Bearer ${token}`,...(payload?{'content-type':'application/json'}:{})},body:payload&&JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(15000)});
  assert(r.ok,`provider request failed: ${method} ${new URL(url).pathname}: ${r.status}`); return r.json();
}
const gh=path=>request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`,env.GH_TOKEN);
async function source(){
  const b=await gh('branches/main'); assert.equal(b.protected,true);assert.equal(b.commit.sha,sha);
  const runs=await gh(`actions/workflows/site-source-verify.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=30`);
  const run=runs.workflow_runs.find(r=>r.conclusion==='success'&&r.head_sha===sha&&r.event==='push'&&r.head_repository.full_name===env.GITHUB_REPOSITORY);
  assert(run,'protected main source verification missing');
  const jobs=await gh(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assert(jobs.jobs.some(j=>j.name==='Production root source (no publication)'&&j.conclusion==='success'&&j.steps.some(s=>s.name==='Build source-only root with the isolated pin, never the enrolled key'&&s.conclusion==='success')),'enrolled root build missing');
}
const cf=async(path,...args)=>{const v=await request(`https://api.cloudflare.com/client/v4${path}`,env.CF_INCIDENT_INSTALL_TOKEN,...args);assert.equal(v.success,true);return v.result;};
const prefix=`/accounts/${account}/workers`, script=`${prefix}/scripts/${name}`;
async function noIngress(){
  const [sub,schedules,routes,domains]=await Promise.all([cf(`${script}/subdomain`),cf(`${script}/schedules`),cf(`/zones/${zone}/workers/routes`),cf(`${prefix}/domains?service=${name}&per_page=1`)]);
  assert.equal(sub.enabled,false);assert.equal(sub.previews_enabled,false);assert.deepEqual(schedules.schedules??schedules,[]);assert(!routes.some(r=>r.script===name));assert.deepEqual(domains,[]);
}
await source();
const dbInfo=await cf(`/accounts/${account}/d1/database/${db}`);assert.equal(dbInfo.uuid,db);assert.equal(dbInfo.name,name);
// The account registry was independently inventoried. Fail closed if it grew beyond a page, gained Pages projects, or the namespace is now active.
const scripts=await cf(`${prefix}/scripts?per_page=100`);assert(Array.isArray(scripts)&&scripts.length>0&&scripts.length<100);
assert.deepEqual(await cf(`/accounts/${account}/pages/projects?per_page=1`),[]);
for(const s of scripts){
  assert.match(s.id,/^[a-zA-Z0-9_-]+$/);assert.notEqual(s.id,name);
  const ds=await cf(`${prefix}/scripts/${s.id}/deployments?per_page=1`);assert.equal(ds.deployments.length,1);
  for(const v of ds.deployments[0].versions){assert.match(v.version_id,uuid);
    const active=await cf(`${prefix}/workers/${s.id}/versions/${v.version_id}`);
    assert(Array.isArray(active.bindings));assert(!active.bindings.some(b=>b.type==='ratelimit'&&String(b.namespace_id)===namespace),'incident namespace in use');
  }
}
// POST collection, not PUT script-by-name: a collision or ambiguous response must never become an overwrite/retry.
const worker=await cf(`${prefix}/workers`,'POST',{name,logpush:false,observability:{enabled:false}});
assert.equal(worker.name,name);assert.match(worker.id,uuid);
await cf(`${script}/subdomain`,'POST',{enabled:false,previews_enabled:false}); await noIngress();
const bindings=[{type:'d1',name:'INCIDENT_DB',id:db},{type:'ratelimit',name:'INGRESS',namespace_id:namespace,simple:{limit:60,period:60}},{type:'plain_text',name:'INCIDENT_BUILD',text:build},{type:'plain_text',name:'PUBLIC_INGRESS',text:'0'}];
const path=`${prefix}/workers/${worker.id}/versions`;
await source();
const version=await cf(`${path}?deploy=true`,'POST',{compatibility_date:'2026-08-14',main_module:'worker.js',bindings,modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:module.toString('base64')}]});
assert.match(version.id,uuid); const live=await cf(`${path}/${version.id}?include=modules`);
assert.equal(live.id,version.id);assert.equal(live.main_module,'worker.js');assert.equal(live.modules.length,1);assert.equal(live.modules[0].content_base64,module.toString('base64'));
assert.deepEqual(live.bindings.map(b=>b.name).sort(),bindings.map(b=>b.name).sort());
for(const expected of bindings){const actual=live.bindings.find(b=>b.name===expected.name);for(const [k,v] of Object.entries(expected))assert.deepEqual(actual[k],v);}
await noIngress(); console.log(`Verified inert incident version ${version.id} at ${sha}; no schema, secrets, route or schedule installed.`);
