import { expect, it } from "vitest";
import { assertCertifiedEngineProfile } from "../../shared/certifiedEngineProfile";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { certifiedRunCacheKey } from "./certifiedRunCache";
import { createCertifiedSession } from "./session";

it("reuses only same-day actual-stock requests with all model and receipt inputs unchanged", () => {
  const asOf = "2026-09-30T08:00:00Z";
  const snapshot = buildCertifiedSupplySnapshot({
    asOf,
    revision: "cache",
    sourceHash: "a".repeat(64),
    sourceStatus: "uncertain",
    soloPeriods: [],
    collaborationPeriods: [],
  });
  const session = createCertifiedSession(
    snapshot.revision,
    { grade: "R", level: 10, exp: 0 },
    [31, 4, 9],
  );
  const key = certifiedRunCacheKey(session, snapshot, asOf);
  const identity = JSON.parse(key).engine;
  expect(identity.recommendedHorizonDays).toBe(14);
  expect(() => assertCertifiedEngineProfile({ ...identity, recommendedHorizonDays: 56 })).toThrow(
    "certified_engine_profile_mismatch",
  );
  expect(
    JSON.stringify({ ...JSON.parse(key), engine: { ...identity, recommendedHorizonDays: 56 } }),
  ).not.toBe(key);
  expect(certifiedRunCacheKey(session, { ...snapshot, asOf: "2026-09-30T08:01:00Z" }, asOf)).toBe(
    key,
  );
  for (const changed of [
    { ...session, stock: [32, 4, 9] as const },
    { ...session, state: { ...session.state, level: 11 } },
    {
      ...session,
      receipts: [
        {
          eventId: "dispatch:2026-09-30",
          gameDate: "2026-09-30",
          at: asOf,
          pieces: [1, 0, 0] as const,
          alreadyInStock: true,
        },
      ],
    },
  ])
    expect(certifiedRunCacheKey(changed, snapshot, asOf)).not.toBe(key);
  expect(
    certifiedRunCacheKey(
      {
        ...session,
        receipts: [{ eventId: "hidden", at: asOf, pieces: null, alreadyInStock: true }],
      },
      snapshot,
      asOf,
    ),
  ).toBe(key);
  for (const changed of [
    { ...snapshot, coverage: { ...snapshot.coverage, currentDay: "2026-10-01" } },
    { ...snapshot, sourceHash: "b".repeat(64) },
    { ...snapshot, sourceStatus: "healthy" as const },
    { ...snapshot, version: "certified-daily-v4" as const },
  ])
    expect(certifiedRunCacheKey(session, changed, asOf)).not.toBe(key);
});

it("binds the policy version independently of session storage", () => {
  const asOf = "2026-10-01T08:00:00Z";
  const snapshot = buildCertifiedSupplySnapshot({
    asOf,
    revision: "same-revision",
    sourceHash: "b".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  const session = createCertifiedSession(
    snapshot.revision,
    { grade: "SR", level: 14, exp: 0 },
    [10, 0, 0],
  );
  const v4 = certifiedRunCacheKey(session, { ...snapshot, version: "certified-daily-v4" }, asOf);
  const v5 = certifiedRunCacheKey(session, { ...snapshot, version: "certified-daily-v5" }, asOf);
  expect(session).not.toHaveProperty("cohortWeights");
  expect(v4).not.toBe(v5);
  expect(JSON.parse(v4).snapshot.version).toBe("certified-daily-v4");
  expect(JSON.parse(v5).snapshot.version).toBe("certified-daily-v5");
});
