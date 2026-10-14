import { expect, it } from "vitest";
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
  expect(certifiedRunCacheKey(session, { ...snapshot, asOf: "2026-09-30T08:01:00Z" }, asOf)).toBe(
    key,
  );
  for (const changed of [
    { ...session, stock: [32, 4, 9] as const },
    { ...session, state: { ...session.state, level: 11 } },
    {
      ...session,
      receipts: [{ eventId: "claim", at: asOf, pieces: [1, 0, 0] as const, alreadyInStock: true }],
    },
  ])
    expect(certifiedRunCacheKey(changed, snapshot, asOf)).not.toBe(key);
  for (const changed of [
    { ...snapshot, coverage: { ...snapshot.coverage, currentDay: "2026-10-01" } },
    { ...snapshot, sourceHash: "b".repeat(64) },
    { ...snapshot, sourceStatus: "healthy" as const },
  ])
    expect(certifiedRunCacheKey(session, changed, asOf)).not.toBe(key);
});
