// Observations only. Even successful qualification is not publication authority.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {childEnvironment} from './run-checked-command.mjs';
import {claimFor, controlFromCustody, evidenceDir, exitFor, harnessSource, load, openCampaign, readCampaign, readFirstAttempt, record, validateReport} from './hybrid-b-policy-evidence.mjs';
import {inventory} from './hybrid-b-policy-inventory.mjs';
import {readPolicyPackage, root} from './hybrid-b-policy-package.mjs';
import {coverage} from './hybrid-b-policy-coverage.mjs';

async function run(mode) {
  if(mode==='qualify') {
    const {privateQualification}=await import('./hybrid-b-release.mjs');
    const {checkPair}=await import('./prepare-root-pair.mjs');
    return privateQualification(process.argv.slice(3),checkPair,harnessSource,root);
  }
  const dir = evidenceDir(), source = harnessSource(), packet = process.env.ROOT_POLICY_PACKET_SHA256;
  assert(/^[a-f0-9]{64}$/.test(packet), 'precommitted packet digest required');
  const packageDir = process.env.ROOT_POLICY_CANDIDATE_DIR;
  const control=controlFromCustody(source,packet);
  if (mode === 'open') {
    // Archive this identifier in the original service attempt before either suite can run.
    console.log(openCampaign(dir,packet,source,control.digest)); return;
  }
  const campaign = readCampaign(dir,packet,source,process.env.ROOT_POLICY_CAMPAIGN_SHA256,control.digest);
  if (mode === 'inspect') {
    const {identity} = await readPolicyPackage(packageDir);
    const observations = ['product','analytics'].map(suite => readFirstAttempt(dir,suite,identity,source,campaign));
    console.log(JSON.stringify({identity,harness:source,campaignSha256:campaign,observations,coverage:coverage(),releaseAdmission:false}));
    return;
  }
  const spec = inventory(mode), claim = claimFor(mode,packet,source,campaign);
  // A process crash, killed browser, failed preflight or second invocation cannot erase this claim.
  const claimSha256 = record(dir,mode,'claim',claim);
  let verified = false, reportSha256 = null;
  try {
    const {identity} = await readPolicyPackage(packageDir);
    assert.equal(process.platform,'linux','use the frozen Linux package runner');
    assert.equal(process.version,'v26.13.1');
    const pkg = JSON.parse(readFileSync(join(root,'package.json'))), playwright = join(root,'node_modules/@playwright/test');
    assert.equal(JSON.parse(readFileSync(join(playwright,'package.json'))).version, pkg.devDependencies['@playwright/test']);
    const env = {...childEnvironment(process.env,source),ROOT_POLICY_CANDIDATE_DIR:packageDir,ROOT_POLICY_PACKET_SHA256:packet,
      ROOT_POLICY_CONTROL_SHA256:control.digest,ROOT_POLICY_CONTROL_FILE:process.env.ROOT_POLICY_CONTROL_FILE,
      ROOT_POLICY_EVIDENCE_DIR:dir,ROOT_POLICY_CAMPAIGN_SHA256:campaign};
    const child = spawnSync(process.execPath,[join(playwright,'cli.js'),'test','--config',spec.config],
      {cwd:root,env,stdio:'ignore'});
    const report = load(dir,mode,'report');
    reportSha256 = report.digest;
    assert(!child.error && child.signal === null && child.status === 0);
    validateReport(report.value,mode,claimSha256);
    assert.equal(harnessSource(),source);
    assert.deepEqual((await readPolicyPackage(packageDir)).identity,identity);
    verified = true;
  } finally {
    record(dir,mode,'exit',exitFor(mode,claimSha256,reportSha256,verified));
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { assert.equal(process.argv.length,process.argv[2]==='qualify'?5:3); await run(process.argv[2]); }
  catch { console.error('HYBRID_B_POLICY_EVIDENCE_BLOCKED'); process.exitCode = 1; }
}
