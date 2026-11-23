import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {root, registry, workers, zone, name, account, db, namespace, client, reserve, install, graph, noPreviews, digest} from './incident-provider.mjs';
import {intent, checkIntent, claim, approved, approvalComment, protection, repo, workflow, gate, owner, ciPins, certifiedRun} from './incident-receipt.mjs';
import {policy,bootstrapPolicy} from './incident-owner.mjs';

const id='d'.repeat(32), tokenId='e'.repeat(32), vid='00000000-0000-4000-8000-000000000001';
const module=Buffer.from('export default {}'), now=Date.now()-30000;
const pins={schema:1,repo,workflow,ref:'refs/heads/main',main:'1'.repeat(40),run:'401',attempt:1,account,name,zone,db,namespace,build:'2'.repeat(64),moduleHash:digest(module)};
const absent=intent(pins,now), tag=checkIntent(pins,absent), receipt=claim(pins,tag,id,tokenId,now);
const review={state:'approved',user:{id:owner},environments:[{id:7,name:gate}],comment:approvalComment(receipt)};
const authorize = () => assert.deepEqual(approved(pins,'allocate',absent,[review],7),receipt);
const initial=()=>({});
function controls(change=initial) {
  const others=Array.from({length:20},(_,i)=>({id:i.toString(16).padStart(32,'0'),name:`fixed-${i}`}));
  let worker, version;
  const calls=[];
  const cf=(role)=>async(path,body)=>{
    calls.push({role,path,body});
    const at=change({role,path,body,worker,version}); if (Object.hasOwn(at,'value')) return at.value;
    if(path===`${registry}?per_page=100`) return role==='editor'?[worker]:[...others,...(worker?[worker]:[])];
    if(path===registry && body){assert.equal(role,'owner');assert.deepEqual(body,{name,subdomain:{enabled:false,previews_enabled:false},logpush:false,observability:{enabled:false},tags:[tag]});worker={...body,id,created_on:new Date(now+1).toISOString(),deployed_on:null,references:{workers:[],domains:[],dispatch_namespace_outbounds:[],durable_objects:[],queues:[]}};return worker;}
    if(path===`${registry}/${id}` || path===`${registry}/${name}`) return worker;
    if(path.endsWith('/subdomain')) return worker.subdomain;
    if(path.endsWith('/schedules')) return {schedules:[]};
    if(path.endsWith('/secrets')) return [];
    if(path===`${registry}/${id}/versions?per_page=100`) return version?[version]:[];
    if(path===`${workers}/scripts/${name}/deployments?per_page=100`) return {deployments:version?[{versions:[{version_id:vid,percentage:100}]}]:[]};
    if(path===`${root}/tokens/verify`) return {status:'active',id:tokenId};
    if(path===`${registry}/${id}/versions?deploy=true` && body){assert.equal(role,'editor'); worker.deployed_on=new Date().toISOString();version={id:vid,...body};return version;}
    if(path===`${registry}/${id}/versions/${vid}?include=modules`) return version;
    if(path===`${root}/d1/database/${db}`) return {name,uuid:db};
    if(path===`${root}/pages/projects?per_page=1` || path===`/zones/${zone}/workers/routes` || path===`${workers}/domains?service=${name}` || path===`${registry}/${id}/previews?per_page=1`) return [];
    if(path===`/zones?account.id=${account}&per_page=50`) return [{id:zone,account:{id:account}}];
    if(path.match(/\/scripts\/fixed-\d+\/deployments\?per_page=1$/)) return {deployments:[{versions:[{version_id:vid}]}]};
    if(path.endsWith(`/versions/${vid}`)) return {id:vid,bindings:[]};
    assert.fail('unexpected endpoint or credential');
  };
  let spent=false;
  return {calls, cf, reserve:()=>reserve(cf('owner'),tag,now,()=>{assert(!spent,'spent');spent=true;}), install:()=>install(cf('editor'),receipt,module,authorize)};
}
test('fixed lifecycle: no keys, account create with BOTH privacy flags, then exactly one UUID Editor POST',async()=>{
  const t=controls();await graph(t.cf('graph'));assert.equal(await t.reserve(),id);
  await graph(t.cf('graph'),id);await noPreviews(t.cf('graph'),id);assert.equal(await t.install(),vid);await graph(t.cf('graph'),id);
  assert.deepEqual(t.calls.filter(c=>c.body).map(c=>[c.role,c.path]),[['owner',registry],['editor',`${registry}/${id}/versions?deploy=true`]]);
  await assert.rejects(t.reserve(),/already exists/);await assert.rejects(t.install(),/deployment state/);
});
test('owner absence, collision, timeout and ambiguous response are terminal; no overwrite or fallback',async()=>{
  for(const fault of ['existing','conflict','timeout','invalid','public','preview','old','redirected','missing-deployed']) {
    let writes=0;
    const t=controls(({path,body})=>{
      if(fault==='existing' && path===`${registry}?per_page=100`) return {value:Array.from({length:20},(_,i)=>({id:i.toString(16).padStart(32,'0'),name:i?`a-${i}`:name}))};
      if(path!==registry || !body) return {}; writes++;
      if(['conflict','timeout'].includes(fault)) throw Error(fault);
      return {value:{...body,id:fault==='invalid'?'':id,name:fault==='redirected'?'other':name,created_on:new Date(now+(fault==='old'?-1:1)).toISOString(),deployed_on:fault==='missing-deployed'?undefined:null,subdomain:{enabled:fault==='public',previews_enabled:fault==='preview'}}};
    });
    await assert.rejects(t.reserve());await assert.rejects(t.reserve());assert.equal(writes,fault==='existing'?0:1);assert(!t.calls.some(c=>c.path.includes('deploy=true')));
  }
});
test('graph refuses missing, partial, drifted, exposed or colliding inventory',async()=>{
  for (const [suffix,value] of [['/workers?per_page=100',[]],['/pages/projects?per_page=1',[{}]],[`/database/${db}`,{name,uuid:'other'}],[`/zones?account.id=${account}&per_page=50`,[]],['/workers/routes',[{script:name}]],[`/domains?service=${name}`,[{}]],[`/versions/${vid}`,{id:vid,bindings:[{type:'ratelimit',namespace_id:419204}]}],['/deployments?per_page=1',{}]]) {
    const t=controls(({path})=>path.endsWith(suffix)?{value}:{});
    await assert.rejects(graph(t.cf('graph')));assert(!t.calls.some(c=>c.body));
  }
  const t=controls(({path})=>path.endsWith('/previews?per_page=1')?{value:[{}]}:{});await assert.rejects(noPreviews(t.cf('graph'),id));
});
test('Editor readbacks independently fail closed before any upload',async()=>{
  for(const fault of ['scope','token','uuid','tag','preview','cron','keys','queue','versions','deployments','digest']) {
    const t=controls(({role,path,worker})=>{
      if(role!=='editor')return {};
      if(fault==='scope' && path===`${registry}?per_page=100`)return {value:[worker,{name:'another'}]};
      if(fault==='token' && path.endsWith('/tokens/verify'))return {value:{status:'active',id}};
      if(fault==='uuid' && path===`${registry}/${name}`)return {value:{...worker,id:tokenId}};
      if(fault==='tag' && path===`${registry}/${id}`)return {value:{...worker,tags:[]}};
      if(fault==='preview' && path.endsWith('/subdomain'))return {value:{enabled:false,previews_enabled:true}};
      if(fault==='cron' && path.endsWith('/schedules'))return {value:{schedules:[{}]}};
      if(fault==='keys' && path.endsWith('/secrets'))return {value:[{name:'BOT_TOKEN'}]};
      if(fault==='queue' && path===`${registry}/${id}`)return {value:{...worker,references:{...worker.references,queues:[{}]}}};
      if(fault==='versions' && path.endsWith('/versions?per_page=100'))return {value:[{}]};
      if(fault==='deployments' && path.endsWith('/deployments?per_page=100'))return {value:{deployments:[{}]}};
      return {};
    });
    await t.reserve();await assert.rejects(install(t.cf('editor'),receipt,fault==='digest'?Buffer.from('different'):module,authorize));assert(!t.calls.some(c=>c.path.includes('deploy=true')));
  }
});
test('post-write timeout and wrong live module, binding, secret or traffic never report success or retry',async()=>{
  for(const fault of ['timeout','wrong-id','module','bindings','secret','split']){
    const t=controls(({role,path,version})=>{
      if(role!=='editor')return {};
      if(path.includes('deploy=true')&&fault==='timeout')throw Error('timeout');
      if(path.includes('deploy=true')&&fault==='wrong-id')return {value:{id:''}};
      if(!version)return {};
      if(path.endsWith('?include=modules')&&['module','bindings','secret'].includes(fault))return {value:{...version,...(fault==='module'?{modules:[]}:{bindings:fault==='secret'?[...version.bindings,{type:'secret_text',name:'EXTRA'}]:[]})}};
      if(path.endsWith('/deployments?per_page=100')&&fault==='split')return {value:{deployments:[{versions:[{version_id:vid,percentage:99}]}]}};
      return {};
    });await t.reserve();await assert.rejects(t.install());assert.equal(t.calls.filter(c=>c.path.includes('deploy=true')).length,1);
  }
});
test('fresh protected receipts bind all fields, phase, owner approval, run and attempt',()=>{
  authorize();
  for(const k of Object.keys(absent))assert.throws(()=>checkIntent(pins,{...absent,[k]:'wrong'}));
  assert.throws(()=>checkIntent(pins,absent,now+3600000));assert.throws(()=>checkIntent(pins,absent,now-1));
  for(const k of Object.keys(receipt))assert.throws(()=>approved(pins,'allocate',absent,[{...review,comment:approvalComment({...receipt,[k]:'wrong'})}],7));
  for(const rows of [[],[review,review],[{...review,state:'rejected'}],[{...review,user:{id:2}}],[{...review,environments:[{id:8,name:gate}]}]])assert.throws(()=>approved(pins,'allocate',absent,rows,7));
  assert.throws(()=>ciPins({}));
  const cert = {runInvocationURI:`https://github.com/${repo}/actions/runs/401/attempts/1`,buildTrigger:'workflow_dispatch',sourceRepositoryIdentifier:'1229775730',sourceRepositoryOwnerIdentifier:String(owner)};
  const signed = c=>[{verificationResult:{signature:{certificate:c}}}];
  certifiedRun(signed(cert),'401');assert.throws(()=>certifiedRun(signed(cert),'402'));assert.throws(()=>certifiedRun([], '401'));
  for(const k of Object.keys(cert))assert.throws(()=>certifiedRun(signed({...cert,[k]:'wrong'}),'401'));
});
test('enrollment validates authenticated policy, not the token name or a successful verify',()=>{
  const roles=new Map([['e','Individual Workers Editor'],['a','Workers Scripts Write'],['r','Workers Scripts Read'],['p','Pages Read'],['d','D1 Read'],['z','Zone Read'],['s','Workers Routes Read']]);
  const scoped=(groups,resources)=>({effect:'allow',permission_groups:groups.map(id=>({id})),resources});
  const act=`com.cloudflare.api.account.${account}`, cz='com.cloudflare.api.account.zone.';
  const check=(policies,workerId)=>policy({id:tokenId,status:'active',policies},tokenId,roles,workerId);
  const onlyWorker=scoped(['e'],{[act]:{[`com.cloudflare.api.account.worker.${id}`]:'*'}});
  const bootstrap={id:tokenId,status:'active',policies:[scoped(['a'],{[act]:'*'})]};
  bootstrapPolicy(bootstrap,tokenId,roles);
  for(const policies of [[],[onlyWorker],[...bootstrap.policies,onlyWorker],[scoped(['a','d'],{[act]:'*'})],[scoped(['a'],{'com.cloudflare.api.account.*':'*'})]])assert.throws(()=>bootstrapPolicy({...bootstrap,policies},tokenId,roles));
  check([onlyWorker],id);const graphRoles=[scoped(['r','p','d'],{[act]:'*'}),scoped(['z'],{[act]:{[cz+'*']:'*'}}),scoped(['s'],{[cz+zone]:'*'})]; check(graphRoles);
  for (const other of [scoped(['a'],{[act]:'*'}),scoped(['e'],{[act]:'*'}),scoped(['e'],{[act]:{'*':'*'}}),scoped(['e'],{[act]:{[id]:'*',[tokenId]:'*'}})])assert.throws(()=>check([other],id));
  assert.throws(()=>check([scoped(['e'],{[act]:{[`unexpected.${id}`]:'*'}})],id));
  assert.throws(()=>check([onlyWorker],tokenId));assert.throws(()=>check([...graphRoles,scoped(['a'],{[act]:'*'})]));assert.throws(()=>check(graphRoles.slice(1)));
});
test('graph replays sanitized live envelopes including historical deployment pages', async()=>{
  const path=`${registry}?per_page=100`, fixture=controls(), rows=await fixture.cf('graph')(path);
  const info={page:1,per_page:100,count:20,total_count:20};
  const wire={result:rows,success:true,errors:null,messages:null,result_info:info};
  const history=[3,3,1,13,64,8,4,38,5,73,17,134,14,8,5,40,64,81,11,3];
  const bindingCounts=[5,1,4,20,2,3,8,19,16,14,17,21,9,9,7,9,9,9,8,7];
  const limits=[0,0,0,1,0,0,2,0,0,0,0,1,2,1,0,0,2,2,0,1];
  const run=(delta,mutate=()=>{})=>graph(client('synthetic',async(url,{method})=>{
    assert.equal(method,'GET');
    const endpoint=url.slice('https://api.cloudflare.com/client/v4'.length);
    if(endpoint===path)return Response.json({...wire,...delta});
    let result=await fixture.cf('graph')(endpoint);
    const body={success:true,errors:[],messages:[]};
    const page=(per_page,count,total_count,total_pages)=>({page:1,per_page,count,total_count,...(total_pages===undefined?{}:{total_pages})});
    if(endpoint.includes('/pages/projects?')) body.result_info=page(1,0,0,0);
    if(endpoint.startsWith('/zones?')) body.result_info=page(50,1,1,1);
    if(endpoint.endsWith('/workers/routes')) result=Array.from({length:3},(_,j)=>({id:j.toString().padStart(32,'0'),pattern:`example.invalid/${j}`,script:'other'}));
    if(endpoint.includes('/domains?')) Object.assign(body,{errors:null,messages:null,result_info:page(0,0,0)});
    if(endpoint.endsWith('/deployments?per_page=1')) {
      const total=history[Number(endpoint.match(/fixed-(\d+)/)[1])];
      body.result_info=page(1,1,total,total);
    }
    if(endpoint.endsWith(`/versions/${vid}`)) {
      const index=parseInt(endpoint.split('/').at(-3),16);
      result={id:vid,bindings:Array.from({length:bindingCounts[index]},(_,j)=>j<limits[index]?{type:'ratelimit',namespace_id:'1'}:{type:'plain_text'})};
    }
    body.result=result; mutate(endpoint,body);
    return Response.json(body);
  }));
  await run({});await run({errors:[],messages:[]});
  for(const delta of [{success:false},{errors:[{code:1234}]},{errors:undefined},{messages:undefined},{messages:[]},{errors:{}},
    {result:null},{result:{}},{result_info:null},{result_info:undefined},
    ...[{page:2},{per_page:10},{count:19},{total_count:21},{total_count:undefined},{total_pages:2},{total_pages:null}].map(v=>({result_info:{...info,...v}})),
    ...[{id:rows[1].id},{name:rows[1].name},{name:undefined},{name:null},{id:'wrong'}].map(v=>({result:[{...rows[0],...v},...rows.slice(1)]}))]) await assert.rejects(run(delta));
  for(const suffix of ['/pages/projects?per_page=1',`account.id=${account}&per_page=50`,`/domains?service=${name}`,'/deployments?per_page=1']) {
    for(const bad of [undefined,null,{page:2},{count:-1},{per_page:-1},{cursor:'next'},{total_count:-1},{total_pages:999}])
      await assert.rejects(run({},(p,b)=>{if(p.endsWith(suffix)) b.result_info=bad==null?bad:{...b.result_info,...bad};}));
  }
  for(const suffix of [`/domains?service=${name}`,'/deployments?per_page=1',`/versions/${vid}`]) {
    for(const bad of [{success:false},{errors:[{}]},{errors:undefined},{result:null}])
      await assert.rejects(run({},(p,b)=>{if(p.endsWith(suffix)) Object.assign(b,bad);}));
  }
});
test('beta read variant is bounded by method, path, list completeness and resource shape',async()=>{
  const wire={success:true,errors:null,messages:null}, cf=(body,postPath)=>client('synthetic',async()=>Response.json({...wire,...body}),postPath);
  for(const [suffix,per_page] of [['versions?per_page=100',100],['previews?per_page=1',1]]) {
    const p=`${registry}/${id}/${suffix}`, result_info={page:1,per_page,count:0,total_count:0};
    assert.deepEqual(await cf({result:[],result_info})(p),[]);
    const canonical={result:[],result_info,errors:[],messages:[]};
    assert.deepEqual(await cf(canonical)(p),[]);
    for(const extra of [{total_count:1},{page:2},{count:1}]) await assert.rejects(cf({...canonical,result_info:{...result_info,...extra}})(p));
  }
  for(const p of [`${registry}/${name}`,`${registry}/${id}`,`${registry}/${id}/versions/${vid}`,`${registry}/${id}/versions/${vid}?include=modules`]){
    assert.deepEqual(await cf({result:{id}})(p),{id});
    const canonical={errors:[],messages:[],result:{id}};
    assert.deepEqual(await cf(canonical)(p),{id});
    for(const result of [[],null,''])await assert.rejects(cf({...canonical,result})(p));
    await assert.rejects(cf({...canonical,result_info:{}})(p));
  }
  for(const p of [`${root}/tokens/verify`,`${registry}/${id}/versions/latest`,`${registry}?per_page=10`])await assert.rejects(cf({result:[]})(p));
  for(const p of [registry,`${registry}/${id}/versions?deploy=true`])await assert.rejects(cf({result:{id}},p)(p,{}));
  for(const v of [{id,bindings:[]},{id:vid},{id:vid,bindings:[{}]},{id:vid,bindings:[{type:'ratelimit'}]},{id:vid,bindings:[{type:'ratelimit',namespace_id:namespace}]}]){
    await assert.rejects(graph(controls(({path})=>path.endsWith(`/versions/${vid}`)?{value:v}:{}).cf('graph')));
  }
});
test('fixed transport never logs bodies or keys, follows redirects or retries',async()=>{
  assert.throws(()=>client(''));let n=0;
  const cf=client('synthetic-not-a-key',async(url,opts)=>{n++;assert.equal(opts.redirect,'error');assert.equal(new URL(url).origin,'https://api.cloudflare.com');return new Response('sensitive error',{status:403});});
  await assert.rejects(cf(registry,{}),/phase capability/);assert.equal(n,0);
  await assert.rejects(cf(registry),e=>e.message==='provider GET HTTP 403; no retry');assert.equal(n,1);
  await assert.rejects(cf('/accounts/other/workers/workers'));assert.equal(n,1);
  for(const value of ['invalid',{success:false},{success:true,result:[],errors:[],result_info:{count:1,total_count:2}}])await assert.rejects(client('fixed',async()=>new Response(JSON.stringify(value)))(registry));
});
test('source guard: incident CI has only read and per-Worker credentials, never owner or shared credentials',()=>{
  const files=readdirSync('.github/workflows');for(const file of files)assert.doesNotMatch(readFileSync(`.github/workflows/${file}`,'utf8'),/CF_INCIDENT_INSTALL_TOKEN/);
  for(const file of files.filter(f=>!workflow.endsWith('/'+f))) assert.doesNotMatch(readFileSync(`.github/workflows/${file}`,'utf8'),/secrets\.CF_INCIDENT_/i);
  const text=readFileSync(workflow,'utf8');assert.doesNotMatch(text,/secrets\[|secrets:\s*inherit|toJSON\(\s*secrets|incident-owner\.mjs/i);
  assert.doesNotMatch(text.replaceAll('secrets.CF_INCIDENT_GRAPH_READ','').replaceAll('secrets.CF_INCIDENT_WORKER_EDITOR',''),/\bsecrets\b/i);
  assert.deepEqual([...text.matchAll(/\bsecrets\.(\w+)/g)].map(m=>m[1]).sort(),['CF_INCIDENT_GRAPH_READ','CF_INCIDENT_WORKER_EDITOR']);
  const {jobs}=JSON.parse(execFileSync('ruby',['-ryaml','-rjson','-e','print JSON.generate(YAML.safe_load(STDIN.read, aliases: true))'],{input:text,encoding:'utf8'}));
  assert.equal(jobs.prepare.environment,undefined);assert(!JSON.stringify(jobs.prepare).includes('secrets.'));assert.deepEqual(jobs['owner-reservation'].permissions,{});
  for(const [job,v] of Object.entries(jobs)) {
    for(const s of v.steps){if(s.uses)assert.match(s.uses,/@[0-9a-f]{40}$/);const secrets=JSON.stringify(s).match(/secrets\.\w+/g)??[];
      if(secrets.length){assert.deepEqual(secrets,[job==='install'?'secrets.CF_INCIDENT_WORKER_EDITOR':'secrets.CF_INCIDENT_GRAPH_READ']);assert.match(s.run,new RegExp(`node scripts/ci/install-incident-inert.mjs ${job}(?:\\n|$)`));}}
  }
  const env={can_admins_bypass:false,protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{id:owner}}]}],deployment_branch_policy:{custom_branch_policies:true}};
  const branches={total_count:1,branch_policies:[{type:'branch',name:'main'}]};protection(env,branches);
  assert.throws(()=>protection({...env,can_admins_bypass:true},branches));assert.throws(()=>protection(env,{...branches,total_count:2}));
});
