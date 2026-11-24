// Local owner operation. No GitHub workflow, D1 query, deployment, or rollback capability.
import {execFileSync} from 'node:child_process';
import {closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, fsyncSync, writeFileSync} from 'node:fs';
import {tmpdir, userInfo} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {account, activeTokenId, bindings, client, digest, immutable, requireThat as check, root, versionId} from './incident-provider.mjs';
import {api, certifiedRun, gh, graphEnv, owner, ref, repo, workflow} from './incident-receipt.mjs';
import {original} from './incident-recovery-id.mjs';
import {policy} from './incident-owner.mjs';
import {baseline, control, exactVersion, failed, privateGraph, script, target} from './incident-canary-control.mjs';
import {successorBuild} from '../../production-incidents/sealed-successor.ts';

const source = '3677b9bd19669172b82afea497b996234cc19c2d';
const reviewedParent = 'c5166082294a10fcee82b32eef62e3bf86a9ba1e';
const checkout = fileURLToPath(new URL('../../', import.meta.url));
const versionList = `${target}/versions?per_page=100`;
const uploadPath = `${target}/versions?deploy=false`;
const inherited = ['ADMIN_ID', 'BOT_TOKEN'];
export const publicHash = '924bc0aa4ddb4c37351b4551c2d55696c5d0c50e14bef355d605a4af4109ed17';
const successor = Object.freeze({
  run:'45197180403', version:'a7a44718-3df0-4516-a3fa-ebced4038b9f',
  deployment:'de7ca80b-dd35-47e3-a218-4cee7b05890c', restored:'b87e67ae-d1c2-455a-b7c9-e33126c91e57',
  module:'abfdaf31352409a747917ade12e6dd5fbbbac9a76cde214d65ec9849957eec00',
});
export const beforeIds = Object.freeze([baseline.version, baseline.partial, baseline.donor, failed.version, successor.version].sort());
// Both restoration IDs are provider readbacks, not fields signed by the historical permit.
const history = [
  [successor.restored, baseline.version], [successor.deployment, successor.version],
  ['5dadd20e-0a39-41c1-863e-b5dc0329b972', baseline.version],
  [failed.deployment, failed.version], [baseline.deployment, baseline.version],
].map(([id,version_id]) => ({id,versions:[{version_id,percentage:100}]}));
export const closed = Object.freeze({deployment:successor.restored, version:baseline.version, crons:[]});
export const publicBindings = () => bindings(baseline.build).map(b => b.name === 'PUBLIC_INGRESS' ? {...b,text:'1'} : b);
const attemptDir = () => join(userInfo().homedir, '.incident-owner-upload-only');

function windowOpen(until) {
  const now = Date.now();
  check(Number.isSafeInteger(until) && now < until * 1000 && until * 1000 <= now + 3600000, 'outside upload window');
}

export function privateInput(fd) {
  const s = fstatSync(fd);
  check(s.isFIFO() || (s.isFile() && s.uid === process.getuid() && (s.mode & 0o077) === 0), 'not a private file or pipe');
  const buf = Buffer.alloc(513);
  try {
    let n = 0;
    while (n < buf.length) {
      const count = readSync(fd, buf, n, buf.length - n, null);
      if (!count) break;
      n += count;
    }
    const token = buf.subarray(0, n).toString('ascii').trim();
    check(n < buf.length && /^[A-Za-z0-9_-]+$/.test(token), 'invalid credential descriptor');
    return token;
  } finally {
    buf.fill(0);
    // Standard streams belong to the process, not to credential cleanup.
    if (fd > 2) closeSync(fd);
  }
}

function burnAttempt(dir, intent) {
  // One marker per Worker, not per module, approval window, or checkout. Never remove it on error.
  try { mkdirSync(dir, {mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  check(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0, 'unsafe attempt directory');
  const file = join(dir, `${original.workerId}.json`);
  writeFileSync(file, JSON.stringify(intent) + '\n', {flag:'wx', mode:0o600, flush:true});
  for (const path of [dir, dirname(dir)]) {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return file;
}

async function upload(token, module, send) {
  const res = await send(`https://api.cloudflare.com/client/v4${uploadPath}`, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
    headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'},
    body:JSON.stringify({
      main_module:'worker.js', compatibility_date:'2026-08-14', compatibility_flags:[],
      bindings:[...publicBindings(), ...inherited.map(name => ({name,type:'inherit',version_id:baseline.donor}))],
      modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:module.toString('base64')}],
    }),
  });
  check(res.ok, 'upload not acknowledged');
  const v = await res.json();
  check(v?.success === true && ((v.errors === null && v.messages === null) || (same(v.errors, []) && Array.isArray(v.messages))) &&
    typeof v.result?.id === 'string' && versionId.test(v.result.id) && !beforeIds.includes(v.result.id), 'ambiguous upload result');
  return v.result.id;
}

// Historical signatures identify the inert installation/retired Editor and the private
// successor's bytes. Neither signature authorizes this upload, public traffic or another DM.
const retainedSubjects = {
  'installed.json': ['3417671dfd921563e3bbba6233b677064d59b49ad951937d90546aab54ae213f','98d9ad846ac02dd7e90d10d63386f1a4b14b9ab877ea45c4d73d2d0a225a502f'],
  'permit.json': ['10c7e0fa04028cba69076b28f078dfd6089ebaea53d3e592adba7b65dbec3069','c4a2e7da223ddedd73463b591565e8b31a10b4b0e5faaf4ab0c56c5dfe0b5d66'],
};
const trustedRootSha='65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c';
function historicalReceipt(dir, run, workflowPath, sha, artifact, filename, retained) {
  const file = join(dir,filename), offline=[];
  if (retained === undefined) {
    gh('run','download',run,'--repo',repo,'--name',`${artifact}-${run}-1`,'--dir',dir);
  } else {
    // Verify private snapshots of the independently pinned bytes, never a local verifier result or user-selected trust root.
    const snapshot=(name,expected,dest=join(dir,filename+'.'+name))=>{
      const path=join(retained,name),st=lstatSync(path);
      check(st.isFile() && st.size>0 && st.size<=256*1024,'invalid retained provenance input');
      const bytes=readFileSync(path);check(digest(bytes)===expected,'retained provenance digest mismatch');
      writeFileSync(dest,bytes,{mode:0o600,flag:'wx'});return dest;
    };
    const [subject,bundle]=retainedSubjects[filename];
    snapshot(filename,subject,file);
    offline.push('--bundle',snapshot(`sha256:${subject}.jsonl`,bundle),'--custom-trusted-root',snapshot('trusted_root.jsonl',trustedRootSha));
  }
  certifiedRun(JSON.parse(gh('attestation','verify',file,'--repo',repo,'--signer-workflow',`${repo}/${workflowPath}`,
    '--signer-digest',sha,'--source-digest',sha,'--source-ref',ref,'--deny-self-hosted-runners',...offline,'--format','json')),run);
  return readFileSync(file);
}

// Only the mobile successor can recover an absent push; older owner operations remain push-only.
function sourceJobs(head,query,mobileRecovery) {
  const branch = query('branches/main');
  check(branch.protected === true && branch.commit.sha === head && query(`commits/${head}`).commit.verification.verified === true,
    'protected signed source changed');
  const pulls = query(`commits/${head}/pulls`);
  check(pulls.some(p=>p.merged_at && p.merge_commit_sha === head && p.base.ref === 'main' && p.base.repo.id === 1229775730),
    'not the merged source PR');
  const path = '.github/workflows/site-source-verify.yml';
  const runs = event => query(`actions/workflows/site-source-verify.yml/runs?branch=main&event=${event}&head_sha=${head}&per_page=1`);
  let event = 'push', result = runs(event);
  if (mobileRecovery && result.total_count === 0 && result.workflow_runs.length === 0) {
    event = 'workflow_dispatch'; result = runs(event);
  }
  const [run] = result.workflow_runs;
  check(run?.head_sha === head && run.head_branch === 'main' && run.event === event && run.path === path &&
    run.repository.id === 1229775730 && run.head_repository.id === 1229775730 && run.status === 'completed' && run.conclusion === 'success' &&
    Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,'no exact-main source CI');
  const jobs = query(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  check(jobs.total_count === jobs.jobs.length, 'partial source job list');
  return {jobs:jobs.jobs,event};
}

export function checkedMain(head,query) {
  const {jobs} = sourceJobs(head,query,false);
  check(jobs.some(j => j.name === 'Site source prerequisites' && j.conclusion === 'success' && j.steps.some(s =>
    s.name === 'Verify post-successor inactive upload only (offline)' && s.conclusion === 'success')), 'offline upload checks did not pass');
}

export function checkedMobileMain(head,query) {
  const {jobs,event} = sourceJobs(head,query,true);
  const required = [
    ['Site source prerequisites', ['Verify post-successor inactive upload only (offline)', 'Verify mobile retry inactive successor (offline)',
      'Select the source profile from exact bytes, never a dispatch flag',
      ...(event === 'workflow_dispatch' ? ['Authenticate the signed protected main tip'] : [])]],
    ['Production root source (no publication)', ['Verify formal source bindings and the two-direction preparation contract',
      'Build source-only root with the isolated pin, never the enrolled key']],
    ['Site source verification', ['Require the complete applicable source lane']],
  ];
  check(jobs.length === required.length && required.every(([name,steps]) => jobs.some(j => j.name === name &&
    j.status === 'completed' && j.conclusion === 'success' && steps.every(step => j.steps.some(s =>
      s.name === step && s.conclusion === 'success')))), 'incomplete protected mobile source verification');
}

export function checkedCheckout(git) {
  // This source-only repair has its own exact parent; the public bundle and
  // historical receipt below still use the earlier source pin.
  const files = ['scripts/ci/incident-owner-upload-only.mjs','scripts/ci/incident-owner-upload-only.test.mjs',
    'production-incidents/RUNBOOK.ko.md'];
  check(git('rev-parse','HEAD^') === reviewedParent && !git('status','--porcelain','--untracked-files=normal') &&
    same(git('diff','--name-only',reviewedParent,'HEAD').split('\n').sort(),files.sort()), 'unreviewed checkout');
}

function provenance() {
  const git = (...args) => execFileSync('git',args,{cwd:checkout,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  checkedCheckout(git);
  check(JSON.parse(gh('api','user')).id === owner, 'not the local owner');
  const head = git('rev-parse','HEAD');
  const requireSource = () => checkedMain(head,api);
  requireSource();
  return {retired:historicalEditor(),requireSource,head};
}
export function historicalEditor(retained) {
  const dir = mkdtempSync(join(tmpdir(),'incident-upload-proof-'));
  try {
    const installed = historicalReceipt(dir,'45171435589',workflow,'b65321df6af1a67773642261315d3b6edd4c63bc','incident-installed','installed.json',retained);
    check(digest(installed) === '3417671dfd921563e3bbba6233b677064d59b49ad951937d90546aab54ae213f','unexpected installation receipt');
    const i = JSON.parse(installed);
    check(i.phase === 'private-installed' && i.workerId === original.workerId && i.version === baseline.version &&
      i.moduleHash === baseline.module && immutable.test(i.editorId), 'wrong installed identity');
    const permit = historicalReceipt(dir,successor.run,'.github/workflows/incident-private-canary.yml',source,'private-canary-permit','permit.json',retained);
    check(same(JSON.parse(permit),{phase:'sealed-successor-one-dm',predecessor:'45184118767',slot:successorBuild,sha:source,
      run:successor.run,attempt:1,module:successor.module,end:1795448388}), 'wrong historical successor permit');
    // The unsigned local journal records SENT/1 and inert restoration, not the restoration ID.
    const journal = readFileSync(join(userInfo().homedir,'.incident-private-canary',successor.run,'journal.jsonl'));
    check(digest(journal) === 'c86e031f96c0b4c5e87e76e516d4ded97c79ee4feef9561617ab1338a97f059f', 'wrong local successor journal');
    return i.editorId;
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

export async function checkedCredentials(retired, until) {
  const management = client(privateInput(3)), read = client(privateInput(4));
  const token = privateInput(0), editorRead = client(token);
  async function inspect() {
  const groups = await management(`${root}/tokens/permission_groups`);
  check(Array.isArray(groups) && groups.every(g => typeof g?.id === 'string' && g.id && typeof g.name === 'string'), 'invalid permission catalog');
  const roles = new Map(groups.map(g => [g.id,g.name]));
  check(roles.size === groups.length, 'ambiguous permission catalog');
  const readerId = await activeTokenId(read);
  check(readerId === gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo), 'unregistered graph reader');
  policy(await management(`${root}/tokens/${readerId}`),readerId,roles);
  const id = await activeTokenId(editorRead);
  check(id !== retired && id !== readerId,'wrong editor identity');
  const editor = await management(`${root}/tokens/${id}`);
  policy(editor,id,roles,original.workerId);
  const issued = Date.parse(editor.issued_on), expires = Date.parse(editor.expires_on), now = Date.now();
  check(issued <= now && expires > now && expires-issued <= 86400000 && expires >= until*1000, 'expected fresh, bounded Editor');
  check(same(await control(editorRead),closed),'Editor cannot confirm the reserved target');
  return {editorId:id,readerId,issued,expires};
  }
  const initial=await inspect();
  const recheck=async()=>{
    check(same(await inspect(),initial),'token identities or policy changed');
    const mid=await activeTokenId(management);check(mid!==initial.editorId && mid!==initial.readerId,'shared token identity');
    const detail=await management(root+'/tokens/'+mid);const [p]=detail.policies??[];
    const groups=await management(root+'/tokens/permission_groups');const roles=new Map(groups.map(g=>[g.id,g.name]));
    check(detail.id===mid && detail.status==='active' && detail.policies?.length===1 && p.effect==='allow' && p.permission_groups?.length===1 && roles.get(p.permission_groups[0].id)==='Account API Tokens Read' && same(p.resources,{['com.cloudflare.api.account.'+account]:'*'}),'wrong token policy reader');
  };
  return {read,token,...initial,recheck};
}

export function uploadReadbacks(read) {
  const expectClosed = async () => {
    check(same(await control(read),closed),'inert 100%/private controls changed');
    const {deployments} = await read(`${script}/deployments?per_page=100`);
    check(same(deployments.map(({id,versions})=>({id,versions})),history),'deployment history changed');
  };
  const inventory = async () => (await read(versionList)).map(v => v.id).sort();
  const exact = async (id,sha,names,main,settings) => {
    const v = await read(`${target}/versions/${id}?include=modules`);
    check(same(v.urls,[]) && v.migrations == null && v.exports_reconciliation == null,'version URL or runtime change');
    exactVersion(v,id,sha,names,main,settings);
    // The beta endpoint can also return bindings keyed by name in env.
    if (v.env != null) check(same(v.env,Object.fromEntries(v.bindings.map(({name,...rest}) => [name,rest]))),'conflicting environment');
  };
  const verifyKnown = async () => {
    await exact(baseline.version,baseline.module,[],'worker.js');
    await exact(baseline.donor,baseline.module,inherited,'worker.js');
    await exact(successor.version,successor.module,inherited,'private-canary.js');
  };
  return {expectClosed,inventory,exact,verifyKnown};
}
export async function executeUpload({module,until,read,token,dir,send,requireSource,head}) {
  windowOpen(until);
  check(module.length > 0 && module.length < 512*1024 && digest(module) === publicHash,'wrong public module');
  const {expectClosed,inventory,exact,verifyKnown}=uploadReadbacks(read);
  await expectClosed();
  const topology = await privateGraph(read);
  await verifyKnown();
  check(same(await inventory(),beforeIds),'not the five post-successor versions');
  await expectClosed();
  requireSource();
  windowOpen(until);
  const marker = burnAttempt(dir,{phase:'attempt-consumed',utc:new Date().toISOString(),source,reviewedMain:head,hash:publicHash,deployment:closed.deployment,until});
  let candidate;
  try {
    windowOpen(until);
    candidate = await upload(token,module,send);
    writeFileSync(`${marker}.ack`, JSON.stringify({candidate}) + '\n',{flag:'wx',mode:0o600,flush:true});
    await exact(candidate,publicHash,inherited,'worker.js',publicBindings());
    await verifyKnown();
    check(same(await inventory(),[...beforeIds,candidate].sort()),'not exactly one new version');
  } finally {
    // These are GET-only even if the POST/ACK was ambiguous. Do not infer an ACK
    // from a new ID in an inventory or remove the marker after any kind of failure.
    await expectClosed();
    check(await privateGraph(read) === topology,'account graph changed');
    await expectClosed();
  }
  return {phase:'inactive-upload-verified',utc:new Date().toISOString(),hash:publicHash,candidate,deployment:closed.deployment};
}

async function main([modulePath,untilText,...extra]) {
  check(modulePath && /^\d{10}$/.test(untilText) && !extra.length && !process.env.CI && !process.env.GITHUB_ACTIONS,
    'expected local public worker.js and UTC expiry only');
  const until = Number(untilText); windowOpen(until);
  const module = readFileSync(modulePath);
  check(digest(module) === publicHash,'public artifact differs from reviewed pin');
  const {retired,requireSource,head} = provenance();
  const credentials = await checkedCredentials(retired,until);
  console.log(JSON.stringify(await executeUpload({module,until,...credentials,dir:attemptDir(),send:fetch,requireSource,head})));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e => {
  // Do not disclose provider responses, paths, subprocess output or credentials.
  // The marker is authoritative even after a crash; never advise resubmission.
  const safe = new Set(['unreviewed checkout','not the local owner','protected signed source changed','wrong historical successor permit',
    'not the merged source PR','no exact-main source CI','offline upload checks did not pass','wrong local successor journal',
    'public artifact differs from reviewed pin','outside upload window','unregistered graph reader',
    'wrong editor identity','expected fresh, bounded Editor','inert 100%/private controls changed','deployment history changed',
    'not the five post-successor versions','not exactly one new version','account graph changed']);
  console.error(`Stopped: ${safe.has(e.message)?e.message:'verification or acknowledgement incomplete'}. Preserve the attempt marker, reconcile read-only; never replay.`);
  process.exitCode = 1;
});
