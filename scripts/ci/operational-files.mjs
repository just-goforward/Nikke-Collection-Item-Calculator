import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { resolve, relative, sep, join } from 'node:path';
import { createHash } from 'node:crypto';
import { GENERATED } from './operational-policy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = () => { throw new Error('SOURCE_MUTATION'); };
const safePath = path => typeof path === 'string' && path.length > 0 &&
  !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') &&
  path.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));

export async function readTrustedFile(root, path, cap) {
  if (!safePath(path) || !Number.isSafeInteger(cap) || cap < 0) reject();
  const base = resolve(root);
  if (await realpath(base) !== base || (await lstat(base)).isSymbolicLink()) reject();
  let cursor = base;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) reject();
  }
  const handle = await open(cursor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > cap || before.nlink !== 1) reject();
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject();
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

// The host pair adapter admits the immutable RO collector only after the
// producer's pinned-runtime wait/reap chain. File metadata is not a PID fence.
export async function collectSuite(root, suiteId) {
  const paths = {
    'numerical-boundary': 'numerical-boundary.json',
    'production-policy': 'production-policy.json',
    'analytics-policy': 'analytics-policy.json',
    'profile-policy': 'profile-policy.json',
    'node-runtime': 'node-runtime.json',
  };
  if (!Object.hasOwn(paths, suiteId)) reject();
  return readTrustedFile(root, paths[suiteId], 256 * 1024);
}

export async function verifySource(root, approvedBytes, approvedDigest, { generated = false } = {}) {
  if (!Buffer.isBuffer(approvedBytes) || !/^[a-f0-9]{64}$/.test(approvedDigest) ||
      hash(approvedBytes) !== approvedDigest) reject();
  const manifest = JSON.parse(approvedBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) reject();
  const ignored = manifest.generatedDirectories ?? [];
  if (ignored.some(p => !GENERATED.includes(p)) || new Set(ignored).size !== ignored.length) reject();
  const expected = new Set();
  for (const file of manifest.files) {
    if (!safePath(file.path) || expected.has(file.path) ||
        file.path === '.git' || file.path.startsWith('.git/') ||
        ignored.some(p => file.path === p || file.path.startsWith(p + '/')) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !['100644', '100755'].includes(file.mode)) reject();
    expected.add(file.path);
    const bytes = await readTrustedFile(root, file.path, file.size);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) reject();
    if (process.platform !== 'win32') {
      const executable = ((await lstat(join(root, file.path))).mode & 0o111) !== 0;
      if (executable !== (file.mode === '100755')) reject();
    }
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const path = relative(resolve(root), full).split(sep).join('/');
      if (entry.isSymbolicLink()) reject();
      if (path === '.git') {
        if (!entry.isDirectory() && !entry.isFile()) reject();
        continue;
      }
      if (generated && ignored.includes(path)) {
        if (!entry.isDirectory()) reject();
        continue;
      }
      if (entry.isDirectory()) await walk(full);
      else {
        if (!entry.isFile() || !expected.delete(path)) reject();
      }
    }
  }
  await walk(resolve(root));
  if (expected.size) reject();
  return approvedDigest;
}
