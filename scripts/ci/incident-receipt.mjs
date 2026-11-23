import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {account, name, db, namespace, zone, immutable, requireThat, digest} from './incident-provider.mjs';
import {original, recoveryMode} from './incident-recovery-id.mjs';

export const repo = 'just-goforward/Nikke-Collection-Item-Calculator', owner = 281915448;
export const workflow = '.github/workflows/incident-inert-install.yml', ref = 'refs/heads/main';
export const gate = 'incident-private-install', graphEnv = 'cloudflare-site-production';
const hex40 = /^[a-f0-9]{40}$/, hex64 = /^[a-f0-9]{64}$/;
export const numeric = /^[1-9][0-9]{0,15}$/;
export const gh = (...args) => {
  // Never propagate subprocess stderr, inputs or HTTP bodies into Actions or operator logs.
  try { return execFileSync('gh',args,{env:{...process.env,GH_HOST:'github.com',GH_DEBUG:'',DEBUG:''},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim(); }
  catch { throw Error('authenticated GitHub operation failed'); }
};
export const api = path=>JSON.parse(gh('api',`repos/${repo}/${path}`));
export function localMain() { return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); }
export function pins(main, run, moduleHash) {
  const build = JSON.parse(readFileSync('site-worker/production-root-release-v1.json')).serviceCodeHash;
  requireThat(hex40.test(main) && numeric.test(run) && hex64.test(moduleHash) && hex64.test(build) && localMain() === main, 'incorrect reviewed checkout or pins');
  return {schema:1, repo, workflow, ref, main, run, attempt:1, account, name, zone, db, namespace, build, moduleHash};
}
export function ciPins(env) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GH_TOKEN, 'authenticated Actions graph required');
  requireThat(env.GITHUB_REPOSITORY === repo && env.GITHUB_REPOSITORY_ID === '1229775730' && env.GITHUB_REF === ref && env.GITHUB_REF_PROTECTED === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_WORKFLOW_REF === `${repo}/${workflow}@${ref}` && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && env.GITHUB_SHA === env.INCIDENT_REVIEWED_MAIN && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_ACTOR_ID === String(owner), 'not the owner-approved initial protected run');
  return pins(env.GITHUB_SHA,env.GITHUB_RUN_ID,env.INCIDENT_MODULE_SHA256);
}
export function source(p) {
  const branch = api('branches/main'), run = api(`actions/runs/${p.run}`);
  requireThat(branch.protected && branch.commit.sha === p.main && String(run.id) === p.run && run.repository.id === 1229775730 && run.head_repository.full_name === repo && run.path === workflow && run.actor.id === owner && run.triggering_actor.id === owner && run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.head_sha === p.main && run.run_attempt === 1 && ['in_progress','waiting','pending','queued'].includes(run.status), 'protected run is stale or not authorized');
  const {workflow_runs} = api(`actions/workflows/site-source-verify.yml/runs?branch=main&event=push&head_sha=${p.main}&per_page=30`);
  const r = workflow_runs.find(r=>r.conclusion === 'success' && r.head_sha === p.main && r.event === 'push' && r.head_repository.full_name === repo);
  requireThat(r,'protected source verification missing');
  const {jobs} = api(`actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`);
  requireThat(jobs.some(j=>j.name === 'Production root source (no publication)' && j.conclusion === 'success' && j.steps.some(s=>s.name === 'Build source-only root with the isolated pin, never the enrolled key' && s.conclusion === 'success')), 'protected root build missing');
}
export function protection(environment, policies) {
  const reviewers = environment.protection_rules.filter(p=>p.type === 'required_reviewers');
  requireThat(environment.can_admins_bypass === false && reviewers.length === 1 && reviewers[0].prevent_self_review === false && reviewers[0].reviewers.length === 1 && reviewers[0].reviewers[0].type === 'User' && reviewers[0].reviewers[0].reviewer.id === owner && environment.deployment_branch_policy?.custom_branch_policies === true && policies.total_count === 1 && policies.branch_policies.length === 1 && policies.branch_policies[0].type === 'branch' && policies.branch_policies[0].name === 'main', 'environment must be restricted to main and the sole owner, without admin bypass');
}
export function protectedEnv(key) {
  const environment = api(`environments/${key}`);
  protection(environment, api(`environments/${key}/deployment-branch-policies`));
  return environment.id;
}
export function intent(p, now=Date.now()) { return {...p,phase:'absent-before-reserve',created:now}; }
export function checkIntent(p, v, now=Date.now()) {
  requireThat(Number.isSafeInteger(v.created) && v.created <= now && now-v.created < 60*60*1000 && isDeepStrictEqual(v,intent(p,v.created)), 'wrong or expired absence receipt');
  return `incident-first-${digest(JSON.stringify(v))}`;
}
export function claim(p, intentTag, workerId, editorId, notBefore) {
  requireThat(immutable.test(workerId) && immutable.test(editorId) && /^incident-first-[0-9a-f]{64}$/.test(intentTag), 'invalid reservation or editor identity');
  requireThat(Number.isSafeInteger(notBefore),'invalid intent timestamp');
  return {...p,phase:'private-reserved',tag:intentTag,workerId,editorId,notBefore};
}
// The original GitHub signature establishes provenance, not fresh authority. Do not
// use current-tip or freshness checks on that historical run; both apply to the new one.
export function verifyHistorical(p) {
  const v = verify(`production-incidents/absent-${original.run}-1.json`,original);
  requireThat(`incident-first-${digest(JSON.stringify(v))}` === original.tag && v.created === original.notBefore,'wrong historical receipt');
  if (p) requireThat(isDeepStrictEqual(v,intent({...p,run:original.run,main:original.main},original.notBefore)), 'recovery scope or module differs from original');
}
export function recoveryIntent(p, graphDigest, created=Date.now()) {
  requireThat(p.attempt === 1 && p.run !== original.run && p.main !== original.main,'fresh recovery run and source required');
  requireThat(typeof graphDigest === 'string' && hex64.test(graphDigest),'unbound recovery graph');
  return {...p,phase:'exact-private-empty',original,graphDigest,created};
}
export function checkedProof(p,mode,v,now=Date.now()) {
  if (mode === 'allocate') return {tag:checkIntent(p,v,now),notBefore:v.created};
  requireThat(mode === recoveryMode && Number.isSafeInteger(v.created) && v.created <= now && now-v.created < 3600000 &&
    isDeepStrictEqual(v,recoveryIntent(p,v.graphDigest,v.created)), 'wrong or expired reconciliation proof');
  return {tag:original.tag,notBefore:original.notBefore,workerId:original.workerId,proofDigest:digest(JSON.stringify(v))};
}
export function ownerClaim(p,mode,v,workerId,editorId,now) {
  const proof = checkedProof(p,mode,v,now);
  const r = claim(p,proof.tag,workerId,editorId,proof.notBefore);
  if (mode === 'allocate') return r;
  requireThat(workerId === original.workerId,'wrong recovery Worker');
  return {...r,phase:'private-reconciled',graphDigest:v.graphDigest,proofDigest:proof.proofDigest};
}
export function approved(p, mode, v, reviews, envId, now) {
  const prefix = 'incident-private-v1:';
  const rows = reviews.filter(r=>r.comment?.startsWith(prefix));
  requireThat(rows.length === 1 && rows[0].state === 'approved' && rows[0].user.id === owner && rows[0].environments.length === 1 && rows[0].environments[0].id === envId && rows[0].environments[0].name === gate, 'missing or ambiguous owner reservation approval');
  const r = JSON.parse(rows[0].comment.slice(prefix.length));
  requireThat(isDeepStrictEqual(r,ownerClaim(p,mode,v,r.workerId,r.editorId,now)), 'approval differs from reviewed intent');
  return r;
}
export const approvalComment = r=>`incident-private-v1:${JSON.stringify(r)}`;
export function certifiedRun(results, run) {
  requireThat(results.some(v=>{
    const c = v.verificationResult?.signature?.certificate;
    return c?.runInvocationURI === `https://github.com/${repo}/actions/runs/${run}/attempts/1` && c.buildTrigger === 'workflow_dispatch' && c.sourceRepositoryIdentifier === '1229775730' && c.sourceRepositoryOwnerIdentifier === String(owner);
  }), 'no verified GitHub certificate for this run and attempt');
}
export function verify(file, {main, run}) {
  const results = gh('attestation','verify',file,'--repo',repo,'--signer-workflow',`${repo}/${workflow}`,'--signer-digest',main,'--source-digest',main,'--source-ref',ref,'--deny-self-hosted-runners','--format','json');
  certifiedRun(JSON.parse(results),run);
  return JSON.parse(readFileSync(file,'utf8'));
}
