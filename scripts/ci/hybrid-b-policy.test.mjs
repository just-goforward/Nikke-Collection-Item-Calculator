import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CaseLedger} from './hybrid-b-policy-reporter.mjs';
import {inventory} from './hybrid-b-policy-inventory.mjs';
import {claimFor, exitFor, openCampaign, readCampaign, readFirstAttempt, record, validateReport} from './hybrid-b-policy-evidence.mjs';
import {readPolicyPackage, root, sha256, verifyPolicyTree} from './hybrid-b-policy-package.mjs';
import {coverage} from './hybrid-b-policy-coverage.mjs';
import {validateSuite} from './operational-results.mjs';

// Unit-only reporter events, never package or operational evidence.
const pin = 'a'.repeat(64), source = 'f'.repeat(40);
function simulate(suite,mutate = () => {}) {
  const spec = inventory(suite), ledger = new CaseLedger(suite);
  const project = {name:'chromium',retries:0,repeatEach:1};
  const config = {configFile:join(root,spec.config),projects:[project],workers:1,shard:null};
  const tests = spec.cases.map(({title}) => ({title,location:{file:join(root,spec.spec)},parent:{project:() => project},
    expectedStatus:'passed',retries:0,repeatEachIndex:0,results:[{status:'passed',retry:0,errors:[]}]}));
  const hooks = {end:true,framework:'passed'};
  mutate(tests,config,ledger,hooks);
  ledger.onBegin(config,{allTests:() => tests});
  for (const t of tests) for (const r of t.results) {
    ledger.onTestBegin(t,r); if (hooks.end) ledger.onTestEnd(t,r);
  }
  return ledger.finish({status:hooks.framework},pin);
}
for (const suite of ['product','analytics']) test(`${suite}: strict inventory, event accounting and failure retention`, () => {
  validateReport(simulate(suite),suite,pin);
  for (const change of [
    ts => ts.pop(), ts => { ts[0].title = ts[1].title; }, ts => { ts[0].location.file += '.legacy'; },
    ts => { ts[0].expectedStatus = 'failed'; }, ts => { ts[0].retries = 1; }, ts => { ts[0].repeatEachIndex = 1; },
    ts => { ts[0].results = []; }, ts => { ts[0].results[0].retry = 1; }, ts => { ts[0].results[0].errors.push({}); },
    (_,c) => { c.projects[0].name = 'legacy'; }, (_,c) => { c.projects[0].retries = 1; }, (_,c) => { c.shard = {current:1,total:2}; },
    (_ts,_c,l) => l.onError(), (_ts,_c,_l,h) => { h.end = false; }, (_ts,_c,_l,h) => { h.framework = 'interrupted'; },
    ...['skipped','timedOut','interrupted','failed'].map(status => ts => { ts[0].results[0].status = status; }),
  ]) assert.throws(() => validateReport(simulate(suite,change),suite,pin));
  const retried = simulate(suite,ts => { ts[0].results = [{retry:0,status:'failed',errors:[{}]},{retry:1,status:'passed',errors:[]}]; });
  assert.deepEqual(retried.cases[0].attempts,[{retry:0,status:'failed',failureStage:'CASE_OR_FIXTURE_UNCLASSIFIED'},{retry:1,status:'passed'}]);
  const failure = simulate(suite,ts => Object.assign(ts[0].results[0],{status:'failed',errors:[{message:'browserType.launch: No usable sandbox! private-value'}]}));
  assert.equal(failure.cases[0].attempts[0].failureStage,'BROWSER_SANDBOX');
  assert(!JSON.stringify(failure).includes('private-value'));
  assert.equal(retried.cases[0].attemptCount,2);
  assert.throws(() => validateReport(retried,suite,pin));
});

test('analytics retains an allowlisted first failing step, not the error, values or later teardown', () => {
  const privateValue = 'https://example.invalid/?token=private-value';
  const error = {message:privateValue,stack:`Error: ${privateValue}\n    private-path`};
  const later = {...error,stack:'different private-path'};
  const location = {file:join(root,'e2e/root-candidate-analytics.ts')};
  const step = (title, props = {}) => ({category:'test.step',title,location,error:{...error},...props});
  const unknown = 'CASE_OR_FIXTURE_UNCLASSIFIED';
  const check = (expected,steps,{suite='analytics',index=8,errors=[error],status='failed'} = {}) => {
    const report = simulate(suite,ts => Object.assign(ts[index].results[0],{status,errors,steps}));
    assert.deepEqual(report.cases[index].attempts,[{retry:0,status,failureStage:expected}]);
    assert.throws(() => validateReport(report,suite,pin));
    assert(!JSON.stringify(report).includes('private'));
  };
  for (const title of ['BA009_BOOT','BA009_INITIAL_CALCULATION','BA009_CONFIRM_NORMAL','BA009_SETTLED_STOCK','BA009_FOLLOWUP_HORIZON','BA009_STORAGE'])
    check(title,[step(title),step('AUDIT_CLOSE',{error:later})],{errors:[error,later]});
  for (const title of ['AUDIT_CLOSE','AUDIT_DRAIN_ROUTES','AUDIT_PAGE_ERRORS','AUDIT_VIOLATIONS'])
    check(title,[{category:'fixture',steps:[step(title)]}],{index:0});
  check(unknown,[step(privateValue)]);
  check(unknown,[step('BA009_STORAGE',{category:'expect'})]);
  check(unknown,[step('BA009_STORAGE',{location:{file:'private-path'}})]);
  check(unknown,[step('BA009_STORAGE')],{index:0});
  check(unknown,[step('AUDIT_PAGE_ERRORS')],{suite:'product'});
  check(unknown,[step('BA009_STORAGE'),step('AUDIT_CLOSE')]);
  check(unknown,[step('AUDIT_CLOSE',{error:later})],{errors:[error,later]});
  check(unknown,[],{errors:[{message:'BA009_SETTLED_STOCK'}]});
  check('CASE_TIMEOUT',[step('AUDIT_CLOSE')],{status:'timedOut'});
});

test('only a failed BA009 may retain one closed, passive action bucket', () => {
  const attempt = (values, status = 'failed', suite = 'analytics', index = 8) => {
    const report = simulate(suite,ts => Object.assign(ts[index].results[0],{
      status,errors:status === 'passed' ? [] : [{}],
      annotations:values.map(description => ({type:'ba009-rendered-action',description})),
    }));
    if (status === 'passed') validateReport(report,suite,pin);
    else assert.throws(() => validateReport(report,suite,pin));
    assert(!JSON.stringify(report).includes('private-value'));
    return report.cases[index].attempts[0];
  };
  for (const value of ['BLUE_FOUR','OTHER_BATCH','NOT_OBSERVABLE'])
    assert.equal(attempt([value]).renderedAction,value);
  for (const row of [attempt([]),attempt(['private-value']),attempt(['BLUE_FOUR','OTHER_BATCH']),
    attempt(['OTHER_BATCH'],'passed'),attempt(['BLUE_FOUR'],'failed','product'),attempt(['BLUE_FOUR'],'failed','analytics',0)])
    assert(!Object.hasOwn(row,'renderedAction'));
});

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(),'policy-unit-')));
  t.after(() => rmSync(dir,{recursive:true,force:true})); return dir;
}
test('crash, duplicate invocation, crossed packets and missing/failed process exit cannot pass', t => {
  const dir = scratch(t), suite = 'product', identity = {packetSha256:pin};
  const campaign = openCampaign(dir,pin,source,pin);
  assert.equal(readCampaign(dir,pin,source,campaign,pin),campaign);
  assert.throws(() => readCampaign(dir,pin,source,campaign,'0'.repeat(64)));
  assert.throws(() => openCampaign(dir,pin,source,pin));
  const claim = claimFor(suite,pin,source,campaign), digest = record(dir,suite,'claim',claim);
  assert.throws(() => record(dir,suite,'claim',claim),{code:'EEXIST'});
  assert.throws(() => readFirstAttempt(dir,suite,identity,source,campaign));
  const report = {...simulate(suite),claimSha256:digest}, reportDigest = record(dir,suite,'report',report);
  assert.throws(() => readFirstAttempt(dir,suite,identity,source,campaign));
  record(dir,suite,'exit',exitFor(suite,digest,reportDigest,false));
  assert.throws(() => record(dir,suite,'exit',exitFor(suite,digest,reportDigest,true)),{code:'EEXIST'});
  assert.throws(() => readFirstAttempt(dir,suite,identity,source,campaign));
});
test('completed unit records are bound to one campaign, package, suite and source', t => {
  const dir = scratch(t), suite = 'analytics', campaign = openCampaign(dir,pin,source,pin);
  const other = openCampaign(scratch(t),pin,source,pin);
  assert.notEqual(other,campaign);
  assert.throws(() => readCampaign(dir,pin,source,other,pin));
  const claim = record(dir,suite,'claim',claimFor(suite,pin,source,campaign));
  const report = record(dir,suite,'report',{...simulate(suite),claimSha256:claim});
  record(dir,suite,'exit',exitFor(suite,claim,report,true));
  assert.equal(readFirstAttempt(dir,suite,{packetSha256:pin},source,campaign).passed,inventory(suite).cases.length);
  for (const args of [[suite,pin,source,other],[suite,'b'.repeat(64),source,campaign],[suite,pin,'0'.repeat(40),campaign],['product',pin,source,campaign]]) {
    const [s,packetSha256,h,c] = args;
    assert.throws(() => readFirstAttempt(dir,s,{packetSha256},h,c));
  }
});
test('physical inventory checks every file, byte count, digest and serving-control file', async t => {
  const dir = scratch(t), hd = sha256('headers'), entry = {bytes:3,sha256:sha256('abc')}, files = {'/index.html':entry};
  for (const [name,bytes] of [['_headers','headers'],['.assetsignore','/.vite/\n'],['index.html','abc']])
    writeFileSync(join(dir,name),bytes);
  await verifyPolicyTree(dir,files,hd); // A tree check only; no packet or suite report is made.
  await assert.rejects(verifyPolicyTree(dir,files,pin));
  await assert.rejects(verifyPolicyTree(dir,{...files,'/missing':entry},hd));
  await assert.rejects(verifyPolicyTree(dir,{'/index.html':{...entry,bytes:4}},hd));
  writeFileSync(join(dir,'index.html'),'bad');
  await assert.rejects(verifyPolicyTree(dir,files,hd));
  writeFileSync(join(dir,'index.html'),'abc');
  writeFileSync(join(dir,'extra'),'abc');
  await assert.rejects(verifyPolicyTree(dir,files,hd));
  rmSync(join(dir,'extra')); symlinkSync('index.html',join(dir,'extra'));
  await assert.rejects(verifyPolicyTree(dir,{...files,'/extra':entry},hd));
});
test('a copied layout, self-report or legacy document is not a trusted private production packet', async t => {
  const dir = scratch(t), old = process.env.ROOT_POLICY_PACKET_SHA256;
  t.after(() => { if (old === undefined) delete process.env.ROOT_POLICY_PACKET_SHA256; else process.env.ROOT_POLICY_PACKET_SHA256 = old; });
  const bytes = Buffer.from(JSON.stringify({profile:'ISOLATED_LOCAL_ROOT_CANDIDATE',productionDeployable:false}));
  writeFileSync(join(dir,'functional-layout.json'),bytes);
  delete process.env.ROOT_POLICY_PACKET_SHA256;
  await assert.rejects(readPolicyPackage(dir),/precommitted/);
  process.env.ROOT_POLICY_PACKET_SHA256 = sha256(bytes);
  await assert.rejects(readPolicyPackage(dir),{code:'ENOENT'});
  writeFileSync(join(dir,'private-root-pair.json'),bytes);
  process.env.ROOT_POLICY_PACKET_SHA256 = pin;
  await assert.rejects(readPolicyPackage(dir),/custody mismatch/);
  process.env.ROOT_POLICY_PACKET_SHA256 = sha256(bytes);
  await assert.rejects(readPolicyPackage(dir));
});
test('all legacy obligations remain explicit and no legacy/candidate report passes the other decoder', () => {
  const bytes = readFileSync(join(root,'e2e/operational-inventory.json')), old = JSON.parse(bytes);
  const mapped = coverage();
  assert.deepEqual(mapped.map(r => r.id),[...old.suites['production-policy'],...old.suites['analytics-policy']]);
  assert(mapped.every(r => r.disposition === 'blocking-port-or-review' && r.remaining));
  for (const [suite,legacy] of [['product','production-policy'],['analytics','analytics-policy']]) {
    const report = {schemaVersion:1,suiteId:legacy,inventoryDigest:sha256(bytes),complete:true,
      cases:old.suites[legacy].map(id => ({id,status:'passed',attempts:1}))};
    assert.throws(() => validateReport(report,suite,pin));
    assert.throws(() => validateSuite(Buffer.from(JSON.stringify(simulate(suite))),bytes,sha256(bytes),legacy));
    assert.throws(() => validateReport(simulate(suite),suite,'b'.repeat(64)));
  }
});
