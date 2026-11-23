import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {baseline,executePrivate,failed,script,target} from './incident-canary-control.mjs';
import {successorBuild} from '../../production-incidents/sealed-successor.ts';
import {bindings,db,digest,name,registry} from './incident-provider.mjs';
import {original} from './incident-recovery-id.mjs';

// Reproduce the immutable installed bytes rather than substituting an easier hash in the gate.
const tmp=mkdtempSync(join(tmpdir(),'canary-test-')),cwd=resolve('production-incidents'),cfg=join(cwd,`.canary-test-${process.pid}.json`);
after(()=>rmSync(tmp,{recursive:true,force:true}));
let bytes;
try {
  writeFileSync(cfg,execFileSync(process.execPath,['config.mjs','inert',db,'419204',baseline.build],{cwd}),{flag:'wx'});
  execFileSync(process.execPath,['../node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config',cfg,'--outdir',tmp],{cwd,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:'pipe'});
  bytes=readFileSync(join(tmp,'worker.js'));assert.equal(digest(bytes),baseline.module);
} finally {rmSync(cfg,{force:true});}
const module=Buffer.from('different reviewed canary bytes'),hash=digest(module),candidate=crypto.randomUUID();
function fixture(fault) {
  let deployment=crypto.randomUUID(),version=baseline.version,crons=[],created=false,arms=0,observers=0,deployments=0;
  const read=async path=>{
    if([target,`${registry}/${name}`].includes(path))return {id:original.workerId,name,created_on:original.createdOn,deployed_on:original.createdOn,tags:[original.tag],subdomain:{enabled:false,previews_enabled:false},logpush:false,observability:{enabled:false},tail_consumers:[],references:{workers:[],domains:[],dispatch_namespace_outbounds:[],durable_objects:[],queues:[]}};
    if(path===`${script}/subdomain`)return {enabled:false,previews_enabled:false};if(path===`${script}/schedules`)return {schedules:crons.map(cron=>({cron}))};
    if(path===`${script}/deployments?per_page=1`)return {deployments:[{id:deployment,versions:[{version_id:version,percentage:100}]}]};
    if(path===`${script}/deployments?per_page=100`)return {deployments:[[deployment,version],[fault==='wrong predecessor'?deployment:failed.deployment,failed.version],[baseline.deployment,baseline.version]].map(([id,version_id])=>({id,versions:[{version_id,percentage:100}]}))};
    if(path===`${target}/versions?per_page=100`)return [baseline.version,baseline.partial,baseline.donor,failed.version,...(fault==='prior successor'?[candidate]:[])].map(id=>({id}));
    const id=path.match(/\/versions\/([^?]+)\?include=modules$/)?.[1];assert([baseline.version,baseline.donor,candidate].includes(id));
    const names=id===baseline.version?[]:['ADMIN_ID','BOT_TOKEN'];if(fault==='missing donor'&&id===baseline.donor||fault==='dropped inheritance'&&id===candidate)names.pop();
    const main=id===candidate?'private-canary.js':'worker.js';
    const b=bindings(id===candidate?successorBuild:baseline.build).concat(names.map(name=>({type:'secret_text',name})));if(fault==='extra binding'&&id===candidate)b.push({type:'plain_text',name:'EXTRA',text:'not-allowed'});
    return {id,main_module:main,compatibility_date:'2026-08-14',usage_model:'standard',modules:[{name:main,content_type:'application/javascript+module',content_base64:(id===candidate?module:bytes).toString('base64')}],bindings:b};
  };
  const ops={read,module,hash,end:Math.floor(Date.now()/1000)+(fault==='expired'?1:1000),authority:()=>{if(fault==='no consent')throw Error('refused');},inventory:()=>fault==='graph drift'&&version===candidate?'other':'graph',requireSeal:()=>{if(fault==='no seal')throw Error('refused');},receipt:()=>{},
    create:body=>{assert.equal(created,false);created=true;assert.deepEqual(body.bindings.slice(0,4),bindings(successorBuild));assert.deepEqual(body.bindings.filter(b=>b.type==='inherit'),['ADMIN_ID','BOT_TOKEN'].map(name=>({name,type:'inherit',version_id:baseline.donor})));return {id:candidate};},
    deploy:id=>{deployments++;version=id;deployment=crypto.randomUUID();if(fault==='lost deployment ACK'&&id===candidate)throw Error('lost');return {id:deployment};},
    schedules:arr=>{crons=arr;if(arr.length){arms++;if(fault==='lost schedule ACK')throw Error('lost');}},observe:()=>{observers++;if(fault==='changed deployment'){deployment=crypto.randomUUID();throw Error('unrelated control');}}};
  return {run:()=>executePrivate(ops),state:()=>({created,version,crons,arms,observers,deployments})};
}
for(const fault of ['none','no seal','no consent','wrong predecessor','prior successor','missing donor','dropped inheritance','extra binding','expired','graph drift','lost deployment ACK','lost schedule ACK','changed deployment']) test(fault,async()=>{
  const f=fixture(fault);if(fault==='none')await f.run();else await assert.rejects(f.run());const s=f.state();
  if(['no seal','no consent','wrong predecessor','prior successor','missing donor','dropped inheritance','extra binding','expired'].includes(fault)){assert.equal(s.deployments,0);assert.equal(s.arms,0);assert.equal(s.observers,0);assert.equal(s.created,['dropped inheritance','extra binding'].includes(fault));}
  else if(fault==='lost deployment ACK'){assert.equal(s.version,candidate);assert.equal(s.deployments,1);assert.equal(s.arms,0);}
  else if(fault==='changed deployment'){assert.equal(s.version,candidate);assert.equal(s.deployments,1);assert.equal(s.crons.length,1);}
  else {assert.equal(s.deployments,2);assert.equal(s.version,baseline.version);assert.deepEqual(s.crons,[]);assert.equal(s.arms,fault==='graph drift'?0:1);assert.equal(s.observers,fault==='none'?1:0);}
});
