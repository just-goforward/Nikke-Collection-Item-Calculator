import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceCommands, serviceEnvironment } from "./build-local-service.mjs";
import { childEnvironment } from "./ci/run-checked-command.mjs";

export function productionServiceEnvironment(parent) {
  // Keep the approved candidate revision and CI guards, but never ambient online
  // authority or deployment credentials. The shared selector fixes bundled mode.
  return { ...serviceEnvironment(parent), ...childEnvironment(parent, parent.GITHUB_SHA) };
}

export function buildProductionService(parent, execute = spawnSync) {
  const env = productionServiceEnvironment(parent);
  const root = resolve(import.meta.dirname, "..");
  for (const args of serviceCommands("dist")) {
    const result = execute(process.execPath, args, {
      cwd: root, env, stdio: "inherit", timeout: 2_700_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Production service build failed: ${args[0]} (${result.status}, ${result.signal})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Production profile takes no override arguments");
  buildProductionService(process.env);
}
