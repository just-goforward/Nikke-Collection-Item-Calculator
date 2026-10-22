import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCertifiedRuntimeSupplySnapshot,
  buildCertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "./certifiedSupply";
import {
  certifiedVersionPolicy,
  isCertifiedSnapshotVersion,
  isForecastVersionPair,
} from "./certifiedVersionPolicy";

describe("certified version policy", () => {
  it("keeps production version-literal comparisons inside the policy", () => {
    const sites = [
      "shared/forecastPublication.ts",
      "shared/forecastPublicationBytes.ts",
      "shared/supplyForecastCandidate.ts",
      "shared/certifiedSupplyBuild.ts",
      "shared/certifiedSupplyValidation.ts",
      "shared/certifiedSupply.ts",
      "shared/certifiedEngineProfile.ts",
      "src/certified/wasmSolver.ts",
      "src/certified/validation.ts",
      "scripts/supply-forecast-codegen.ts",
      "scripts/certified-forecast-registry.ts",
    ];
    const literal = String.raw`["'](?:certified-daily-v\d+|schedule-kit-v\d+)["']`;
    const comparison = new RegExp(
      String.raw`(?:[!=]==?\s*${literal}|${literal}\s*[!=]==?|payloadVersion["']?\]?\s*[!=]==?\s*\d+)`,
    );
    for (const site of sites) {
      expect(readFileSync(new URL(`../${site}`, import.meta.url), "utf8"), site).not.toMatch(
        comparison,
      );
    }
  });

  it("admits v4 physical laws and weekly kits while retaining seven-day history", () => {
    const base = buildCertifiedSupplySnapshot({
      asOf: "2026-10-01T05:00:00+09:00",
      revision: "v4-policy-oracle",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    const snapshot = { ...base, version: "certified-daily-v4" as const };
    expect(assertCertifiedRuntimeSupplySnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.events.some((event) => event.kind === "weekly-kits")).toBe(true);
    expect(viewCertifiedSupplySnapshot(snapshot, snapshot.asOf).coverage.past.days).toBe(7);
    expect(() =>
      assertCertifiedRuntimeSupplySnapshot({
        ...snapshot,
        laws: [...snapshot.laws, { id: "novel", kind: "finite", outcomes: [] }],
      }),
    ).toThrow();
  });

  it.each([
    undefined,
    null,
    "",
    "certified-daily-v0",
    "certified-daily-v6",
    "__proto__",
    "constructor",
    {},
  ])("rejects unsupported snapshot version %j", (version) => {
    expect(isCertifiedSnapshotVersion(version)).toBe(false);
    expect(() => certifiedVersionPolicy(version)).toThrow(
      "certified_snapshot_version_or_provenance_invalid",
    );
  });

  it.each([
    ["certified-daily-v1", 3, false, false, 56, false, false],
    ["certified-daily-v2", 4, false, true, 56, false, false],
    ["certified-daily-v3", 4, true, true, 7, false, false],
    ["certified-daily-v4", 4, true, true, 7, true, false],
    ["certified-daily-v5", 3, true, true, 7, true, true],
  ] as const)(
    "dispatches %s explicitly",
    (version, cohortCount, physicalLaws, minimumWait, historyDays, segmentsAndGrants, fixedDispatch) => {
      expect(isCertifiedSnapshotVersion(version)).toBe(true);
      expect(certifiedVersionPolicy(version)).toEqual({
        cohortCount,
        physicalLaws,
        minimumWait,
        historyDays,
        segmentsAndGrants,
        fixedDispatch,
      });
      expect(Object.isFrozen(certifiedVersionPolicy(version))).toBe(true);
    },
  );

  it("accepts only the four historical/current payload and rules pairs", () => {
    const pairs = [
      [3, "schedule-kit-v2"],
      [4, "schedule-kit-v3"],
      [5, "schedule-kit-v4"],
      [6, "schedule-kit-v5"],
    ] as const;
    for (const payload of [undefined, null, "", 2, 3, 4, 5, 6]) {
      for (const rules of [
        undefined,
        null,
        "",
        "schedule-kit-v1",
        "schedule-kit-v2",
        "schedule-kit-v3",
        "schedule-kit-v4",
        "schedule-kit-v5",
      ]) {
        expect(isForecastVersionPair(payload, rules)).toBe(
          pairs.some(
            ([expectedPayload, expectedRules]) =>
              payload === expectedPayload && rules === expectedRules,
          ),
        );
      }
    }
  });
});
