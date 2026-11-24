import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkPair, checkReview, publicMetadata, servedDigest } from './prepare-root-pair.mjs';
import { recordHandoff } from './root-pair-handoff.mjs';
import { existsSync } from 'node:fs';
import { checkEnrolledBuild, sourceLane, requireSourceReview } from './root-source-profile.mjs';
import { SERVICE_H14_BUILD } from '../../src/serviceH14/generated/build.ts';

// Parse actual workflow structure. Ruby/Psych is present on the Ubuntu and macOS runners.
const workflow = name => JSON.parse(execFileSync('ruby', ['-rjson', '-ryaml', '-e', 'print JSON.generate(YAML.safe_load(STDIN.read))'], {
  input: readFileSync(resolve(import.meta.dirname, '../../.github/workflows', `${name}.yml`)), encoding: 'utf8',
}));
const hashOf = value => hash('sha256', value);
const temp = t => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'root-prep-test-'))); t.after(() => rmSync(path, { recursive: true })); return path; };

test('no dispatch-selected authority, mutable lookup, or public write consumer for root preparation', () => {
  const w = workflow('site-worker-promote'), jobs = w.jobs, prep = jobs['prepare-root-pair'];
  const { inputs } = (w.on ?? w.true).workflow_dispatch;
  assert.deepEqual(Object.keys(inputs).sort(), ['deploy_sha', 'operation']); assert.equal(inputs.operation.default, 'prepare-root-pair');
  assert.match(prep.if, /inputs.operation == 'prepare-root-pair'/); assert.match(prep.if, /github.ref_protected/); assert.match(prep.if, /inputs.deploy_sha == github.sha/);
  assert.match(jobs.build.if, /inputs.operation == 'publish-existing'/); assert.equal(jobs.publish.needs, 'build');
  assert.equal(prep.environment, jobs.publish.environment); assert.equal(prep.environment, 'cloudflare-site-production');
  assert.deepEqual(prep.permissions, { actions: 'read', contents: 'read' }); assert.doesNotMatch(JSON.stringify(prep), /secrets\.|CLOUDFLARE_API_TOKEN|deploy-site\.ts|workflow_dispatch\s*:/);
  assert.equal(prep.env.ROOT_PAIR_REVIEW_SHA256, '${{ vars.ROOT_PAIR_REVIEW_SHA256 }}');
  assert.equal(prep.steps.find(s => s.with?.['run-id']).with['artifact-ids'], '${{ env.REVIEW_ARTIFACT }}');
  for (const s of prep.steps.filter(s => s.uses)) assert.match(s.uses, /@[0-9a-f]{40}$/);
  const prepare = prep.steps.findIndex(s => s.run === 'node scripts/ci/prepare-root-pair.mjs');
  const uploads = prep.steps.filter(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert(prepare >= 0); assert(uploads.every(s => prep.steps.indexOf(s) > prepare && s.with['if-no-files-found'] === 'error' && !s.with.overwrite && !s.if));
  assert.deepEqual(uploads.map(s => s.id ?? 'receipt'), ['rollback', 'forward', 'receipt']);
  for (const r of ['rollback', 'forward']) {
    const upload = uploads.find(s => s.id === r); assert.equal(upload.with['include-hidden-files'], true);
    assert.equal(upload.with.name, `root-${r}-` + '${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
    assert(prep.steps.some(s => s.with?.['artifact-ids'] === '${{ steps.' + r + '.outputs.artifact-id }}' && s.with.path.endsWith(`/root-roundtrip/${r}`)));
  }
  assert(jobs.publish.steps.some(s => s.with?.['artifact-ids'] === '${{ needs.build.outputs.artifact_id }}'));
  assert(jobs.publish.steps.some(s => s.run?.startsWith('node scripts/deploy-site.ts production-online-sealed')));
});

test('exact-main source status and source-only isolated profile are separate checks', () => {
  const source = workflow('site-source-verify').jobs, prod = workflow('site-worker-promote').jobs['prepare-root-pair'];
  const step = prod.steps.find(s => s.run?.includes('gh api'));
  assert.match(step.run, /\.head_sha == \$sha/); assert.match(step.run, /\.event == "push"/); assert.match(step.run, /\.run_attempt\|tostring/);
  for (const name of ['site-source-verify', 'root-source-verify', 'required-source']) assert(step.run.includes(`index("${source[name].name}") != null`));
  const job = JSON.stringify(source['root-source-verify']); assert.match(job, /loadApproval/); assert.match(job, /ISOLATED_LOCAL_ROOT_CANDIDATE/);
  assert.doesNotMatch(job, /secrets\.|upload-artifact|private-production-v1/);
  assert.equal(source['root-source-verify'].needs, 'site-source-verify');
  assert.match(source['root-source-verify'].if, /'root' \|\| needs.site-source-verify.outputs.profile == 'root-review-only'/);
  const steps = source['site-source-verify'].steps;
  for (const cmd of ['typecheck:operations', 'test:operations', 'site-deployment-artifact.test.mjs']) {
    const common = steps.find(s => s.run?.includes(cmd)); assert.equal(common.if, undefined);
    assert(steps.indexOf(common) < steps.findIndex(s => s.id === 'profile'));
  }
  for (const match of ['pnpm run build:site-production', 'assertProductionSiteCandidateProfile']) {
    assert.equal(steps.find(s => s.run?.includes(match)).if, "steps.profile.outputs.profile == 'legacy'");
  }
});

test('input-free manual source verification authenticates main before any checkout and uses the existing reviewed root lane', () => {
  const w = workflow('site-source-verify'), jobs = w.jobs, prerequisites = jobs['site-source-verify'];
  assert.deepEqual((w.on ?? w.true).workflow_dispatch, {});
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(jobs).sort(), ['required-source', 'root-source-verify', 'site-source-verify']);
  for (const j of Object.values(jobs)) {
    assert.equal(j.environment, undefined);
    assert(!j.steps.some(s => s.uses?.includes('download-artifact')));
  }
  const [guard, checkout] = prerequisites.steps;
  assert.equal(guard.name, 'Authenticate the signed protected main tip');
  assert.equal(guard.if, "github.event_name == 'workflow_dispatch'");
  assert.deepEqual(guard.env, { GH_TOKEN: '${{ github.token }}' });
  for (const s of [checkout, jobs['root-source-verify'].steps[0]]) {
    assert.match(s.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.equal(s.with.ref, '${{ github.sha }}'); assert.equal(s.with['persist-credentials'], false);
  }
  const repo = 'just-goforward/Nikke-Collection-Item-Calculator', sha = 'a'.repeat(40);
  const bytes = Buffer.from('reviewed enrollment'), pin = hashOf(JSON.stringify(['production-root-source-review-v1',repo,sha,hashOf(bytes)]));
  const env = { GITHUB_REPOSITORY:repo, GITHUB_REPOSITORY_ID:'1229775730', GITHUB_REF:'refs/heads/main', GITHUB_REF_PROTECTED:'true',
    GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_SHA:sha, GITHUB_WORKFLOW_SHA:sha, ROOT_PAIR_SOURCE_APPROVAL_SHA256:pin,
    GITHUB_WORKFLOW_REF:`${repo}/.github/workflows/site-source-verify.yml@refs/heads/main` };
  const branch = {name:'main',protected:true,commit:{sha,commit:{verification:{verified:true}}}};
  // Exercise the checked-in shell without a token or network, including a failed API read.
  const run = (overrides={}, response=branch) => spawnSync('bash', ['-c',
    `gh() { [[ "$*" == "api repos/${repo}/branches/main" && -n "$RESPONSE" ]] || return 1; printf '%s\\n' "$RESPONSE"; }\n` + guard.run],
    {env:{PATH:process.env.PATH,...env,...overrides,RESPONSE:response && JSON.stringify(response)}}).status;
  assert.equal(run(), 0);
  for (const changed of [{GITHUB_REF:'refs/tags/main'},{GITHUB_REF_PROTECTED:'false'},{GITHUB_REPOSITORY:'other/repo'},
    {GITHUB_REPOSITORY_ID:'1'},{GITHUB_WORKFLOW_REF:'other.yml'},{GITHUB_WORKFLOW_SHA:'b'.repeat(40)}]) assert.notEqual(run(changed), 0);
  for (const response of ['', {...branch,protected:false}, {...branch,commit:{...branch.commit,sha:'b'.repeat(40)}},
    {...branch,commit:{sha,commit:{verification:{verified:false}}}}]) assert.notEqual(run({},response), 0);
  assert.equal(sourceLane(bytes,env),'root');
  for (const changed of [{GITHUB_REF:'refs/heads/topic'},{GITHUB_REF_PROTECTED:'false'},{GITHUB_WORKFLOW_SHA:'b'.repeat(40)},
    {GITHUB_WORKFLOW_REF:'other.yml'},{ROOT_PAIR_SOURCE_APPROVAL_SHA256:undefined},
    {GITHUB_SHA:'b'.repeat(40),GITHUB_WORKFLOW_SHA:'b'.repeat(40)}]) assert.throws(()=>sourceLane(bytes,{...env,...changed}));
  assert.throws(()=>sourceLane(Buffer.from('different bytes'),env)); assert.throws(()=>sourceLane(null,env));
});

test('required Site status cannot pass with a failed, skipped, or cancelled applicable lane',()=>{
  const jobs=workflow('site-source-verify').jobs, g=jobs['required-source'];
  assert.equal(g.name,'Site source verification');assert.equal(Object.values(jobs).filter(j=>j.name===g.name).length,1);
  assert.equal(g.if,'always()');assert.deepEqual(g.needs,['site-source-verify','root-source-verify']);
  const [step]=g.steps;assert.deepEqual(step.env,{PREREQUISITES:'${{ needs.site-source-verify.result }}',PROFILE:'${{ needs.site-source-verify.outputs.profile }}',ROOT:'${{ needs.root-source-verify.result }}'});
  const statuses=['success','failure','skipped','cancelled'];
  for(const prerequisites of statuses) for(const profile of ['legacy','root','root-review-only','unknown','']) for(const root of statuses){
    const expected=prerequisites==='success' && (profile==='legacy' && root==='skipped' || ['root','root-review-only'].includes(profile) && root==='success');
    const result=spawnSync('bash',['-c',step.run],{env:{PREREQUISITES:prerequisites,PROFILE:profile,ROOT:root}});
    assert.ifError(result.error);assert.equal(result.status,expected?0:1,`${prerequisites}:${profile}:${root}`);
  }
});

test('legacy has no root authority; a prospective PR can be reviewed without a main SHA or public permission', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', GITHUB_REF: 'refs/pull/123/merge' };
  const bytes = Buffer.from('not a grant'); assert.equal(sourceLane(null, env), 'legacy');
  assert.equal(sourceLane(bytes, env), 'root-review-only'); assert.throws(() => requireSourceReview(bytes, env));
  const main = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/test',
    GITHUB_WORKFLOW_REF: 'example/test/.github/workflows/site-source-verify.yml@refs/heads/main' };
  assert.throws(() => sourceLane(bytes, main), /independent exact-main root source review required/);
  assert.throws(() => sourceLane(bytes, { ...main, ROOT_PAIR_SOURCE_APPROVAL_SHA256: hashOf(bytes) }), /independent exact-main/);
});

const contractPath = resolve(import.meta.dirname, '../../site-worker/production-root-release-v1.json');
test('actual proposal binds all three generated identity fields; enrollment is not release authorization',
  { skip: existsSync(contractPath) ? false : 'legacy source has no enrolled proposal' }, () => {
    const bytes = readFileSync(contractPath); assert.doesNotThrow(() => checkEnrolledBuild(bytes, SERVICE_H14_BUILD));
    for (const k of ['codeHash', 'exactWasmHash', 'nativeSourceHash'])
      assert.throws(() => checkEnrolledBuild(bytes, { ...SERVICE_H14_BUILD, [k]: hashOf(k) }), /root source identity mismatch/);
    assert.throws(() => checkEnrolledBuild(JSON.stringify({ ...JSON.parse(bytes), deploymentApproved: true }), SERVICE_H14_BUILD));
  });

test('missing independent pin, changed review bytes and private-only review all fail before build', t => {
  const dir = temp(t), bytes = JSON.stringify({ profile: 'private-production-root-v1', publicationApproved: false });
  writeFileSync(join(dir, 'public-review.json'), bytes);
  for (const [pin, error] of [[undefined, /independent review digest required/], ['1'.repeat(64), /unreviewed/], [hashOf(bytes), /independent public pair review required/]])
    assert.throws(() => checkReview(dir, pin, '', '', Buffer.alloc(0)), error);
});

test('role comparisons require the exact three changed documents; stable paths and lengths cannot be spliced', () => {
  const file = s => ({ bytes: s.length, sha256: hashOf(s) });
  const tree = s => Object.fromEntries(['/index.html', '/en/index.html', '/ja/index.html', '/assets/x.js'].map(p => [p, file(p.endsWith('html') ? p + s : 'shared')]));
  const files = { forward: tree('new'), rollback: tree('old'), headersSha256: hashOf('header') };
  const pair = { profile: 'private-production-root-v1', productionDeployable: false, publicationApproved: false,
    review: { source: 'test-only', contractSha256: hashOf('contract') }, files };
  // This tests only structural equivalence, not an approval or a positive sealed release.
  const expected = { source: pair.review.source, enrollmentContractSha256: pair.review.contractSha256, headersSha256: files.headersSha256,
    directions: Object.fromEntries(['forward', 'rollback'].map(role => [role, { servedSha256: servedDigest(files[role]) }])) };
  assert.doesNotThrow(() => checkPair(expected, pair));
  assert.equal(servedDigest(files.forward), servedDigest(Object.fromEntries(Object.entries(files.forward).reverse())));
  assert.throws(() => checkPair(expected, { ...pair, files: { ...files, rollback: files.forward } }), /unreviewed rollback tree/);
  files.forward['/assets/x.js'].bytes++; assert.throws(() => checkPair(expected, pair), /unreviewed forward tree/);
  files.forward['/assets/x.js'] = file('other'); expected.directions.forward.servedSha256 = servedDigest(files.forward);
  assert.throws(() => checkPair(expected, pair), /only the three localized app documents may differ/);
});

test('neither direction can substitute private or verification-only receipts, even with matching file digests', t => {
  const dir = temp(t);
  for (const [role, profile] of [['rollback', 'production-k1r2-verification-only'], ['forward', 'private-production-root-v1']]) {
    const input = join(dir, role), dist = join(dir, `${role}-dist`); mkdirSync(input); mkdirSync(dist);
    const bytes = JSON.stringify({ profile, deploymentApproved: false, solverApproval: 'NONDEPLOYABLE_SERVICE_CANDIDATE' });
    writeFileSync(join(input, 'local-operational-profile.json'), bytes);
    assert.throws(() => publicMetadata(role, dir, dist, {}, { directions: { [role]: { operationalSha256: hashOf(bytes) } } }), /production-root-pair-release-v1/);
  }
});

test('handoff cannot claim an absent immutable artifact; no receipt is created', t => {
  const dir = temp(t), out = join(dir, 'root-pair'); mkdirSync(out); writeFileSync(join(out, 'digests.json'), '{}');
  const sha = '1'.repeat(40), repository = 'sample/offline';
  assert.throws(() => recordHandoff({ RUNNER_TEMP: dir, GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha, GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/site-worker-promote.yml@refs/heads/main`, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }), /missing rollback artifact ID/);
  assert.throws(() => readFileSync(join(out, 'receipt/handoff.json')), { code: 'ENOENT' });
});
