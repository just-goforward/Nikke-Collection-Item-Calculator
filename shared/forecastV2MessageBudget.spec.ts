import { describe, expect, it } from "vitest";
import {
  renderForecastV2Notification,
  validateForecastV2Payload,
} from "./forecastV2Notifications.ts";
import { buttonsOf, context, description, request } from "./forecastV2TestFixtures.ts";

describe("v2 message budget", () => {
  it("keeps every section and the expiry for a maximal valid payload", () => {
    const max = (length: number) => "가".repeat(length);
    const payload = {
      ...request,
      type: "collaboration" as const,
      options: Array.from({ length: 24 }, (_, i) => ({ id: `o${i}`, label: max(160) })),
      goal: max(120),
      reason: "collaboration_start_unresolved",
      postedAt: "2026-10-22T02:00:00.000Z",
      confirmed: Array.from({ length: 6 }, () => max(160)),
      guessed: Array.from({ length: 6 }, () => max(160)),
      blocked: max(240),
      todo: max(300),
    };
    const message = renderForecastV2Notification("decision_request", payload, context);
    const text = description(message);
    for (const section of [
      "🔎",
      "하려던 일:",
      "✅ 확인한 것:",
      "🤔 추측한 것:",
      "❌ 막힌 이유:",
      "👉 해 주실 일:",
      "만료 ",
    ])
      expect(text).toContain(section);
    expect(text).toContain("외 ");
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.length + `ref:${context.idempotencyKey}`.length).toBeLessThanOrEqual(2000);
    expect(buttonsOf(message)).toHaveLength(25);
    // The action-coverage contract must also hold under saturation.
    const todo = text.split("\n").find((line) => line.startsWith("👉 해 주실 일:"));
    const labels = buttonsOf(message).map((button) => button.label);
    for (const referenced of todo?.matchAll(/\[([^\]]+)\]/g) ?? [])
      expect(labels).toContain(referenced[1]);
    for (const action of buttonsOf(message)
      .filter((button) => !button.custom_id.includes(":opt:"))
      .map((button) => button.label))
      expect(todo).toContain(`[${action}]`);
  });

  it("truncates an oversized title and still keeps a valid masked link", () => {
    const title = `${"]".repeat(1400)} ${"[".repeat(1400)} 긴 제목`;
    expect(title.length).toBeGreaterThan(2000);
    const message = renderForecastV2Notification(
      "decision_request",
      { ...request, title, type: "solo_review", options: [], reason: "solo_period_unresolved" },
      context,
    );
    const text = description(message);
    for (const section of [
      "하려던 일:",
      "✅ 확인한 것:",
      "🤔 추측한 것:",
      "❌ 막힌 이유:",
      "👉 해 주실 일:",
      "만료 ",
    ])
      expect(text).toContain(section);
    expect(text.length + `ref:${context.idempotencyKey}`.length).toBeLessThanOrEqual(2000);
    // The escaped brackets can never close the label early or open a link.
    expect(text.split("\n")[0]).toContain("](https://game.naver.com/lounge/nikke/board/detail/1)");
    expect(text).not.toContain("\n]");
    expect(buttonsOf(message).map((b) => b.custom_id)).toEqual([
      "fv2:s:bedit:one:7",
      "fv2:s:bno:one:7",
    ]);
  });

  it("budgets a long notice URL so guidance and expiry always survive", () => {
    // A same-host URL with a huge query string; validation keeps it, the budget must not.
    const url = `${request.url}?${"q".repeat(4000)}`;
    expect(validateForecastV2Payload("decision_request", { ...request, url })).toBe(true);
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        url,
        type: "maintenance",
        options: [
          { id: "source_0", label: "2026-10-23T02:00:00Z ~ 2026-10-23T07:00:00Z" },
          { id: "ignore", label: "관련 없음" },
        ],
        reason: "maintenance_conflict",
        confirmed: ["이 공지의 점검: 10/23(금) 11:00 ~ 10/23(금) 16:00"],
      },
      context,
    );
    const text = description(message);
    for (const section of ["🔎", "❌ 막힌 이유:", "👉 해 주실 일:", "만료 "])
      expect(text).toContain(section);
    expect(text).toContain("같은 날짜에 이미 다른 점검 일정이 있어");
    expect(text.length + `ref:${context.idempotencyKey}`.length).toBeLessThanOrEqual(2000);
    // The message degrades by dropping the unusable link, not by cutting the guidance:
    // the escaped title text still identifies the post on the first line.
    expect(text).not.toContain("q".repeat(50));
    expect(text.split("\n")[0]).toBe("🔎 @\u200beveryone \\*\\*공지\\*\\*");
    expect(text.endsWith(" KST")).toBe(true);
  });

  it("keeps the expiry when a saturated reminder carries the longest bounded noGuess", () => {
    const message = renderForecastV2Notification(
      "decision_reminder",
      {
        decisionRequestId: "one",
        type: "collaboration",
        title: "콜라보 재안내",
        url: request.url,
        reason: "collaboration_overlap",
        noGuess: "가".repeat(160),
        confirmed: Array.from({ length: 6 }, () => "가".repeat(160)),
        expiresAt: "2026-11-15T00:00:00Z",
      },
      context,
    );
    const text = description(message);
    for (const section of ["❌ 막힌 이유:", "👉 해 주실 일:"]) expect(text).toContain(section);
    expect(text).toMatch(/만료 \d{2}\/\d{2}\(.\) \d{2}:\d{2} KST$/);
    expect(
      text.split("\n").find((line) => line.startsWith("🤔 추측한 것:"))?.length,
    ).toBeLessThanOrEqual("🤔 추측한 것: ".length + 160);
  });
});
