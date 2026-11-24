import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claimFor, evidenceDir, harnessSource, knownStatus, load, record, validateReport } from './hybrid-b-policy-evidence.mjs';
import { inventory } from './hybrid-b-policy-inventory.mjs';
import { root } from './hybrid-b-policy-package.mjs';

// Do not copy console streams, test errors, URLs, attachments or browser data to evidence.
function failureStage(run) {
  const message = run.errors[0]?.message ?? '';
  if (/browserType\.launch:/.test(message)) {
    if (/No usable sandbox|Failed to move to new namespace/.test(message)) return 'BROWSER_SANDBOX';
    if (/Executable doesn't exist at/.test(message)) return 'BROWSER_EXECUTABLE_UNAVAILABLE';
    if (/error while loading shared libraries/.test(message)) return 'BROWSER_DEPENDENCY';
    if (/spawn \S+ EACCES/.test(message)) return 'BROWSER_EXEC_PERMISSION';
    return 'BROWSER_LAUNCH';
  }
  if (/^browser\.newContext:/.test(message)) return 'BROWSER_CONTEXT';
  if (/^browserContext\.newPage:/.test(message)) return 'BROWSER_PAGE';
  if (run.status === 'timedOut') return 'CASE_TIMEOUT';
  return 'CASE_OR_FIXTURE_UNCLASSIFIED';
}
export class CaseLedger {
  constructor(suite) {
    this.spec = inventory(suite);
    this.rows = new Map();
    this.failed = false;
  }
  onError() { this.failed = true; }
  onBegin(config,suite) {
    try {
      assert.equal(config.configFile, join(root,this.spec.config));
      assert.equal(config.workers,1);
      assert.equal(config.shard,null);
      assert.equal(config.projects.length,1);
      const [project] = config.projects;
      assert.equal(project.name,this.spec.project);
      assert.equal(project.retries,0);
      assert.equal(project.repeatEach,1);
      const tests = suite.allTests();
      assert.equal(tests.length,this.spec.cases.length);
      for (const test of tests) {
        const entry = this.spec.cases.find(row => row.title === test.title);
        assert(entry && !this.rows.has(entry.id));
        assert.equal(test.parent.project()?.name,project.name);
        assert.equal(test.location.file,join(root,this.spec.spec));
        assert.equal(test.expectedStatus,'passed');
        assert.equal(test.retries,0);
        assert.equal(test.repeatEachIndex,0);
        this.rows.set(entry.id,{test, begins:[], ends:[]});
      }
    } catch { this.failed = true; }
  }
  observe(test,result,kind) {
    const row = this.rows.get(this.spec.cases.find(entry => entry.title === test.title)?.id);
    if (!row || test !== row.test || row[kind].length >= 2) { this.failed = true; return; }
    row[kind].push(result);
  }
  onTestBegin(test,result) { this.observe(test,result,'begins'); }
  onTestEnd(test,result) { this.observe(test,result,'ends'); }
  finish(result,claimSha256) {
    const {suite} = this.spec;
    const cases = this.spec.cases.map(({id}) => {
      const row = this.rows.get(id), runs = row?.test.results ?? [];
      if (row?.test.expectedStatus !== 'passed' || runs.length !== 1 || row.begins.length !== 1 || row.ends.length !== 1 ||
          row.begins[0] !== runs[0] || row.ends[0] !== runs[0] || runs[0].errors.length !== 0 || runs[0].retry !== 0 || runs[0].status !== 'passed') this.failed = true;
      return {id, attemptCount:runs.length, attempts:runs.slice(0,2).map(run => ({retry:Number.isSafeInteger(run.retry) ? run.retry : -1,
        status:knownStatus(run.status) ? run.status : 'invalid', ...(run.status === 'passed' ? {} : {failureStage:failureStage(run)})}))};
    });
    return {profile:'hybrid-b-policy-observation-v1',suite,claimSha256,cases,
      frameworkStatus:['passed','failed','timedout','interrupted'].includes(result.status) ? result.status : 'invalid',
      complete:!this.failed && result.status === 'passed',releaseAdmission:false};
  }
}

export default class HybridPolicyReporter extends CaseLedger {
  constructor({suite}) {
    super(suite);
    this.dir = evidenceDir();
    const {value,digest} = load(this.dir,suite,'claim');
    assert.deepEqual(value, claimFor(suite,process.env.ROOT_POLICY_PACKET_SHA256,harnessSource(),process.env.ROOT_POLICY_CAMPAIGN_SHA256));
    this.claimSha256 = digest;
  }
  printsToStdio() { return true; }
  onEnd(result) {
    const {suite} = this.spec;
    try {
      const report = this.finish(result,this.claimSha256);
      record(this.dir,suite,'report',report);
      validateReport(report,suite,this.claimSha256);
      return {status:'passed'};
    } catch { return {status:'failed'}; }
  }
}
