import { describe, expect, it } from "vitest";
import type { CertifiedSupplyEvent } from "../../shared/certifiedSupply";
import type { CertifiedSupplyLaw } from "../../shared/certifiedSupplyLaws";
import {
  acknowledgeCertifiedReceipt,
  certifiedClaimableEvents,
  createCertifiedSession,
  reconcileCertifiedSession,
  recordCertifiedOutcome,
  recordCertifiedReceipt,
  restoreCertifiedSession,
} from "./session";

const event: CertifiedSupplyEvent = {
  id: "dispatch:2026-09-30",
  gameDate: "2026-09-30",
  at: "2026-09-29T20:00:00Z",
  kind: "dispatch",
  status: "confirmed",
  refs: [{ lawId: "observed-cohort", count: 1 }],
  ruleId: "fixture",
  sourceIds: [],
};
const laws: readonly CertifiedSupplyLaw[] = [
  {
    id: "observed-cohort",
    kind: "finite",
    modelVersion: "fixture-v1",
    outcomesByCohort: [
      [{ pieces: [3, 0, 0], mass: { numerator: "1", denominator: "1" } }],
      [{ pieces: [0, 2, 0], mass: { numerator: "1", denominator: "1" } }],
      [{ pieces: [0, 0, 1], mass: { numerator: "1", denominator: "1" } }],
    ],
  },
];

describe("certified personal ledger", () => {
  it("does not invent a historical claim backlog from unknown expiry", () => {
    const session = createCertifiedSession("review6", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
    const now = Date.parse("2026-10-01T04:00:00Z");
    expect(certifiedClaimableEvents([event, { ...event, expiresAt: null }], session, now)).toEqual(
      [],
    );
    expect(() => acknowledgeCertifiedReceipt(session, event, new Date(now).toISOString())).toThrow(
      "receipt_not_claimable",
    );
    expect(
      certifiedClaimableEvents([{ ...event, expiresAt: "2026-10-02T00:00:00Z" }], session, now),
    ).toHaveLength(1);
  });

  it("admits current-day receipts only after their actual arrival and before explicit expiry", () => {
    const session = createCertifiedSession("review6", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
    const noon = { ...event, at: "2026-09-30T12:00:00+09:00" };
    expect(
      certifiedClaimableEvents([noon], session, Date.parse("2026-09-30T09:30:00+09:00")),
    ).toEqual([]);
    expect(
      certifiedClaimableEvents([noon], session, Date.parse("2026-09-30T12:01:00+09:00")),
    ).toHaveLength(1);
    expect(
      certifiedClaimableEvents(
        [{ ...noon, expiresAt: "2026-09-30T12:01:00+09:00" }],
        session,
        Date.parse("2026-09-30T12:01:00+09:00"),
      ),
    ).toEqual([]);
  });

  it("keeps the raw remainder and charges exactly one use before a great success", () => {
    const session = createCertifiedSession(
      "revision-a",
      { grade: "SR", level: 14, exp: 0 },
      [19, 0, 0],
    );
    const next = recordCertifiedOutcome(session, "blue", "great", "2026-09-30T04:00:00Z");
    expect(next.stock).toEqual([9, 0, 0]);
    expect(next.state).toEqual({ grade: "SR", level: 15, exp: 0 });
    expect(session.stock).toEqual([19, 0, 0]);
  });
  it("cannot record a use without ten pieces", () => {
    const session = createCertifiedSession(
      "revision-a",
      { grade: "SR", level: 14, exp: 0 },
      [9, 0, 0],
    );
    expect(() => recordCertifiedOutcome(session, "blue", "normal", "2026-09-30T04:00:00Z")).toThrow(
      "insufficient_stock",
    );
    expect(session.outcomes).toHaveLength(0);
  });
  it("revision changes preserve received stock and receipts for deleted events", () => {
    const original = createCertifiedSession(
      "revision-a",
      { grade: "SR", level: 14, exp: 0 },
      [40, 2, 1],
    );
    const session = {
      ...original,
      receipts: [
        {
          eventId: "solo:r40:day1",
          at: "2026-08-20T04:00:00Z",
          pieces: [24, 2, 0] as const,
          alreadyInStock: false,
        },
      ],
    };
    const next = reconcileCertifiedSession(session, "revision-b", []);
    expect(next.stock).toEqual([40, 2, 1]);
    expect(next.receipts).toEqual(session.receipts);
    expect(next.retiredReceiptIds).toEqual(["solo:r40:day1"]);
  });
  it("restores only validated staging data and never accepts another engine identity", () => {
    const session = createCertifiedSession(
      "revision-a",
      { grade: "R", level: 0, exp: 0 },
      [0, 0, 0],
    );
    expect(restoreCertifiedSession(JSON.stringify(session))).toEqual(session);
    expect(
      restoreCertifiedSession(JSON.stringify({ ...session, profileId: "production" })),
    ).toBeNull();
    expect(restoreCertifiedSession(JSON.stringify({ ...session, stock: [-1, 0, 0] }))).toBeNull();
    const receipt = {
      eventId: event.id,
      at: "2026-09-30T04:00:00Z",
      pieces: [3, 0, 0],
      alreadyInStock: false,
    };
    const outcome = {
      kit: "blue",
      outcome: "normal",
      at: receipt.at,
      before: session.state,
      after: { ...session.state, exp: 100 },
    };
    for (const corrupted of [
      { ...session, receipts: [receipt, receipt] },
      { ...session, receipts: [{ ...receipt, pieces: null }] },
      { ...session, outcomes: [{ ...outcome, kit: "unknown" }] },
      { ...session, outcomes: [{ ...outcome, outcome: "unknown" }] },
      { ...session, outcomes: [{ ...outcome, before: { ...session.state, level: 16 } }] },
      { ...session, outcomes: [{ ...outcome, after: { ...session.state, exp: 1 } }] },
      { ...session, state: { ...session.state, level: 15, exp: 100 } },
      {
        ...session,
        cohortWeights: [
          { numerator: "-1", denominator: "1" },
          { numerator: "1", denominator: "1" },
          { numerator: "1", denominator: "1" },
        ],
      },
      {
        ...session,
        cohortWeights: [
          { numerator: "0", denominator: "1" },
          { numerator: "0", denominator: "1" },
          { numerator: "0", denominator: "1" },
        ],
      },
      {
        ...session,
        cohortWeights: [{ numerator: "1", denominator: "0" }, ...session.cohortWeights.slice(1)],
      },
    ])
      expect(restoreCertifiedSession(JSON.stringify(corrupted))).toBeNull();
    const restored = restoreCertifiedSession(
      JSON.stringify({ ...session, receipts: [receipt], outcomes: [outcome] }),
    );
    expect(restored?.receipts).toEqual([receipt]);
    expect(restored?.outcomes).toEqual([outcome]);
  });
});

describe("certified receipt observations", () => {
  it("uses the adopted event law and carries the same inferred cohort into later days", () => {
    const session = createCertifiedSession(
      "revision-a",
      { grade: "SR", level: 14, exp: 0 },
      [0, 0, 0],
    );
    const observed = recordCertifiedReceipt(
      session,
      event,
      [0, 2, 0],
      "2026-09-30T04:00:00Z",
      false,
      { laws },
    );
    expect(observed.stock).toEqual([0, 2, 0]);
    expect(observed.cohortWeights).toEqual([
      { numerator: "0", denominator: "1" },
      { numerator: "1", denominator: "1" },
      { numerator: "0", denominator: "1" },
    ]);
    expect(() =>
      recordCertifiedReceipt(
        observed,
        { ...event, id: "dispatch:2026-10-01", gameDate: "2026-10-01", at: "2026-09-30T20:00:00Z" },
        [3, 0, 0],
        "2026-10-01T04:00:00Z",
        false,
        { laws },
      ),
    ).toThrow("receipt_outside_supply_model");
    expect(() =>
      recordCertifiedReceipt(observed, event, [0, 2, 0], "2026-09-30T04:00:00Z", false, { laws }),
    ).toThrow("receipt_not_claimable");
  });
  it("acknowledges already counted pieces without fabricating an observation or adding stock", () => {
    const session = createCertifiedSession(
      "revision-a",
      { grade: "SR", level: 14, exp: 0 },
      [40, 2, 1],
    );
    const next = acknowledgeCertifiedReceipt(session, event, "2026-09-30T04:00:00Z");
    expect(next.stock).toEqual(session.stock);
    expect(next.cohortWeights).toEqual(session.cohortWeights);
    expect(next.receipts).toEqual([
      { eventId: event.id, at: "2026-09-30T04:00:00Z", pieces: null, alreadyInStock: true },
    ]);
    expect(restoreCertifiedSession(JSON.stringify(next))).toEqual(next);
  });
});
