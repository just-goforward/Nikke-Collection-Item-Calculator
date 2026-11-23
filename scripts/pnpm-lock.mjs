import { createHash } from 'node:crypto';

export const PNPM_VERSION = '12.21.0';
export const PNPM_LOCKFILE = 'pnpm-lock.yaml';
const reject = () => { throw new Error('Invalid pnpm lock provenance'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const namePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const safe = value => typeof value === 'string' && !/[\\\0:\r\n]/.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');

// Bootstrap runs before node_modules exists. Accept only the emitted lockfile-v9
// YAML subset; aliases, tags, merge keys and unsupported syntax fail closed.
function yaml(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  let cursor = 0;
  function scalar(raw) {
    if (raw === '{}') return Object.create(null);
    if (raw.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(raw)) reject();
      return raw.slice(1, -1).replaceAll("''", "'");
    }
    if (raw.startsWith('"')) {
      try { const value = JSON.parse(raw); if (typeof value !== 'string') reject(); return value; }
      catch { reject(); }
    }
    if (!raw || /^[!&*|>{[\]}#]/.test(raw) || /:\s|\s#|[\r\n\t]/.test(raw)) reject();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  function value(raw) {
    if (raw.startsWith('{') && raw.endsWith('}')) {
      const result = Object.create(null);
      if (raw === '{}') return result;
      for (const part of split(raw.slice(1, -1))) {
        const [key, val] = pair(part);
        if (Object.hasOwn(result, key)) reject();
        result[key] = scalar(val);
      }
      return result;
    }
    if (raw.startsWith('[') && raw.endsWith(']'))
      return raw === '[]' ? [] : split(raw.slice(1, -1)).map(scalar);
    return scalar(raw);
  }
  function split(raw) {
    const parts = []; let start = 0, quote;
    for (let i = 0; i < raw.length; i++) {
      if (quote) {
        if (raw[i] === quote) {
          if (quote === "'" && raw[i + 1] === "'") i++;
          else if (quote !== '"' || raw[i - 1] !== '\\') quote = undefined;
        }
      } else if (raw[i] === "'" || raw[i] === '"') quote = raw[i];
      else if (raw[i] === ',') { parts.push(raw.slice(start, i).trim()); start = i + 1; }
    }
    if (quote) reject();
    parts.push(raw.slice(start).trim());
    return parts;
  }
  function pair(raw) {
    const match = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^:]+):(?: (.*))?$/.exec(raw);
    if (!match) reject();
    const key = scalar(match[1]);
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype', '<<'].includes(key)) reject();
    return [key, match[2] ?? ''];
  }
  function block(indent, depth = 0) {
    if (depth > 16) reject();
    const sequence = lines[cursor]?.slice(indent).startsWith('- ');
    const result = sequence ? [] : Object.create(null);
    while (cursor < lines.length) {
      const line = lines[cursor], spaces = /^ */.exec(line)[0].length;
      if (spaces < indent) break;
      if (spaces !== indent || line.includes('\t')) reject();
      const raw = line.slice(indent); cursor++;
      if (sequence) {
        if (!raw.startsWith('- ')) reject();
        result.push(scalar(raw.slice(2)));
      } else {
        const [key, val] = pair(raw);
        if (Object.hasOwn(result, key)) reject();
        if (!val && (cursor === lines.length || /^ */.exec(lines[cursor])[0].length !== indent + 2)) reject();
        result[key] = val ? value(val) : block(indent + 2, depth + 1);
      }
    }
    return result;
  }
  const result = block(0);
  if (cursor !== lines.length) reject();
  return result;
}

// Stable API: packages[id] = {id,name,version,integrity,resolved}; importers[path]
// contains dependency groups of {specifier,version,id,snapshot}. IDs never encode
// npm installation paths. Peer contexts remain separate in snapshots.
function normalizeDocument(raw, manager = false) {
  if (raw.lockfileVersion !== '9.0' || !object(raw.importers) || !object(raw.packages) ||
      !object(raw.snapshots) || !object(raw.importers['.']) ||
      Object.keys(raw).some(key => !['lockfileVersion', 'settings', 'overrides', 'importers', 'packages', 'snapshots'].includes(key)) ||
      Object.keys(raw.packages).length > 3000) reject();
  const packages = Object.create(null), importers = Object.create(null);
  for (const [id, record] of Object.entries(raw.packages)) {
    const at = id.lastIndexOf('@'), name = id.slice(0, at), version = id.slice(at + 1);
    if (!namePattern.test(name) || !versionPattern.test(version) || !object(record) ||
        Object.keys(record).some(key => !['resolution', 'engines', 'cpu', 'os', 'libc', 'hasBin',
          'peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'deprecated'].includes(key)) ||
        (record.deprecated !== undefined && typeof record.deprecated !== 'string') ||
        !object(record.resolution) || Object.keys(record.resolution).join() !== 'integrity' ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.resolution.integrity ?? '')) reject();
    for (const field of ['os', 'cpu', 'libc']) {
      if (record[field] !== undefined && (!Array.isArray(record[field]) ||
          !record[field].every(value => typeof value === 'string' && /^!?[a-z0-9_-]+$/.test(value)))) reject();
    }
    packages[id] = Object.freeze({ id, name, version, integrity: record.resolution.integrity,
      os: record.os ?? [], cpu: record.cpu ?? [], libc: record.libc ?? [],
      resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz` });
  }
  const snapshotId = key => key.split('(')[0];
  for (const [key, snapshot] of Object.entries(raw.snapshots)) {
    if (!/^[a-zA-Z0-9@/_.+()\-]+$/.test(key) || key.length > 4096) reject();
    let position = 0;
    function peer(depth = 0) {
      if (depth > 16) reject();
      const start = position;
      while (position < key.length && !'()'.includes(key[position])) position++;
      if (!packages[key.slice(start, position)]) reject();
      while (key[position] === '(') {
        position++; peer(depth + 1);
        if (key[position++] !== ')') reject();
      }
    }
    peer();
    if (position !== key.length) reject();
    if (!packages[snapshotId(key)] || !object(snapshot) ||
        Object.keys(snapshot).some(field => !['dependencies', 'optionalDependencies', 'optional',
          'transitivePeerDependencies'].includes(field))) reject();
    for (const group of ['dependencies', 'optionalDependencies']) {
      if (snapshot[group] !== undefined && !object(snapshot[group])) reject();
      for (const [name, version] of Object.entries(snapshot[group] ?? {}))
        if (!Object.hasOwn(raw.snapshots, `${name}@${version}`)) reject();
    }
  }
  for (const [path, importer] of Object.entries(raw.importers)) {
    if ((path !== '.' && !safe(path)) || !object(importer)) reject();
    const normalized = Object.create(null);
    const groups = manager ? ['packageManagerDependencies'] :
      ['dependencies', 'devDependencies', 'optionalDependencies'];
    if (Object.keys(importer).some(key => !groups.includes(key) &&
        !(manager && key === 'configDependencies' && object(importer[key]) && !Object.keys(importer[key]).length))) reject();
    for (const group of groups) {
      if (importer[group] !== undefined && !object(importer[group])) reject();
      normalized[group] = Object.create(null);
      for (const [name, dep] of Object.entries(importer[group] ?? {})) {
        if (!namePattern.test(name) || !object(dep) || typeof dep.specifier !== 'string' ||
            typeof dep.version !== 'string') reject();
        const snapshot = `${name}@${dep.version}`, id = snapshotId(snapshot);
        if (!packages[id] || !Object.hasOwn(raw.snapshots, snapshot)) reject();
        normalized[group][name] = Object.freeze({ specifier: dep.specifier,
          version: packages[id].version, id, snapshot });
      }
    }
    importers[path] = normalized;
  }
  return { schemaVersion: 1, lockfileVersion: '9.0', packages, importers, snapshots: raw.snapshots };
}

export function parsePnpmLock(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024) reject();
  let documents;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    documents = text.split(/^---\r?$/m).filter(part => part.trim()).map(yaml);
  } catch { reject(); }
  if (!documents.length || documents.length > 2) reject();
  const managers = documents.filter(doc => doc.importers?.['.']?.packageManagerDependencies);
  const apps = documents.filter(doc => !doc.importers?.['.']?.packageManagerDependencies);
  if (apps.length !== 1 || managers.length !== documents.length - 1) reject();
  const app = normalizeDocument(apps[0]);
  let manager = null;
  if (managers.length) {
    manager = normalizeDocument(managers[0], true);
    const targets = ['android-arm64', 'android-x64', 'darwin-arm64', 'darwin-x64', 'freebsd-x64',
      'linux-arm64-musl', 'linux-arm64', 'linux-ppc64', 'linux-riscv64', 'linux-s390x',
      'linux-x64-musl', 'linux-x64', 'netbsd-x64', 'win32-arm64', 'win32-x64'];
    const expected = ['pnpm', ...targets.map(target => `@pnpm/exe.${target}`)].map(name => `${name}@${PNPM_VERSION}`).sort();
    if (Object.keys(manager.importers).join() !== '.' ||
        Object.keys(manager.importers['.'].packageManagerDependencies).join() !== 'pnpm' ||
        manager.importers['.'].packageManagerDependencies.pnpm.specifier !== PNPM_VERSION ||
        Object.keys(manager.packages).sort().join() !== expected.join() ||
        Object.keys(manager.snapshots).sort().join() !== expected.join() ||
        manager.packages[`pnpm@${PNPM_VERSION}`].integrity !==
          'sha512-Zv2CeO4ok1zpUXktNDZ/869cQyonVkRYIwKVM4NbjaUpu+C+UTCv1W7QcT+4eJ5Hutgtk71a4v5UsVVi1idu8A==' ||
        manager.packages[`@pnpm/exe.linux-x64@${PNPM_VERSION}`].integrity !==
          'sha512-8eufCjHXspKbNS/kh8q4Q0gqJoOuvC4Q5pgos6XS8By/nAMtP+jf8F1Cw9er840kfAX+PJ/ts+A9qnLE91rvXQ==') reject();
  }
  return { ...app, digest: createHash('sha256').update(bytes).digest('hex'), manager };
}

export function lockedPackage(lock, name, version) {
  if (!namePattern.test(name ?? '') || !versionPattern.test(version ?? '')) reject();
  const record = lock?.packages?.[`${name}@${version}`];
  if (!record) reject();
  return record;
}

export function importerDependency(lock, importer, name) {
  const groups = lock?.importers?.[importer];
  if (!groups) reject();
  const records = ['dependencies', 'devDependencies', 'optionalDependencies']
    .map(group => groups[group]?.[name]).filter(Boolean);
  if (records.length !== 1) reject();
  return lockedPackage(lock, name, records[0].version);
}

// pnpm v12.21.0: crates/deps-path/src/dep_path_to_filename.rs and
// crates/crypto-hash/src/lib.rs. Only registry snapshots admitted above apply.
export function virtualStorePackages(lock, { maxLength = process.platform === 'win32' ? 60 : 120 } = {}) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 34 || maxLength > 255) reject();
  const paths = new Set();
  return Object.keys(lock.snapshots).map(snapshot => {
    const record = lock.packages[snapshot.split('(')[0]];
    if (!record) reject();
    let directory = snapshot.replaceAll('/', '+');
    if (directory.includes('(')) {
      if (directory.endsWith(')')) directory = directory.slice(0, -1);
      directory = directory.replaceAll(')(', '_').replace(/[()]/g, '_');
    }
    if (directory.length > maxLength || directory !== directory.toLowerCase())
      directory = `${directory.slice(0, maxLength - 33)}_${createHash('sha256').update(directory).digest('hex').slice(0, 32)}`;
    const packagePath = `node_modules/.pnpm/${directory}/node_modules/${record.name}`;
    if (!safe(packagePath) || paths.has(packagePath)) reject();
    paths.add(packagePath);
    return { ...record, snapshot, packagePath };
  });
}

export function packageForVirtualStorePath(lock, path, options) {
  if (!safe(path)) reject();
  const matches = virtualStorePackages(lock, options)
    .filter(record => path === record.packagePath || path.startsWith(record.packagePath + '/'));
  if (matches.length !== 1) reject();
  return matches[0];
}
