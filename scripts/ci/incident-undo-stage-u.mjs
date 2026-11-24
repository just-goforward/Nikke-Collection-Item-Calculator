// One inactive successor of the exact layout receipt. No deploy, route, schedule or recovery writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baseline, privateGraph, target } from './incident-canary-control.mjs';
import { beforeIds, checkedCredentials, checkedMain, checkedMobileMain, closed, historicalEditor, privateInput, publicBindings, publicHash, uploadReadbacks } from './incident-owner-upload-only.mjs';
import { activeTokenId, digest, immutable, versionId, zone, account, client } from './incident-provider.mjs';
import { original } from './incident-recovery-id.mjs';
import { api, gh, graphEnv, owner, protectedEnv, repo } from './incident-receipt.mjs';
import { checkApproval } from './incident-mobile-successor.mjs';
import { checkLayoutVersion, checkOwnerDirectory, checkReceiverVersion, layoutU, readLayoutU, readStageU, stageU, stageUPredecessor } from './incident-stage-u-evidence.mjs';
import { checkEnrolledBuild, requireReviewedBytes } from './root-source-profile.mjs';

const parent = 'c552ebfc4763119368418598f6d56f2c937abdc1';
const gateStep = 'Verify single inactive Undo successor (offline)';
const undoBuild = '670227ca951c6390ec4bfc94705f645378720de51edab254bafa3e5ec3a5f951';
const undoContract = '950422dfe31f33bac0632d46736f0bfed819855845b43e5b22b596eec6279c56';
const undoBindings = '7c8a14cab315650b33154d5d6428b76248b8cbd5c160f01144e7768f6604cd87';
const paths = Object.freeze([
  '.github/workflows/site-source-verify.yml', 'docs/candidate-toolchain.md', 'e2e/stock-undo.fixture.tsx', 'e2e/stock-undo.test.mjs',
  'production-incidents/RUNBOOK.ko.md', 'scripts/ci/incident-mobile-successor.mjs', 'scripts/ci/incident-mobile-successor.test.mjs',
  'scripts/ci/incident-owner-activate.test.mjs', 'scripts/ci/incident-undo-stage-u.mjs', 'scripts/ci/incident-undo-stage-u.test.mjs',
  'site-worker/production-root-release-v1.json', 'src/components/StockPanel.tsx', 'src/serviceH14/generated/build.ts',
]);

export function checkUndoStageUSource(head, git) {
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD'), `${head} ${parent}`, 'expected exact protected Undo squash');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'dirty Undo checkout');
  assert.deepEqual(git('diff', '--no-renames', '--name-only', parent, head).split('\n').sort(), paths, 'unexpected Undo Stage U source paths');
}
const previous = Object.freeze([...beforeIds, stageUPredecessor, stageU.version, layoutU.version].sort());
const inherited = ['ADMIN_ID', 'BOT_TOKEN'];
const sha = /^[a-f0-9]{64}$/;
const windowOpen = (until, now = Date.now()) => assert(Number.isSafeInteger(until) && now < until * 1000 && until * 1000 <= now + 3600000, 'outside signed Undo upload window');

export function unusedUndoSlot(dir) {
  checkOwnerDirectory(dir);
  const slot = join(dir, 'successor-of-' + layoutU.version);
  assert.equal(lstatSync(slot, { throwIfNoEntry: false }), undefined, 'Undo attempt already consumed; retain its original journal');
  return slot;
}

function sync(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function record(dir, name, value) {
  writeFileSync(join(dir, name), JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  sync(dir);
}

export function undoUploadScope({ head, contract, build, until, topology, editorId, readerId }) {
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(topology, sha);
  assert.equal(contract, undoContract, 'unreviewed Undo contract');
  assert.equal(build, undoBuild, 'unreviewed Undo service build');
  assert.equal(digest(JSON.stringify(publicBindings(build))), undoBindings, 'unreviewed Undo receiver bindings');
  assert.match(editorId, immutable); assert.match(readerId, immutable); assert.notEqual(editorId, readerId);
  return {
    operation: 'undo-successor-inactive-upload-v1', repository: repo, source: head, contract, account,
    worker: original.workerId, predecessor: layoutU.version, predecessorReceipt: layoutU,
    build, module: publicHash, bindingsSha256: undoBindings,
    donor: baseline.donor, inertDeployment: closed.deployment, topology, editorId, readerId, until,
  };
}

function receiverChecks(read) {
  const { expectClosed, exact, inventory, verifyKnown } = uploadReadbacks(read);
  const routes = async () => {
    const rows = await read('/zones/' + zone + '/workers/routes');
    assert.equal(rows.length, 3);
    for (const [id, path, script] of [
      ['863270c636c945b8b788c329c9762f50', '/preview/*', 'collection-kit-site-preview-k1r2'],
      ['483199a1890b4fb696b38d53b6d63e3c', '/api/calendar', 'collection-kit-conditional-production'],
      ['85e95eb76fd94eeba4531b7b26caa11c', '/api/joint-supply/v2', 'collection-kit-conditional-production'],
    ]) assert(rows.some(r => r.id === id && r.pattern === 'nikkecollection.com' + path && r.script === script && r.request_limit_fail_open === false));
  };
  const history = async () => {
    await routes(); await expectClosed(); await verifyKnown();
    await exact(stageUPredecessor, publicHash, inherited, 'worker.js', publicBindings());
    await checkReceiverVersion(read, stageU.build);
    await checkLayoutVersion(read, layoutU.build);
  };
  return { expectClosed, exact, inventory, routes, history };
}

export async function reviewUndoScope(context) {
  const { dir, read, until } = context;
  windowOpen(until); unusedUndoSlot(dir);
  const { history, inventory } = receiverChecks(read);
  await history(); assert.deepEqual(await inventory(), previous);
  const scope = undoUploadScope({ ...context, topology: await privateGraph(read) });
  unusedUndoSlot(dir); windowOpen(until);
  return { scope, scopeSha256: digest(JSON.stringify(scope)), uploadAuthorized: false };
}

export async function uploadUndoInactive(context) {
  const { dir, read, until, module, send, token, authorize } = context;
  assert(module.length > 0 && module.length < 512 * 1024 && digest(module) === publicHash, 'wrong public receiver module');
  const { scope } = await reviewUndoScope(context);
  const approval = await authorize(scope);
  assert.deepEqual((await reviewUndoScope(context)).scope, scope);
  assert.deepEqual(await authorize(scope), approval); windowOpen(until);
  const { expectClosed, exact, inventory, routes, history } = receiverChecks(read);
  const slot = unusedUndoSlot(dir); mkdirSync(slot, { mode: 0o700 }); sync(dir);
  record(slot, 'intent.json', { scope, approval }); windowOpen(until);
  let id;
  try {
    const settings = publicBindings(scope.build);
    const response = await send('https://api.cloudflare.com/client/v4' + target + '/versions?deploy=false', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-08-14', compatibility_flags: [],
        bindings: [...settings, ...inherited.map(name => ({ name, type: 'inherit', version_id: baseline.donor }))],
        modules: [{ name: 'worker.js', content_type: 'application/javascript+module', content_base64: module.toString('base64') }] }),
    });
    assert(response.ok);
    const value = await response.json();
    assert(value.success === true && [value.errors, value.messages].every(x => x === null || Array.isArray(x) && !x.length));
    id = value.result.id; assert.match(id, versionId); assert(!previous.includes(id));
    record(slot, 'ack.json', { id, source: scope.source, predecessor: scope.predecessor, build: scope.build, module: scope.module, bindingsSha256: scope.bindingsSha256 });
    await exact(id, publicHash, inherited, 'worker.js', settings);
    await history(); assert.deepEqual(await inventory(), [...previous, id].sort());
  } finally {
    // Never infer success from an inventory and never retry an ambiguous response.
    await expectClosed(); assert.equal(await privateGraph(read), scope.topology); await routes(); await expectClosed();
  }
  windowOpen(until);
  const result = { state: 'verified-inactive-only', id, scope, approval, verifiedAt: Date.now(), activationAuthorized: false };
  record(slot, 'verified.json', result);
  return result;
}

async function main([file, end, proposedEditor, ...extra]) {
  const preview = file === '--review-scope';
  assert(file && /^\d{10}$/.test(end) && !extra.length &&
    (preview ? typeof proposedEditor === 'string' && immutable.test(proposedEditor) : proposedEditor === undefined) &&
    !process.env.CI && !process.env.GITHUB_ACTIONS);
  const until = Number(end); windowOpen(until);
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(realpathSync(process.cwd()), realpathSync(cwd), 'run from the exact reviewed checkout');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD'), dir = join(userInfo().homedir, '.incident-owner-upload-only');
  const readVar = name => gh('variable', 'get', name, '--env', graphEnv, '--repo', repo);
  const source = () => {
    checkUndoStageUSource(head, git);
    assert.equal(JSON.parse(gh('api', 'user')).id, owner);
    protectedEnv(graphEnv);
    checkedMain(head, api, gateStep); // Push-only; never substitutes an isolated PR or a manual run.
    checkedMobileMain(head, api); // Require all three exact source jobs and the prior controls as well.
  };
  source(); const predecessor = readLayoutU(dir); unusedUndoSlot(dir);
  const contractBytes = readFileSync(join(cwd, 'site-worker/production-root-release-v1.json'));
  const verifyApprovalPin = () => requireReviewedBytes(contractBytes, {
    GITHUB_REPOSITORY: repo, GITHUB_SHA: head,
    ROOT_PAIR_SOURCE_APPROVAL_SHA256: gh('variable', 'get', 'ROOT_PAIR_SOURCE_APPROVAL_SHA256', '--repo', repo).trim(),
  });
  verifyApprovalPin();
  const { assertServiceH14Build } = await import('../service-h14-integrity.ts');
  const identity = await assertServiceH14Build();
  checkEnrolledBuild(contractBytes, identity);
  const request = { head, contract: digest(contractBytes), build: identity.codeHash, until, dir };
  const retained = process.env.INCIDENT_U_RETAINED_PROOF_DIR;
  if (retained !== undefined) checkOwnerDirectory(retained);
  const retired = historicalEditor(retained);
  const excluded = new Set([retired, readStageU(dir).scope.editorId, predecessor.scope.editorId]);
  if (preview) {
    const read = client(privateInput(4)), readerId = await activeTokenId(read);
    assert.equal(readerId, readVar('INCIDENT_GRAPH_TOKEN_ID')); assert(!excluded.has(proposedEditor));
    const result = await reviewUndoScope({ ...request, editorId: proposedEditor, readerId, read });
    source(); verifyApprovalPin(); readLayoutU(dir); unusedUndoSlot(dir); windowOpen(until);
    console.log(JSON.stringify(result)); return;
  }
  assert(!process.stdin.isTTY, 'owner credentials require private descriptors');
  const module = readFileSync(file), credentials = await checkedCredentials(retired, until);
  assert(credentials.issued > predecessor.verifiedAt && !excluded.has(credentials.editorId), 'fresh Undo-only Editor required');
  const authorize = async scope => {
    source(); verifyApprovalPin(); readLayoutU(dir); unusedUndoSlot(dir); await credentials.recheck();
    const cid = readVar('INCIDENT_UNDO_OWNER_COMMENT_ID'); assert.match(cid, /^[1-9][0-9]{0,15}$/);
    const comment = api('comments/' + cid); assert.equal(String(comment.id), cid);
    return checkApproval(scope, comment, readVar('INCIDENT_UNDO_TECH_REVIEW'), readVar('INCIDENT_UNDO_TECH_REVIEW_KEY'));
  };
  console.log(JSON.stringify(await uploadUndoInactive({ ...request, ...credentials, module, authorize, send: fetch })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(() => {
  console.error('Stopped: preserve original and Undo journals. Never replay or infer an ACK; authenticated reads only.');
  process.exitCode = 1;
});
