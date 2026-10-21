import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { renderForecastV2Notification } from "../../../../shared/forecastV2Notifications";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { maintainDecisions, requestDecision } from "./decisions";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});

it("stores decision evidence and repeats it in the reminder", async () => {
  const db = env.FORECAST_DB;
  const created = "2026-06-25T08:00:00.000Z";
  await requestDecision(
    db,
    {
      id: "evidence_review",
      type: "solo_review",
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [6252194],
      title: "솔로 레이드 시즌 41",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [],
      extracted: { startAt: "2026-10-23T02:00:00.000Z", endAt: "2026-11-04T19:59:59.000Z" },
      evidence: {
        goal: "솔로 레이드 일정 확정",
        reason: "maintenance_missing",
        postedAt: created,
        confirmed: ["감지한 키워드: 솔로 레이드"],
        guess: { startAt: "2026-10-23T02:00:00.000Z", endAt: "2026-11-04T19:59:59.000Z" },
      },
    },
    created,
  );
  const stored = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_decision_requests WHERE decision_id=?")
        .bind("evidence_review")
        .first<string>("payload_json"),
    ),
  ) as { evidence: Record<string, unknown>; extracted: { complete: boolean } };
  expect(stored.extracted.complete).toBe(true);
  expect(stored.evidence).toMatchObject({
    goal: "솔로 레이드 일정 확정",
    reason: "maintenance_missing",
    confirmed: ["감지한 키워드: 솔로 레이드"],
  });
  const request = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_notification_outbox WHERE idempotency_key=?")
        .bind("decision_evidence_review")
        .first<string>("payload_json"),
    ),
  ) as Record<string, unknown>;
  expect(request).toMatchObject({ reason: "maintenance_missing", goal: "솔로 레이드 일정 확정" });
  await maintainDecisions(db, "2026-07-03T08:00:00.000Z");
  const reminder = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_notification_outbox WHERE idempotency_key=?")
        .bind("reminder_evidence_review")
        .first<string>("payload_json"),
    ),
  ) as Record<string, unknown>;
  expect(reminder).toMatchObject({
    title: "솔로 레이드 시즌 41",
    url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
    goal: "솔로 레이드 일정 확정",
    reason: "maintenance_missing",
    confirmed: ["감지한 키워드: 솔로 레이드"],
  });
});

it.each([
  ["grant_date", [{ id: "date_0", label: "2026-06-25" }]],
  [
    "grant_quantity",
    [
      { id: "separate", label: "별도 지급" },
      { id: "correction", label: "정정" },
    ],
  ],
  ["maintenance", [{ id: "ignore", label: "관련 없음" }]],
  ["collaboration", [{ id: "ignore", label: "관련 없음" }]],
] as const)(
  "keeps a legacy %s reminder free of synthesized judgment facts",
  async (type, options) => {
    const db = env.FORECAST_DB;
    const created = "2026-06-25T08:00:00.000Z";
    await requestDecision(
      db,
      {
        id: `legacy_${type}`,
        type,
        environment: "staging",
        eventId: null,
        sourceHash: "a".repeat(64),
        feedIds: [6252194],
        title: "공지",
        url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
        options: [...options],
      },
      created,
    );
    await maintainDecisions(db, "2026-07-03T08:00:00.000Z");
    const reminder = JSON.parse(
      String(
        await db
          .prepare(
            "SELECT payload_json FROM forecast_v2_notification_outbox WHERE idempotency_key=?",
          )
          .bind(`reminder_legacy_${type}`)
          .first<string>("payload_json"),
      ),
    ) as Record<string, unknown>;
    // The row stored no evidence, so nothing about the judgment may be invented.
    for (const key of ["goal", "reason", "blocked", "todo", "confirmed", "guessed"])
      expect(reminder[key]).toBeUndefined();
    expect(reminder["type"]).toBe(type);
    expect(reminder["title"]).toBe("공지");
    expect(reminder["url"]).toBe("https://game.naver.com/lounge/nikke/board/detail/6252194");
    expect(Date.parse(String(reminder["expiresAt"]))).toBeGreaterThan(Date.parse(created));
  },
);

it("renders a legacy complete solo reminder neutrally, never as a period failure", async () => {
  const db = env.FORECAST_DB;
  const created = "2026-06-25T08:00:00.000Z";
  // A decision row written before the evidence schema: extraction, no evidence.
  await db
    .prepare(`INSERT INTO forecast_v2_decision_requests
    (decision_id,type,event_id,payload_json,payload_hash,expected_calendar_revision,expires_at,status,created_at)
    VALUES('legacy_solo','solo_review',NULL,?,?,0,'2026-07-09T08:00:00.000Z','pending',?)`)
    .bind(
      JSON.stringify({
        env: "staging",
        eventId: null,
        sourceHash: "a".repeat(64),
        feedIds: [6252194],
        title: "솔로 레이드 시즌 41",
        url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
        options: [],
        extracted: {
          complete: true,
          startAt: "2026-06-25T02:00:00.000Z",
          endAt: "2026-07-08T19:59:59.000Z",
        },
      }),
      "b".repeat(64),
      created,
    )
    .run();
  await maintainDecisions(db, "2026-07-03T08:00:00.000Z");
  const payload = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_notification_outbox WHERE kind=?")
        .bind("decision_reminder")
        .first<string>("payload_json"),
    ),
  ) as Record<string, unknown>;
  expect(payload).toMatchObject({ type: "solo_review", title: "솔로 레이드 시즌 41" });
  expect(payload["reason"]).toBeUndefined();
  const message = renderForecastV2Notification("decision_reminder", payload, {
    environment: "staging",
    expectedRevision: 0,
    idempotencyKey: "reminder_legacy_solo",
  });
  const lines = (message.embeds[0]?.description ?? "").split("\n");
  expect(lines[1]).toBe("하려던 일: 솔로 레이드 일정 확정");
  expect(lines[2]).toBe("✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다");
  expect(lines[3]).toBe("🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다");
  expect(lines[4]).toBe("❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다");
  expect(lines[4]).not.toContain("진행 기간(시작·종료)을 확정하지 못했습니다");
  expect(lines.at(-1)).toMatch(/^만료 \d{2}\/\d{2}\(.\) \d{2}:\d{2} KST$/);
});

it("clamps oversized evidence instead of failing the outbox insert", async () => {
  const db = env.FORECAST_DB;
  await requestDecision(
    db,
    {
      id: "long_evidence",
      type: "grant_quantity",
      environment: "staging",
      eventId: null,
      sourceHash: "a".repeat(64),
      feedIds: [6252194],
      title: "지급",
      url: "https://game.naver.com/lounge/nikke/board/detail/6252194",
      options: [{ id: "separate", label: "별도 지급" }],
      evidence: {
        goal: "g".repeat(400),
        confirmed: Array.from({ length: 9 }, () => "c".repeat(400)),
        blocked: "b".repeat(900),
      },
    },
    "2026-06-25T08:00:00.000Z",
  );
  const payload = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_notification_outbox WHERE idempotency_key=?")
        .bind("decision_long_evidence")
        .first<string>("payload_json"),
    ),
  ) as { goal: string; confirmed: string[]; blocked: string };
  expect(payload.goal.length).toBe(120);
  expect(payload.confirmed).toHaveLength(6);
  expect(payload.confirmed.every((item) => item.length === 160)).toBe(true);
  expect(payload.blocked.length).toBe(240);
});
