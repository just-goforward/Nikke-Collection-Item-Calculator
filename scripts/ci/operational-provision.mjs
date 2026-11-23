import { createHash } from 'node:crypto';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute, relative, sep, resolve } from 'node:path';
import { HEX, PNPM_SRI, PNPM_URL, PNPM_VERSION, fail, sha256 } from './operational-policy.mjs';
import { validateFootprint, allocatedFootprint } from './operational-storage.mjs';
import { virtualStorePackages } from '../pnpm-lock.mjs';

const officialHosts = new Set(['registry.npmjs.org', 'nodejs.org', 'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com', 'download.playwright-chromium.org',
  'raw.githubusercontent.com']);
export const artifactName = item => `${item.id}.${item.kind === 'browser' ? 'zip' : item.kind === 'registry-metadata' ? 'json' : 'tgz'}`;
export function registryMetadataUrl(name) {
  if (typeof name !== 'string') fail();
  const parts = /^(?:@([a-z0-9._-]+)\/)?([a-z0-9._-]+)$/.exec(name);
  if (!parts) fail();
  const [, scope, pkg] = parts;
  if (scope === '.' || scope === '..' || pkg === '.' || pkg === '..') fail();
  return `https://registry.npmjs.org/${scope ? `@${scope}%2F` : ''}${pkg}`;
}
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
  if (plan.schemaVersion !== 2 || plan.storeFormat !== 'pnpm-12.21.0-tarball-v1' ||
      lock?.schemaVersion !== 1 || !lock.manager || lock.digest !== a.lockDigest ||
      !Array.isArray(plan.artifacts) || !plan.artifacts.length ||
      plan.artifacts.length > 3000 || !Array.isArray(plan.lifecycles)) fail();
  const ids = new Set(), packages = new Set(), metadata = new Set();
  const packageNames = new Set([...Object.values(lock.packages),
    ...Object.values(lock.manager.packages)].map(record => record.name));
  let bytes = 0, pnpm = 0, manager = 0, browsers = 0;
  for (const item of plan.artifacts) {
    validateDownload(item);
    if (!/^[A-Z][0-9]{4}$/.test(item.id) || ids.has(item.id)) fail();
    ids.add(item.id); bytes += item.size;
    if (item.kind === 'pnpm') {
      pnpm++;
      if (item.url !== PNPM_URL || item.integrity !== PNPM_SRI ||
          item.unpackedBytes > 64 * 1024 * 1024) fail();
    } else if (item.kind === 'manager-package') {
      manager++;
      const record = lock.manager.packages[`pnpm@${PNPM_VERSION}`];
      if (item.packageId !== record.id || item.url !== record.resolved ||
          item.integrity !== record.integrity || Object.hasOwn(item, 'packagePath')) fail();
    } else if (item.kind === 'registry-metadata') {
      if (!packageNames.has(item.packageName) || metadata.has(item.packageName) ||
          item.url !== registryMetadataUrl(item.packageName) ||
          !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity ?? '')) fail();
      metadata.add(item.packageName);
    } else if (item.kind === 'package') {
      if (typeof item.packageId !== 'string' || packages.has(item.packageId) ||
          Object.hasOwn(item, 'packagePath')) fail();
      const record = lock.packages[item.packageId];
      if (!record || record.resolved !== item.url || record.integrity !== item.integrity) fail();
      packages.add(item.packageId);
    } else if (item.kind === 'browser') {
      browsers++;
      if (!/^chromium(?:_headless_shell)?-[0-9]+$/.test(item.target ?? '') ||
          !Number.isSafeInteger(item.unpackedBytes) || item.unpackedBytes < item.size ||
          item.unpackedBytes > 1024 * 1024 * 1024) fail();
    } else fail();
  }
  if (pnpm !== 1 || manager !== 1 || metadata.size !== packageNames.size ||
      !browsers || bytes > 1024 * 1024 * 1024) fail();
  for (const record of Object.values(lock.packages)) {
    if (linuxPackage(record) && !packages.has(record.id)) fail();
  }
  const lifecycleIds = new Set();
  const installed = virtualStorePackages(lock, { maxLength: 120 });
  for (const item of plan.lifecycles) {
    const record = lock.packages[item.packageId];
    if (!record || !['esbuild', 'workerd'].includes(record.name) || !linuxPackage(record) ||
        lifecycleIds.has(item.snapshot) || Object.hasOwn(item, 'packagePath') ||
        !installed.some(pkg => pkg.id === item.packageId && pkg.snapshot === item.snapshot) ||
        item.script !== 'install.js' || !HEX.test(item.scriptDigest ?? '') ||
        !packages.has(item.packageId) || record.version !== item.version ||
        record.integrity !== item.integrity) fail();
    lifecycleIds.add(item.snapshot);
  }
  for (const record of installed) {
    if (linuxPackage(record) && ['esbuild', 'workerd'].includes(record.name) &&
        !lifecycleIds.has(record.snapshot)) fail();
  }
  if (!['esbuild', 'workerd'].every(name =>
    installed.some(record => record.name === name && lifecycleIds.has(record.snapshot)))) fail();
}
export function linuxPackage(record) {
  return [['os', 'linux'], ['cpu', 'x64'], ['libc', 'glibc']].every(([key, value]) => {
    const values = record[key];
    return !values.includes(`!${value}`) &&
      (!values.some(item => !item.startsWith('!')) || values.includes(value));
  });
}
export function verifyArtifact(bytes, artifact) {
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256 ||
      `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== artifact.integrity) fail();
}
export function verifyPnpmPackage(pkg) {
  if (pkg.name !== '@pnpm/exe.linux-x64' || pkg.version !== PNPM_VERSION ||
      JSON.stringify(pkg.os) !== '["linux"]' || JSON.stringify(pkg.cpu) !== '["x64"]' ||
      JSON.stringify(pkg.libc) !== '["glibc"]') fail();
}
// pnpm 12.21.0 mirror.rs accepts this two-line NDJSON layout. Retain the full
// registry document, including publish times and trust evidence; never create
// a lockfile-verification cache or bypass pnpm's supply-chain policy.
export function registryMetadataEntries(bytes, artifact, lock) {
  verifyArtifact(bytes, artifact);
  const meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const records = [...Object.values(lock.packages), ...Object.values(lock.manager?.packages ?? {})]
    .filter(record => record.name === artifact.packageName);
  if (!records.length || meta.name !== artifact.packageName || !meta.versions || !meta.time) fail();
  for (const record of records) {
    const pkg = meta.versions[record.version];
    if (pkg?.name !== record.name || pkg.version !== record.version ||
        pkg.dist?.integrity !== record.integrity || pkg.dist?.tarball !== record.resolved ||
        typeof meta.time[record.version] !== 'string' ||
        !Number.isFinite(Date.parse(meta.time[record.version]))) fail();
  }
  const body = Buffer.from('{}\n' + JSON.stringify(meta));
  const entries = ['metadata-full', 'metadata', 'metadata-full-filtered'].map(kind => ({
    path: `v12/${kind}/https%3A+registry.npmjs.org/${meta.name}.jsonl`,
    bytes: body, mode: 0o644, directory: false,
  }));
  if (allocatedFootprint(entries.map(entry => ({ path: entry.path, size: body.length }))) > artifact.unpackedBytes) fail('OVERFLOW');
  return entries;
}
export function lifecycleRecords(a, lock) {
  const installed = virtualStorePackages(lock, { maxLength: 120 });
  return a.provision.lifecycles.map(item => {
    const record = installed.find(pkg => pkg.snapshot === item.snapshot && pkg.id === item.packageId);
    if (!record) fail();
    return { packageId: record.id, snapshot: record.snapshot, packagePath: record.packagePath,
      scriptDigest: item.scriptDigest, version: item.version, integrity: item.integrity, exitCode: 0 };
  });
}
export function validateLifecyclePackage(item, record, script, pkg) {
  if (item.packageId !== record.id || sha256(script) !== item.scriptDigest ||
      pkg.name !== record.name || pkg.version !== item.version ||
      item.integrity !== record.integrity ||
      !['esbuild', 'workerd'].includes(record.name) ||
      !['node install.js', 'node ./install.js'].includes(pkg.scripts?.postinstall)) fail();
}
export function validateLifecycleReceipt(a, lock, receipt) {
  const expected = { schemaVersion: 2, pnpm: PNPM_VERSION, lockDigest: a.lockDigest,
    provisionDigest: a.provisionDigest, lifecycles: lifecycleRecords(a, lock) };
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) fail();
  return expected;
}
export function pnpmStoreAddArguments(paths, store = '/work/store') {
  if (!paths.length || paths.some(path => !isAbsolute(path) || !path.endsWith('.tgz'))) fail();
  return ['store', 'add', ...paths, '--offline', '--ignore-scripts', '--ignore-pnpmfile', `--store-dir=${store}`];
}
export function pnpmInstallArguments(store = '/work/store') {
  return ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile',
    `--store-dir=${store}`, '--config.package-import-method=copy',
    '--config.node-linker=isolated', '--config.virtual-store-dir=node_modules/.pnpm',
    '--config.virtual-store-type=project', '--config.virtual-store-dir-max-length=120',
    '--config.side-effects-cache=false', '--config.verify-store-integrity=true'];
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
