import {hash} from 'node:crypto';

export const account = '15be33fd20ea78eb3d60b719be831148';
export const zone = '2ed78e90cd4834066e079282aea4acb2';
export const name = 'collection-kit-production-incidents';
export const db = '9a516350-d7d8-4a77-9cce-45d669fd3502';
export const namespace = '419204';
export const root = `/accounts/${account}`, workers = `${root}/workers`, registry = `${workers}/workers`;
const script = `${workers}/scripts/${name}`;
export const immutable = /^[a-f0-9]{32}$/, versionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const digest = bytes => hash('sha256', bytes);
export function requireThat(ok, message) { if (!ok) throw Error(message); }
const list = value => { requireThat(Array.isArray(value), 'missing provider list'); return value; };
export function client(token, send = fetch, postPath = null) {
  requireThat(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'credential missing or malformed');
  return async (path, data) => {
    requireThat(data === undefined || (path === postPath && (path === registry || new RegExp(`^${registry}/[0-9a-f]{32}/versions\\?deploy=true$`).test(path))), 'write outside phase capability');
    requireThat(path.startsWith(`${root}/`) || path.startsWith(`/zones/${zone}/`) || path === `/zones?account.id=${account}&per_page=50`, 'unexpected provider path');
    const method = data === undefined ? 'GET' : 'POST';
    let response;
    try { response = await send(`https://api.cloudflare.com/client/v4${path}`, {method, redirect:'error', signal:AbortSignal.timeout(15000), headers:{authorization:`Bearer ${token}`, ...(data && {'content-type':'application/json'})}, body:data && JSON.stringify(data)}); }
    catch { throw Error(`provider ${method} transport failure; no retry`); }
    requireThat(response.ok, `provider ${method} HTTP ${response.status}; no retry`);
    let value; try { value = await response.json(); } catch { throw Error('ambiguous provider response; no retry'); }
    requireThat(value?.success === true && value.result != null && Array.isArray(value.errors) && !value.errors.length, 'provider result not unambiguously successful');
    if (value.result_info) {
      const {page, total_pages, total_count, count} = value.result_info;
      // Graph readers use one full inventory page or deliberately filter to a single absent resource.
      if (!path.endsWith('/deployments?per_page=1')) requireThat((page ?? 1) === 1 && (total_pages ?? 1) <= 1 && (total_count == null || total_count === count), 'incomplete provider inventory');
    }
    return value.result;
  };
}
export function privateWorker(w, id, tag, empty, notBefore) {
  requireThat(Number.isSafeInteger(notBefore) && Date.parse(w.created_on) >= notBefore && Date.parse(w.created_on) <= Date.now(), 'Worker not created in this attested reservation window');
  requireThat(immutable.test(id) && w.id === id && w.name === name, 'Worker identity mismatch');
  requireThat(w.subdomain?.enabled === false && w.subdomain?.previews_enabled === false && w.logpush === false && w.observability?.enabled === false && (!w.tail_consumers || list(w.tail_consumers).length === 0), 'Worker not private');
  requireThat(w.references && ['workers','domains','dispatch_namespace_outbounds','durable_objects','queues'].every(k=>Array.isArray(w.references[k])) && Object.values(w.references).every(a=>Array.isArray(a) && !a.length), 'incoming Worker references not proven empty');
  requireThat(list(w.tags).length === 1 && w.tags[0] === tag, 'reservation tag mismatch');
  requireThat(empty ? w.deployed_on === null : typeof w.deployed_on === 'string', 'unexpected deployment state');
}
export async function inventory(cf) {
  const rows = list(await cf(`${registry}?per_page=100`));
  requireThat(rows.length >= 20 && rows.length < 100 && rows.every(w => immutable.test(w.id) && /^[a-zA-Z0-9_-]+$/.test(w.name)) && new Set(rows.map(w=>w.id)).size === rows.length && new Set(rows.map(w=>w.name)).size === rows.length, 'account Worker inventory incomplete or ambiguous');
  return rows;
}
export async function absent(cf) { requireThat(!(await inventory(cf)).some(w=>w.name === name), 'Worker already exists; do not adopt'); }
export async function ingress(cf) {
  const zones = list(await cf(`/zones?account.id=${account}&per_page=50`));
  requireThat(zones.length === 1 && zones[0].id === zone && zones[0].account?.id === account, 'zone inventory differs from reviewed account');
  const routes = list(await cf(`/zones/${zone}/workers/routes`));
  requireThat(!routes.some(r => r.script === name), 'Worker route exists');
  requireThat(!list(await cf(`${workers}/domains?service=${name}`)).length, 'Worker domain exists');
}
export async function graph(cf, reservedId) {
  const database = await cf(`${root}/d1/database/${db}`);
  requireThat(database.uuid === db && database.name === name, 'incorrect incident database');
  requireThat(!list(await cf(`${root}/pages/projects?per_page=1`)).length, 'Pages inventory changed');
  const all = await inventory(cf), target = all.find(w=>w.name === name);
  requireThat(reservedId ? target?.id === reservedId : !target, 'account inventory conflicts with phase');
  await ingress(cf);
  for (const w of all) {
    if (w === target) continue;
    const {deployments} = await cf(`${workers}/scripts/${w.name}/deployments?per_page=1`);
    requireThat(list(deployments).length === 1 && list(deployments[0].versions).length > 0, 'active deployment missing');
    for (const {version_id} of deployments[0].versions) {
      requireThat(versionId.test(version_id), 'invalid active version ID');
      const v = await cf(`${registry}/${w.id}/versions/${version_id}`);
      requireThat(v.id === version_id && !list(v.bindings).some(b=>b.type === 'ratelimit' && String(b.namespace_id) === namespace), 'namespace collision or unknown version');
    }
  }
}
export async function state(cf, id, tag, empty, notBefore) {
  requireThat(immutable.test(id), 'invalid immutable ID');
  for (const key of [id, name]) privateWorker(await cf(`${registry}/${key}`), id, tag, empty, notBefore);
  const sub = await cf(`${script}/subdomain`);
  requireThat(sub.enabled === false && sub.previews_enabled === false, 'HTTP ingress not disabled');
  const schedules = await cf(`${script}/schedules`);
  requireThat(!list(schedules.schedules ?? schedules).length, 'schedule exists');
  requireThat(!list(await cf(`${script}/secrets`)).length, 'secret bindings exist');
  const versions = list(await cf(`${registry}/${id}/versions?per_page=100`));
  const {deployments} = await cf(`${script}/deployments?per_page=100`);
  requireThat(versions.length === (empty ? 0 : 1) && list(deployments).length === versions.length, 'unexpected version or deployment');
  return {versions, deployments};
}
export async function noPreviews(cf, id) {
  requireThat(immutable.test(id) && !list(await cf(`${registry}/${id}/previews?per_page=1`)).length, 'Worker preview exists');
}
// Only the owner CLI calls this capability. It cannot upload code or repair privacy after creation.
export async function reserve(cf, tag, notBefore, spend) {
  await absent(cf);
  spend(); // exclusive durable attempt marker before the only non-idempotent call
  const w = await cf(registry, {name, subdomain:{enabled:false, previews_enabled:false}, logpush:false, observability:{enabled:false}, tags:[tag]});
  privateWorker(w, w.id, tag, true, notBefore);
  await state(cf, w.id, tag, true, notBefore);
  return w.id;
}
export async function editor(cf, id, tokenId) {
  const t = await cf(`${root}/tokens/verify`);
  requireThat(t.status === 'active' && immutable.test(tokenId) && t.id === tokenId, 'not the owner-approved account token');
  const scope = list(await cf(`${registry}?per_page=100`));
  requireThat(scope.length === 1 && scope[0].id === id && scope[0].name === name, 'editor visible Worker scope is not the single reserved target');
}
export function bindings(build) {
  return [{type:'d1',name:'INCIDENT_DB',id:db},{type:'ratelimit',name:'INGRESS',namespace_id:namespace,simple:{limit:60,period:60}},{type:'plain_text',name:'INCIDENT_BUILD',text:build},{type:'plain_text',name:'PUBLIC_INGRESS',text:'0'}];
}
export async function install(cf, receipt, module) {
  const {workerId:id, editorId, tag, build, moduleHash} = receipt;
  requireThat(digest(module) === moduleHash && module.length > 0 && module.length < 512*1024, 'module differs from reviewed bytes');
  await editor(cf, id, editorId);
  await state(cf, id, tag, true, receipt.notBefore);
  const v = await cf(`${registry}/${id}/versions?deploy=true`, {compatibility_date:'2026-08-14',main_module:'worker.js',bindings:bindings(build),modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:module.toString('base64')}]});
  requireThat(versionId.test(v.id), 'ambiguous version response; do not retry');
  await installed(cf, receipt, v.id);
  return v.id;
}
export async function installed(cf, {workerId:id, tag, build, moduleHash, notBefore}, vid) {
  requireThat(versionId.test(vid), 'invalid installed version');
  const {versions, deployments} = await state(cf, id, tag, false, notBefore);
  const live = await cf(`${registry}/${id}/versions/${vid}?include=modules`);
  requireThat(versions[0].id === vid && live.id === vid && live.main_module === 'worker.js' && live.compatibility_date === '2026-08-14' && list(live.modules).length === 1 && live.modules[0].name === 'worker.js' && digest(Buffer.from(live.modules[0].content_base64,'base64')) === moduleHash, 'installed module differs');
  const expected = bindings(build);
  requireThat(list(live.bindings).length === expected.length && expected.every(e=>live.bindings.some(b=>b.name === e.name && b.type === e.type && Object.entries(e).every(([k,v])=>k === 'simple' ? b.simple?.period === v.period && b.simple?.limit === v.limit : b[k] === v))), 'installed bindings differ');
  requireThat(list(deployments[0].versions).length === 1 && deployments[0].versions[0].version_id === vid && deployments[0].versions[0].percentage === 100, 'unexpected traffic split');
}
