import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCertifiedRuntimeSupplySnapshot } from "../shared/certifiedSupply.ts";

const projectRoot = new URL("../", import.meta.url);

/** A separate unsigned policy, derived only from the unchanged approved input. */
export function deriveLocalPolicy(root = projectRoot) {
  const registry = JSON.parse(readFileSync(new URL("shared/supplyForecasts.json", root), "utf8"));
  assert.equal(registry.approvedForecastId, "supply-2026-10-15-v3");
  const entry = registry.forecasts.find(
    (row: { id: string }) => row.id === registry.approvedForecastId,
  );
  assert.ok(entry);
  const original = assertCertifiedRuntimeSupplySnapshot(entry.certifiedSnapshot);
  assert.equal(original.version, "certified-daily-v3");
  const source = {
    sourceForecastId: entry.id as string,
    sourceRevision: original.revision,
    sourceHash: original.sourceHash,
    policy: "fixed-dispatch-0-1-2:1-2-3",
  };
  const delta = {
    version: "certified-daily-v5",
    revision: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    provenanceSuffix: ["local-unapproved"],
  };
  assertCertifiedRuntimeSupplySnapshot({
    ...original,
    version: delta.version,
    revision: delta.revision,
    provenance: [...original.provenance, ...delta.provenanceSuffix],
  });
  return { id: "supply-2026-10-15-v5", approved: false, source, delta };
}

function derivedModule(root: URL) {
  const policy = JSON.parse(
    readFileSync(new URL("shared/certifiedLocalPolicy.json", root), "utf8"),
  );
  assert.deepEqual(policy, deriveLocalPolicy(root), "Local policy derivation drift");
  return {
    output: new URL("shared/generated/certifiedLocalForecast.ts", root),
    contents: `// Generated local policy; NOT an approved collector publication.\nexport const CERTIFIED_LOCAL_FORECAST_POLICY = ${JSON.stringify(policy.delta)} as const;\n`,
  };
}

export function assertCertifiedLocalForecast(root = projectRoot) {
  const derived = derivedModule(root);
  assert.equal(readFileSync(derived.output, "utf8"), derived.contents, "Local policy module stale");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const derived = derivedModule(projectRoot);
  writeFileSync(derived.output, derived.contents);
  console.log(`Generated non-approved local policy: ${fileURLToPath(derived.output)}`);
}
