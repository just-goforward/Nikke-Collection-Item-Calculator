import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceCommands, serviceEnvironment } from "./build-local-service.mjs";
import { childEnvironment } from "./ci/run-checked-command.mjs";
import { productionForecastBuildEnv } from "./forecast-runtime-build.ts";

export function productionServiceEnvironment(parent) {
  // Public trust comes only from the checked-in approved contract, never ambient
  // online authority or deployment credentials.
  return productionForecastBuildEnv({ ...serviceEnvironment(parent), ...childEnvironment(parent, parent.GITHUB_SHA) });
}

export function buildProductionService(parent, execute = spawnSync) {
  const env = productionServiceEnvironment(parent);
  const root = resolve(import.meta.dirname, "..");
  const commands = serviceCommands("dist");
  commands[commands.length - 1] = [
    "--input-type=module", "-e",
    "const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); const {default:contract}=await import('./site-worker/production-forecast.proposed.json',{with:{type:'json'}}); await buildSiteProduction(process.argv[1],false,contract); await buildSiteProduction(process.argv[1],true,contract);",
    "dist",
  ];
  for (const args of commands) {
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
