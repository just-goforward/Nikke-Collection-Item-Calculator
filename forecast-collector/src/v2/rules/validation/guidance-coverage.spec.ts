import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { FORECAST_V2_GUIDANCE } from "../../../../../shared/forecastV2Guidance";

// The guidance table must cover every reason code any v2 judge can emit, so an
// approver never receives a bare "unknown" code. The list is derived from source.
const RULES = new URL("../", import.meta.url);

function sources(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name, dir);
    if (entry.isDirectory()) return entry.name === "validation" ? [] : sources(url);
    return entry.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(entry.name)
      ? [readFileSync(url, "utf8")]
      : [];
  });
}

it("has a guidance entry for every reason code produced under v2/rules", () => {
  const codes = new Set(
    sources(RULES).flatMap((text) =>
      [...text.matchAll(/reason:\s*"([a-z][a-z0-9_]*)"/g)].map((match) => String(match[1])),
    ),
  );
  expect([...codes].sort()).toEqual(
    expect.arrayContaining([
      "archive_readdition",
      "collaboration_overlap",
      "collaboration_start_unresolved",
      "grant_date",
      "grant_date_precision",
      "grant_quantity",
      "grant_quantity_ambiguous",
      "maintenance_conflict",
      "maintenance_missing",
      "maintenance_multiple",
      "maintenance_period_missing",
      "solo_period_unresolved",
    ]),
  );
  expect([...codes].filter((code) => !Object.hasOwn(FORECAST_V2_GUIDANCE, code))).toEqual([]);
});
