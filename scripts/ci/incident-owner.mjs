import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {account, zone, root, registry, client, requireThat, immutable, reserve, state, editor} from './incident-provider.mjs';
import {repo, owner, gate, graphEnv, numeric, gh, api, pins, source, protectedEnv, localMain, verify, checkIntent, claim, approvalComment} from './incident-receipt.mjs';

const writeOnce = (path, value)=>writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});
function privateInput(fd) {
  requireThat(!process.stdin.isTTY || fd !== 0,'use a secret-manager pipe or private input descriptor; not an echoed terminal');
  try { return readFileSync(fd,'utf8').trim(); } catch { throw Error('private credential descriptor unavailable'); }
}
function setSecret(key, env, value) {
  try { execFileSync('gh',['secret','set',key,'--repo',repo,'--env',env],{input:value,stdio:['pipe','ignore','pipe'],env:{...process.env,GH_HOST:'github.com',GH_DEBUG:'',DEBUG:''},timeout:30000}); }
  catch { throw Error('environment secret enrollment failed'); }
}
function resourcePath(resources) {
  let node = resources, path = [];
  while (node && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 1) {
    const key = Object.keys(node)[0]; path.push(...key.split('.')); node = node[key];
  }
  requireThat(node === '*', 'expected a single specific resource');
  return path;
}
// The management credential reads account token metadata only and never enters GitHub.
// A successful token verify or a denied request alone is NOT policy introspection.
export function policy(details, tokenId, roles, workerId) {
  requireThat(details.id === tokenId && details.status === 'active' && details.policies?.length > 0, 'no active token policy');
  const granted = new Set();
  for (const p of details.policies) {
    requireThat(p.effect === 'allow' && p.permission_groups?.length > 0, 'unknown policy');
    const path = resourcePath(p.resources), key = path.join('.');
    for (const g of p.permission_groups) {
      const role = roles.get(g.id); requireThat(role,'unapproved token permission'); granted.add(role);
      if (workerId) {
        requireThat(role === 'Individual Workers Editor' && immutable.test(workerId) && !path.includes('*') && path.at(-1) === workerId && key.startsWith('com.cloudflare.api.account.') && path.filter(x=>immutable.test(x)).every(x=>x === account || x === workerId), 'Editor not restricted to the reserved immutable Worker');
      } else if (['Zone Read','Zone Zone Read','Workers Routes Read'].includes(role)) {
        const zones = `com.cloudflare.api.account.${account}.com.cloudflare.api.account.zone.`;
        requireThat(role === 'Workers Routes Read' ? [zones + zone,`com.cloudflare.api.account.zone.${zone}`].includes(key) : key === zones + '*', 'zone discovery must cover the account; route read must be limited to the reviewed zone');
      } else {
        requireThat(['Workers Scripts Read','D1 Read','Pages Read'].includes(role) && key === `com.cloudflare.api.account.${account}`, 'unexpected account read scope');
      }
    }
  }
  if (workerId) requireThat(granted.size === 1,'unexpected additional Editor grant');
  else requireThat(['Workers Scripts Read','D1 Read','Pages Read','Workers Routes Read'].every(r=>granted.has(r)) && (granted.has('Zone Read') || granted.has('Zone Zone Read')), 'incomplete graph reader');
}
export function bootstrapPolicy(details, tokenId, roles) {
  const p = details.policies?.[0];
  requireThat(details.id === tokenId && details.status === 'active' && details.policies?.length === 1 && p.effect === 'allow' && p.permission_groups?.length === 1 && roles.get(p.permission_groups[0].id) === 'Workers Scripts Write' && resourcePath(p.resources).join('.') === `com.cloudflare.api.account.${account}`, 'owner bootstrap must be the single reviewed account-level Worker permission');
}
async function checkedToken(token, workerId, check=policy) {
  const cf = client(token), reader = client(privateInput(3));
  const t = await cf(`${root}/tokens/verify`);
  requireThat(t.status === 'active' && immutable.test(t.id), 'invalid account-owned credential');
  const groups = await reader(`${root}/tokens/permission_groups`);
  const roles = new Map(groups.map(g=>[g.id,g.name]));
  check(await reader(`${root}/tokens/${t.id}`), t.id, roles, workerId);
  if (workerId) await editor(cf, workerId, t.id);
  return t.id;
}
async function main([mode, run, ...extra]) {
  requireThat(!process.env.GITHUB_ACTIONS && !process.env.CI && !extra.length && ['enroll-graph','reserve','authorize'].includes(mode), 'local owner command required');
  requireThat(JSON.parse(gh('api','user')).id === owner, 'authenticated sole owner required');
  const envId = protectedEnv(gate); protectedEnv(graphEnv);
  const pin = key=>gh('variable','get',key,'--env',graphEnv,'--repo',repo);
  requireThat(!execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim(), 'clean reviewed checkout required');
  const sha = localMain(); requireThat(pin('INCIDENT_REVIEWED_MAIN') === sha && api('branches/main').commit.sha === sha && api('branches/main').protected, 'approved protected main required');
  if (mode === 'enroll-graph') {
    requireThat(run === undefined,'unexpected argument');
    const token = privateInput(0), id = await checkedToken(token);
    setSecret('CF_INCIDENT_GRAPH_READ',graphEnv,token);
    gh('variable','set','INCIDENT_GRAPH_TOKEN_ID','--body',id,'--repo',repo,'--env',graphEnv);
    return;
  }
  requireThat(numeric.test(run), 'expected exact workflow run ID');
  const p = pins(sha,run,pin('INCIDENT_MODULE_SHA256')); source(p);
  const pending = () => {
    const rows = api(`actions/runs/${run}/pending_deployments`);
    requireThat(rows.length === 1 && rows[0].environment.id === envId && rows[0].environment.name === gate && rows[0].current_user_can_approve === true,'not waiting for this owner and environment');
    requireThat(!api(`actions/runs/${run}/approvals`).some(r=>r.environments.some(e=>e.id === envId)), 'gate already used');
  };
  pending();
  const dir = join(homedir(),'.incident-private-install',run), tmp = mkdtempSync(join(tmpdir(),'incident-intent-'));
  mkdirSync(dir,{recursive:true,mode:0o700});
  try {
    gh('run','download',run,'--repo',repo,'--name',`incident-absent-${run}-1`,'--dir',tmp);
    const receipt = verify(join(tmp,'absent.json'),p), tag = checkIntent(p,receipt);
    if (mode === 'reserve') {
      const token = privateInput(0), cf = client(token,fetch,registry);
      await checkedToken(token,undefined,bootstrapPolicy);
      const id = await reserve(cf,tag,receipt.created,()=>{source(p); pending(); checkIntent(p,receipt); writeOnce(join(dir,'attempt'),{tag});});
      writeOnce(join(dir,'created'),{workerId:id,tag});
      console.log(`Private empty Worker ID: ${id}. Enroll only Individual Workers Editor for this ID.`);
    } else {
      const created = JSON.parse(readFileSync(join(dir,'created'),'utf8'));
      requireThat(created.tag === tag && immutable.test(created.workerId),'no matching completed local reservation');
      const token = privateInput(0), editorId = await checkedToken(token,created.workerId);
      await state(client(token),created.workerId,tag,true,receipt.created);
      const r = claim(p,tag,created.workerId,editorId,receipt.created);
      setSecret('CF_INCIDENT_WORKER_EDITOR',gate,token);
      source(p); pending(); checkIntent(p,receipt);
      // Native GitHub review, scoped to the exact pending deployment/run. Never an operator-authored proof file.
      writeOnce(join(dir,'approval-attempt'),{tag});
      gh('api','--method','POST',`repos/${repo}/actions/runs/${run}/pending_deployments`,'-F',`environment_ids[]=${envId}`,'-f','state=approved','-f',`comment=${approvalComment(r)}`);
    }
  } finally { rmSync(tmp,{recursive:true,force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
