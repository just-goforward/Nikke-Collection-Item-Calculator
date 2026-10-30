import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySource, collectSuite, readTrustedFile } from './operational-files.mjs';
import { admit, requireContainmentEvidence } from './operational-admission.mjs';
import { Supervisor } from './operational-supervisor.mjs';
import { sealedCommand } from './operational-policy.mjs';

test('detects actual raw source mutation before and after execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operational-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source'), 'approved');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [
    { path: 'source', size: 8, mode: '100644', sha256: hash('approved') }
  ] }));
  assert.equal(await verifySource(root, bytes, hash(bytes)), hash(bytes));
  await writeFile(join(root, 'source'), 'modified');
  await assert.rejects(verifySource(root, bytes, hash(bytes)), /SOURCE_MUTATION/);
  await assert.rejects(readTrustedFile(root, '../escape', 8), /SOURCE_MUTATION/);
  await assert.rejects(readTrustedFile(root, 'source', 2), /SOURCE_MUTATION/);
  await assert.rejects(collectSuite(root, '../outside'), /SOURCE_MUTATION/);
});
test('missing approval and unproven containment fail closed', () => {
  assert.throws(() => admit({}), /ADMISSION_BLOCKED/);
  assert.throws(() => requireContainmentEvidence({ transport: 'intercepted' }, 'a'.repeat(32)), /ADMISSION_BLOCKED/);
});
test('supervisor binds stage IDs and cleans namespace after cancellation', async () => {
  const calls = [];
  const supervisor = new Supervisor({ approvedStageIds: ['S06'], deadlineMs: Date.now() + 20000,
    cleanupReserveMs: 1000, adapter: {
      stop: async () => { calls.push('stop'); }, kill: async () => { calls.push('kill'); },
      remove: async () => { calls.push('remove'); }, absent: async () => { calls.push('absent'); return true; }
    } });
  const controller = new AbortController(); controller.abort();
  const command = sealedCommand('S06', { node: process.execPath, npmCli: join(tmpdir(), 'npm-cli.js'),
    root: tmpdir(), platform: process.platform });
  assert.equal(await supervisor.stage(command, {
    signal: controller.signal
  }), false);
  assert.equal(supervisor.failure, 'CANCELLED');
  assert.deepEqual(calls, ['stop', 'kill', 'remove', 'absent']);
  await assert.rejects(supervisor.stage({ ...command }, {}), /ADMISSION_BLOCKED/);
});
test('source accounting excludes only root Git metadata and approved generated directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operational-walk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source'), 'x');
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'metadata');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedDirectories: ['node_modules', 'dist'],
    files: [{ path: 'source', size: 1, mode: '100644',
      sha256: createHash('sha256').update('x').digest('hex') }] }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  await verifySource(root, bytes, digest);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.html'), 'generated');
  await assert.rejects(verifySource(root, bytes, digest), /SOURCE_MUTATION/);
  await verifySource(root, bytes, digest, { generated: true });
  await writeFile(join(root, 'extra'), 'unapproved');
  await assert.rejects(verifySource(root, bytes, digest, { generated: true }), /SOURCE_MUTATION/);
});
test('fixed report reader refuses hard-linked output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operational-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'original'), '{}');
  await link(join(root, 'original'), join(root, 'numerical-boundary.json'));
  await assert.rejects(readTrustedFile(root, 'numerical-boundary.json', 100), /SOURCE_MUTATION/);
  await assert.rejects(collectSuite(root, 'numerical-boundary'), /SOURCE_MUTATION/);
});
