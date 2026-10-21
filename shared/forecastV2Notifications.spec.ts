import { describe, expect, it } from "vitest";
import {
  forecastV2CustomId,
  renderForecastV2Notification,
  validateForecastV2Payload,
} from "./forecastV2Notifications.ts";
import { buttonsOf, context, description, request } from "./forecastV2TestFixtures.ts";

describe("v2 notification actions", () => {
  it.each(["collaboration", "maintenance"])("renders an edit-only %s replacement", (type) => {
    const payload = { ...request, type, options: [] };
    expect(validateForecastV2Payload("decision_request", payload)).toBe(true);
    const message = renderForecastV2Notification("decision_request", payload, context);
    expect(message.components.flatMap((r) => r.components)).toEqual([
      { type: 2, style: 2, label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
    ]);
  });

  it.each(["grant_date", "grant_quantity"])("rejects empty options for %s", (type) => {
    const payload = { ...request, type, options: [] };
    expect(validateForecastV2Payload("decision_request", payload)).toBe(false);
    expect(() => renderForecastV2Notification("decision_request", payload, context)).toThrow(
      "v2_payload_invalid",
    );
  });

  it.each([undefined, false])(
    "omits confirmation for incomplete solo schedules (%s)",
    (complete) => {
      const message = renderForecastV2Notification(
        "decision_request",
        {
          ...request,
          type: "solo_review",
          extracted: { complete },
        },
        context,
      );
      expect(message.components.flatMap((r) => r.components).map((b) => b.custom_id)).toEqual([
        "fv2:s:bedit:one:7",
        "fv2:s:bno:one:7",
      ]);
    },
  );

  it.each(["collaboration", "maintenance"])("offers options and editing for %s", (type) => {
    const message = renderForecastV2Notification("decision_request", { ...request, type }, context);
    expect(buttonsOf(message).map((b) => b.custom_id)).toEqual([
      "fv2:s:opt:one:7:a",
      "fv2:s:bedit:one:7",
    ]);
    const options = Array.from({ length: 24 }, (_, i) => ({ id: `o${i}`, label: `${i}` }));
    const full = renderForecastV2Notification(
      "decision_request",
      { ...request, type, options },
      context,
    );
    expect(full.components).toHaveLength(5);
    expect(buttonsOf(full)).toHaveLength(25);
    expect(
      validateForecastV2Payload("decision_request", {
        ...request,
        type,
        options: [...options, { id: "extra", label: "extra" }],
      }),
    ).toBe(false);
  });

  it("escapes source text and binds options to revision", () => {
    const message = renderForecastV2Notification("decision_request", request, context);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds[0]?.description).toContain("@\u200beveryone");
    expect(message.embeds[0]?.description).toContain("\\*\\*공지\\*\\*");
    expect(message.components[0]?.components[0]?.custom_id).toBe("fv2:s:opt:one:7:a");
  });

  it("renders solo reviews with the three agreed actions", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      { ...request, type: "solo_review", options: [], extracted: { complete: true } },
      context,
    );
    expect(message.components[0]?.components.map((b) => b.custom_id)).toEqual([
      "fv2:s:bok:one:7",
      "fv2:s:bedit:one:7",
      "fv2:s:bno:one:7",
    ]);
    expect(
      validateForecastV2Payload("decision_request", { ...request, type: "solo_schedule" }),
    ).toBe(false);
  });

  it("rejects hostile URLs and oversized custom IDs", () => {
    expect(
      validateForecastV2Payload("decision_request", { ...request, url: "https://evil.example/" }),
    ).toBe(false);
    expect(() => forecastV2CustomId("staging", "bok", "a".repeat(100), 0)).toThrow();
  });

  it("caps one message with a marker and retains a calendar link", () => {
    const message = renderForecastV2Notification(
      "calendar_changed",
      {
        snapshotId: "s1",
        revision: 9,
        adminUrl: "https://forecast-admin-staging.nikkecollection.com/?rev=8#gd-2026-10-18",
        changes: [
          { kind: "grant", label: "x".repeat(3000), change: "changed", before: "1", after: "2" },
        ],
      },
      context,
    );
    expect(message.embeds).toHaveLength(1);
    expect(
      message.embeds[0]!.description.length + message.embeds[0]!.footer.text.length,
    ).toBeLessThanOrEqual(2000);
    expect(message.embeds[0]!.description).toContain("…(생략)");
    expect(message.embeds[0]!.description).toContain("?rev=9#gd-2026-10-18");
  });

  it("renders reminders and B reports", () => {
    expect(
      renderForecastV2Notification("decision_reminder", { decisionRequestId: "one" }, context)
        .embeds[0]?.description,
    ).toContain("결정 대기");
    const b = renderForecastV2Notification(
      "b_report",
      {
        feedId: 1,
        title: "중단",
        url: request.url,
        postedAt: request.expiresAt,
        decisionRequestId: "one",
        extracted: {
          complete: true,
          segments: [{ kind: "suspend" }],
          kits: [{ gameDay: "2026-10-18", ii: 3, box: 4 }],
        },
        decision: {
          complete: true,
          startAt: "2026-10-18T02:00:00Z",
          endAt: "2026-10-18T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(b).map((c) => c.label)).toEqual([
      "이 일정으로 확정",
      "일정 수정",
      "관련 없음",
    ]);
    expect(description(b)).toContain("관리 키트 II 3");
  });

  it("keeps the KST span in a reminder's confirm question", () => {
    // Regression: the reminder passed its guess to the composer but not to the
    // formatter, so the question rendered without the range HEAD showed.
    expect(
      description(
        renderForecastV2Notification(
          "decision_reminder",
          {
            decisionRequestId: "one",
            type: "collaboration",
            guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-27T07:00:00Z" },
          },
          context,
        ),
      ),
    ).toBe(
      [
        "🔎 결정 대기 알림",
        "하려던 일: 콜라보 일정 확정",
        "✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다",
        "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/27(금) 16:00)으로 하면 될까요?",
        "❌ 막힌 이유: 자동 판단을 마치지 못했습니다.",
        "👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
      ].join("\n"),
    );
  });
});
