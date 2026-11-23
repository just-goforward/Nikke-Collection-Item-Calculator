// No bootstrap capability here. Only the attested, UUID-addressed Editor path may write.
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {client, root, registry, requireThat, immutable, graph, noPreviews, state, install, installed, digest} from './incident-provider.mjs';
import {api, gate, ciPins, source, intent, checkIntent, approved, verify} from './incident-receipt.mjs';

const env = process.env, mode = process.argv[2], p = ciPins(env), dir = env.RUNNER_TEMP;
const load = file=>verify(join(dir,file),p);
const output = (file,data)=>writeFileSync(join(dir,file),JSON.stringify(data),{flag:'wx'});
source(p);
function reservation() {
  const absence = load('absent.json'), tag = checkIntent(p,absence);
  const envId = api(`environments/${gate}`).id;
  return approved(p,tag,api(`actions/runs/${p.run}/approvals`),envId,absence.created);
}
async function graphReader() {
  const cf = client(env.CF_INCIDENT_GRAPH_READ), t = await cf(`${root}/tokens/verify`);
  requireThat(immutable.test(t.id) && t.status === 'active' && t.id === env.INCIDENT_GRAPH_TOKEN_ID,'incorrect graph read credential');
  return cf;
}
if (mode === 'absent') {
  const module = readFileSync(join(dir,'incident-bundle/worker.js'));
  requireThat(module.length > 0 && module.length < 512*1024 && digest(module) === p.moduleHash,'independent module pin mismatch');
  await graph(await graphReader());
  output('absent.json',intent(p));
} else if (mode === 'reserved') {
  const receipt = reservation(), cf = await graphReader();
  await graph(cf,receipt.workerId); await noPreviews(cf,receipt.workerId);
  await state(cf,receipt.workerId,receipt.tag,true,receipt.notBefore);
  output('reserved.json',receipt);
} else if (mode === 'install' || mode === 'verify') {
  const receipt = reservation();
  requireThat(isDeepStrictEqual(receipt,load('reserved.json')),'reservation attestation does not match live owner approval');
  if (mode === 'install') {
    const cf = client(env.CF_INCIDENT_WORKER_EDITOR,fetch,`${registry}/${receipt.workerId}/versions?deploy=true`);
    const id = await install(cf,receipt,readFileSync(join(dir,'incident-bundle/worker.js')));
    appendFileSync(env.GITHUB_OUTPUT,`version=${id}\n`);
  } else {
    const cf = await graphReader();
    await graph(cf,receipt.workerId); await noPreviews(cf,receipt.workerId);
    await installed(cf,receipt,env.INCIDENT_VERSION);
    output('installed.json',{...receipt,phase:'private-installed',version:env.INCIDENT_VERSION});
  }
} else throw Error('unknown installer phase');
