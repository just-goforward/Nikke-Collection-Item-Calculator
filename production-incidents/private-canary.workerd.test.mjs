import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Miniflare} from 'miniflare';
import {oldEvidence,seedSeal} from './canary-fixture.mjs';
import {successorBuild} from './sealed-successor.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const admin='1'.repeat(18), channel='2'.repeat(18);
const schema=readFileSync(new URL('schema.sql',import.meta.url),'utf8').replaceAll('\n',' ');

test('generated one-shot canary uses local workerd fetch and local D1 only',async t=>{
  const tmp=mkdtempSync(join(tmpdir(),'incident-runtime-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  execFileSync('bash',['scripts/ci/bundle-private-canary.sh',tmp],{cwd:root,env:{PATH:process.env.PATH,HOME:tmp,CI:'true',INCIDENT_CANARY_END:String(Math.floor(Date.now()/1000)+1800)}});
  const contents=readFileSync(join(tmp,'private-canary.js'),'utf8');
  const open='/api/v10/users/@me/channels', post=`/api/v10/channels/${channel}/messages`;
  const okChannel=()=>Response.json({type:1,id:channel,recipients:[{id:admin}]});
  const okMessage=async req=>Response.json({id:'3'.repeat(18),channel_id:channel,nonce:(await req.json()).nonce});
  const redirect=()=>Response.redirect('https://never-follow.invalid/',307);
  const status=code=>()=>new Response(null,{status:code});
  // Each scenario gets a fresh database. Only a local handler can receive any
  // subrequest, including a mistakenly followed Location after either POST.
  const cases=[
    ['verified',okChannel,okMessage,'sent',false],
    ['channel redirect',redirect,null,'blocked',false],
    ['channel unauthorized',status(401),null,'blocked',false],
    ['channel busy',status(503),null,'blocked',true],
    ['channel malformed JSON',()=>new Response('{'),null,'blocked',true],
    ['recipient omitted',()=>Response.json({type:1,id:channel}),null,'blocked',false],
    ['recipient mismatch',()=>Response.json({type:1,id:channel,recipients:[{id:channel}]}),null,'blocked',false],
    ['message redirect',okChannel,redirect,'blocked',false],
    ['message forbidden',okChannel,status(403),'blocked',false],
    ['message rate limited',okChannel,status(429),'blocked',true],
    ['message server failure',okChannel,status(503),'uncertain',false],
    ['message receipt missing',okChannel,()=>Response.json({}),'uncertain',false],
  ];
  for(const [name,create,message,state,sealedRetry] of cases) await t.test(name,async()=>{
    const dir=mkdtempSync(join(tmp,'case-'));
    const calls=[];
    const handler=req=>{
      const url=new URL(req.url);
      calls.push([url.origin,url.pathname,req.method]);
      if(url.origin==='https://discord.com' && url.pathname===open)return create(req);
      if(url.origin==='https://discord.com' && url.pathname===post && message)return message(req);
      return new Response(null,{status:418});
    };
    const vars={PUBLIC_INGRESS:'0',INCIDENT_BUILD:successorBuild,ADMIN_ID:admin,BOT_TOKEN:'fixture'};
    const mf=new Miniflare({
      host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},unsafeRuntimeEnv:{},resourceTmpPath:dir,
      workers:[{
        config:{
          name:'canary-test',compatibilityDate:'2026-08-14',
          manifest:{mainModule:'worker.js',modulesRoot:root,modules:{'worker.js':{type:'esm',contents}}},
          env:{...Object.fromEntries(Object.entries(vars).map(([k,value])=>[k,{type:'text',value}])),INCIDENT_DB:{type:'d1',name:'test-db'}},
        },
        dev:{rootPath:dir,unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler}},
      }],
    });
    try {
      const db=await mf.getD1Database('INCIDENT_DB');await db.exec(schema);
      await db.exec(seedSeal);const before=(await db.prepare(oldEvidence).all()).results;
      const worker=await mf.getWorker();
      for(let i=0;i<2;i++)await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.now()});
      const {results}=await db.prepare('SELECT build,reason,stage,state,attempts,next FROM notifications WHERE build=?').bind(successorBuild).all();
      assert.equal(results.length,1);const {next,...row}=results[0];
      assert.deepEqual(row,{build:successorBuild,reason:'canary',stage:'private',state,attempts:1});
      assert.equal(sealedRetry?next>=Math.floor(Date.now()/1000)+3590:next===0,true);
      assert.deepEqual((await db.prepare(oldEvidence).all()).results,before);
      assert.deepEqual(calls,(message?[open,post]:[open]).map(path=>['https://discord.com',path,'POST']));
    } finally {await mf.dispose();}
  });
});
