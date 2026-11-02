import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSiteProduction, siteTargetHtml } from "./build-site-production.ts";
import { SITE_LOCALE_ORDER, SITE_LOCALES } from "../shared/siteLocales.ts";

const require = createRequire(import.meta.url);
const { productionServiceEnvironment } = require("./build-production-service.mjs") as {
  productionServiceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};
const { serviceCommands } = require("./build-local-service.mjs") as {
  serviceCommands(outdir: string): string[][];
};
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length !== 1 || !["--build", "--check"].includes(args[0]!))
  throw new Error("Usage: node scripts/build-site-staging.ts --build|--check");
const directory = resolve(root, "dist");
if (args[0] === "--build") {
  const env = productionServiceEnvironment(process.env);
  // Reuse the exact certified/bundled service build, then package for the staging stats target.
  for (const command of serviceCommands("dist").slice(0, -1)) {
    const result = spawnSync(process.execPath, command, {
      cwd: root, env, stdio: "inherit", timeout: 2_700_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Staging build failed: ${command[0]}`);
  }
  for (const locale of SITE_LOCALE_ORDER) {
    const path = resolve(directory, `${SITE_LOCALES[locale].path.slice(1)}index.html`);
    await writeFile(path, siteTargetHtml(await readFile(path, "utf8"), "staging"));
  }
  await buildSiteProduction(directory, false, undefined, "staging");
}
await buildSiteProduction(directory, true, undefined, "staging");
