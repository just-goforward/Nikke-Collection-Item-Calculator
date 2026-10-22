import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../shared/certifiedSupplyLaws.ts";
import {
  assertCertifiedEngineBuild,
  certifiedEngineBuildGuardPlugin,
  deriveCertifiedEngineBuild,
  writeCertifiedEngineBuild,
} from "./certified-engine-build.ts";
import { deriveCertifiedForecastAuthority } from "./certified-forecast-authority.ts";
import { assertPinnedCertifiedForecastFiles } from "./certified-forecast-pins.ts";
import {
  assertCertifiedWasmBuild,
  certifiedWasmBuildInputs,
} from "./certified-wasm-build-inputs.ts";

function fixture() {
  const base = join(process.cwd(), ".tmp", "certified-build-pin-fixtures");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "fixture-"));
  const paths = [
    "src/certifiedRuntime/browserWorker.ts",
    "src/certifiedRuntime/nodeWorker.ts",
    "src/certifiedRuntime/browserClient.ts",
    "src/certifiedRuntime/nodeClient.ts",
    "src/lib/certifiedForecast.ts",
    "shared/generated/certifiedEngineBuild.ts",
  ];
  for (const path of paths) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), "export const fixtureValue = 1;\n");
  }
  writeFileSync(
    join(directory, "index.html"),
    '<script type="module" src="/src/main.ts"></script>',
  );
  writeFileSync(join(directory, "src/main.ts"), 'console.log("legacy shell");');
  writeFileSync(
    join(directory, "shared/supplyForecasts.json"),
    JSON.stringify({
      stagingForecastId: "approved",
      approvedForecastId: "approved",
      forecasts: [
        { id: "approved", sourceEvidence: [], profiles: [{ effectiveFrom: "2026-09-30" }] },
      ],
    }),
  );
  const manifests: string[] = [];
  for (const corpus of ["official-solo-history", "pr-notice-evidence"]) {
    const folder = join(directory, "forecast-collector", "fixtures", corpus);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "notice.json"), '{"body":"season40"}');
    writeFileSync(join(folder, "normalized.json"), '[{"round":40}]');
    manifests.push(join(folder, "manifest.json"));
    refreshPins(manifests[manifests.length - 1] ?? "");
  }
  return { directory, root: pathToFileURL(`${directory}/`), manifests };
}
function refreshPins(manifestPath: string) {
  const folder = join(manifestPath, "..");
  const files = ["notice.json", "normalized.json"].map((path) => {
    const bytes = readFileSync(join(folder, path));
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  writeFileSync(manifestPath, JSON.stringify({ requested: 1, acquired: 1, files }));
}

describe("approved forecast version admission", () => {
  it("interns rule IDs without changing any expanded approved snapshot byte", async () => {
    const root = new URL("../", import.meta.url);
    const bytes = readFileSync(new URL("shared/supplyForecasts.json", root));
    const registry = JSON.parse(bytes.toString());
    const approved = registry.forecasts.find(
      (row: { id: string }) => row.id === registry.approvedForecastId,
    );
    const authority = deriveCertifiedForecastAuthority(root);
    const loaded = await import(
      `data:text/javascript;base64,${Buffer.from(authority.contents).toString("base64")}`
    );
    expect(JSON.stringify(loaded.CERTIFIED_APPROVED_FORECAST.certifiedSnapshot)).toBe(
      JSON.stringify(approved.certifiedSnapshot),
    );
    expect(loaded.CERTIFIED_APPROVED_FORECAST.id).toBe(registry.approvedForecastId);
    expect(loaded.CERTIFIED_APPROVED_REGISTRY_HASH).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(Buffer.byteLength(authority.contents)).toBeLessThan(
      Buffer.byteLength(JSON.stringify(loaded.CERTIFIED_APPROVED_FORECAST)),
    );
  });
  it("selects the approved ID, never an unapproved staging selection", () => {
    const item = fixture();
    const path = join(item.directory, "shared/supplyForecasts.json");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    registry.forecasts.push({ id: "unapproved", sourceEvidence: [], profiles: [] });
    registry.stagingForecastId = "unapproved";
    writeFileSync(path, JSON.stringify(registry));
    const authority = deriveCertifiedForecastAuthority(item.root);
    expect(authority.contents).toContain('"id":"approved"');
    expect(authority.contents).not.toContain('"id":"unapproved"');
    delete registry.approvedForecastId;
    writeFileSync(path, JSON.stringify(registry));
    expect(() => deriveCertifiedForecastAuthority(item.root)).toThrow(
      "approved_staging_forecast_missing",
    );
    delete registry.forecasts[0].id;
    writeFileSync(path, JSON.stringify(registry));
    expect(() => deriveCertifiedForecastAuthority(item.root)).toThrow(
      "approved_staging_forecast_missing",
    );
  });
  it("refuses to generate v3 runtime authority from an adopted historical v1 ledger", () => {
    const item = fixture();
    const current = buildCertifiedSupplySnapshot({
      asOf: "2026-09-30T04:00:00Z",
      revision: "adopted-legacy",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    const legacy = {
      ...current,
      version: "certified-daily-v1",
      laws: LEGACY_CERTIFIED_SUPPLY_LAWS,
      rules: current.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
      events: current.events.filter((event) => event.kind !== "weekly-kits"),
    };
    const registry = (certifiedSnapshot: unknown) =>
      JSON.stringify({
        stagingForecastId: "approved",
        approvedForecastId: "approved",
        forecasts: [{ id: "approved", sourceEvidence: [], certifiedSnapshot }],
      });
    const path = join(item.directory, "shared/supplyForecasts.json");
    writeFileSync(path, registry(legacy));
    expect(() => deriveCertifiedForecastAuthority(item.root)).toThrow(
      "unsupported_forecast_version",
    );
    expect(readFileSync(path, "utf8")).toBe(registry(legacy));
    writeFileSync(path, registry(current));
    expect(deriveCertifiedForecastAuthority(item.root).contents).toContain("certified-daily-v5");
  });
});

describe("generated certified engine module", () => {
  it("exports only the runtime code hash while retaining provenance in the build record", async () => {
    const item = fixture();
    const result = await writeCertifiedEngineBuild(item.root);
    const moduleUrl = new URL("shared/generated/certifiedEngineBuild.ts", item.root);
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as emitted from ${JSON.stringify(moduleUrl.href)}; console.log(JSON.stringify(emitted));`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(loaded.error).toBeUndefined();
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({ CERTIFIED_ENGINE_CODE_HASH: result.codeHash });
    expect(result.seedProvenanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await assertCertifiedEngineBuild(item.root)).toEqual(result);
  });
});

describe("approved notice bytes and code freshness", () => {
  it("uses supplied WASM without Cargo and rejects artifact or Rust source drift", async () => {
    const item = fixture();
    const put = (path: string, contents: string | Buffer) => {
      mkdirSync(join(item.directory, path, ".."), { recursive: true });
      writeFileSync(join(item.directory, path), contents);
    };
    for (const path of [
      "scripts/build-certified-wasm.ts",
      "scripts/certified-wasm-build-inputs.ts",
    ])
      put(path, readFileSync(path));
    put("rust/certified/src/lib.rs", "// fixture Rust input\n");
    const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const inputs = certifiedWasmBuildInputs(item.root);
    put("public/certified_solver.wasm", bytes);
    put(
      "shared/generated/certifiedWasmBuild.ts",
      `export const CERTIFIED_WASM_HASH = "${hash}";\nexport const CERTIFIED_WASM_SOURCE_HASH = "${inputs.hash}";\n`,
    );
    put(
      "src/certifiedRuntime/browserWorker.ts",
      'export { CERTIFIED_WASM_HASH } from "../../shared/generated/certifiedWasmBuild.ts";\n',
    );
    const initial = await writeCertifiedEngineBuild(item.root);
    const checked = spawnSync(
      process.execPath,
      [join(item.directory, "scripts/build-certified-wasm.ts")],
      { cwd: item.directory, env: { ...process.env, PATH: "" }, encoding: "utf8" },
    );
    expect(checked.error).toBeUndefined();
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain(hash);
    expect(assertCertifiedWasmBuild(item.root).hash).toBe(hash);
    expect(await assertCertifiedEngineBuild(item.root)).toEqual(initial);
    put("public/certified_solver.wasm", Buffer.from("changed bytes"));
    await expect(deriveCertifiedEngineBuild(item.root)).rejects.toThrow(
      "certified_wasm_hash_stale",
    );
    put("public/certified_solver.wasm", bytes);
    put("rust/certified/src/lib.rs", "// edited Rust input\n");
    await expect(deriveCertifiedEngineBuild(item.root)).rejects.toThrow(
      "certified_wasm_source_stale",
    );
  });

  it("pins every registry byte while omitting unused profiles and adopted-ledger excerpts", async () => {
    const item = fixture();
    const initial = await writeCertifiedEngineBuild(item.root);
    const generatedPath = join(item.directory, "shared/generated/certifiedForecastAuthority.ts");
    expect(readFileSync(generatedPath, "utf8")).not.toContain('"profiles"');
    const registryPath = join(item.directory, "shared/supplyForecasts.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.forecasts[0].profiles[0].effectiveFrom = "2026-10-01";
    registry.forecasts[0].sourceEvidence = [
      { itemId: "quoted-source", excerpt: "UNUSED_SOURCE_PAYLOAD" },
    ];
    registry.forecasts[0].certifiedSnapshot = buildCertifiedSupplySnapshot({
      asOf: "2026-10-02T03:00:00.000Z",
      revision: "adopted-current",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    writeFileSync(registryPath, JSON.stringify(registry));
    await expect(assertCertifiedEngineBuild(item.root)).rejects.toThrow(
      "certified_forecast_authority_stale",
    );
    const updated = await writeCertifiedEngineBuild(item.root);
    expect(updated.codeHash).not.toBe(initial.codeHash);
    expect(updated.seedProvenanceHash).not.toBe(initial.seedProvenanceHash);
    expect(readFileSync(generatedPath, "utf8")).toContain('"certifiedSnapshot"');
    expect(readFileSync(generatedPath, "utf8")).toContain("2026-10-02T03:00:00.000Z");
    expect(readFileSync(generatedPath, "utf8")).not.toContain("UNUSED_SOURCE_PAYLOAD");
    expect(await assertCertifiedEngineBuild(item.root)).toEqual(updated);
    registry.forecasts[0].sourceEvidence[0].excerpt = "CHANGED_SOURCE_PAYLOAD";
    writeFileSync(registryPath, JSON.stringify(registry));
    await expect(assertCertifiedEngineBuild(item.root)).rejects.toThrow(
      "certified_forecast_authority_stale",
    );
    const changed = await writeCertifiedEngineBuild(item.root);
    expect(changed.seedProvenanceHash).not.toBe(updated.seedProvenanceHash);
    expect(readFileSync(generatedPath, "utf8")).not.toContain("CHANGED_SOURCE_PAYLOAD");
  });
  it("binds all retained raw/normalized files and rejects body edits with unchanged metadata", async () => {
    const item = fixture();
    const result = await writeCertifiedEngineBuild(item.root);
    expect(await assertCertifiedEngineBuild(item.root)).toEqual(result);
    expect(result.sources.some((source) => source.path.endsWith("notice.json"))).toBe(true);
    const manifest = item.manifests[0];
    if (!manifest) throw new Error("missing fixture manifest");
    writeFileSync(join(manifest, "..", "notice.json"), '{"body":"season41"}');
    await expect(deriveCertifiedEngineBuild(item.root)).rejects.toThrow(
      "certified_forecast_pin_changed",
    );
    refreshPins(manifest);
    const updated = await deriveCertifiedEngineBuild(item.root);
    expect(updated.codeHash).not.toBe(result.codeHash);
    expect(updated.seedProvenanceHash).not.toBe(result.seedProvenanceHash);
    await expect(assertCertifiedEngineBuild(item.root)).rejects.toThrow(
      "certified_engine_build_hash_stale",
    );
  });

  it("rejects missing, incomplete or escaped-path file pins", () => {
    const item = fixture();
    const manifest = item.manifests[0];
    if (!manifest) throw new Error("missing fixture manifest");
    writeFileSync(manifest, JSON.stringify({ acquired: 1 }));
    expect(() => assertPinnedCertifiedForecastFiles(manifest)).toThrow(
      "certified_forecast_pins_missing",
    );
    refreshPins(manifest);
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...data, files: data.files.slice(0, 1) }));
    expect(() => assertPinnedCertifiedForecastFiles(manifest)).toThrow(
      "certified_forecast_pin_coverage_mismatch",
    );
    writeFileSync(
      manifest,
      JSON.stringify({ ...data, files: [{ ...data.files[0], path: "../notice.json" }] }),
    );
    expect(() => assertPinnedCertifiedForecastFiles(manifest)).toThrow(
      "certified_forecast_pin_invalid",
    );
  });

  it("rejects a direct Vite build with a stale source digest before writing assets", async () => {
    const item = fixture();
    await writeCertifiedEngineBuild(item.root);
    writeFileSync(
      join(item.directory, "src/certifiedRuntime/browserWorker.ts"),
      "export const fixtureValue = 2;\n",
    );
    await expect(
      build({
        configFile: false,
        root: item.directory,
        logLevel: "silent",
        plugins: [certifiedEngineBuildGuardPlugin(item.root)],
        build: { write: false },
      }),
    ).rejects.toThrow("certified_engine_build_hash_stale");
    await writeCertifiedEngineBuild(item.root);
    await expect(
      build({
        configFile: false,
        root: item.directory,
        logLevel: "silent",
        plugins: [certifiedEngineBuildGuardPlugin(item.root)],
        build: { write: false },
      }),
    ).resolves.toBeDefined();
  });
});
