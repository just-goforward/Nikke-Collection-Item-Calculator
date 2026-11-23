import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePnpmLock, importerDependency, virtualStorePackages,
  packageForVirtualStorePath } from './pnpm-lock.mjs';

const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const fixture = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.0(bar@2.0.0)
packages:
  foo@1.0.0:
    resolution: {integrity: ${integrity}}
  bar@2.0.0:
    resolution: {integrity: ${integrity}}
snapshots:
  foo@1.0.0(bar@2.0.0):
    dependencies:
      bar: 2.0.0
  bar@2.0.0: {}
`;

test('registry importer provenance retains peer-qualified physical package identities', () => {
  const lock = parsePnpmLock(fixture);
  assert.equal(importerDependency(lock, '.', 'foo').resolved, 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz');
  const path = 'node_modules/.pnpm/foo@1.0.0_bar@2.0.0/node_modules/foo/index.js';
  assert.equal(packageForVirtualStorePath(lock, path).snapshot, 'foo@1.0.0(bar@2.0.0)');
  for (const invalid of [path.replace('bar@2.0.0', 'bar@3.0.0'), path.replace('/foo/index', '/foobar/index'),
    path.replace('foo@1.0.0_bar@2.0.0', 'foo@1.0.0'), `../${path}`])
    assert.throws(() => packageForVirtualStorePath(lock, invalid), /Invalid pnpm lock provenance/);
});

test('virtual-store shortening matches pnpm v12 source vectors including nested peers', () => {
  const snapshot = 'eslint-plugin-testing-library@7.7.0(eslint@9.35.0(jiti@2.6.1))(typescript@6.0.3)';
  const normalized = { packages: { 'eslint-plugin-testing-library@7.7.0':
    { name: 'eslint-plugin-testing-library' } }, snapshots: { [snapshot]: {} } };
  assert.equal(virtualStorePackages(normalized, { maxLength: 120 })[0].packagePath,
    'node_modules/.pnpm/eslint-plugin-testing-library@7.7.0_eslint@9.35.0_jiti@2.6.1__typescript@6.0.3/node_modules/eslint-plugin-testing-library');
  assert.equal(virtualStorePackages(normalized, { maxLength: 60 })[0].packagePath,
    'node_modules/.pnpm/eslint-plugin-testing-libra_83c0ef4044d5733e4e09c244c25ac4c4/node_modules/eslint-plugin-testing-library');
});

test('lock reader rejects ambiguous YAML, unbound references and nonregistry artifacts', () => {
  for (const invalid of [
    fixture.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"),
    fixture.replace('  bar@2.0.0: {}', '  bar@2.0.0: {}\n  bar@2.0.0: {}'),
    fixture.replace('version: 1.0.0(bar@2.0.0)', 'version: 1.0.0(bar@3.0.0)'),
    fixture.replaceAll('1.0.0(bar@2.0.0)', '1.0.0(bar@3.0.0)'),
    fixture.replace(`{integrity: ${integrity}}`, '{tarball: https://example.org/foo.tgz}'),
    fixture.replace('dependencies:\n      foo:', 'dependencies: &alias\n      foo:'),
    `${fixture}patchedDependencies: {}\n`,
  ]) assert.throws(() => parsePnpmLock(invalid), /Invalid pnpm lock provenance/);
});

test('two-document root lock separates manager pins from application provenance and rejects substitutions', () => {
  const bytes = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url));
  const lock = parsePnpmLock(bytes);
  assert.ok(lock.manager.packages['pnpm@12.21.0']);
  assert.equal(lock.packages['pnpm@12.21.0'], undefined);
  assert.throws(() => packageForVirtualStorePath(lock,
    'node_modules/.pnpm/pnpm@12.21.0/node_modules/pnpm/bin/pnpm.mjs'), /Invalid pnpm lock provenance/);
  for (const altered of [bytes.toString().replaceAll('pnpm@12.21.0:', 'pnpm@12.17.0:'),
    bytes.toString().replace('packageManagerDependencies:', 'dependencies:'),
    bytes.toString().replace('sha512-8eufCjHXspKbNS/kh8q4Q0gqJoOuvC4Q5pgos6XS8By/nAMtP+jf8F1Cw9er840kfAX+PJ/ts+A9qnLE91rvXQ==', integrity)])
    assert.throws(() => parsePnpmLock(altered), /Invalid pnpm lock provenance/);
});
