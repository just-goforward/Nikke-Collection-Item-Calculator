import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveRow, ReviewRow } from "../../shared/forecast-publication/store.ts";
import { publicationHash } from "../../shared/forecastPublication.ts";
import { supplyForecastCandidateSchema } from "../../shared/supplyForecastCandidate.ts";
import {
  loadReviewCompetition,
  publicationReviewContent,
  publicationReviewPayload,
} from "./publication-review-message.ts";
import { localDatabase } from "./test-database.ts";

// Lead's SELECT-only staging capture, 2026-10-21. Each string preserves the original
// payload_json bytes; no Wrangler metadata or non-forecast records are retained.
const payloads: string[] = JSON.parse(
  readFileSync(new URL("./fixtures/staging-publication-candidates.json", import.meta.url), "utf8"),
);
const candidates = payloads.map((payload) =>
  supplyForecastCandidateSchema.parse(JSON.parse(payload)),
);
const ACTIVE = "forecast-8d394501e121291efebaf687";
const FIRST = "forecast-5814579f4e4be1ceffd3025f";
const LAST = "forecast-b5d86d532c4ab956a65a63c4";
const NOW = Date.parse("2026-10-21T23:01:14.000Z");
const DAY = 86_400_000;
const active: ActiveRow = {
  environment: "staging",
  sequence: 3,
  candidate_id: ACTIVE,
  operation_id: null,
  signed_pointer_json: null,
};

function candidate(id: string) {
  const value = candidates.find((row) => row.candidateId === id);
  if (!value) throw new Error("staging_candidate_fixture_missing");
  return value;
}

function snapshot(id: string) {
  const value = candidate(id).certifiedSnapshot;
  if (!value) throw new Error("staging_snapshot_fixture_missing");
  return value;
}

// Actions, candidate prefixes and expiry timestamps come from the Lead's five-row
// review evidence. Actual review IDs were not supplied, so IDs are explicit test
// markers. The first two approval payloads were not supplied either: their coverage
// remains unknown in this local database rather than being fabricated.
const reviews: (ReviewRow & { created_at: number })[] = [
  ["off", null, "00:01:58.797", "fixture-off"],
  ["approve", "forecast-2f94cb74", "00:10:58.871", "fixture-2f94cb74"],
  ["approve", "forecast-1e37a007", "00:13:59.143", "fixture-1e37a007"],
  ["approve", FIRST, "20:52:59.241", "fixture-5814579f"],
  ["approve", LAST, "20:56:01.534", "fixture-b5d86d53"],
].map(([action, id, time, reviewId]) => {
  const expires = Date.parse(`2026-10-22T${time}Z`);
  return {
    review_id: String(reviewId),
    environment: "staging",
    action: action === "off" ? "off" : "approve",
    candidate_id: id ?? null,
    payload_hash: null,
    expected_sequence: 3,
    previous_candidate_id: ACTIVE,
    expires_at: expires,
    created_at: expires - DAY,
  };
});
const sqlite = new DatabaseSync(":memory:");
const db = localDatabase(sqlite);

beforeAll(async () => {
  sqlite.exec(`
    CREATE TABLE forecast_candidates(candidate_id TEXT PRIMARY KEY,payload_json TEXT);
    CREATE TABLE forecast_runtime_reviews(review_id TEXT PRIMARY KEY,environment TEXT,
      action TEXT,candidate_id TEXT,created_at INTEGER,expires_at INTEGER,expected_sequence INTEGER);
    CREATE TABLE forecast_runtime_activation_history(review_id TEXT);
  `);
  for (const payload of payloads) {
    const row = JSON.parse(payload);
    sqlite.prepare("INSERT INTO forecast_candidates VALUES(?,?)").run(row.candidateId, payload);
  }
  for (const review of reviews) {
    if (review.candidate_id === FIRST || review.candidate_id === LAST)
      review.payload_hash = await publicationHash(candidate(review.candidate_id));
    sqlite
      .prepare("INSERT INTO forecast_runtime_reviews VALUES(?,?,?,?,?,?,?)")
      .run(
        review.review_id,
        review.environment,
        review.action,
        review.candidate_id,
        review.created_at,
        review.expires_at,
        review.expected_sequence,
      );
  }
});
afterAll(() => sqlite.close());

async function input(id: string) {
  const review = reviews.find((row) => row.candidate_id === id);
  if (!review) throw new Error("staging_review_fixture_missing");
  return {
    review,
    active,
    candidate: candidate(id),
    activeCandidate: candidate(ACTIVE),
    competition: await loadReviewCompetition(db, review, NOW),
    now: NOW,
  };
}

function golden(name: string) {
  return readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8").trimEnd();
}

describe("real sealed staging publication payloads", () => {
  it("retains every captured payload byte and the sealed canonical hashes", async () => {
    expect(payloads.map((payload) => createHash("sha256").update(payload).digest("hex"))).toEqual([
      "6271311a91755d97fa45adc9a8a1296af634fd894d12b088057640a70521f8b0",
      "29b35682ba2de896a719db6b2b6725404d5921b4fd08e1201eba9d13a9564114",
      "bed9b75b6394d8b9032c19a6e8463bff2fb416087867b7cd53144abc82594e54",
    ]);
    expect(await Promise.all(candidates.map(publicationHash))).toEqual([
      "641b555bc1f6594fb6b096418b9a2ff8beecaba933ea6d9fd09e2cd7fe478913",
      "b90c87ec8fdc69d0b75ad969dd1cfe69c8fd1754e35825b0bf332c2bb25c3f74",
      "c9119417022031498329c5ad18dd13f37d8aec804c48b4aa0d519efbd867c0cc",
    ]);
  });

  it.each([
    [FIRST, "publication-review-5814579f"],
    [LAST, "publication-review-b5d86d53"],
  ])("renders %s against the captured active payload", async (id, name) => {
    const value = await input(id);
    expect(value.competition.counts).toEqual({ approve: 4, rollback: 0, off: 1 });
    expect(value.competition.todayCount).toBe(1); // Only the supplied 5814579f payload is today.
    const payload = publicationReviewPayload(value);
    expect(payload.content).toBe(golden(name));
    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.components[0]?.components[0]?.label).toBe("승인 (staging)");
    expect(value.competition.newer?.candidateId ?? null).toBe(id === FIRST ? LAST : null);
  });

  it("shows the real candidate contents without inventing an active baseline", async () => {
    const value = await input(FIRST);
    const content = publicationReviewContent({
      ...value,
      active: { ...active, sequence: 0, candidate_id: null },
      activeCandidate: null,
      review: { ...value.review, expected_sequence: 0, previous_candidate_id: null },
      competition: { counts: { approve: 1, rollback: 0, off: 0 }, todayCount: 1, newer: null },
    });
    expect(content).toBe(golden("publication-review-active-off"));
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).not.toContain("구성 동일");
  });

  it.each([FIRST, LAST])(
    "retains captured bytes while classifying rolling-window omissions: %s",
    async (id) => {
      const before = candidate(ACTIVE).certifiedSnapshot;
      const after = candidate(id).certifiedSnapshot;
      if (!before || !after) throw new Error("staging_snapshot_fixture_missing");
      expect(before.soloRounds.find((row) => row.round === 41)?.endGameDate).toBe("2026-10-01");
      expect(after.soloRounds.find((row) => row.round === 41)?.endGameDate).toBeNull();
      expect(before.rules[0]?.effectiveFrom).toBe("2026-10-11T20:00:00.000Z");
      expect(after.rules[0]?.effectiveFrom).toBe(
        id === FIRST ? "2026-10-14T20:00:00.000Z" : "2026-10-13T20:00:00.000Z",
      );
      expect(after.rules.map(({ effectiveFrom: _, ...rule }) => rule)).toEqual(
        before.rules.map(({ effectiveFrom: _, ...rule }) => rule),
      );
      expect(after.laws).toEqual(before.laws);
      expect(candidate(id).grants).toEqual(candidate(ACTIVE).grants);
      expect(Date.parse(after.coverage.from) - Date.parse(before.coverage.from)).toBe(
        Date.parse(after.coverage.currentDay) - Date.parse(before.coverage.currentDay),
      );
      const content = publicationReviewContent(await input(id));
      expect(content).not.toContain("라운드 41 변경");
      expect(content).not.toContain("파견 변경");
      expect(content).toContain("· 적용 기간 시작일만 기준 게임일에 맞춰 이동");
    },
  );
});

describe("publication comparison window and wording boundaries", () => {
  it("does not hide a shop quantity change while the coverage window moves", async () => {
    const value = await input(FIRST);
    const original = snapshot(FIRST);
    const content = publicationReviewContent({
      ...value,
      candidate: {
        ...value.candidate,
        certifiedSnapshot: {
          ...original,
          rules: original.rules.map((rule) => ({
            ...rule,
            normalShop: rule.normalShop.map((ref) => ({ ...ref, count: 6 })),
          })),
        },
      },
    });
    expect(content).toContain("· 상점(주당) 변경: 상자 II 5개 → 상자 II 6개");
    expect(content).not.toContain("파견 변경");
    expect(content).not.toContain("시작일만");
  });

  it.each(["effectiveFrom", "effectiveUntil"] as const)(
    "reports a non-window %s change and names all overflow kinds",
    async (field) => {
      const value = await input(FIRST);
      const original = snapshot(FIRST);
      const content = publicationReviewContent({
        ...value,
        candidate: {
          ...value.candidate,
          certifiedSnapshot: {
            ...original,
            rules: original.rules.map((rule) => ({
              ...rule,
              [field]: field === "effectiveFrom" ? "2026-10-15T21:00:00Z" : "2026-12-31T20:00:00Z",
            })),
          },
        },
      });
      expect(content).toContain("· 파견(일당) 적용 기간 변경:");
      expect(content).toContain("· 상점(주당) 적용 기간 변경:");
      expect(content).toContain("· 외 2건: 콜라보 상점(주당) · 주간 키트");
      expect(content).not.toContain("그 외 2건 구성 변경");
      expect(content).not.toContain("시작일만");
    },
  );

  it("flags a lost confirmed end inside the coverage window instead of treating it as history", async () => {
    const value = await input(FIRST);
    const original = snapshot(FIRST);
    const content = publicationReviewContent({
      ...value,
      activeCandidate: value.candidate,
      candidate: {
        ...value.candidate,
        certifiedSnapshot: {
          ...original,
          soloRounds: original.soloRounds.map((round) =>
            round.round === 42 ? { ...round, endGameDate: null } : round,
          ),
        },
      },
    });
    expect(content).toContain(
      "· 라운드 42 변경: 10-15~10-21 (확정) → 10-15 시작 · 종료일 정보 없음(확인 필요) (확정)",
    );
    expect(content).not.toContain("10-15부터");
  });

  it("preserves unknown reward identifiers verbatim instead of guessing Korean names", async () => {
    const value = await input(FIRST);
    const original = snapshot(FIRST);
    const content = publicationReviewContent({
      ...value,
      active: { ...active, candidate_id: null },
      activeCandidate: null,
      candidate: {
        ...value.candidate,
        certifiedSnapshot: {
          ...original,
          rules: original.rules.map((rule) => ({
            ...rule,
            weeklyFixed: [{ lawId: "unknown-weekly-law", count: 1 }],
          })),
          laws: original.laws.map((law, index) =>
            index === 0 ? { ...law, id: "unknown-reward-law" } : law,
          ),
        },
      },
    });
    expect(content).toContain("· 주간 키트: unknown-weekly-law 1");
    expect(content).toContain("보상 종류: unknown-reward-law");
  });
});
