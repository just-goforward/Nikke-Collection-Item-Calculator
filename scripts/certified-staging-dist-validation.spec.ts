import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  APPROVED_PANEL_DIRECTORY,
  APPROVED_PANEL_INDICES,
  frozenApprovedSnapshot,
  independentApprovedPricing,
  loadIndependentApprovedPanel,
} from "./certified-staging-approved-panel.ts";
import {
  assertDistStable,
  buildDistClientAdapter,
  inspectCertifiedDist,
  sha256Bytes,
  startCertifiedDistServer,
} from "./certified-staging-dist-validation.ts";
import { mapTriple, q, wire } from "./certified-staging-oracle.ts";
import {
  loadFrozenPilotEndpoints,
  PILOT_ENDPOINT_IDS,
} from "./certified-staging-pilot-endpoint-fixture.ts";

function tinyDist() {
  const parent = resolve(".certified-test-tmp/review13-dist-contract");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "dist-"));
  mkdirSync(resolve(root, ".vite"));
  mkdirSync(resolve(root, "assets"));
  writeFileSync(
    resolve(root, ".vite/manifest.json"),
    JSON.stringify({
      "src/certifiedUi/CertifiedCalculator.tsx": {
        file: "assets/CertifiedCalculator-frozen.js",
        assets: ["assets/browserWorker-frozen.js"],
      },
    }),
  );
  writeFileSync(
    resolve(root, "assets/CertifiedCalculator-frozen.js"),
    "export const client = true;\n",
  );
  writeFileSync(
    resolve(root, "assets/browserWorker-frozen.js"),
    "postMessage('frozen-worker-bytes');\n",
  );
  writeFileSync(resolve(root, "index.html"), "<!doctype html><title>Fixture</title>");
  return root;
}

describe("mandatory independent shipped dist Worker validation", () => {
  it("preserves authenticated pilot6 input rows and exact independently enumerated uniform recurring rates", () => {
    const pilot = loadFrozenPilotEndpoints();
    expect(pilot.rows.map((row) => row.id)).toEqual(PILOT_ENDPOINT_IDS);
    expect(pilot.provenance.original.sha256).toBe(
      "372d7263d0778304d5c5195d014553d70c8dc744892988b8523d9380fe60e88b",
    );
    const original = JSON.parse(
      readFileSync(`${APPROVED_PANEL_DIRECTORY}/independent-physical-cohorts.json`, "utf8"),
    ) as { rate: ReturnType<typeof wire>[] };
    const rates = independentApprovedPricing(frozenApprovedSnapshot(), [q(1, 3), q(1, 3), q(1, 3)]);
    expect(mapTriple(rates, wire)).toEqual(original.rate);
  });
  it("regenerates all approved24 frozen expectations without candidate numerical imports or ignored caches", async () => {
    const panel = loadIndependentApprovedPanel();
    expect(panel.map((row) => row.originalIndex)).toEqual(APPROVED_PANEL_INDICES);
    expect(panel).toHaveLength(24);
    const built = await build({
      entryPoints: ["scripts/certified-staging-approved-panel.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    assert.ok(built.metafile);
    const inputs = Object.keys(built.metafile.inputs);
    expect(
      inputs.some((path) =>
        /(?:^|\/)src\/certified\/|certifiedRational|certifiedSupplyModel/.test(path),
      ),
    ).toBe(false);
    expect(inputs).toContain("scripts/certified-staging-oracle.ts");
    expect(
      panel.every((row) =>
        row.expected.actionGaps.every(
          (gap) =>
            gap.optimal ||
            gap.P.numerator !== "0" ||
            gap.B.numerator !== "0" ||
            gap.C.numerator !== "0",
        ),
      ),
    ).toBe(true);
  });

  it("pins the manifest-selected Worker and rejects stale or missing production assets", () => {
    const root = tinyDist();
    const dist = inspectCertifiedDist(root);
    expect(dist.worker.urlPath).toBe("/assets/browserWorker-frozen.js");
    assertDistStable(dist);
    writeFileSync(dist.worker.path, "changed worker bytes");
    expect(() => assertDistStable(dist)).toThrow("production dist bytes changed");
    writeFileSync(
      resolve(root, ".vite/manifest.json"),
      JSON.stringify({
        "src/certifiedUi/CertifiedCalculator.tsx": {
          file: "assets/CertifiedCalculator-frozen.js",
          assets: [],
        },
      }),
    );
    expect(() => inspectCertifiedDist(root)).toThrow("exactly one certified Worker");
  });

  it("serves exact pinned bytes, records their hashes and rejects source URLs", async () => {
    const dist = inspectCertifiedDist(tinyDist());
    const bytes = Buffer.from("export const clientAdapter = true;\n");
    const server = await startCertifiedDistServer(dist, {
      urlPath: "/adapter.js",
      bytes,
      sha256: sha256Bytes(bytes),
    });
    try {
      const response = await fetch(`${server.origin}${dist.worker.urlPath}`);
      const received = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(createHash("sha256").update(received).digest("hex")).toBe(dist.worker.sha256);
      expect(response.headers.get("x-content-sha256")).toBe(dist.worker.sha256);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(
        server.served.map(({ urlPath, sha256, bytes: count }) => ({
          urlPath,
          sha256,
          bytes: count,
        })),
      ).toEqual([
        { urlPath: dist.worker.urlPath, sha256: dist.worker.sha256, bytes: dist.worker.bytes },
      ]);
      expect((await fetch(`${server.origin}/src/certifiedRuntime/browserWorker.ts`)).status).toBe(
        404,
      );
      expect((await fetch(`${server.origin}/assets/browserWorker-missing.js`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("binds the separately compiled client adapter to actual dist and excludes Worker/kernel compilation", async () => {
    const adapter = await buildDistClientAdapter("/assets/browserWorker-frozen.js");
    expect(adapter.bytes.toString("utf8")).toContain("/assets/browserWorker-frozen.js");
    expect(adapter.bytes.toString("utf8")).not.toContain("/src/certifiedRuntime/browserWorker.ts");
    expect(
      adapter.sources.some((source) => /src\/certified\/|browserWorker\.ts$/.test(source.path)),
    ).toBe(false);
    expect(adapter.sha256).toBe(sha256Bytes(adapter.bytes));
  });
});
