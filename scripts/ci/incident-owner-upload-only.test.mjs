import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkedCheckout, checkedMain, executeUpload} from './incident-owner-upload-only.mjs';
import {baseline, failed, script, target} from './incident-canary-control.mjs';
import {account, bindings, client, db, digest, name, namespace, registry, root, zone} from './incident-provider.mjs';
import {original} from './incident-recovery-id.mjs';
import {serviceBuild, successorBuild} from '../../production-incidents/sealed-successor.ts';

const trial = 'a7a44718-3df0-4516-a3fa-ebced4038b9f', restored = 'b87e67ae-d1c2-455a-b7c9-e33126c91e57';
const candidate = 'abcd1234-abcd-abcd-abcd-123456789abc';
const knownIds = [baseline.version, baseline.partial, baseline.donor, failed.version, trial];
const rows = [[restored,baseline.version],['de7ca80b-dd35-47e3-a218-4cee7b05890c',trial],
  ['5dadd20e-0a39-41c1-863e-b5dc0329b972',baseline.version],[failed.deployment,failed.version],[baseline.deployment,baseline.version]];
const tmp = mkdtempSync(join(tmpdir(),'owner-upload-test-')), cwd = fileURLToPath(new URL('../../production-incidents/',import.meta.url));
const bundles = {};
before(() => {
  // Real public, inert and expiring private module pins. No credentials, Worker URL,
  // remote binding or config deployment. The transport used below is entirely local.
  const env = {PATH:process.env.PATH,HOME:tmp,WRANGLER_SEND_METRICS:'false',INCIDENT_CANARY_END:'1795448388',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'};
  for (const [phase,file,hash] of [['inert','worker.js',baseline.module],
    ['canary','private-canary.js','abfdaf31352409a747917ade12e6dd5fbbbac9a76cde214d65ec9849957eec00'],
    ['public','worker.js','924bc0aa4ddb4c37351b4551c2d55696c5d0c50e14bef355d605a4af4109ed17']]) {
    const cfg = join(cwd,`.upload-test-${process.pid}-${phase}.json`), out = join(tmp,phase);
    try {
      const config = execFileSync(process.execPath,['config.mjs',phase,db,namespace,serviceBuild],{cwd,env});
      writeFileSync(cfg,config,{flag:'wx'});
      execFileSync(process.execPath,['../node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config',cfg,'--outdir',out],{cwd,env,stdio:'pipe'});
      bundles[phase] = readFileSync(join(out,file)); assert.equal(digest(bundles[phase]),hash);
    } finally { rmSync(cfg,{force:true}); }
  }
});
after(() => rmSync(tmp,{recursive:true,force:true}));

test('credential cleanup preserves standard descriptors for a later synchronous spawn',()=>{
  const helper = new URL('./incident-owner-upload-only.mjs',import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {fstatSync, readSync} from 'node:fs';
    import {privateInput} from ${JSON.stringify(helper)};
    const stdin = fstatSync(0);
    assert.equal(privateInput(3),'dummy_policy');
    assert.throws(()=>fstatSync(3),{code:'EBADF'});
    assert.throws(()=>privateInput(4),/invalid credential descriptor/);
    assert.throws(()=>fstatSync(4),{code:'EBADF'});
    if (process.argv[1] === 'invalid') assert.throws(()=>privateInput(0),/invalid credential descriptor/);
    else assert.equal(privateInput(0),'dummy_editor');
    const remaining = fstatSync(0);
    assert.deepEqual([remaining.dev,remaining.ino],[stdin.dev,stdin.ino]);
    assert.equal(readSync(0,Buffer.alloc(1),0,1,null),0);
    fstatSync(1);
    fstatSync(2);
    const output = execFileSync(process.execPath,['--eval','process.stdout.write("spawned")'],{
      encoding:'utf8',env:{},stdio:['ignore','pipe','pipe'],timeout:10000
    });
    assert.equal(output,'spawned');
    process.stdout.write(output);
  `;
  for (const stdin of ['valid','invalid']) {
    const inputs = [];
    try {
      for (const [i,text] of [stdin==='valid'?'dummy_editor\n':'!invalid\n','dummy_policy\n','!invalid\n'].entries()) {
        const file = join(tmp,`fd-${stdin}-${i}`);
        writeFileSync(file,text,{flag:'wx',mode:0o600});
        inputs.push(openSync(file,'r'));
      }
      assert.equal(execFileSync(process.execPath,['--input-type=module','--eval',probe,stdin],{
        encoding:'utf8',env:{},stdio:[inputs[0],'pipe','pipe',inputs[1],inputs[2]],timeout:15000
      }),'spawned');
    } finally {
      for (const fd of inputs) closeSync(fd);
    }
  }
});

function fixture(fault) {
  const dir = mkdtempSync(join(tmp,'state-')), marker = join(dir,`${original.workerId}.json`);
  const others = Array.from({length:20},(_,i)=>({id:i.toString(16).padStart(32,'0'),name:`other-${i}`}));
  const calls = []; let posted=false, writes=0;
  const worker = {id:original.workerId,name,created_on:original.createdOn,deployed_on:original.createdOn,tags:[original.tag],
    logpush:false,observability:{enabled:false},tail_consumers:[],subdomain:{enabled:false,previews_enabled:false},
    references:{workers:[],domains:[],dispatch_namespace_outbounds:[],durable_objects:[],queues:[]}};
  const pub = bindings(serviceBuild).map(b=>b.name==='PUBLIC_INGRESS'?{...b,text:'1'}:b);
  const inherited = ['ADMIN_ID','BOT_TOKEN'].map(name=>({name,type:'inherit',version_id:baseline.donor}));
  function row(id) {
    assert.ok([baseline.version,baseline.donor,trial,candidate].includes(id));
    const phase = id===trial?'canary':id===candidate?'public':'inert', main=phase==='canary'?'private-canary.js':'worker.js';
    const names = id===baseline.version?[]:['ADMIN_ID','BOT_TOKEN'];
    if (fault==='wrong donor' && id===baseline.donor || fault==='lost secret' && id===candidate) names.pop();
    const b = (phase==='public' && fault!=='canary bindings'?pub:bindings(phase==='canary'||fault==='canary bindings'&&id===candidate?successorBuild:serviceBuild))
      .map(x=>x.type==='d1'?{...x,database_id:db}:x).concat(names.map(name=>({name,type:'secret_text'})));
    const bytes = id===candidate&&fault==='different bytes'?bundles.canary:bundles[phase];
    const v = {id,compatibility_date:'2026-08-14',main_module:main,usage_model:'standard',urls:id===candidate&&fault==='version URL'?['test.invalid']:[],
      modules:[{name:main,content_type:'application/javascript+module',content_base64:bytes.toString('base64')}],bindings:b,
      env:Object.fromEntries(b.map(({name,...rest})=>[name,rest]))};
    if (id===candidate && fault==='extra env') v.env.EXTRA={type:'plain_text',text:'unexpected'};
    return v;
  }
  function serve(path) {
    if (path===target || path===`${registry}/${name}`) return [worker];
    if (path===`${script}/subdomain`) return [worker.subdomain];
    if (path===`${script}/schedules`) return [{schedules:fault==='cron'?[{cron:'*/5 * * * *'}]:[]}];
    if ([`${script}/deployments?per_page=1`,`${script}/deployments?per_page=100`].includes(path)) {
      const history=structuredClone(rows);
      if(fault==='four versions era') history.splice(0,2);
      if(fault==='wrong restoration') history[0][0]=candidate;
      if(fault==='post deployment drift'&&posted) history[0][1]=candidate;
      if(fault==='reordered predecessor') history.reverse();
      if(fault==='wrong earlier restoration') history[2][0]=candidate;
      const latest=path.endsWith('=1'), all=history.map(([id,version_id])=>({id,versions:[{version_id,percentage:100}]}));
      if(fault==='split') all[0].versions=[{version_id:baseline.version,percentage:99},{version_id:trial,percentage:1}];
      return [{deployments:latest?all.slice(0,1):all},latest?1:100,latest?1:all.length,all.length];
    }
    if(path===`${target}/versions?per_page=100`) {
      const ids=knownIds.slice(); if(fault==='missing successor') ids.pop();
      if(fault==='same count wrong ID') ids[1]=candidate;
      if(posted && fault!=='no visible result') ids.push(candidate);
      if(posted && fault==='extra version') ids.push('11111111-2222-3333-4444-555555555555');
      return [ids.map(id=>({id})),100,ids.length,ids.length+(fault==='truncated list'?1:0)];
    }
    if(path.startsWith(`${target}/versions/`) && path.endsWith('?include=modules')) return [row(path.split('/').pop().split('?')[0])];
    if(path===`${registry}?per_page=100`) return [[...others,worker],100,others.length+1];
    if(path===`${root}/d1/database/${db}`) return [{name,uuid:db}];
    if(path===`${root}/pages/projects?per_page=1`) return [[],1,0];
    if(path===`/zones?account.id=${account}&per_page=50`) return [[{id:zone,account:{id:account}}],50,1];
    if(path===`/zones/${zone}/workers/routes`) return [fault==='route'?[{id:'0'.repeat(32),pattern:'example.test/*',script:name}]:[]];
    if(path===`${target}/previews?per_page=1`) { const a=posted&&fault==='new preview'?[{}]:[]; return [a,1,a.length]; }
    if(path.endsWith(`/domains?service=${name}`)) return [[],0,0];
    if(/\/scripts\/other-\d+\/deployments\?per_page=1$/.test(path)) return [{deployments:[{id:restored,versions:[{version_id:baseline.version,percentage:100}]}]},1,1];
    if(others.some(w=>path===`${registry}/${w.id}/versions/${baseline.version}`)) return [{id:baseline.version,bindings:[]}];
    assert.fail(`unexpected read ${path}`);
  }
  const send = async (url,options)=>{
    assert.equal(new URL(url).origin,'https://api.cloudflare.com');assert.equal(options.redirect,'error');
    const path=url.slice('https://api.cloudflare.com/client/v4'.length);calls.push([options.method,path]);
    if(options.method==='GET') {
      assert.equal(options.headers.authorization,'Bearer offline-reader');
      const [result,per_page,count,total_count=count]=serve(path);
      const result_info=per_page===undefined?undefined:{page:1,per_page,count,total_count,total_pages:per_page>0?Math.ceil(total_count/per_page):0};
      return Response.json({success:true,errors:[],messages:[],result,result_info});
    }
    writes++;assert.equal(writes,1);assert.equal(options.method,'POST');assert.equal(path,`${target}/versions?deploy=false`);
    assert.equal(options.headers.authorization,'Bearer offline-editor');assert.equal(JSON.parse(readFileSync(marker)).phase,'attempt-consumed');
    assert.deepEqual(JSON.parse(options.body),{main_module:'worker.js',compatibility_date:'2026-08-14',compatibility_flags:[],bindings:[...pub,...inherited],
      modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:bundles.public.toString('base64')}]});
    // The provider might create a version even though the response never arrives.
    posted=fault!=='no visible result';
    if(fault==='lost ACK'||fault==='no visible result') throw Error('connection lost');
    if(fault==='invalid ACK') return Response.json({success:true,errors:[{}],messages:[],result:{id:candidate}});
    if(fault==='old ID') return Response.json({success:true,errors:null,messages:null,result:{id:trial}});
    return Response.json({success:true,errors:null,messages:null,result:{id:candidate}});
  };
  const run=()=>executeUpload({module:fault==='wrong pin'?bundles.canary:bundles.public,until:Math.floor(Date.now()/1000)+900,
    read:client('offline-reader',send),token:'offline-editor',dir,send,head:'a'.repeat(40),
    requireSource:()=>assert.notEqual(fault,'main moved')});
  return {run,calls,marker,writes:()=>writes};
}

test('only one inactive public version, independently verified against actual bundled bytes and unchanged private graph',async()=>{
  const f=fixture();const v=await f.run();assert.equal(v.phase,'inactive-upload-verified');assert.equal(v.candidate,candidate);assert.equal(v.deployment,restored);
  assert.deepEqual(JSON.parse(readFileSync(`${f.marker}.ack`)),{candidate});
  await assert.rejects(f.run());assert.equal(f.writes(),1);
});
for (const fault of ['wrong pin','four versions era','wrong restoration','wrong earlier restoration','reordered predecessor','split',
  'missing successor','same count wrong ID','truncated list','cron','route','wrong donor','main moved']) test(`no write: ${fault}`,async()=>{
  const f=fixture(fault);await assert.rejects(f.run());assert.equal(f.writes(),0);assert.equal(existsSync(f.marker),false);
});
for (const fault of ['lost ACK','no visible result','invalid ACK','old ID','lost secret','canary bindings','different bytes','extra env',
  'version URL','new preview','extra version','post deployment drift']) test(`consumed; no deploy or replay: ${fault}`,async()=>{
  const f=fixture(fault);await assert.rejects(f.run());assert.equal(f.writes(),1);assert.ok(existsSync(f.marker));
  const writes=f.calls.findIndex(([m])=>m==='POST');assert.ok(f.calls.slice(writes+1).some(([m,p])=>m==='GET' && p.startsWith(`${script}/deployments?`)));
  await assert.rejects(f.run());assert.equal(f.writes(),1);
});
test('two concurrent invocations sharing the owner journal cannot issue two POSTs',async()=>{
  const f=fixture();const outcomes=await Promise.allSettled([f.run(),f.run()]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.writes(),1);
});

test('source repair checkout requires the exact first parent, clean tree and complete three-file diff',()=>{
  const parent = 'c5166082294a10fcee82b32eef62e3bf86a9ba1e';
  const files = ['production-incidents/RUNBOOK.ko.md','scripts/ci/incident-owner-upload-only.mjs',
    'scripts/ci/incident-owner-upload-only.test.mjs'];
  for (const fault of ['none','historical parent','dirty','untracked','missing file','extra file']) {
    const git = (...args) => {
      if (args[0] === 'rev-parse') {
        assert.deepEqual(args,['rev-parse','HEAD^']);
        return fault==='historical parent'?'3677b9bd19669172b82afea497b996234cc19c2d':parent;
      }
      if (args[0] === 'status') {
        assert.deepEqual(args,['status','--porcelain','--untracked-files=normal']);
        return fault==='dirty'?` M ${files[0]}`:fault==='untracked'?'?? other-file':'';
      }
      assert.deepEqual(args,['diff','--name-only',parent,'HEAD']);
      return (fault==='missing file'?files.slice(1):fault==='extra file'?[...files,'.github/workflows/site-source-verify.yml']:files).join('\n');
    };
    if (fault==='none') checkedCheckout(git);
    else assert.throws(()=>checkedCheckout(git),/^Error: unreviewed checkout$/,fault);
  }
});

test('only the merged signed protected head with its successful push workflow and offline step is eligible',()=>{
  const head='a'.repeat(40), id=1229775730, repository={id};
  for (const fault of ['none','moved','unsigned','no PR','PR-side CI','another SHA','foreign repository','wrong workflow','in progress','skipped test']) {
    const query=path=>{
      if(path==='branches/main') return {protected:true,commit:{sha:fault==='moved'?'b'.repeat(40):head}};
      if(path===`commits/${head}`) return {commit:{verification:{verified:fault!=='unsigned'}}};
      if(path===`commits/${head}/pulls`) return fault==='no PR'?[]:[{merged_at:'2026-11-23',merge_commit_sha:head,base:{ref:'main',repo:repository}}];
      if(path===`actions/workflows/site-source-verify.yml/runs?branch=main&event=push&head_sha=${head}&per_page=1`) return {workflow_runs:[{
        id:10,run_attempt:2,head_sha:fault==='another SHA'?'b'.repeat(40):head,head_branch:'main',repository,
        head_repository:fault==='foreign repository'?{id:1}:repository,event:fault==='PR-side CI'?'pull_request':'push',
        path:fault==='wrong workflow'?'other':'.github/workflows/site-source-verify.yml',status:fault==='in progress'?'in_progress':'completed',conclusion:'success'}]};
      assert.equal(path,'actions/runs/10/attempts/2/jobs?per_page=100');
      return {total_count:1,jobs:[{name:'Site source prerequisites',conclusion:'success',steps:[
        {name:'Verify post-successor inactive upload only (offline)',conclusion:fault==='skipped test'?'skipped':'success'}]}]};
    };
    if(fault==='none') checkedMain(head,query); else assert.throws(()=>checkedMain(head,query),undefined,fault);
  }
});
