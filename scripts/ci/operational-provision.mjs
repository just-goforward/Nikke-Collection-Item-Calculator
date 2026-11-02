import { createHash } from 'node:crypto';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute, relative, sep, resolve } from 'node:path';
import { HEX, NPM_SRI, fail, sha256, safePath } from './operational-policy.mjs';
import { validateFootprint } from './operational-storage.mjs';

const officialHosts = new Set(['registry.npmjs.org', 'nodejs.org', 'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com', 'download.playwright-chromium.org',
  'raw.githubusercontent.com']);
export const artifactName = item => `${item.id}.${item.kind === 'browser' ? 'zip' : 'tgz'}`;
export function validateDownload(item) {
  if (!item || !HEX.test(item.sha256 ?? '') || !Number.isSafeInteger(item.size) || item.size <= 0 ||
      item.size > 512 * 1024 * 1024 || !Array.isArray(item.redirects) || item.redirects.length > 4) fail();
  for (const url of [item.url, ...item.redirects]) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        parsed.hash || !officialHosts.has(parsed.hostname)) fail();
  }
}
export async function download(item, { fetchImpl = fetch, signal } = {}) {
  validateDownload(item);
  // Host downloads are metadata only. Package/browser bytes must already be
  // independently supplied as RO inputs and are consumed inside the producer.
  if (item.size > 8 * 1024 * 1024) fail();
  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = item.url;
  for (let hop = 0; hop <= item.redirects.length; hop++) {
    const response = await fetchImpl(current, { redirect: 'manual', signal: combined,
      headers: { 'accept-encoding': 'identity' }, credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), current).href;
      await response.body?.cancel();
      if (next !== item.redirects[hop]) fail();
      current = next;
      continue;
    }
    if (response.status !== 200 || response.headers.get('content-encoding')) {
      await response.body?.cancel(); fail();
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > item.size) fail('OVERFLOW');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== item.size || sha256(bytes) !== item.sha256) fail();
    if (item.integrity &&
        `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== item.integrity) fail();
    return bytes;
  }
  fail();
}
export function validateProvision(a, lock) {
  validateFootprint(a);
  const plan = a.provision;
  if (!Array.isArray(plan.artifacts) || !plan.artifacts.length ||
      plan.artifacts.length > 3000 || !Array.isArray(plan.lifecycles)) fail();
  const ids = new Set(), packages = new Set();
  let bytes = 0, npm = 0, browsers = 0;
  for (const item of plan.artifacts) {
    validateDownload(item);
    if (!/^[A-Z][0-9]{4}$/.test(item.id) || ids.has(item.id)) fail();
    ids.add(item.id); bytes += item.size;
    if (item.kind === 'npm') {
      npm++;
      if (item.url !== 'https://registry.npmjs.org/npm/-/npm-12.2.1.tgz' ||
          item.integrity !== NPM_SRI || item.size > 8 * 1024 * 1024 ||
          item.unpackedBytes > 64 * 1024 * 1024) fail();
    } else if (item.kind === 'package') {
      if (!safePath(item.packagePath) || packages.has(item.packagePath)) fail();
      const record = lock.packages[item.packagePath];
      if (!record || record.resolved !== item.url || record.integrity !== item.integrity) fail();
      packages.add(item.packagePath);
    } else if (item.kind === 'browser') {
      browsers++;
      if (!/^chromium(?:_headless_shell)?-[0-9]+$/.test(item.target ?? '') ||
          !Number.isSafeInteger(item.unpackedBytes) || item.unpackedBytes < item.size ||
          item.unpackedBytes > 1024 * 1024 * 1024) fail();
    } else fail();
  }
  if (npm !== 1 || !browsers || bytes > 1024 * 1024 * 1024) fail();
  for (const [path, record] of Object.entries(lock.packages)) {
    if (record.resolved?.startsWith('https:') && !record.optional && !packages.has(path)) fail();
  }
  const lifecyclePaths = new Set();
  for (const item of plan.lifecycles) {
    if (!/^node_modules\/(?:[^/]+\/node_modules\/)*(?:esbuild|workerd)$/.test(item.packagePath ?? '') ||
        lifecyclePaths.has(item.packagePath) || item.script !== 'install.js' ||
        !HEX.test(item.scriptDigest ?? '') || !packages.has(item.packagePath)) fail();
    const record = lock.packages[item.packagePath];
    if (record.version !== item.version || record.integrity !== item.integrity || !record.hasInstallScript) fail();
    lifecyclePaths.add(item.packagePath);
  }
  if (![...lifecyclePaths].some(p => p.endsWith('/esbuild')) ||
      ![...lifecyclePaths].some(p => p.endsWith('/workerd'))) fail();
}
export async function validateProvisionInputDirectory(a, root, checkout) {
  if (!isAbsolute(root ?? '') || resolve(root) !== root || await realpath(root) !== root) fail();
  const rel = relative(checkout, root);
  if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) || (await lstat(root)).isSymbolicLink()) fail();
  const expected = a.provision.artifacts.map(artifactName).sort();
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(expected)) fail();
  for (const artifact of a.provision.artifacts) {
    const st = await lstat(join(root, artifactName(artifact)));
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== artifact.size) fail();
  }
}
