// No bootstrap capability here. Only the attested, UUID-addressed Editor path may write.
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {client, root, registry, requireThat, immutable, graph, recoveryGraph, noPreviews, state, install, installed, digest} from './incident-provider.mjs';
import {api, gate, graphEnv, owner, ciPins, source, intent, approved, verify, verifyHistorical, recoveryIntent} from './incident-receipt.mjs';
import {recoveryMode} from './incident-recovery-id.mjs';

const env = process.env, mode = process.argv[2], p = ciPins(env), dir = env.RUNNER_TEMP;
const route = env.INCIDENT_RESERVATION;
requireThat(route === 'allocate' || route === recoveryMode,'unknown reservation mode');
const load = file=>verify(join(dir,file),p);
const output = (file,data)=>writeFileSync(join(dir,file),JSON.stringify(data),{flag:'wx'});
source(p);
if (route === recoveryMode) {
  verifyHistorical(p);
  const envId = api(`environments/${graphEnv}`).id;
  requireThat(api(`actions/runs/${p.run}/approvals`).some(r=>r.state === 'approved' && r.user.id === owner &&
    r.environments.length === 1 && r.environments[0].id === envId && r.environments[0].name === graphEnv),'fresh protected graph approval missing');
}
function reservation() {
  const proof = load('preflight.json');
  const envId = api(`environments/${gate}`).id;
  return approved(p,route,proof,api(`actions/runs/${p.run}/approvals`),envId);
}
async function graphReader() {
  const cf = client(env.CF_INCIDENT_GRAPH_READ), t = await cf(`${root}/tokens/verify`);
  requireThat(immutable.test(t.id) && t.status === 'active' && t.id === env.INCIDENT_GRAPH_TOKEN_ID,'incorrect graph read credential');
  return cf;
}
if (mode === 'preflight') {
  const module = readFileSync(join(dir,'incident-bundle/worker.js'));
  requireThat(module.length > 0 && module.length < 512*1024 && digest(module) === p.moduleHash,'independent module pin mismatch');
  const cf = await graphReader();
  let proof;
  if (route === recoveryMode) proof = recoveryIntent(p,await recoveryGraph(cf));
  else { await graph(cf); proof = intent(p); }
  source(p);
  output('preflight.json',proof);
} else if (mode === 'reserved') {
  const receipt = reservation(), cf = await graphReader();
  if (route === recoveryMode) requireThat(await recoveryGraph(cf) === receipt.graphDigest,'account graph changed after recovery preflight');
  else {
    await graph(cf,receipt.workerId); await noPreviews(cf,receipt.workerId);
    await state(cf,receipt.workerId,receipt.tag,true,receipt.notBefore);
  }
  source(p);
  requireThat(isDeepStrictEqual(reservation(),receipt),'reservation authorization changed');
  output('reserved.json',receipt);
} else if (mode === 'install' || mode === 'verify') {
  const receipt = reservation();
  requireThat(isDeepStrictEqual(receipt,load('reserved.json')),'reservation attestation does not match live owner approval');
  if (mode === 'install') {
    const cf = client(env.CF_INCIDENT_WORKER_EDITOR,fetch,`${registry}/${receipt.workerId}/versions?deploy=true`);
    const id = await install(cf,receipt,readFileSync(join(dir,'incident-bundle/worker.js')),()=>{
      source(p);
      requireThat(isDeepStrictEqual(reservation(),receipt),'install authorization changed');
    });
    appendFileSync(env.GITHUB_OUTPUT,`version=${id}\n`);
  } else {
    const cf = await graphReader();
    const graphDigest = await graph(cf,receipt.workerId);
    if (route === recoveryMode) requireThat(graphDigest === receipt.graphDigest,'account graph changed since reconciliation');
    await noPreviews(cf,receipt.workerId);
    await installed(cf,receipt,env.INCIDENT_VERSION);
    output('installed.json',{...receipt,phase:'private-installed',version:env.INCIDENT_VERSION});
  }
} else throw Error('unknown installer phase');
