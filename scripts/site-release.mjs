import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const config = "site-worker/production.wrangler.toml";
// This narrow prebuilt adapter admits only the reviewed, build-hook-free config.
// A config/binding change needs a fresh compatibility review before using this mode.
const prebuiltConfigHash = "153cbbc0c37361323d37ad0a1b21d7e9b9c5e8195f351035a2e2c6bf56ed8862";
const required = ["dist/.vite/manifest.json", "dist/.vite/site-production.json",
  "dist/.vite/local-operational-profile.json", "dist/.vite/forecast-runtime.json",
  "worker/worker.js", "worker/meta.json", `source/${config}`];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function safe(path) {
  if (!/^[A-Za-z0-9_.@/-]+$/.test(path) || path.split("/").some(p => !p || p === "." || p === ".."))
    throw new Error("Unsafe release path");
  return path;
}
function inventory(root, prefix = "", result = {}, state = { entries: 0, bytes: 0 }) {
  if (prefix.split("/").length > 32) throw new Error("Release depth limit exceeded");
  const directory = opendirSync(join(root, prefix));
  try {
  let entry;
  while ((entry = directory.readSync()) !== null) {
    if (++state.entries > 10000) throw new Error("Release entry count exceeded");
    const path = safe(prefix + entry.name);
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) inventory(root, path + "/", result, state);
    else {
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid release file");
      state.bytes += stat.size;
      if (state.bytes > 512 * 1024 * 1024) throw new Error("Release byte limit exceeded");
      result[path] = { bytes: stat.size, sha256: hash(readFileSync(join(root, path))) };
    }
  }
  } finally { directory.closeSync(); }
  return result;
}
function outside(root, directory) {
  if (!isAbsolute(directory) || !relative(root, directory).startsWith("..") ||
      !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("Release directory must be outside checkout");
}
export function assertContext(env, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || env.GITHUB_SHA !== sha ||
      env.GITHUB_WORKFLOW_SHA !== sha || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/.github/workflows/site-worker-promote.yml@refs/heads/main` ||
      !/^[0-9]+$/.test(env.GITHUB_RUN_ID ?? "") || !/^[0-9]+$/.test(env.GITHUB_RUN_ATTEMPT ?? ""))
    throw new Error("Exact main manual workflow required");
}
function snapshot(root, sha, execute = execFileSync) {
  const git = args => execute("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git(["rev-parse", "HEAD"]) !== sha || git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Release requires clean approved SHA");
  execute("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], { cwd: root });
}
export function workerProvenance(root, directory, recorded) {
  const stat = lstatSync(join(directory, "worker/meta.json"));
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid Worker metadata");
  const meta = JSON.parse(readFileSync(join(directory, "worker/meta.json"), "utf8"));
  const checkout = recorded?.checkout ?? realpathSync(root).replaceAll("\\", "/");
  const modules = recorded?.modules ?? realpathSync(join(root, "node_modules")).replaceAll("\\", "/");
  const paths = /^[A-Za-z]:\//.test(checkout) ? win32 : posix;
  if (!paths.isAbsolute(checkout) || !paths.isAbsolute(modules))
    throw new Error("Invalid metadata provenance roots");
  function inside(base, file) {
    const result = paths.relative(base, file).replaceAll("\\", "/");
    return result && result !== ".." && !result.startsWith("../") && !paths.isAbsolute(result)
      ? safe(result) : null;
  }
  // Wrangler 4.156.1 resolveEntryWithMain sets projectRoot to the user
  // config directory; bundleWorker uses it as esbuild absWorkingDir.
  function canonical(raw) {
    const file = paths.resolve(checkout, "site-worker", raw);
    const dependency = inside(modules, file);
    const source = inside(checkout, file);
    if (dependency) return `node_modules/${dependency}`;
    if (source) return source;
    throw new Error("Metadata dependency outside approved roots");
  }
  const outputs = Object.values(meta.outputs);
  if (outputs.length !== 1 || outputs[0].imports.length ||
      canonical(outputs[0].entryPoint) !== "site-worker/src/worker.ts")
    throw new Error("Release requires one self-contained Worker module");
  const inputs = Object.keys(meta.inputs);
  if (inputs.length > 1000) throw new Error("Worker dependency count exceeded");
  const dependencies = new Set(inputs.map(canonical));
  if (!dependencies.has("site-worker/src/worker.ts")) throw new Error("Missing Worker entry input");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  const currentModules = realpathSync(join(root, "node_modules"));
  const currentCheckout = realpathSync(root);
  for (const identity of dependencies) {
    const dependency = identity.startsWith("node_modules/");
    const base = dependency ? currentModules : currentCheckout;
    const file = realpathSync(join(root, identity));
    const local = relative(base, file);
    if (!local || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(local))
      throw new Error("Dependency realpath escapes approved root");
    if (!dependency) continue;
    const key = Object.keys(lock.packages ?? {}).filter(key =>
      key.startsWith("node_modules/") && identity.startsWith(key + "/"))
      .sort((a, b) => b.length - a.length)[0];
    const installed = key && JSON.parse(readFileSync(join(root, key, "package.json")));
    if (!key || lock.packages[key].link || !lock.packages[key].integrity ||
        installed.version !== lock.packages[key].version)
      throw new Error("Installed dependency lacks matching lock provenance");
    const packageIdentity = `${key}/package.json`;
    if (identity !== packageIdentity) dependencies.add(packageIdentity);
  }
  return { checkout, modules, dependencies: [...dependencies].sort() };
}
export function verifyRelease(root, directory, sha, digest, run, attempt, restored = false) {
  outside(root, directory);
  const manifestPath = join(directory, "manifest.json");
  if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).size > 2 * 1024 * 1024)
    throw new Error("Invalid release manifest");
  const bytes = readFileSync(manifestPath);
  if (!/^[a-f0-9]{64}$/.test(digest ?? "") || hash(bytes) !== digest)
    throw new Error("Release manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[0-9]+$/.test(run ?? "") ||
      !/^[0-9]+$/.test(attempt ?? "") || manifest.version !== 1 ||
      manifest.sha !== sha || manifest.run !== run || manifest.attempt !== attempt ||
      manifest.wrangler !== "4.156.1")
    throw new Error("Release identity mismatch");
  const files = inventory(directory);
  delete files["manifest.json"];
  if (JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(manifest.files).sort()))
    throw new Error("Release content mismatch");
  for (const path of required) if (!files[path]) throw new Error(`Missing release file: ${path}`);
  for (const path of Object.keys(files)) {
    if (!/^(dist\/|source\/|worker\/(?:worker\.js|meta\.json)$)/.test(path))
      throw new Error("Unexpected release payload");
    if (path.startsWith("source/") &&
        !readFileSync(join(root, path.slice(7))).equals(readFileSync(join(directory, path))))
      throw new Error("Release source differs from checkout");
  }
  const provenance = workerProvenance(root, directory, manifest.provenance);
  if (JSON.stringify(provenance) !== JSON.stringify(manifest.provenance))
    throw new Error("Canonical Worker provenance mismatch");
  for (const path of [config, "package-lock.json", ...provenance.dependencies])
    if (!files[`source/${path}`]) throw new Error("Missing release source dependency");
  for (const path of Object.keys(inventory(join(root, "site-worker/src"))))
    if (!files[`source/site-worker/src/${path}`]) throw new Error("Missing Worker source");
  if (hash(readFileSync(join(root, config))) !== prebuiltConfigHash)
    throw new Error("Prebuilt configuration requires compatibility review");
  if (JSON.parse(readFileSync(join(root, "node_modules/wrangler/package.json"))).version !== manifest.wrangler)
    throw new Error("Wrangler version mismatch");
  if (restored) {
    const actual = inventory(join(root, "dist"));
    const expected = Object.fromEntries(Object.entries(files)
      .filter(([path]) => path.startsWith("dist/")).map(([path, value]) => [path.slice(5), value]));
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort()))
      throw new Error("Restored assets differ from sealed release");
  }
  const entry = readFileSync(join(directory, "worker/worker.js"));
  if (!Buffer.from(entry.toString("utf8")).equals(entry)) throw new Error("Worker is not UTF-8");
  execFileSync(process.execPath, ["--input-type=module", "--check"], {
    input: entry, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  return join(directory, "worker/worker.js");
}
export function seal(root, directory, sha, env, execute = execFileSync) {
  assertContext(env, sha);
  snapshot(root, sha, execute);
  outside(root, directory);
  inventory(directory);
  inventory(join(root, "dist"));
  const provenance = workerProvenance(root, directory);
  const paths = [config, "package-lock.json", ...provenance.dependencies,
    ...execute("git", ["ls-files", "-z", "site-worker/src"], { cwd: root }).toString().split("\0").filter(Boolean)];
  if (paths.length > 2000) throw new Error("Release source count exceeded");
  let sourceBytes = 0;
  for (const path of new Set(paths)) {
    safe(path);
    const stat = lstatSync(join(root, path));
    sourceBytes += stat.size;
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || sourceBytes > 512 * 1024 * 1024)
      throw new Error("Invalid release source");
    const target = join(directory, "source", path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(join(root, path), target, { dereference: false });
  }
  cpSync(join(root, "dist"), join(directory, "dist"), { recursive: true, dereference: false });
  const files = inventory(directory);
  const bytes = JSON.stringify({ version: 1, sha, run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, wrangler: "4.156.1", files, provenance });
  writeFileSync(join(directory, "manifest.json"), bytes, { flag: "wx" });
  const digest = hash(bytes);
  verifyRelease(root, directory, sha, digest, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
  snapshot(root, sha, execute);
  return digest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, sha, digest, run, attempt] = process.argv.slice(2);
  const root = resolve(import.meta.dirname, "..");
  if (mode === "context") { assertContext(process.env, sha); snapshot(root, sha); }
  else if (mode === "seal") console.log(seal(root, directory, sha, process.env));
  else if (mode === "verify" || mode === "restore") {
    verifyRelease(root, directory, sha, digest, run, attempt, mode === "verify");
    if (mode === "restore") {
      if (existsSync(join(root, "dist"))) throw new Error("Refusing to replace existing assets");
      cpSync(join(directory, "dist"), join(root, "dist"), { recursive: true });
      verifyRelease(root, directory, sha, digest, run, attempt, true);
    }
  } else throw new Error("Unsupported Site release operation");
}
