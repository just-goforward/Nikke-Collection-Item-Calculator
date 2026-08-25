import { spawn } from "node:child_process";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type {} from "./process-forecast-source-queue-main.ts";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "forecast-source-queue-"));
const outputPath = join(temporaryDirectory, "process-forecast-source-queue.mjs");

try {
  await build({
    entryPoints: [resolve(import.meta.dirname, "process-forecast-source-queue-main.ts")],
    outfile: outputPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    logLevel: "silent",
  });

  if (process.argv.includes("--check")) {
    console.log("Forecast source-queue processor bundle check passed.");
  } else {
    process.exitCode = await runBundledProcessor(outputPath);
  }
} finally {
  await unlink(outputPath).catch(() => undefined);
  await rmdir(temporaryDirectory).catch(() => undefined);
}

function runBundledProcessor(entrypoint: string) {
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Forecast source-queue processor exited from signal ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}
