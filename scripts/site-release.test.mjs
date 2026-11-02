import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, ftruncateSync, closeSync, openSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertContext, seal, verifyRelease, workerProvenance } from "./site-release.mjs";
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
    "package-lock.json": '{"packages":{}}',
  };
  for (const [path, bytes] of Object.entries(source)) {
    put(root, path, bytes); add(`source/${path}`, bytes);
  }
  put(root, "node_modules/wrangler/package.json", '{"version":"4.156.1"}');
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
      wrangler: "4.156.1", files, provenance, ...changes });
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
test("actual config-relative metadata and linked packages retain portable, bounded provenance", t => {
  const f = fixture(t);
  const installed = join(dirname(f.root), "installed modules");
  renameSync(join(f.root, "node_modules"), installed);
  symlinkSync(installed, join(f.root, "node_modules"), "junction");
  const packageFile = '{"name":"example","version":"1.0.0"}';
  const moduleFile = "export const dependency = 1;";
  for (const [name, bytes] of [["package.json", packageFile], ["index.js", moduleFile]]) {
    f.put(f.root, `node_modules/example/${name}`, bytes);
    f.add(`source/node_modules/example/${name}`, bytes);
  }
  const lock = JSON.stringify({ packages: {
    "node_modules/example": { version: "1.0.0", integrity: "sha512-fixture" },
  } });
  f.put(f.root, "package-lock.json", lock); f.add("source/package-lock.json", lock);
  const raw = {
    inputs: { "src/worker.ts": {}, "../shared/contract.ts": {},
      [realpathSync(join(installed, "example/index.js")).replaceAll("\\", "/")]: {} },
    outputs: { "worker.js": { imports: [], entryPoint: "src/worker.ts" } },
  };
  f.add("worker/meta.json", JSON.stringify(raw));
  Object.assign(f.provenance, workerProvenance(f.root, f.artifact));
  assert.deepEqual(f.provenance.dependencies, ["node_modules/example/index.js",
    "node_modules/example/package.json", "shared/contract.ts", "site-worker/src/worker.ts"]);
  const digest = f.manifest();
  assert.doesNotThrow(() => f.verify(digest));
  const relocated = join(dirname(f.root), "different-checkout");
  cpSync(f.root, relocated, { recursive: true, dereference: true });
  assert.doesNotThrow(() => verifyRelease(relocated, f.artifact, f.sha, digest, "123", "1", true));
  f.put(relocated, "node_modules/example/index.js", "changed dependency bytes");
  assert.throws(() => verifyRelease(relocated, f.artifact, f.sha, digest, "123", "1", true), /source differs/);
  for (const outside of ["../../unapproved.ts", installed.replaceAll("\\", "/") + "-other/secret.js"]) {
    f.add("worker/meta.json", JSON.stringify({ ...raw, inputs: { ...raw.inputs, [outside]: {} } }));
    assert.throws(() => workerProvenance(f.root, f.artifact), /outside approved roots/);
  }
  f.add("worker/meta.json", JSON.stringify(raw));
  f.put(f.root, "node_modules/example/package.json", '{"version":"2.0.0"}');
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
