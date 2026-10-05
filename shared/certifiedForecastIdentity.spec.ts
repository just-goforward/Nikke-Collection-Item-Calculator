import { describe, expect, it, vi } from "vitest";
import {
  assertCertifiedForecastIdentity,
  certifiedForecastIdentityWorkspaceBound,
  createCertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "./certifiedForecastIdentity";
import { buildCertifiedSupplySnapshot } from "./certifiedSupply";

const fixture = () =>
  buildCertifiedSupplySnapshot({
    asOf: "2026-08-20T09:30:00+09:00",
    revision: "content-identity",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });

describe("certified request content identity", () => {
  it("is independent of object key order and validates its complete envelope", async () => {
    const snapshot = fixture();
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
    const a = await createCertifiedForecastIdentity(snapshot);
    const b = await createCertifiedForecastIdentity(reordered as typeof snapshot);
    expect(sameCertifiedForecastIdentity(a, b)).toBe(true);
    expect(assertCertifiedForecastIdentity(a)).toEqual(a);
    expect(() => assertCertifiedForecastIdentity({ ...a, unchecked: true })).toThrow(
      "identity_mismatch",
    );
  });

  it("includes semantic arrival dates, asOf, and coverage even when source identity is unchanged", async () => {
    const snapshot = fixture();
    const original = await createCertifiedForecastIdentity(snapshot);
    const event = snapshot.events[0]!;
    const changed = [
      { ...snapshot, asOf: "2026-08-20T09:31:00+09:00" },
      {
        ...snapshot,
        events: [
          { ...event, at: new Date(Date.parse(event.at) + 3_600_000).toISOString() },
          ...snapshot.events.slice(1),
        ],
      },
      {
        ...snapshot,
        coverage: {
          ...snapshot.coverage,
          future: { ...snapshot.coverage.future, complete: false, missing: ["source_period"] },
        },
      },
    ];
    for (const input of changed) {
      const identity = await createCertifiedForecastIdentity(input);
      expect(identity.sourceHash).toBe(original.sourceHash);
      expect(identity.snapshotHash).not.toBe(original.snapshotHash);
    }
  });

  it("reserves hashing workspace before serialization/digest and releases it on denied admission", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const snapshot = fixture();
    const reservation: number[] = [];
    try {
      await expect(
        createCertifiedForecastIdentity(snapshot, (bytes) => {
          reservation.push(bytes);
          if (bytes) throw new Error("host_payload_limit");
        }),
      ).rejects.toThrow("host_payload_limit");
      expect(reservation).toEqual([certifiedForecastIdentityWorkspaceBound(snapshot), 0]);
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it("releases hashing workspace after a digest failure", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("digest_failed"));
    const reservation: number[] = [];
    try {
      await expect(
        createCertifiedForecastIdentity(fixture(), (bytes) => reservation.push(bytes)),
      ).rejects.toThrow("digest_failed");
      expect(reservation[0]).toBeGreaterThan(0);
      expect(reservation.at(-1)).toBe(0);
    } finally {
      digest.mockRestore();
    }
  });
});
