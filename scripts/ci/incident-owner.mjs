import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {account, zone, root, registry, client, requireThat, immutable, reserve, state, activeTokenId, recoveryGraph, probeRecoveryTarget, probeRecoveryGraph} from './incident-provider.mjs';
import {repo, owner, gate, graphEnv, numeric, gh, api, pins, source, protectedEnv, localMain, verify, checkedProof, ownerClaim, approvalComment, verifyHistorical} from './incident-receipt.mjs';
import {original, recoveryMode} from './incident-recovery-id.mjs';
import {isDeepStrictEqual} from 'node:util';

const writeOnce = (path, value)=>writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});
function privateInput(fd) {
  requireThat(!process.stdin.isTTY || fd !== 0,'use a secret-manager pipe or private input descriptor; not an echoed terminal');
  try { return readFileSync(fd,'utf8').trim(); } catch { throw Error('private credential descriptor unavailable'); }
}
function setSecret(key, env, value) {
  try { execFileSync('gh',['secret','set',key,'--repo',repo,'--env',env],{input:value,stdio:['pipe','ignore','pipe'],env:{...process.env,GH_HOST:'github.com',GH_DEBUG:'',DEBUG:''},timeout:30000}); }
  catch { throw Error('environment secret enrollment failed'); }
}
const accountResource = `com.cloudflare.api.account.${account}`;
const zoneResource = `com.cloudflare.api.account.zone.${zone}`;
// The management credential reads account token metadata only and never enters GitHub.
// A successful token verify or a denied request alone is NOT policy introspection.
export function policy(details, tokenId, roles, workerId) {
  requireThat(details.id === tokenId && details.status === 'active' && Array.isArray(details.policies) && details.policies.length > 0, 'no active token policy');
  if (workerId !== undefined) {
    const [p] = details.policies;
    requireThat(typeof workerId === 'string' && immutable.test(workerId) && details.policies.length === 1 && p?.effect === 'allow' &&
      Array.isArray(p.permission_groups) && p.permission_groups.length === 1 && roles.get(p.permission_groups[0]?.id) === 'Individual Workers Editor' &&
      isDeepStrictEqual(p.resources,{[accountResource]:{[`com.cloudflare.edge.worker.script.${workerId}`]:'*'}}),
      'Editor must have exactly one allow grant for the reserved immutable Worker');
    return;
  }
  const granted = new Set();
  for (const p of details.policies) {
    requireThat(p.effect === 'allow' && p.permission_groups?.length > 0, 'unknown policy');
    const resources = p.resources;
    for (const g of p.permission_groups) {
      const role = roles.get(g.id); requireThat(role,'unapproved token permission'); granted.add(role);
      if (['Zone Read','Zone Zone Read','Workers Routes Read'].includes(role)) {
        requireThat(role === 'Workers Routes Read'
          ? isDeepStrictEqual(resources,{[zoneResource]:'*'}) || isDeepStrictEqual(resources,{[accountResource]:{[zoneResource]:'*'}})
          : isDeepStrictEqual(resources,{[accountResource]:{'com.cloudflare.api.account.zone.*':'*'}}),
        'zone discovery must cover the account; route read must be limited to the reviewed zone');
      } else {
        requireThat(['Workers Scripts Read','D1 Read','Pages Read'].includes(role) && isDeepStrictEqual(resources,{[accountResource]:'*'}), 'unexpected account read scope');
      }
    }
  }
  requireThat(['Workers Scripts Read','D1 Read','Pages Read','Workers Routes Read'].every(r=>granted.has(r)) && (granted.has('Zone Read') || granted.has('Zone Zone Read')), 'incomplete graph reader');
}
export function bootstrapPolicy(details, tokenId, roles) {
  const p = details.policies?.[0];
  requireThat(details.id === tokenId && details.status === 'active' && details.policies?.length === 1 && p.effect === 'allow' && p.permission_groups?.length === 1 && roles.get(p.permission_groups[0].id) === 'Workers Scripts Write' && isDeepStrictEqual(p.resources,{[accountResource]:'*'}), 'owner bootstrap must be the single reviewed account-level Worker permission');
}
async function permissionRoles(reader) {
  // Group names come from the authenticated catalog, not the detail's display name.
  const groups = await reader(`${root}/tokens/permission_groups`);
  requireThat(Array.isArray(groups) && groups.every(g=>typeof g?.id === 'string' && g.id.length > 0 && typeof g.name === 'string'), 'invalid permission group catalog');
  const roles = new Map(groups.map(g=>[g.id,g.name]));
  requireThat(roles.size === groups.length,'ambiguous permission group catalog');
  return roles;
}
async function checkedToken(cf, reader, workerId, check=policy) {
  const id = await activeTokenId(cf);
  const roles = await permissionRoles(reader);
  check(await reader(`${root}/tokens/${id}`), id, roles, workerId);
  return id;
}
async function checkedEditor(cf, reader, workerId, tag, notBefore) {
  const id = await checkedToken(cf,reader,workerId);
  await state(cf,workerId,tag,true,notBefore);
  return id;
}
async function enrolledGraphId(cf, expected) {
  const id = await activeTokenId(cf);
  requireThat(id === expected,'incorrect enrolled reader');
  return id;
}
async function checkedRecoveryGraph(cf, expected) {
  await enrolledGraphId(cf,expected);
  return recoveryGraph(cf);
}

// Diagnostic only. No writable client, filesystem journal, receipt, or workflow run.
export async function recoveryPreflight(editorToken, managementToken, graphToken, graphId, send=fetch) {
  const target = ['reserved-id','reserved-name','subdomain','schedules','versions','deployments','secrets'];
  const pending = labels=>Object.fromEntries(labels.map(label=>[label,'not-run']));
  const matrix = {
    editor:pending(['verify',...target]),
    management:pending(['permission-groups','token-detail','exact-policy']),
    graph:pending(['verify','database','projects','workers','zones','routes','domains','active-deployments','active-versions',...target,'previews']),
  };
  let gets = 0;
  const reader = token=>{
    const get = client(token,send); // no POST capability
    return path=>{ gets++; return get(path); };
  };
  const phases = row=>async(label,check)=>{
    requireThat(Object.hasOwn(row,label),'unknown diagnostic phase');
    try {
      const result = await check();
      if (row[label] === 'not-run') row[label] = 'ok';
      return result;
    } catch (e) {
      // Aggregate fan-out under fixed keys; never replace the first failure
      // with a later success, and never expose provider text, URLs or IDs.
      const status = /^provider GET HTTP ([1-5]\d\d); no retry$/.exec(e?.message)?.[1];
      if (['not-run','ok'].includes(row[label])) row[label] = status ? `http-${status}` :
        e?.message === 'provider GET transport failure; no retry' ? 'transport' : 'invalid';
    }
  };
  const editor = reader(editorToken), management = reader(managementToken), graph = reader(graphToken);
  const e = phases(matrix.editor), m = phases(matrix.management), g = phases(matrix.graph);
  const id = await e('verify',()=>activeTokenId(editor));
  const roles = await m('permission-groups',()=>permissionRoles(management));
  if (id) {
    const detail = await m('token-detail',()=>management(`${root}/tokens/${id}`));
    if (detail != null && roles) await m('exact-policy',()=>policy(detail,id,roles,original.workerId));
  }
  if (matrix.management['exact-policy'] === 'ok') await probeRecoveryTarget(editor,e);
  if (await g('verify',()=>enrolledGraphId(graph,graphId))) await probeRecoveryGraph(graph,g);
  const passed = row=>Object.values(row).every(status=>status === 'ok');
  return {editorPolicyAndState:passed(matrix.editor) && passed(matrix.management),graphAndPreviews:passed(matrix.graph),gets,matrix};
}
async function main([mode, run, ...extra]) {
  requireThat(!process.env.GITHUB_ACTIONS && !process.env.CI && !extra.length && ['enroll-graph','reserve','authorize','authorize-recovery','preflight-recovery'].includes(mode), 'local owner command required');
  requireThat(JSON.parse(gh('api','user')).id === owner, 'authenticated sole owner required');
  if (mode === 'preflight-recovery') {
    requireThat(run === undefined,'read-only preflight takes no arguments');
    verifyHistorical();
    const graphId = gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo);
    const report = await recoveryPreflight(privateInput(0),privateInput(3),privateInput(4),graphId);
    console.log(JSON.stringify(report));
    if (!report.editorPolicyAndState || !report.graphAndPreviews) process.exitCode = 1;
    return;
  }
  const envId = protectedEnv(gate); protectedEnv(graphEnv);
  const pin = key=>gh('variable','get',key,'--env',graphEnv,'--repo',repo);
  requireThat(!execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim(), 'clean reviewed checkout required');
  const sha = localMain(); requireThat(pin('INCIDENT_REVIEWED_MAIN') === sha && api('branches/main').commit.sha === sha && api('branches/main').protected, 'approved protected main required');
  if (mode === 'enroll-graph') {
    requireThat(run === undefined,'unexpected argument');
    const token = privateInput(0), id = await checkedToken(client(token),client(privateInput(3)));
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
    const route = mode === 'authorize-recovery' ? recoveryMode : 'allocate';
    gh('run','download',run,'--repo',repo,'--name',`incident-preflight-${run}-1`,'--dir',tmp);
    const receipt = verify(join(tmp,'preflight.json'),p), {tag,notBefore} = checkedProof(p,route,receipt);
    const current = () => { source(p); pending(); checkedProof(p,route,receipt); };
    if (mode === 'reserve') {
      const token = privateInput(0), cf = client(token,fetch,registry);
      await checkedToken(client(token),client(privateInput(3)),undefined,bootstrapPolicy);
      const id = await reserve(cf,tag,notBefore,()=>{current(); writeOnce(join(dir,'attempt'),{tag});});
      writeOnce(join(dir,'created'),{workerId:id,tag});
      console.log(`Private empty Worker ID: ${id}. Enroll only Individual Workers Editor for this ID.`);
    } else {
      let workerId;
      if (route === recoveryMode) {
        verifyHistorical(p);
        const old = join(homedir(),'.incident-private-install',original.run);
        requireThat(isDeepStrictEqual(readdirSync(old),['attempt']) &&
          isDeepStrictEqual(JSON.parse(readFileSync(join(old,'attempt'),'utf8')),{tag}), 'historical attempt journal differs; do not edit it');
        requireThat(await checkedRecoveryGraph(client(privateInput(4)),pin('INCIDENT_GRAPH_TOKEN_ID')) === receipt.graphDigest,'live graph differs from signed recovery preflight');
        workerId = original.workerId;
      } else {
        const created = JSON.parse(readFileSync(join(dir,'created'),'utf8'));
        requireThat(created.tag === tag && immutable.test(created.workerId),'no matching completed local reservation');
        workerId = created.workerId;
      }
      const token = privateInput(0), editorId = await checkedEditor(client(token),client(privateInput(3)),workerId,tag,notBefore);
      const r = ownerClaim(p,route,receipt,workerId,editorId);
      current();
      writeOnce(join(dir,'approval-attempt'),{tag});
      setSecret('CF_INCIDENT_WORKER_EDITOR',gate,token);
      current();
      gh('api','--method','POST',`repos/${repo}/actions/runs/${run}/pending_deployments`,'-F',`environment_ids[]=${envId}`,'-f','state=approved','-f',`comment=${approvalComment(r)}`);
    }
  } finally { rmSync(tmp,{recursive:true,force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
