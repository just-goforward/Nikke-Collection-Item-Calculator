import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCertifiedRuntimeSupplySnapshot } from "../shared/certifiedSupply.ts";

type Registry = { approvedForecastId: string; forecasts: Record<string, unknown>[] };

/** Intern declared rule IDs in source only. Expanded JSON, order and registry pins
 * are unchanged; do not shorten any identity/provenance in the snapshot itself. */
function authoritySource(value: unknown, ruleIds: readonly string[]) {
  const bindings = new Map(ruleIds.map((id, index) => [id, `r${index}`]));
  const literal = (value: unknown): string => {
    if (typeof value === "string") return bindings.get(value) ?? JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(literal).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .map(([key, child]) => `${JSON.stringify(key)}:${literal(child)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  return {
    declarations: [...bindings]
      .map(([id, name]) => `const ${name} = ${JSON.stringify(id)};\n`)
      .join(""),
    expression: literal(value),
  };
}
export function deriveCertifiedForecastAuthority(root: URL) {
  const bytes = readFileSync(new URL("shared/supplyForecasts.json", root));
  const registry = JSON.parse(bytes.toString("utf8")) as Registry;
  if (typeof registry.approvedForecastId !== "string" || !registry.approvedForecastId)
    throw new Error("approved_staging_forecast_missing");
  const adopted = registry.forecasts.find((entry) => entry["id"] === registry.approvedForecastId);
  if (!adopted || !Array.isArray(adopted["sourceEvidence"]))
    throw new Error("approved_staging_forecast_missing");
  const snapshot =
    adopted["certifiedSnapshot"] === undefined
      ? undefined
      : assertCertifiedRuntimeSupplySnapshot(adopted["certifiedSnapshot"]);
  // Legacy seeds need notice excerpts. An adopted ledger already contains its
  // modeled provenance and dates; omit unused header fields/excerpts from the Worker.
  // The hash below still pins every byte of the full approved registry.
  const projection = Object.fromEntries(
    Object.entries(adopted).filter(
      ([key]) =>
        key !== "profiles" &&
        (adopted["certifiedSnapshot"] === undefined ||
          !["sourceEvidence", "kind", "effectiveFrom"].includes(key)),
    ),
  );
  const registryHash = createHash("sha256").update(bytes).digest("hex");
  const source = authoritySource(projection, snapshot?.rules.map((rule) => rule.id) ?? []);
  return {
    output: fileURLToPath(new URL("shared/generated/certifiedForecastAuthority.ts", root)),
    registryHash,
    contents: `// Generated from the full approved registry; its original bytes remain pinned.\n${source.declarations}export const CERTIFIED_APPROVED_REGISTRY_HASH = "${registryHash}";\nexport const CERTIFIED_APPROVED_FORECAST = ${source.expression};\n`,
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
