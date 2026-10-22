import { describe, expect, it } from "vitest";
import type {
  CertifiedSoloRound,
  CertifiedSupplyEvent,
  CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import {
  certifiedRequestReceivedEventIds,
  createCertifiedSession,
  reconcileCertifiedSession,
  recordCertifiedOutcome,
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

describe("engine request receipts", () => {
  const asOf = "2026-09-30T04:00:00Z"; // 13:00 KST on game day 2026-09-30
  const solo = (round: number): CertifiedSupplyEvent => ({
    ...event,
    id: `solo:r${round}:day1`,
    kind: "solo",
    round,
  });
  const events: CertifiedSupplyEvent[] = [
    event, // today's dispatch, arrived 05:00 KST
    { ...event, id: "shop:2026-09-30", kind: "shop", cancelled: true },
    { ...event, id: "dispatch:later", at: "2026-09-30T06:00:00Z" },
    {
      ...event,
      id: "weekly-kits:2026-09-23",
      gameDate: "2026-09-23",
      at: "2026-09-22T20:00:00Z",
      expiresAt: "2026-09-29T20:00:00Z",
    },
    {
      ...event,
      id: "weekly-kits:2026-09-24",
      gameDate: "2026-09-24",
      at: "2026-09-23T20:00:00Z",
      expiresAt: "2026-10-05T20:00:00Z",
    },
    { ...event, id: "dispatch:2026-09-29", gameDate: "2026-09-29", at: "2026-09-28T20:00:00Z" },
    { ...event, id: "dispatch:2026-09-28", gameDate: "2026-09-28", at: "2026-09-27T20:00:00Z" },
    solo(41),
    solo(40),
  ];
  const round = (number: number, status: CertifiedSoloRound["status"], startGameDate: string) => ({
    round: number,
    startGameDate,
    endGameDate: null,
    status,
    sourceIds: [],
  });

  it("adds every currently claimable reward to the stored receipts without changing the session", async () => {
    const snapshot: CertifiedSupplySnapshot = {
      ...(await prepareCertifiedForecast(asOf)),
      events,
      soloRounds: [round(40, "confirmed", "2026-09-30"), round(41, "estimated", "2026-09-28")],
    };
    const session = {
      ...createCertifiedSession("revision-a", { grade: "SR", level: 14, exp: 0 }, [40, 2, 1]),
      receipts: [
        {
          eventId: "dispatch:2026-09-28",
          gameDate: "2026-09-28",
          at: "2026-09-28T04:00:00Z",
          pieces: [3, 0, 0] as [number, number, number],
          alreadyInStock: false,
        },
      ],
    };
    const before = structuredClone(session);
    expect(certifiedRequestReceivedEventIds(session, snapshot, asOf)).toEqual([
      "dispatch:2026-09-30",
      "weekly-kits:2026-09-24",
      "dispatch:2026-09-28",
      "solo:r40:day1",
    ]);
    // Cancelled, later-today, expired, closed prior-day and estimated solo rewards stay out.
    expect(session).toEqual(before);
  });
});

describe("certified personal ledger", () => {
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
