import { isAbsolute, relative, sep } from 'node:path';
import { HEX, sha256, fail, safePath, STAGES, GENERATED, NPM_SRI } from './operational-policy.mjs';
import { validateFootprint } from './operational-storage.mjs';
import { validateRuntimePins } from './operational-runtime-profile.mjs';

// Temporary R8 execution interlock. Removal requires an approved kernel fence,
// independent review, and subsequent Lead execution/pin approval. No input unlocks it.
export function assertOperationalExecutionAllowed() {
  fail('ADMISSION_BLOCKED');
}

export function admit(input) {
  assertOperationalExecutionAllowed();
  return validateDetachedApprovalModel(input);
}

// Pure model validation is not execution authorization.
export function validateDetachedApprovalModel({ approvalBytes, approvalDigest, approvalPath, checkout, eventName,
  eventSha, expectedSha, head, parents, tree, publicPaths }) {
  if (!Buffer.isBuffer(approvalBytes) || !HEX.test(approvalDigest) ||
      sha256(approvalBytes) !== approvalDigest || !isAbsolute(approvalPath ?? '') ||
      !isAbsolute(checkout ?? '')) fail();
  const inside = relative(checkout, approvalPath);
  if (!(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))) fail();
  let a;
  try { a = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(approvalBytes)); }
  catch { fail(); }
  if (eventName !== 'workflow_dispatch' || !/^[a-f0-9]{40}$/.test(head ?? '') ||
      expectedSha !== head || eventSha !== head || a.candidateSha !== head ||
      a.schemaVersion !== 1 || a.event !== eventName || a.tree !== tree ||
      !Array.isArray(parents) || JSON.stringify(a.parents) !== JSON.stringify(parents) ||
      parents.some(p => !/^[a-f0-9]{40}$/.test(p)) || !/^[a-f0-9]{40}$/.test(tree ?? '')) fail();
  validateApprovalModel(a);
  const paths = a.source.files.map(f => ({ path: f.path, mode: f.mode })).sort((x, y) => x.path.localeCompare(y.path, 'en'));
  const gitPaths = [...publicPaths].sort((x, y) => x.path.localeCompare(y.path, 'en'));
  if (JSON.stringify(paths) !== JSON.stringify(gitPaths)) fail();
  return a;
}

export function validateApproval(a) {
  assertOperationalExecutionAllowed();
  validateApprovalModel(a);
}

export function validateApprovalModel(a) {
  validateRuntimePins(a.runtime);
  if (a.executionAuthorized !== true ||
      !/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(a.image ?? '') ||
      a.platform !== 'linux/amd64' || a.node !== '26.13.0' || a.npm !== '12.2.1' ||
      !HEX.test(a.reviewedBackendDigest ?? '') ||
      JSON.stringify(a.stageIds) !== JSON.stringify(Object.keys(STAGES)) ||
      !HEX.test(a.inventoryDigest ?? '') || !HEX.test(a.nodeInventoryDigest ?? '') ||
      !HEX.test(a.lockDigest ?? '') || !HEX.test(a.provisionDigest ?? '') ||
      !HEX.test(a.seccompDigest ?? '') || !HEX.test(a.hostNodeDigest ?? '') ||
      !HEX.test(a.dockerDigest ?? '') || !HEX.test(a.nodeDigest ?? '') ||
      !HEX.test(a.npmCliDigest ?? '') || a.npmIntegrity !== NPM_SRI ||
      !a.source || a.source.schemaVersion !== 1 || !Array.isArray(a.source.files) ||
      !a.source.files.length || JSON.stringify(a.source.generatedDirectories) !== JSON.stringify(GENERATED)) fail();
  const files = new Map();
  const counts = { protected: 0, wasm: 0, fixture: 0 };
  let sourceBytes = 0;
  for (const f of a.source.files) {
    if (!safePath(f.path) || f.path === '.git' || f.path.startsWith('.git/') || files.has(f.path) ||
        !HEX.test(f.sha256 ?? '') || !['100644', '100755'].includes(f.mode) ||
        !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 2147483648 ||
        !['source', 'protected', 'wasm', 'fixture', 'lock', 'test', 'provision'].includes(f.classification) ||
        GENERATED.some(p => f.path === p || f.path.startsWith(p + '/'))) fail();
    files.set(f.path, f);
    sourceBytes += f.size;
    if (sourceBytes > 2147483648) fail();
    if (Object.hasOwn(counts, f.classification)) counts[f.classification]++;
  }
  if (counts.protected !== 136 || counts.wasm !== 13 || counts.fixture !== 46 ||
      files.get('package-lock.json')?.sha256 !== a.lockDigest ||
      files.get('package-lock.json')?.classification !== 'lock' ||
      files.get('e2e/operational-inventory.json')?.sha256 !== a.inventoryDigest ||
      files.get('scripts/ci/operational-node-inventory.json')?.sha256 !== a.nodeInventoryDigest) fail();
  const backend = [...files.values()].filter(f => /^scripts\/ci\/operational-.*\.mjs$/.test(f.path))
    .sort((x, y) => x.path < y.path ? -1 : 1).map(f => [f.path, f.sha256]);
  if (!backend.length || sha256(JSON.stringify(backend)) !== a.reviewedBackendDigest) fail();
  if (!a.testDigests || !Object.keys(a.testDigests).length) fail();
  for (const path of ['tsconfig.operational-ci.json', 'e2e/operational-console-flood.test.mjs',
    'e2e/operational-type-config.test.mjs']) {
    if (files.get(path)?.classification !== 'test' || a.testDigests[path] !== files.get(path)?.sha256) fail();
  }
  for (const [path, digest] of Object.entries(a.testDigests)) {
    if (!HEX.test(digest) || files.get(path)?.sha256 !== digest || files.get(path)?.classification !== 'test') fail();
  }
  for (const f of files.values()) {
    if ((/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f.path) || /^(?:playwright|vitest)\..*ci\.config\.ts$/.test(f.path) ||
        f.path === 'tsconfig.operational-ci.json') &&
        a.testDigests[f.path] !== f.sha256) fail();
  }
  if (!a.provision || !Array.isArray(a.provision.artifacts) ||
      sha256(JSON.stringify(a.provision)) !== a.provisionDigest) fail();
  validateFootprint(a);
}

// Consumes the detailed transport transcript, never caller-supplied success booleans.
export function requireContainmentEvidence(evidence, nonce) {
  if (!evidence || evidence.nonce !== nonce || !HEX.test(nonce ?? '') ||
      !Array.isArray(evidence.attempts) || evidence.attempts.length !== 15 ||
      !Array.isArray(evidence.interfaces) || evidence.interfaces.join(',') !== 'lo' ||
      !/^net:\[\d+\]$/.test(evidence.namespace ?? '') ||
      evidence.namespace === evidence.hostNamespace ||
      evidence.nonLoopbackRoutes !== 0 || evidence.unsafeMounts !== 0) fail();
  const wanted = new Set(['node', 'browser', 'worker'].flatMap(engine =>
    ['ipv4', 'ipv6', 'dns', 'direct', 'loopback'].map(kind => `${engine}:${kind}`)));
  for (const item of evidence.attempts) {
    if (!wanted.delete(`${item.engine}:${item.kind}`) || item.transport !== 'native' ||
        item.outcome !== (item.kind === 'loopback' ? 'connected' : 'blocked')) fail();
  }
  if (wanted.size) fail();
}

export function parseGitIdentity(commitBytes, treeBytes, headBytes) {
  const lines = commitBytes.toString('utf8').split('\n\n')[0].split('\n');
  const head = headBytes.toString('utf8').trim();
  const trees = lines.filter(line => line.startsWith('tree '));
  const parents = lines.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (trees.length !== 1 || !/^[a-f0-9]{40}$/.test(head)) fail();
  const tree = trees[0].slice(5);
  const publicPaths = treeBytes.toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(line);
    if (!match || !safePath(match[2])) fail();
    return { path: match[2], mode: match[1] };
  });
  return { head, parents, tree, publicPaths };
}
