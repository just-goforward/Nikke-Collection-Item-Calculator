import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, ftruncateSync, closeSync, openSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertContext, seal, verifyRelease, workerProvenance } from "./site-release.mjs";
import { parsePnpmLock, virtualStorePackages } from "./pnpm-lock.mjs";
test("only the exact main manual workflow revision is eligible", () => {
  const sha = "a".repeat(40);
  const env = { GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/site-worker-promote.yml@refs/heads/main" };
  assert.doesNotThrow(() => assertContext(env, sha));
  for (const changes of [{ GITHUB_SHA: "b".repeat(40) }, { GITHUB_REF: "refs/heads/other" },
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_WORKFLOW_SHA: "b".repeat(40) }, { GITHUB_RUN_ID: "" }])
    assert.throws(() => assertContext({ ...env, ...changes }, sha));
});

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), "site-release-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, "checkout"), artifact = join(temporary, "release");
  const sha = "a".repeat(40), files = {};
  const put = (base, path, value) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), value);
  };
  const add = (path, bytes) => {
    put(artifact, path, bytes);
    files[path] = { bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const provenance = { checkout: root.replaceAll("\\", "/"),
    modules: join(root, "node_modules").replaceAll("\\", "/"),
    dependencies: ["shared/contract.ts", "site-worker/src/worker.ts"] };
  const source = {
    "site-worker/production.wrangler.toml": readFileSync(resolve(import.meta.dirname, "../site-worker/production.wrangler.toml")),
    "site-worker/src/worker.ts": "export default {};",
    "shared/contract.ts": "export const revision = 1;",
    "pnpm-workspace.yaml": "verifyDepsBeforeRun: error\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n",
  };
  for (const [path, bytes] of Object.entries(source)) {
    put(root, path, bytes); add(`source/${path}`, bytes);
  }
  put(root, "node_modules/wrangler/package.json", '{"version":"4.166.0"}');
  for (const path of ["manifest.json", "site-production.json", "local-operational-profile.json", "forecast-runtime.json"])
    add(`dist/.vite/${path}`, "{}");
  add("dist/.assetsignore", "/.vite/\n");
  add("dist/index.html", "<h1>verified fixture</h1>");
  add("worker/worker.js", "export default { fetch() { return new Response('sealed'); } };");
  add("worker/meta.json", JSON.stringify({
    inputs: { "src/worker.ts": {}, "../shared/contract.ts": {} },
    outputs: { "worker.js": { imports: [], entryPoint: "src/worker.ts" } },
  }));
  cpSync(join(artifact, "dist"), join(root, "dist"), { recursive: true });
  function manifest(changes = {}) {
    const bytes = JSON.stringify({ version: 1, sha, run: "123", attempt: "1",
      wrangler: "4.166.0", files, provenance, ...changes });
    put(artifact, "manifest.json", bytes);
    return createHash("sha256").update(bytes).digest("hex");
  }
  const digest = manifest();
  return { root, artifact, sha, digest, add, put, files, provenance, manifest,
    verify: (expected = digest, restored = true) =>
      verifyRelease(root, artifact, sha, expected, "123", "1", restored) };
}
test("sealed handoff admits matching Worker, source, hidden receipts and restored assets", t => {
  const f = fixture(t);
  assert.equal(f.verify(), join(f.artifact, "worker/worker.js"));
});
test("handoff rejects a changed workspace policy even when the lock is unchanged", t => {
  const f = fixture(t);
  f.put(f.root, "pnpm-workspace.yaml", "verifyDepsBeforeRun: install\n");
  assert.throws(() => f.verify(), /Release source differs from checkout/);
});
test("actual config-relative metadata and linked packages retain portable, bounded provenance", t => {
  const f = fixture(t);
  const installed = join(dirname(f.root), "installed modules");
  renameSync(join(f.root, "node_modules"), installed);
  symlinkSync(installed, join(f.root, "node_modules"), "junction");
  const packageFile = '{"name":"example","version":"1.0.0"}';
  const moduleFile = "export const dependency = 1;";
  for (const [name, bytes] of [["package.json", packageFile], ["index.js", moduleFile]]) {
    f.put(f.root, `node_modules/.pnpm/example@1.0.0/node_modules/example/${name}`, bytes);
    f.add(`source/node_modules/.pnpm/example@1.0.0/node_modules/example/${name}`, bytes);
  }
  const lock = `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  example@1.0.0:
    resolution: {integrity: sha512-${Buffer.alloc(64, 1).toString("base64")}}
snapshots:
  example@1.0.0: {}
`;
  f.put(f.root, "pnpm-lock.yaml", lock); f.add("source/pnpm-lock.yaml", lock);
  const raw = {
    inputs: { "src/worker.ts": {}, "../shared/contract.ts": {},
      [realpathSync(join(installed, ".pnpm/example@1.0.0/node_modules/example/index.js")).replaceAll("\\", "/")]: {} },
    outputs: { "worker.js": { imports: [], entryPoint: "src/worker.ts" } },
  };
  f.add("worker/meta.json", JSON.stringify(raw));
  Object.assign(f.provenance, workerProvenance(f.root, f.artifact));
  assert.deepEqual(f.provenance.dependencies, ["node_modules/.pnpm/example@1.0.0/node_modules/example/index.js",
    "node_modules/.pnpm/example@1.0.0/node_modules/example/package.json", "shared/contract.ts", "site-worker/src/worker.ts"]);
  const digest = f.manifest();
  assert.doesNotThrow(() => f.verify(digest));
  const relocated = join(dirname(f.root), "different-checkout");
  cpSync(f.root, relocated, { recursive: true, dereference: true });
  assert.doesNotThrow(() => verifyRelease(relocated, f.artifact, f.sha, digest, "123", "1", true));
  f.put(relocated, "node_modules/.pnpm/example@1.0.0/node_modules/example/index.js", "changed dependency bytes");
  assert.throws(() => verifyRelease(relocated, f.artifact, f.sha, digest, "123", "1", true), /source differs/);
  for (const outside of ["../../unapproved.ts", installed.replaceAll("\\", "/") + "-other/secret.js"]) {
    f.add("worker/meta.json", JSON.stringify({ ...raw, inputs: { ...raw.inputs, [outside]: {} } }));
    assert.throws(() => workerProvenance(f.root, f.artifact), /outside approved roots/);
  }
  f.add("worker/meta.json", JSON.stringify(raw));
  f.put(f.root, "node_modules/.pnpm/example@1.0.0/node_modules/example/package.json", '{"name":"example","version":"2.0.0"}');
  assert.throws(() => workerProvenance(f.root, f.artifact), /matching lock provenance/);
});
test("handoff rejects altered payloads, omitted receipts and extra files", t => {
  const f = fixture(t);
  f.put(f.artifact, "worker/worker.js", "export default {};");
  assert.throws(() => f.verify(), /content mismatch/);
  f.add("worker/worker.js", "export default {};");
  const digest = f.manifest();
  assert.throws(() => f.verify(f.digest), /digest mismatch/);
  assert.doesNotThrow(() => f.verify(digest));
  f.put(f.artifact, "unexpected", "unverified");
  assert.throws(() => f.verify(digest), /content mismatch/);
});
test("pnpm provenance binds exact peer snapshots, package names and physical file boundaries", t => {
  const f = fixture(t);
  const key = "node_modules/.pnpm/example@1.0.0_peer@2.0.0/node_modules/example";
  const sri = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  f.put(f.root, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  example@1.0.0:
    resolution: {integrity: ${sri}}
  peer@2.0.0:
    resolution: {integrity: ${sri}}
snapshots:
  example@1.0.0(peer@2.0.0): {}
  peer@2.0.0: {}
`);
  f.put(f.root, `${key}/package.json`, '{"name":"example","version":"1.0.0"}');
  f.put(f.root, `${key}/index.js`, "export {};");
  const metadata = path => f.add("worker/meta.json", JSON.stringify({
    inputs: { "src/worker.ts": {}, [path]: {} },
    outputs: { "worker.js": { imports: [], entryPoint: "src/worker.ts" } },
  }));
  metadata(`../${key}/index.js`);
  assert.deepEqual(workerProvenance(f.root, f.artifact).dependencies,
    [`${key}/index.js`, `${key}/package.json`, "site-worker/src/worker.ts"]);
  for (const pkg of [{ name: "other", version: "1.0.0" }, { name: "example", version: "2.0.0" }]) {
    f.put(f.root, `${key}/package.json`, JSON.stringify(pkg));
    assert.throws(() => workerProvenance(f.root, f.artifact), /matching lock provenance/);
  }
  f.put(f.root, `${key}/package.json`, '{"name":"example","version":"1.0.0"}');
  const unapproved = key.replace("peer@2.0.0", "peer@3.0.0");
  f.put(f.root, `${unapproved}/index.js`, "export {};");
  metadata(`../${unapproved}/index.js`);
  assert.throws(() => workerProvenance(f.root, f.artifact), /Invalid pnpm lock provenance/);
  metadata(`../${key}/index.js`);
  rmSync(join(f.root, key), { recursive: true });
  f.put(f.root, "node_modules/substitute/package.json", '{"name":"example","version":"1.0.0"}');
  f.put(f.root, "node_modules/substitute/index.js", "export {};");
  symlinkSync(join(f.root, "node_modules/substitute"), join(f.root, key), "junction");
  assert.throws(() => workerProvenance(f.root, f.artifact), /matching lock provenance/);
});
test("scoped pnpm packages seal and verify with source-derived virtual-store paths", t => {
  const f = fixture(t);
  const lock = readFileSync(resolve(import.meta.dirname, "../pnpm-lock.yaml"));
  const record = virtualStorePackages(parsePnpmLock(lock))
    .find(pkg => pkg.name === "@axe-core/playwright");
  assert.ok(record.packagePath.includes("@axe-core+playwright@"));
  f.put(f.root, "pnpm-lock.yaml", lock);
  f.put(f.root, `${record.packagePath}/package.json`,
    JSON.stringify({ name: record.name, version: record.version }));
  f.put(f.root, `${record.packagePath}/index.js`, "export {};");
  f.add("worker/meta.json", JSON.stringify({
    inputs: { "src/worker.ts": {}, [`../${record.packagePath}/index.js`]: {} },
    outputs: { "worker.js": { imports: [], entryPoint: "src/worker.ts" } },
  }));
  for (const path of ["source", "dist", "manifest.json"])
    rmSync(join(f.artifact, path), { recursive: true });
  const env = { GITHUB_SHA: f.sha, GITHUB_WORKFLOW_SHA: f.sha,
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/site-worker-promote.yml@refs/heads/main" };
  const git = (command, args) => {
    assert.equal(command, "git");
    if (args[0] === "rev-parse") return f.sha;
    if (args[0] === "ls-files") return "site-worker/src/worker.ts\0";
    return "";
  };
  const digest = seal(f.root, f.artifact, f.sha, env, git);
  assert.equal(f.verify(digest), join(f.artifact, "worker/worker.js"));
  assert.deepEqual(JSON.parse(readFileSync(join(f.artifact, "manifest.json"))).provenance.dependencies,
    [`${record.packagePath}/index.js`, `${record.packagePath}/package.json`, "site-worker/src/worker.ts"]);
});
test("handoff rejects missing hidden verification metadata even with a matching manifest", t => {
  const f = fixture(t);
  rmSync(join(f.artifact, "dist/.vite/site-production.json"));
  delete f.files["dist/.vite/site-production.json"];
  assert.throws(() => f.verify(f.manifest()), /Missing release file/);
});
test("handoff binds SHA, run and attempt independently of the artifact name", t => {
  const f = fixture(t);
  for (const changes of [{ sha: "b".repeat(40) }, { run: "124" }, { attempt: "2" }])
    assert.throws(() => f.verify(f.manifest(changes)), /identity mismatch/);
});
test("handoff requires exact checkout dependencies and complete Worker source", t => {
  const f = fixture(t);
  f.put(f.root, "shared/contract.ts", "export const revision = 2;");
  assert.throws(() => f.verify(), /source differs/);
  f.put(f.root, "shared/contract.ts", "export const revision = 1;");
  f.put(f.root, "site-worker/src/missing.ts", "export {};");
  assert.throws(() => f.verify(), /Missing Worker source/);
});
test("handoff rejects restored assets differing from the sealed payload", t => {
  const f = fixture(t);
  f.put(f.root, "dist/index.html", "not the sealed asset");
  assert.throws(() => f.verify(), /Restored assets differ/);
});
test("prebuilt mode refuses config changes that could execute custom builds", t => {
  const f = fixture(t), path = "site-worker/production.wrangler.toml";
  const config = readFileSync(join(f.root, path), "utf8") + '\n[build]\ncommand = "echo forbidden"\n';
  f.put(f.root, path, config); f.add(`source/${path}`, config);
  assert.throws(() => f.verify(f.manifest()), /compatibility review/);
});
test("handoff refuses external modules rather than publishing unsealed dependencies", t => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.verify());
  const meta = JSON.parse(readFileSync(join(f.artifact, "worker/meta.json"), "utf8"));
  meta.outputs["worker.js"].imports = [{ path: "./unsealed.js" }];
  f.add("worker/meta.json", JSON.stringify(meta));
  assert.throws(() => f.verify(f.manifest()), {
    name: "Error", message: "Release requires one self-contained Worker module",
  });
});
test("handoff bounds individual files before reading their contents", t => {
  const f = fixture(t);
  const fd = openSync(join(f.artifact, "oversize"), "wx");
  try { ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  assert.throws(() => f.verify(), /Invalid release file/);
});
test("handoff refuses directory links", t => {
  const f = fixture(t);
  const target = join(f.root, "dist");
  symlinkSync(target, join(f.artifact, "dist/link"), "junction");
  assert.throws(() => f.verify(), /Invalid release file/);
});
test("sealing binds a clean main snapshot and copies hidden verification receipts", t => {
  const f = fixture(t);
  for (const path of ["source", "dist", "manifest.json"])
    rmSync(join(f.artifact, path), { recursive: true });
  const env = { GITHUB_SHA: f.sha, GITHUB_WORKFLOW_SHA: f.sha,
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/site-worker-promote.yml@refs/heads/main" };
  const git = (command, args) => {
    assert.equal(command, "git");
    if (args[0] === "rev-parse") return f.sha;
    if (args[0] === "ls-files") return "site-worker/src/worker.ts\0";
    return "";
  };
  assert.throws(() => seal(f.root, f.artifact, f.sha, env,
    (command, args) => args[0] === "status" ? " M package.json" : git(command, args)), /clean approved SHA/);
  const digest = seal(f.root, f.artifact, f.sha, env, git);
  assert.equal(f.verify(digest), join(f.artifact, "worker/worker.js"));
  assert.equal(readFileSync(join(f.artifact, "dist/.vite/site-production.json"), "utf8"), "{}");
});
