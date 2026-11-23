import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSiteUploadApproved } from '../deploy-site.ts';
import { childEnvironment } from './run-checked-command.mjs';
import { operations, paths, readTransition, requireLiveCustody, root, verifyPackages } from './root-promotion-custody.mjs';
import { account, assertStartingState, freshProducer, hostname, observeSite, served, site, versionMessage } from './root-promotion-live.mjs';

// Sequencing only; this function has no credentials and cannot itself issue a write.
export async function transition(g, c, io) {
  assert.equal(c.role,operations[g.operation]);assert.equal(c.manifest,c.h.directions[c.role].manifestSha256);
  if(g.operation!=='root-install-bridge')assert(g.bridge,'verified BRIDGE_READY required');
  assertStartingState(g,await io.observe(),c.h);
  if (g.operation==='root-install-bridge') await io.served('rollback',true);
  if (g.operation==='root-activate-forward') await io.served('rollback',false);
  // A broken forward UI must not be a prerequisite to restoring its verified bridge.
  const [before,head]=await Promise.all([io.observe(),io.head(),io.main()]);
  assertStartingState(g,before,c.h); io.checkRestored();
  assert(head.sequence>=g.minimumProducerSequence,'producer below independently approved floor');
  assert(Date.now()<Math.min(c.expiresAt,head.expiresAt),'approval or signed producer lease expired before write');
  const message=versionMessage(c.role,c.manifest); io.publish(message);
  // No automatic write retry, fall-forward, rollback, or READY receipt on a partial failure.
  const post=await io.observe();assert.notEqual(post.version,before.version);assert.notEqual(post.deployment,before.deployment);
  assert.equal(post.annotations['workers/tag'],g.source);assert.equal(post.annotations['workers/message'],message);assert.equal(post.controlSha256,g.controlSha256);
  await io.served(c.role,false);
  await io.browser(c.role);
  const [end,fresh]=await Promise.all([io.observe(),io.head()]);assert.deepEqual(end,post);assert(fresh.sequence>=head.sequence);
  assert(Date.now()<Math.min(c.expiresAt,fresh.expiresAt),'expired before final receipt');
  return {end,fresh,state:g.operation==='root-install-bridge'?'BRIDGE_READY':c.role==='forward'?'FORWARD_ACTIVE':'ROLLBACK_ACTIVE'};
}

// The upload primitive is deliberately private to the guarded entry point.
export async function promoteRoot(args, env) {
  const g=readTransition(env); assert.deepEqual(args,['production-root-sealed',g.source]);
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID,account);assert.equal(env.SITE_DEPLOY_ACCOUNT_ID,account);
  assert.equal(env.SITE_DEPLOY_HOSTNAME,hostname);assert.equal(env.SITE_DEPLOY_WORKER,site);
  assert(env.CLOUDFLARE_API_TOKEN && env.ROOT_CONTROL_READ_TOKEN && env.CLOUDFLARE_API_TOKEN!==env.ROOT_CONTROL_READ_TOKEN);
  const cleanEnv=childEnvironment(env,g.source),git=(...a)=>execFileSync('git',a,{cwd:root,env:cleanEnv,encoding:'utf8'}).trim();
  function snapshot(){assert.equal(git('rev-parse','HEAD'),g.source);assert.equal(git('status','--porcelain','--untracked-files=all'),'');}
  snapshot();const c=verifyPackages(env,g,false),dist=join(root,'dist');
  const headers=new Set(readFileSync(join(dist,'_headers'),'utf8').split('\n').filter(s=>s.startsWith('/')));
  const {end,fresh,state}=await transition(g,c,{
    observe:()=>observeSite(c.enrolled,env.ROOT_CONTROL_READ_TOKEN),head:()=>freshProducer(c.enrolled),main:()=>requireLiveCustody(env,g,c.h),
    served:(role,documentsOnly)=>served(c.pair.files[role],documentsOnly,documentsOnly?new Set():headers),
    browser:role=>execFileSync(process.execPath,['scripts/ci/root-promotion-browser.mjs',join(paths(env).receipt,'private-root-pair.json'),role],{cwd:root,env:cleanEnv,stdio:'inherit',timeout:180000}),
    checkRestored(){
      execFileSync(process.execPath,['scripts/site-release.mjs','verify',c.release,g.source,c.manifest,c.h.run,c.h.attempt],{cwd:root,env:cleanEnv,stdio:'inherit'});
      snapshot();assertSiteUploadApproved(dist);
    },
    publish(message){execFileSync(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config','site-worker/production.wrangler.toml','--env','',
      '--tag',g.source,'--message',message,'--assets',dist,join(c.release,'worker/worker.js'),'--no-bundle','--no-experimental-auto-create'],{
      cwd:root,env:{...cleanEnv,CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:env.CLOUDFLARE_API_TOKEN},stdio:'inherit',timeout:180000});},
  });
  writeFileSync(paths(env).state,JSON.stringify({profile:'production-root-state-v1',state,operation:g.operation,source:g.source,run:env.GITHUB_RUN_ID,
    attempt:env.GITHUB_RUN_ATTEMPT,handoffSha256:g.handoffSha256,manifestSha256:c.manifest,deployment:end.deployment,version:end.version,
    fromDeployment:g.fromDeployment,fromVersion:g.fromVersion,controlSha256:end.controlSha256,moduleSha256:end.moduleSha256,
    producerVersion:end.producerVersion,sequence:fresh.sequence,checkedAt:Date.now()},null,2)+'\n',{flag:'wx'});
}
