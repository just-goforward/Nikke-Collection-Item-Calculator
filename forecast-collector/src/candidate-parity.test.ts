import { describe, expect, it } from "vitest";
import { assertForecastCandidateInvariants } from "../../shared/supplyForecastCandidate";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { sha256Hex, stableJson } from "./crypto";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

const sourceItem: NormalizedSourceItem = {
  source: "naver-board-56",
  itemId: "8060044",
  url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
  title: "Solo",
  excerpt: "Solo schedule",
  normalizedText: "Solo schedule",
  publishedAt: "2026-08-18T03:00:00.000Z",
  contentHash: "a".repeat(64),
  structured: true,
  official: true,
};
const solo: ScheduleEvent = {
  eventId: "naver-board-56:8060044:solo",
  eventType: "solo",
  sourceItem,
  startsAt: "2026-08-20T03:00:00.000Z",
  endsAt: "2026-08-26T19:59:00.000Z",
  scheduleStatus: "confirmed",
  manualReview: false,
  reason: null,
};
const collaboration: ScheduleEvent = {
  ...solo,
  eventId: "collab",
  eventType: "collaboration",
  sourceItem: {
    ...sourceItem,
    itemId: "8031679",
    url: "https://game.naver.com/lounge/nikke/board/detail/8031679",
    contentHash: "b".repeat(64),
  },
  startsAt: "2026-08-19T20:00:00.000Z",
  endsAt: "2026-09-09T19:59:00.000Z",
};

// Captured from the pre-optimization candidate builder, before changing projection arithmetic.
// Only approved coverage/provenance corrections were applied to those captured envelopes.
// JSON digests cover the entire envelope's UTF-8 bytes, including field/array order and floats.
const baseline = [
  {
    label: "solo-d1",
    at: "2026-08-20T00:00:00Z",
    bytes: 69273,
    profiles: 47,
    jsonSha256: "2416311f38d7a7bba1a4e740ba23fb8a8230033f93273c4ecc08cfc4b48ec28f",
    candidateId: "forecast-c07efd033724b8c77d857ee3",
    payloadHash: "686b3e48f8e11723a5e9439cf4b25a62f22f05b3a7072fc9dcaffead4892497e",
  },
  {
    label: "solo-d2",
    at: "2026-08-21T00:00:00Z",
    bytes: 69430,
    profiles: 48,
    jsonSha256: "52476bbb3b8f3c25d9bb4272162f59d566cf4f207869a8f09bf6418e7de2c2d5",
    candidateId: "forecast-8906414e99d8db52a56871ef",
    payloadHash: "d960d86e6d909a707bc13412503844340358cc03fd17b2b632ed79a48ce6b195",
  },
  {
    label: "solo-d3",
    at: "2026-08-22T00:00:00Z",
    bytes: 69469,
    profiles: 49,
    jsonSha256: "a0b53b541ead046e49754394a243d505857258997ca9c830a70a94f84a12d41c",
    candidateId: "forecast-1427ff15c9776ead696bd349",
    payloadHash: "1b650c71cfe0d79f04f6d784f9d33fafb15da72116770aa83991f6fc8eecef97",
  },
  {
    label: "collaboration",
    at: "2026-08-24T00:00:00Z",
    bytes: 69203,
    profiles: 49,
    jsonSha256: "4bec9468e61cc301bb20925499e1cf33b63343458d2164e4bc260f07633d2591",
    candidateId: "forecast-f5d4b49b29ae4c5324fc4fa2",
    payloadHash: "034e0818e323b072215d2ccb10b2e633a9c4f55932a447100d8b6575b056a60a",
  },
  {
    label: "incomplete",
    at: "2026-09-18T00:00:00Z",
    bytes: 65205,
    profiles: 43,
    jsonSha256: "2be7944dc5880a77993111fbc1dab144e2bedf7843c7c151acde4bd613d1dbf0",
    candidateId: "forecast-c989f479dcb917926dc62e98",
    payloadHash: "3dbb1f72ee83a80afd0b00d8c457189ca3bf80750dcb61dc656ce62831c4bc21",
  },
];

describe("candidate v5 migration from historical byte identities", () => {
  it.each(baseline)(
    "$label validates v5 profile coverage without reusing a historical identity",
    async (row) => {
      const now = Date.parse(row.at);
      const resolved = resolveSoloSchedule([solo], now);
      if (!resolved) throw new Error("resolved_schedule_fixture_missing");
      const result = await buildForecastCandidate(
        resolved,
        row.label === "collaboration" ? [collaboration] : [],
        { status: "x_unavailable", sourceItem: null, reason: "local-cpu-probe" },
        now,
        1,
      );
      const bytes = JSON.stringify(result);
      expect(await sha256Hex(bytes)).not.toBe(row.jsonSha256);
      expect(result.candidate.candidateId).not.toBe(row.candidateId);
      expect(result.payloadHash).not.toBe(row.payloadHash);
      expect(result.payloadHash).toBe(await sha256Hex(stableJson(result.candidate)));
      expect(result.candidate).toMatchObject({
        payloadVersion: 5,
        rulesVersion: "schedule-kit-v4",
        grants: [],
      });
      expect(() => assertForecastCandidateInvariants(result.candidate)).not.toThrow();
      expect(result.candidate.profiles.length).toBeGreaterThan(0);
      expect(
        result.candidate.profiles.every(
          (profile) =>
            profile.effectiveUntil !== null &&
            Date.parse(profile.effectiveUntil) - Date.parse(profile.effectiveFrom) === 86400000,
        ),
      ).toBe(true);
    },
  );
});
