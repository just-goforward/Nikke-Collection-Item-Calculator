import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkUndoStageUSource, reviewUndoScope, undoUploadScope, unusedUndoSlot, uploadUndoInactive } from './incident-undo-stage-u.mjs';
import { digest } from './incident-provider.mjs';
import { layoutU } from './incident-stage-u-evidence.mjs';
import { SERVICE_H14_BUILD } from '../../src/serviceH14/generated/build.ts';
import { checkApproval } from './incident-mobile-successor.mjs';
import { owner } from './incident-receipt.mjs';

const head = 'c'.repeat(40), parent = 'c552ebfc4763119368418598f6d56f2c937abdc1';
const paths = [
  '.github/workflows/site-source-verify.yml', 'docs/candidate-toolchain.md', 'e2e/stock-undo.fixture.tsx', 'e2e/stock-undo.test.mjs',
  'production-incidents/RUNBOOK.ko.md', 'scripts/ci/incident-mobile-successor.mjs', 'scripts/ci/incident-mobile-successor.test.mjs',
  'scripts/ci/incident-owner-activate.test.mjs', 'scripts/ci/incident-undo-stage-u.mjs', 'scripts/ci/incident-undo-stage-u.test.mjs',
  'site-worker/production-root-release-v1.json', 'src/components/StockPanel.tsx', 'src/serviceH14/generated/build.ts',
];

test('Stage U scope requires the exact combined #99 squash, not the product-only tree or an extra change', () => {
  const diff = `diff --no-renames --name-only ${parent} ${head}`;
  const expected = { 'rev-list --parents -n 1 HEAD': head + ' ' + parent,
    'status --porcelain --untracked-files=all': '', [diff]: paths.join('\n') };
  const probe = changes => checkUndoStageUSource(head, (...argv) => ({ ...expected, ...changes })[argv.join(' ')]);
  probe({});
  for (const v of [{ 'rev-list --parents -n 1 HEAD': `${head} ${parent} ${head}` },
    { 'status --porcelain --untracked-files=all': '?? dirty' }, { [diff]: paths.slice(3).join('\n') },
    { [diff]: [...paths, 'production-incidents/worker.ts'].join('\n') }]) assert.throws(() => probe(v));
});

test('Undo binds the generated identity, exact enrollment, and original layout receipt, never an older build', () => {
  const bytes = readFileSync(new URL('../../site-worker/production-root-release-v1.json', import.meta.url));
  const enrollment = JSON.parse(bytes);
  const input = { head, contract: digest(bytes), build: SERVICE_H14_BUILD.codeHash, until: 1796000000,
    topology: '1'.repeat(64), editorId: '2'.repeat(32), readerId: '3'.repeat(32) };
  assert.equal(enrollment.serviceCodeHash, input.build);
  assert.equal(enrollment.nativeSourceHash, SERVICE_H14_BUILD.nativeSourceHash);
  assert.equal(enrollment.nativeWasmSha256, SERVICE_H14_BUILD.exactWasmHash);
  const scope = undoUploadScope(input);
  assert.deepEqual(scope.predecessorReceipt, layoutU);
  assert.equal(scope.predecessor, layoutU.version);
  assert.equal(scope.operation, 'undo-successor-inactive-upload-v1');
  assert.notEqual(scope.bindingsSha256, layoutU.bindingsSha256);
  assert.equal(scope.module, layoutU.module);
  for (const v of [{ build: layoutU.build }, { build: 'f'.repeat(64) }, { contract: 'f'.repeat(64) },
    { editorId: input.readerId }, { topology: 'not-a-pin' }]) assert.throws(() => undoUploadScope({ ...input, ...v }));
});

test('a reserved or ambiguous slot does not consult the provider; a bad module never reaches authorization', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'incident-undo-stage-u-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const forbidden = () => assert.fail('provider or authorization was called');
  const input = { dir, until: Math.floor(Date.now() / 1000) + 60, read: forbidden, send: forbidden, authorize: forbidden };
  await assert.rejects(uploadUndoInactive({ ...input, module: Buffer.from('not the sealed module') }), /wrong public receiver module/);
  await assert.rejects(reviewUndoScope({ ...input, until: 1 }), /outside signed Undo upload window/);
  const slot = unusedUndoSlot(dir);
  assert.equal(slot, join(dir, 'successor-of-' + layoutU.version));
  mkdirSync(slot, { mode: 0o700 });
  assert.throws(() => unusedUndoSlot(dir), /already consumed/);
  await assert.rejects(reviewUndoScope(input), /already consumed/);
});

test('separate technical and owner approval bind the Undo scope and reject layout authorization', () => {
  const now = 1796000000000, at = new Date(now - 2000).toISOString();
  const scope = undoUploadScope({ head, build: SERVICE_H14_BUILD.codeHash,
    contract: digest(readFileSync(new URL('../../site-worker/production-root-release-v1.json', import.meta.url))),
    until: now / 1000 + 60, topology: '4'.repeat(64), editorId: '5'.repeat(32), readerId: '6'.repeat(32) });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const scopeSha256 = digest(JSON.stringify(scope));
  const statement = JSON.stringify({ kind: 'technical-review-only-v1', source: head, scopeSha256,
    reviewer: 'offline fixture', method: 'scope check', findings: 'fixture only', disposition: 'offline only',
    openBlockers: 0, publicationApproved: false });
  const envelope = JSON.stringify({ statement, signature: sign(null, Buffer.from(statement), privateKey).toString('base64') });
  const comment = { id: 1, commit_id: head, user: { id: owner }, author_association: 'OWNER',
    created_at: at, updated_at: at, body: `APPROVE INACTIVE UPLOAD ONLY ${scopeSha256} ${digest(envelope)}` };
  const key = publicKey.export({ format: 'jwk' }).x;
  assert.equal(checkApproval(scope, comment, envelope, key, now).scopeSha256, scopeSha256);
  for (const mutation of [{ operation: 'layout-successor-inactive-upload-v1' }, { source: 'e'.repeat(40) },
    { predecessor: layoutU.source }, { topology: 'f'.repeat(64) }, { until: scope.until + 1 }])
    assert.throws(() => checkApproval({ ...scope, ...mutation }, comment, envelope, key, now));
  assert.throws(() => checkApproval(scope, { ...comment, author_association: 'MEMBER' }, envelope, key, now));
  assert.throws(() => checkApproval(scope, comment, envelope, key, scope.until * 1000));
});
