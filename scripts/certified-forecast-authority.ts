import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Registry = { stagingForecastId: string; forecasts: Record<string, unknown>[] };
export function deriveCertifiedForecastAuthority(root: URL) {
  const bytes = readFileSync(new URL("shared/supplyForecasts.json", root));
  const registry = JSON.parse(bytes.toString("utf8")) as Registry;
  const adopted = registry.forecasts.find((entry) => entry["id"] === registry.stagingForecastId);
  if (!adopted || !Array.isArray(adopted["sourceEvidence"]))
    throw new Error("approved_staging_forecast_missing");
  // The certified seed uses source evidence, not legacy rolling-window totals.
  // Keep all other approved fields, including an optional full certified ledger.
  const projection = Object.fromEntries(
    Object.entries(adopted).filter(([key]) => key !== "profiles"),
  );
  const registryHash = createHash("sha256").update(bytes).digest("hex");
  return {
    output: fileURLToPath(new URL("shared/generated/certifiedForecastAuthority.ts", root)),
    registryHash,
    contents: `// Generated from the full approved registry; its original bytes remain pinned.\nexport const CERTIFIED_APPROVED_REGISTRY_HASH = "${registryHash}";\nexport const CERTIFIED_APPROVED_FORECAST = ${JSON.stringify(projection)};\n`,
  };
}

export function assertCertifiedForecastAuthority(root: URL): void {
  const authority = deriveCertifiedForecastAuthority(root);
  if (readFileSync(authority.output, "utf8") !== authority.contents)
    throw new Error("certified_forecast_authority_stale");
}
export function writeCertifiedForecastAuthority(root: URL): void {
  const authority = deriveCertifiedForecastAuthority(root);
  writeFileSync(authority.output, authority.contents);
}
