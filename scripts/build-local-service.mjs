import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export function serviceEnvironment(parent) {
  const env = Object.fromEntries(["PATH", "HOME", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR"].filter(k => parent[k] !== undefined).map(k => [k, parent[k]]));
  return { ...env, VITE_SERVICE_CERTIFIED_SOLVER: "true", VITE_FORECAST_RUNTIME: "bundled", VITE_FORECAST_PUBLIC_KEY_ID: "", VITE_FORECAST_PUBLIC_KEY_BASE64: "" };
}
export function serviceCommands(outdir) {
  return [
    ["scripts/build-certified-wasm.ts"],
    ["scripts/build-solver-wasm.ts"],
    ["scripts/certified-engine-build.ts", "--check"],
    ["node_modules/vite/bin/vite.js", "build", "--configLoader", "native", "--config", "scripts/local-service.config.mjs", "--outDir", outdir],
    ["--input-type=module", "-e", "const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); await buildSiteProduction(process.argv[1]); await buildSiteProduction(process.argv[1],true);", outdir],
  ];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Local profile takes no implicit/online options");
  const root = resolve(import.meta.dirname, "..");
  const outdir = join(root, "dist-service-bundled");
  if (existsSync(outdir)) throw new Error("Local output already exists; preserve it and request a separately scoped new output");
  const evidenceRoot = resolve(root, "../operations");
  mkdirSync(evidenceRoot, { recursive: true });
  const evidence = mkdtempSync(join(evidenceRoot, "service-profile-"));
  const env = serviceEnvironment(process.env);
  Object.assign(env, { NODE_COMPILE_CACHE: join(evidence, "node-cache"), SOLVER_A_VITE_CACHE_DIR: join(evidence, "vite-cache") });
  const commands = [];
  for (const [i, args] of serviceCommands(outdir).entries()) {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(evidence, `${i}.stdout`), result.stdout ?? "");
    writeFileSync(join(evidence, `${i}.stderr`), result.stderr ?? "");
    commands.push({ command: [process.execPath, ...args], cwd: root, exit: result.status, signal: result.signal, error: result.error?.code ?? null });
    writeFileSync(join(evidence, "execution.json"), JSON.stringify({ profile: "local-shared-service-bundled", env: { VITE_SERVICE_CERTIFIED_SOLVER: "true", VITE_FORECAST_RUNTIME: "bundled", VITE_FORECAST_PUBLIC_KEY_ID: "", VITE_FORECAST_PUBLIC_KEY_BASE64: "" }, outdir, commands }, null, 2));
    if (result.error || result.status !== 0) throw new Error(`Local profile step ${i} failed; preserve ${evidence}; no retries`);
  }
  console.log(JSON.stringify({ outdir, evidence, profile: "local-shared-service-bundled" }));
}
