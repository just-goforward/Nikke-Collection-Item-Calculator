import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveLocalPolicy } from "./certified-local-forecast.ts";

// This command writes only a non-approved local policy. It never edits the registry.
const policy = deriveLocalPolicy();
const contents = execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)),
    "format",
    "--stdin-file-path=shared/certifiedLocalPolicy.json",
  ],
  { input: JSON.stringify(policy), encoding: "utf8" },
);
writeFileSync(new URL("../shared/certifiedLocalPolicy.json", import.meta.url), contents);
console.log(JSON.stringify({ localForecastId: policy.id, source: policy.source, approved: false }));
