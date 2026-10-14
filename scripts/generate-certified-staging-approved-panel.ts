import { calculateFresh } from "./certified-staging-approved-panel/v6/calculate.ts";
import {
  prepareGeneration,
  preparePins,
  prepareProvenance,
  publishGeneration,
  verifyGeneration,
} from "./certified-staging-approved-panel/v6/generate.ts";

// Separate draft/format/seal phases: tidy formats new bytes before their hashes
// become evidence. No command ever reformats or replaces an existing seal.
const [command = "--prepare", directory, biomeSha256] = process.argv.slice(2);
let result: unknown;
if (command === "--calculate") result = calculateFresh();
else if (command === "--prepare") {
  if (!directory || !biomeSha256)
    throw new Error("--prepare requires HEAD lock SHA-256 and staged biome SHA-256");
  result = prepareGeneration(process.cwd(), { packageLockSha256: directory, biomeSha256 });
} else {
  if (!directory) throw new Error("An explicit draft directory is required");
  if (command === "--provenance") result = prepareProvenance(directory);
  else if (command === "--pins") result = preparePins(directory);
  else if (command === "--verify") result = verifyGeneration(directory);
  else if (command === "--publish") result = publishGeneration(directory);
  else throw new Error(`Unknown evidence phase: ${command}`);
}
console.log(JSON.stringify(result, null, 2));
