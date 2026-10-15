/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertCertifiedRuntimeSupplySnapshot,
  buildCertifiedSupplySnapshot,
} from "./certifiedSupply";
import { SUPPLY_FORECAST_REGISTRY } from "./generated/supplyForecast";
import { buildScheduleForecastProfiles } from "./supplyForecastProjection";

const directories: string[] = [];
let generator = "";
const historical = SUPPLY_FORECAST_REGISTRY.forecasts.find(
  (forecast) => forecast.id === "supply-2026-08-21-v1",
);
if (!historical) throw new Error("historical_forecast_fixture_missing");
const historicalId = historical.id;
const emptyId = "supply-2026-10-15-v99";
const built = buildCertifiedSupplySnapshot({
  asOf: "2026-10-14T20:00:00.000Z",
  revision: "empty-reference-schedule",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
});
const snapshot = assertCertifiedRuntimeSupplySnapshot({
  ...built,
  soloRounds: [],
  events: built.events.filter((event) => event.kind !== "solo"),
});
const empty = {
  id: emptyId,
  kind: "schedule",
  rulesVersion: "schedule-kit-v3",
  effectiveFrom: "2026-10-15",
  sourceEvidence: [],
  profiles: [],
  certifiedSnapshot: snapshot,
};

beforeAll(async () => {
  const result = await build({
    entryPoints: ["scripts/supply-forecast-codegen.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  generator = result.outputFiles[0]?.text ?? "";
  if (!generator) throw new Error("codegen_fixture_bundle_missing");
});
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function fixture(activeForecastId = historicalId) {
  const directory = mkdtempSync(join(tmpdir(), "supply-codegen-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "shared/generated"), { recursive: true });
  const script = join(directory, "scripts/supply-forecast-codegen.mjs");
  writeFileSync(script, generator);
  const registry = {
    version: 3,
    activeForecastId,
    stagingForecastId: emptyId,
    approvedForecastId: emptyId,
    forecasts: [historical, empty],
  };
  const source = join(directory, "shared/supplyForecasts.json");
  writeFileSync(source, JSON.stringify(registry));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5_000 });
  return { directory, registry, source, run };
}

describe("empty v3 forecast activation", () => {
  it("rejects activation without replacing the last loadable generated registry", () => {
    expect(
      buildScheduleForecastProfiles({
        forecastId: emptyId,
        effectiveFrom: snapshot.asOf,
        certifiedSnapshot: snapshot,
      }),
    ).toEqual([]);
    const item = fixture();
    expect(item.run().status).toBe(0);
    const generated = [
      join(item.directory, "shared/generated/supplyForecast.ts"),
      join(item.directory, "shared/generated/supplyForecastRuntime.ts"),
    ] as const;
    const before = generated.map((path) => readFileSync(path, "utf8"));
    writeFileSync(item.source, JSON.stringify({ ...item.registry, activeForecastId: emptyId }));
    for (const args of [[], ["--check"]]) {
      const rejected = item.run(...args);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(`active_supply_forecast_unavailable:${emptyId}`);
      expect(generated.map((path) => readFileSync(path, "utf8"))).toEqual(before);
    }
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const registry = await import(${JSON.stringify(pathToFileURL(generated[0]).href)});
       console.log(JSON.stringify({
         active: registry.ACTIVE_SUPPLY_FORECAST_ID,
         base: registry.ACTIVE_SUPPLY_FORECAST_BASE_PROFILE_ID,
         historical: registry.isSupplyForecastId(${JSON.stringify(historicalId)}),
         incomplete: registry.isSupplyForecastId(${JSON.stringify(emptyId)}),
         missingProfile: registry.resolveSupplyForecastProfile(${JSON.stringify(emptyId)}, Date.parse(${JSON.stringify(snapshot.asOf)})),
       }));`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(loaded.status).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({
      active: historicalId,
      base: "supply-2026-08-21-v1@fixed",
      historical: true,
      incomplete: true,
      missingProfile: null,
    });
  });

  it("type-checks generated modules containing an empty non-active projection", () => {
    const item = fixture();
    expect(item.run().status).toBe(0);
    const config = join(item.directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        extends: resolve("tsconfig.json"),
        compilerOptions: { types: [] },
        include: ["shared/generated/*.ts"],
        exclude: [],
      }),
    );
    const checked = spawnSync(
      process.execPath,
      [resolve("node_modules/typescript/bin/tsc"), "-p", config],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(checked.error).toBeUndefined();
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });
});
