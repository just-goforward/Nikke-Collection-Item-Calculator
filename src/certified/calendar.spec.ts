import { describe, expect, it } from "vitest";
import { q, toWire } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplyEvent,
} from "../../shared/certifiedSupply";
import { solveCertified } from "./solver";
import type { CertifiedInput } from "./types";

const AS_OF = "2026-08-20T08:00:00.000Z";
function event(day: number, at?: string, expiresAt?: string): CertifiedSupplyEvent {
  const gameDate = new Date(Date.parse("2026-08-20T00:00:00Z") + day * 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `dispatch:${gameDate}`,
    gameDate,
    at: at ?? `${gameDate}T08:00:00.000Z`,
    kind: "dispatch",
    status: "confirmed",
    refs: [{ lawId: "deterministic:0,0,10", count: 1 }],
    ruleId: "calendar-test",
    ...(expiresAt ? { expiresAt } : {}),
  };
}
function request(events: CertifiedSupplyEvent[], receivedEventIds: string[] = []): CertifiedInput {
  const base = buildCertifiedSupplySnapshot({
    asOf: AS_OF,
    revision: "calendar-regression",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
    sourceStatus: "healthy",
  });
  const snapshot = {
    ...base,
    events,
    rules: [
      {
        id: "calendar-test",
        effectiveFrom: "2020-01-01T00:00:00Z",
        effectiveUntil: null,
        dispatch: [{ lawId: "deterministic:1,1,1", count: 1 }],
        normalShop: [],
        collaborationShop: [],
        soloDays: [],
        provenance: ["calendar regression"],
      },
    ],
  };
  return {
    grade: "SR",
    level: 14,
    exp: 0,
    stock: [0, 0, 0],
    asOf: AS_OF,
    snapshot,
    receivedEventIds,
  };
}
describe("certified availability timing", () => {
  it("puts a later current-day reward at waiting day1 while D0 uses input stock", () => {
    const result = solveCertified(request([event(0, "2026-08-20T10:00:00.000Z")]));
    expect(result.current?.value.successP).toEqual(toWire(q(0)));
    expect(result.claimNotice).toBeNull();
    expect(result.waiting.recommendedDays).toBe(1);
    expect(result.waiting.value?.successP).toEqual(toWire(q(1)));
  });
  it("requires claiming an explicit unexpired previous-day reward", () => {
    const prior = event(-1, undefined, "2026-08-21T08:00:00.000Z");
    const result = solveCertified(request([prior]));
    expect(result.current?.value.successP).toEqual(toWire(q(0)));
    expect(result.claimNotice?.eventIds).toEqual([prior.id]);
    expect(result.waiting.status).toBe("claim_required");
    expect(result.waiting.recommendedDays).toBeNull();
  });
  it("does not claim a previous-day reward whose expiry equals asOf", () => {
    const result = solveCertified(request([event(-1, undefined, AS_OF)]));
    expect(result.claimNotice).toBeNull();
    expect(result.waiting.recommendedDays).toBe(0);
  });
  it("does not add or reclaim a previously received unexpired reward", () => {
    const prior = event(-1, undefined, "2026-08-21T08:00:00.000Z");
    const result = solveCertified(request([prior], [prior.id]));
    expect(result.current?.value.successP).toEqual(toWire(q(0)));
    expect(result.claimNotice).toBeNull();
    expect(result.waiting.recommendedDays).toBe(0);
  });
});
