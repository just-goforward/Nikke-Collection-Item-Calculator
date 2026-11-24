import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, hash } from 'node:crypto';
import { observeRum } from './root-rum-policy.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import { assertSiteUploadApproved } from '../deploy-site.ts';
import { childEnvironment } from './run-checked-command.mjs';
import { operations, paths, readTransition, requireLiveCustody, root, verifyPackages } from './root-promotion-custody.mjs';
import { account, assertStartingState, confirmLineage, freshProducer, hostname, observeSite, served, site, versionMessage } from './root-promotion-live.mjs';
import { regionalBrowsers, witnessPair } from './root-promotion-browser.mjs';

// Sequencing only; this function has no credentials and cannot itself issue a write.
export async function transition(g, c, io) {
  assert(!g.reconcile && g.operation!=='root-abandon-bridge','read-only operation');
  assert.equal(c.role,operations[g.operation]);assert.equal(c.manifest,c.h.directions[c.role].manifestSha256);
  if(g.operation!=='root-install-bridge')assert(g.bridge,'verified BRIDGE_READY required');
  const startHeaders=g.operation==='root-install-bridge'?'0c713a5d956b36052396b0bdf21034caa04ad14bf11fce83a5240f032b208407':c.pair.files.headersSha256;
  const start=await io.observe();assertStartingState(g,start,c.h);assert.equal(start.headersSha256,startHeaders,'prior active headers changed');
  if (g.operation==='root-install-bridge') await io.served('rollback',true);
  if (g.operation==='root-activate-forward') await io.served('rollback',false);
  const restoring = g.operation === 'root-restore-rollback';
  const preflight = await io.browser(restoring ? 'forward' : 'rollback',restoring ? 'restore-preflight' : 'full');
  assert.match(g.previewSha256,/^[0-9a-f]{64}$/);
  for(const r of preflight) assert.equal(hash('sha256',JSON.stringify(r.previews)),g.previewSha256,'protected preview differs from approved documents or headers');
  const [before,head,preConfig]=await Promise.all([io.observe(),io.head(),io.rum(),io.main()]);
  assertStartingState(g,before,c.h); io.checkRestored();
  assert.deepEqual(before,start,'active control changed during preflight');
  assert.equal(before.headersSha256,startHeaders,'prior active headers changed');
  assert(head.sequence>=g.minimumProducerSequence,'producer below independently approved floor');
  assert(Date.now()<Math.min(c.expiresAt,head.expiresAt),'approval or signed producer lease expired before write');
  const message=versionMessage(c.role,c.manifest),version=io.publish(message);
  assert.match(version,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,'missing acknowledged Wrangler version');
  assert.notEqual(version,before.version);
  return {version,before,head,preConfig,preflight};
}

const witnessIdentity=reports=>reports.map(r=>[r.egress,r.egressId,r.runnerSha256,r.previews]);

// No write function or write credential in this phase. Eventual propagation may only retry reads.
export async function confirmTransition(g,c,ack,io,pause=delay) {
  const {version,before,head,preConfig,preflight}=ack;
  assertStartingState(g,before,c.h);assert.equal(preConfig.configSha256,g.rumConfigSha256);
  const message=versionMessage(c.role,c.manifest);
  for(const ms of [0,1000,3000]) {
    if(ms)await pause(ms);
    assert(Date.now()<c.expiresAt,'confirmation approval expired');
    const post=await io.observe();
    if(ms!==3000 && post.version===before.version && post.deployment===before.deployment){assert.deepEqual(post,before);continue;}
    assert.equal(post.version,version,'live version differs from write ACK');assert.notEqual(post.version,before.version);
    if(g.reconcile)assert.equal(post.deployment,g.reconcile.deployment);await io.lineage(before,post);assert.notEqual(post.deployment,before.deployment);
    assert.deepEqual(post.incident,before.incident,'active incident deployment, version or build changed');
    assert.equal(post.annotations['workers/tag'],g.source);assert.equal(post.annotations['workers/message'],message);assert.equal(post.controlSha256,g.controlSha256);
    assert.equal(post.headersSha256,c.pair.files.headersSha256,'deployed asset headers differ from seal');
    await io.served(c.role,false);
    const postflight = await io.browser(c.role,'full');
    assert.deepEqual(witnessIdentity(postflight),witnessIdentity(preflight),'regional runner or protected preview changed');
    const [end,fresh,postConfig]=await Promise.all([io.observe(),io.head(),io.rum()]);assert.deepEqual(end,post);assert(fresh.sequence>=Math.max(head.sequence,g.minimumProducerSequence));
    assert.deepEqual(postConfig.config,preConfig.config,'effective RUM settings changed across switch');
    await io.lineage(before,end);
    assert(Date.now()<Math.min(c.expiresAt,fresh.expiresAt),'expired before final receipt');
    return {end,fresh,preflight,postflight,preConfig,postConfig,state:g.operation==='root-install-bridge'?'BRIDGE_READY':c.role==='forward'?'FORWARD_ACTIVE':'ROLLBACK_ACTIVE'};
  }
}

export function readWriteCheckpoint(file,identity,pin){
  const body=readFileSync(file);if(pin!==undefined)assert.equal(hash('sha256',body),pin,'unreviewed write checkpoint bytes');
  const record=JSON.parse(body);assert.deepEqual(record.identity,identity,'write checkpoint from another operation, run, or seal');
  assert.match(record.ack.version,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  return record.ack;
}

// Abandoning a never-left bridge does not deploy anything. BRIDGE_READY alone is not an exit.
export async function confirmBridgeExit(g,c,io,bridgeAck){
  assert.equal(g.operation,'root-abandon-bridge');assert(!g.reconcile && (g.bridge ? !g.bridgeWrite && !bridgeAck : g.bridgeWrite && bridgeAck));assert.equal(c.role,'rollback');
  const before=await io.observe();assertStartingState(g,before,c.h);
  assert.equal(before.headersSha256,c.pair.files.headersSha256);assert.equal(c.manifest,c.h.directions.rollback.manifestSha256);
  const [head,preConfig]=await Promise.all([io.head(),io.rum()]);assert(head.sequence>=g.minimumProducerSequence);
  if(bridgeAck){
    assert.equal(bridgeAck.version,before.version);assert.notEqual(bridgeAck.before.deployment,before.deployment);
    assert.equal(bridgeAck.before.version,c.enrolled.priorSiteVersion);assert.equal(bridgeAck.before.controlSha256,before.controlSha256);
    assert.deepEqual(bridgeAck.preConfig.config,preConfig.config);assert(head.sequence>=bridgeAck.head.sequence);
    await io.lineage(bridgeAck.before,before);
  }
  await io.served('rollback',false);
  const postflight=await io.browser('rollback','full');
  for(const r of postflight)assert.equal(hash('sha256',JSON.stringify(r.previews)),g.previewSha256);
  const [end,fresh,postConfig]=await Promise.all([io.observe(),io.head(),io.rum()]);assert.deepEqual(end,before);assert(fresh.sequence>=head.sequence);
  if(bridgeAck){
    await io.lineage(bridgeAck.before,end);
    assert.deepEqual(witnessIdentity(postflight),witnessIdentity(bridgeAck.preflight),'original bridge runner or preview changed');
  }
  assert.deepEqual(postConfig.config,preConfig.config);assert(Date.now()<Math.min(c.expiresAt,fresh.expiresAt));
  return {end,fresh,state:'BRIDGE_ABANDONED',preflight:[],postflight,preConfig,postConfig};
}

// The upload primitive is private to the guarded deploy-site entry point.
export function promoteRoot(args,env){return executePhase(args,env,true);}
async function executePhase(args, env, write) {
  const g=readTransition(env); assert.deepEqual(args,['production-root-sealed',g.source]);
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID,account);assert.equal(env.SITE_DEPLOY_ACCOUNT_ID,account);
  assert.equal(env.SITE_DEPLOY_HOSTNAME,hostname);assert.equal(env.SITE_DEPLOY_WORKER,site);
  if(write)assert(!g.reconcile && g.operation!=='root-abandon-bridge' && env.ROOT_OPERATION===g.operation && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_API_TOKEN!==env.ROOT_CONTROL_READ_TOKEN);
  else assert(!env.CLOUDFLARE_API_TOKEN,'read-only confirmation required');
  assert(env.ROOT_CONTROL_READ_TOKEN);
  const cleanEnv=childEnvironment(env,g.source),git=(...a)=>execFileSync('git',a,{cwd:root,env:cleanEnv,encoding:'utf8'}).trim();
  function snapshot(){assert.equal(git('rev-parse','HEAD'),g.source);assert.equal(git('status','--porcelain','--untracked-files=all'),'');}
  snapshot();const c=verifyPackages(env,g,false),dist=join(root,'dist');
  const headers=new Set(readFileSync(join(dist,'_headers'),'utf8').split('\n').filter(s=>s.startsWith('/')));
  const browsers = regionalBrowsers(g,env);
  const ref=g.reconcile??g.bridgeWrite,run=ref?.run??env.GITHUB_RUN_ID,attempt=ref?.attempt??env.GITHUB_RUN_ATTEMPT;
  // Per originating operation, reproducible only by the enrolled verifier; never archive the key.
  assert.match(env.ROOT_EGRESS_KEY,/^[0-9a-f]{64}$/,'protected per-operation egress pseudonym key required');
  const witnessEnv={...cleanEnv,ROOT_EGRESS_NONCE:createHmac('sha256',Buffer.from(env.ROOT_EGRESS_KEY,'hex')).update(JSON.stringify([g.source,run,attempt])).digest('hex'),
    ...(g.restoreRum && {ROOT_RESTORE_RUM:JSON.stringify(g.restoreRum)})};
  assert(env.ROOT_RUM_READ_TOKEN && env.ROOT_RUM_READ_TOKEN!==env.CLOUDFLARE_API_TOKEN,'dedicated RUM read capability required');
  const io={
    lineage:(from,to)=>confirmLineage(env.ROOT_CONTROL_READ_TOKEN,from,to),
    rum:()=>observeRum(env.ROOT_RUM_READ_TOKEN,g.rumConfigSha256),
    observe:()=>observeSite(c.enrolled,env.ROOT_CONTROL_READ_TOKEN),head:()=>freshProducer(c.enrolled),main:()=>requireLiveCustody(env,g,c.h),
    served:(role,documentsOnly)=>served(c.pair.files[role],documentsOnly,documentsOnly?new Set():headers),
    browser:(role,mode)=>witnessPair(browsers,join(paths(env).receipt,'private-root-pair.json'),g.source,c.h.packetSha256,role,mode,root,witnessEnv),
    checkRestored(){
      execFileSync(process.execPath,['scripts/site-release.mjs','verify-root',c.release,g.source,c.manifest,c.h.run,c.h.attempt],{cwd:root,env:cleanEnv,stdio:'inherit'});
      snapshot();assertSiteUploadApproved(dist);
    },
  };
  const file=join(paths(env).base,'write.json'),identity={profile:'acknowledged-root-write-v1',source:g.source,operation:g.bridgeWrite?'root-install-bridge':g.operation,run,attempt,
    handoffSha256:g.handoffSha256,manifest:c.manifest,previewSha256:g.previewSha256,euAssurance:g.euAssurance,regionalBrowsers:g.regionalBrowsers};
  if(write){
    const output=join(paths(env).base,'wrangler.jsonl');
    const publish=message=>{
      execFileSync(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config','site-worker/production.wrangler.toml','--env','',
        '--tag',g.source,'--message',message,'--assets',dist,join(c.release,'worker/worker.js'),'--no-bundle','--no-experimental-auto-create'],{
        cwd:root,env:{...cleanEnv,WRANGLER_OUTPUT_FILE_PATH:output,CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:env.CLOUDFLARE_API_TOKEN},stdio:'inherit',timeout:180000});
      const rows=readFileSync(output,'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.type==='deploy');
      assert.equal(rows.length,1);assert.equal(rows[0].version,1);assert.equal(rows[0].worker_name,site);return rows[0].version_id;
    };
    const ack=await transition(g,c,{...io,publish});
    writeFileSync(file,JSON.stringify({identity,approval:c.approval,ack})+'\n',{flag:'wx',flush:true});return;
  }
  await io.main();io.checkRestored();
  const noSiteWrite=g.operation==='root-abandon-bridge';
  let result;
  if(noSiteWrite)result=await confirmBridgeExit(g,c,io,g.bridgeWrite?readWriteCheckpoint(file,identity,g.bridgeWrite.checkpointSha256):undefined);
  else {
    result=await confirmTransition(g,c,readWriteCheckpoint(file,identity,g.reconcile?.checkpointSha256),io);
  }
  const {end,fresh,state,preflight,postflight,preConfig,postConfig}=result;
  const origin=noSiteWrite?{noSiteWrite:true,...(g.bridgeWrite && {bridgeWriteRun:run,bridgeWriteAttempt:attempt,bridgeWriteSha256:g.bridgeWrite.checkpointSha256})}:{writeRun:run,writeAttempt:attempt};
  writeFileSync(join(paths(env).base,'regional.json'),JSON.stringify({source:g.source,operation:g.operation,run:env.GITHUB_RUN_ID,
    restoreRum:g.restoreRum,...origin,eu:g.euAssurance==='config-substitute-v1'?'UNMEASURED':'MEASURED',preConfig,postConfig,approval:c.approval,rehearsalSha256:c.h.rehearsalSha256,
    attempt:env.GITHUB_RUN_ATTEMPT,handoffSha256:g.handoffSha256,controlSha256:g.controlSha256,expiresAt:c.expiresAt,
    pre:{deployment:g.fromDeployment,version:g.fromVersion,reports:preflight},post:{deployment:end.deployment,version:end.version,reports:postflight},incident:end.incident})+'\n',{flag:'wx'});
  writeFileSync(paths(env).state,JSON.stringify({profile:'production-root-state-v1',state,operation:g.operation,source:g.source,run:env.GITHUB_RUN_ID,
    attempt:env.GITHUB_RUN_ATTEMPT,handoffSha256:g.handoffSha256,manifestSha256:c.manifest,deployment:end.deployment,version:end.version,
    fromDeployment:g.fromDeployment,fromVersion:g.fromVersion,controlSha256:end.controlSha256,moduleSha256:end.moduleSha256,
    ...origin,incident:end.incident,producerVersion:end.producerVersion,sequence:fresh.sequence,checkedAt:Date.now()},null,2)+'\n',{flag:'wx'});
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert.deepEqual(process.argv.slice(2),['confirm']);await executePhase(['production-root-sealed',process.env.GITHUB_SHA],process.env,false);
}
