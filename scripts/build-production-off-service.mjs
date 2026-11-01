import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceCommands, serviceEnvironment } from "./build-local-service.mjs";
import { childEnvironment } from "./ci/run-checked-command.mjs";

export function buildProductionOffService(sha, parent = process.env, execute = spawnSync) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Explicit approved full source SHA required");
  const root = resolve(import.meta.dirname, "..");
  if (existsSync(resolve(root, "dist")))
    throw new Error("Preserve existing dist; select a fresh release workspace");
  const env = { ...serviceEnvironment(parent), ...childEnvironment(serviceEnvironment(parent), sha) };
  const commands = serviceCommands("dist");
  commands[4] = ["--input-type=module", "-e",
    "const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); const {assertProductionOffSiteProfile}=await import('./scripts/site-deployment-artifact.mjs'); await buildSiteProduction(process.argv[1]); await buildSiteProduction(process.argv[1],true); await assertProductionOffSiteProfile(process.argv[1],process.argv[2]);",
    "dist", sha];
  for (const args of commands) {
    const result = execute(process.execPath, args, { cwd: root, env, stdio: "inherit", timeout: 240000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Production OFF build failed; preserve output, no retries");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Expected approved full source SHA");
  buildProductionOffService(process.argv[2]);
}
