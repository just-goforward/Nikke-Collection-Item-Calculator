import assert from 'node:assert/strict';
import {hash} from 'node:crypto';
import {api,gh,graphEnv,numeric,owner,protectedEnv,repo} from './incident-receipt.mjs';
import {checkSwitchAuthority} from './root-switch-policy.mjs';

const workflow='.github/workflows/mac-writer-approval.yml';
const digest=bytes=>hash('sha256',bytes);
export function requireMacApproval({head,run,operation,intent}) {
  assert(['incident-activate','root-install-bridge'].includes(operation));
  assert.equal(intent.productSource,'3d5786ff93ac1a56d3a650019f84ef64a41018f9');
  assert.equal(intent.profile,'mac-root-pair-receipt-v1');assert.match(intent.receiptSha256,/^[0-9a-f]{64}$/);
  assert.match(head,/^[0-9a-f]{40}$/);assert.match(run,numeric);
  assert.equal(JSON.parse(gh('api','user')).id,owner);
  const branch=api('branches/main');assert.equal(branch.protected,true);assert.equal(branch.commit.sha,head);
  const id=protectedEnv(graphEnv),r=api(`actions/runs/${run}`),title=`mac-writer-v1:${operation}:${digest(JSON.stringify(intent))}`;
  assert.equal(String(r.id),run);assert.equal(r.repository.id,1229775730);assert.equal(r.head_repository.id,1229775730);
  assert.equal(r.repository.full_name,repo);assert.equal(r.head_repository.full_name,repo);assert.equal(r.path,workflow);
  assert.equal(r.event,'workflow_dispatch');assert.equal(r.head_branch,'main');assert.equal(r.head_sha,head);assert.equal(r.run_attempt,1);
  assert.equal(r.actor.id,owner);assert.equal(r.triggering_actor.id,owner);assert.equal(r.display_title,title);
  assert.equal(r.status,'completed');assert.equal(r.conclusion,'success');
  const now=Date.now(),start=Date.parse(r.created_at);assert(start<=now && now-start<3600000);
  const jobs=api(`actions/runs/${run}/attempts/1/jobs?per_page=100`);assert.equal(jobs.total_count,1);
  const [job]=jobs.jobs;assert.equal(job.name,'Approve exact local writer intent');assert.equal(job.conclusion,'success');
  assert(job.steps.some(s=>s.name==='Record protected approval only' && s.conclusion==='success'));
  const approvals=api(`actions/runs/${run}/approvals`);assert.equal(approvals.length,1);
  const [approval]=approvals;assert.equal(approval.state,'approved');assert.equal(approval.user.id,owner);
  assert.deepEqual(approval.environments.map(e=>[e.id,e.name]),[[id,graphEnv]]);
  const get=k=>gh('variable','get',k,'--repo',repo,'--env',graphEnv);
  const env=Object.fromEntries(['ROOT_SWITCH_SIGNERS','ROOT_TECHNICAL_REVIEW','ROOT_OWNER_DECISION'].map(k=>[k,get(k)]));
  if(operation==='root-install-bridge')assert.equal(digest(get('ROOT_SITE_TRANSITION')),intent.grantSha256);
  const approvalProof=checkSwitchAuthority(env,head,operation,{...intent,run,attempt:'1'},Date.now());
  const review=JSON.parse(JSON.parse(env.ROOT_TECHNICAL_REVIEW).statement);
  assert.deepEqual(review.macWriter,{profile:intent.profile,receiptSha256:intent.receiptSha256,operation,privateHead:intent.privateHead});
  assert(Date.now()<start+3600000);return {...approvalProof,expiresAt:Math.min(start+3600000,approvalProof.expiresAt)};
}
