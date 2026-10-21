import { describe, expect, it } from "vitest";
import {
  type ForecastV2NotificationKind,
  forecastV2CustomId,
  renderForecastV2Notification,
  validateForecastV2Payload,
} from "./forecastV2Notifications.ts";

const context = {
  environment: "staging" as const,
  expectedRevision: 7,
  idempotencyKey: "decision:one",
};
const request = {
  decisionRequestId: "one",
  type: "grant_date",
  feedIds: [1],
  title: "@everyone **공지**",
  url: "https://game.naver.com/lounge/nikke/board/detail/1",
  options: [{ id: "a", label: "오늘" }],
  expiresAt: "2026-11-01T00:00:00Z",
};
const description = (message: ReturnType<typeof renderForecastV2Notification>) =>
  message.embeds[0]?.description ?? "";
const buttonsOf = (message: ReturnType<typeof renderForecastV2Notification>) =>
  message.components.flatMap((row) => row.components);
describe("v2 notifications", () => {
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
});

const solo = (extra: object) =>
  renderForecastV2Notification(
    "decision_request",
    {
      ...request,
      type: "solo_review",
      options: [],
      expiresAt: "2026-11-05T03:12:00Z",
      ...extra,
    },
    context,
  );

describe("v2 approver-facing evidence", () => {
  it("tells the approver nothing could be extracted and asks for manual input", () => {
    const message = solo({
      reason: "solo_period_unresolved",
      goal: "솔로 레이드 일정 확정",
      postedAt: "2026-10-22T02:00:00Z",
      confirmed: ["감지한 키워드: 솔로 레이드, 진행 기간"],
      guessed: [],
      extracted: { complete: false },
    });
    expect(description(message)).toBe(
      [
        "🔎 [@\u200beveryone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1) · 게시 10/22(목) 11:00",
        "하려던 일: 솔로 레이드 일정 확정",
        "✅ 확인한 것: 감지한 키워드: 솔로 레이드, 진행 기간",
        "🤔 추측한 것: 일정을 확인하지 못했습니다. [일정 수정]으로 직접 입력해 주세요.",
        "❌ 막힌 이유: 솔로 레이드 진행 기간(시작·종료)을 확정하지 못했습니다.",
        "👉 해 주실 일: 공지의 진행 기간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 무관한 공지면 [관련 없음].",
        "만료 11/05(목) 12:12 KST",
      ].join("\n"),
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual(["일정 수정", "관련 없음"]);
  });

  it("asks explicitly about a complete guess even when the maintenance lookup failed", () => {
    const message = solo({
      reason: "maintenance_missing",
      goal: "솔로 레이드 일정 확정",
      confirmed: ["감지한 키워드: 솔로 레이드, 점검 완료 후"],
      guessed: ["10/23(금) 11:00 ~ 11/05(목) 04:59"],
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-04T19:59:59Z" },
      extracted: { complete: true },
    });
    expect(description(message)).toBe(
      [
        "🔎 [@\u200beveryone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)",
        "하려던 일: 솔로 레이드 일정 확정",
        "✅ 확인한 것: 감지한 키워드: 솔로 레이드, 점검 완료 후",
        "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/05(목) 04:59)으로 하면 될까요?",
        "❌ 막힌 이유: 같은 날짜의 점검 일정을 찾지 못해 '점검 완료 후' 시각을 확정하지 못했습니다.",
        "👉 해 주실 일: 점검 일정을 확인해 주세요. 점검 공지가 아직 없다면 잠시 기다리고, 점검이 있는데 달력에 없다면 [일정 수정]으로 직접 입력해 주세요. 그 밖에 [이 일정으로 확정], [관련 없음] 버튼도 있습니다.",
        "만료 11/05(목) 12:12 KST",
      ].join("\n"),
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual([
      "이 일정으로 확정",
      "일정 수정",
      "관련 없음",
    ]);
  });

  it.each([
    [
      "maintenance_multiple",
      { type: "maintenance", options: [{ id: "ignore", label: "관련 없음" }] },
      "같은 날짜에 점검이 여러 건 있어 적용할 점검 종료 시각을 고르지 못했습니다.",
      "어느 점검 시간이 맞는지 확인한 뒤 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 달력의 중복 점검도 함께 확인해 주세요.",
    ],
    [
      "grant_date_precision",
      { type: "grant_date", options: [{ id: "date_0", label: "2026-10-23" }] },
      "지급일의 시각(정밀도)을 확인하지 못했습니다.",
      "공지의 지급일·시각을 확인해 아래 버튼에서 맞는 지급일을 골라 주세요.",
    ],
    [
      "grant_quantity",
      {
        type: "grant_quantity",
        options: [
          { id: "separate", label: "별도 지급" },
          { id: "correction", label: "정정" },
        ],
      },
      "같은 날 지급 수량이 이미 달력에 있는 값과 달라 별도 지급인지 정정인지 확인이 필요합니다.",
      "별도로 더 지급된 것이면 [별도 지급], 기존 수량을 고치는 것이면 [정정].",
    ],
    [
      "collaboration_start_unresolved",
      { type: "collaboration", options: [{ id: "ignore", label: "관련 없음" }] },
      "콜라보 시작 시각('점검 완료 후' 등)을 확정하지 못했습니다.",
      "아래 버튼에 맞는 시작 일정이 있으면 고르고, 없으면 [일정 수정]으로 시작·종료를 직접 입력해 주세요.",
    ],
    [
      "maintenance_conflict",
      { type: "maintenance", options: [{ id: "ignore", label: "기존 점검 유지" }] },
      "같은 날짜에 이미 다른 점검 일정이 있어 어느 점검 시간을 달력에 남길지 확인이 필요합니다.",
      "이 공지의 점검 시간을 적용할지 기존 점검을 유지할지 버튼으로 고르고, 둘 다 아니면 [일정 수정]으로 직접 입력해 주세요.",
    ],
  ])("explains %s with the matching guidance", (reason, extra, blocked, todo) => {
    const message = renderForecastV2Notification(
      "decision_request",
      { ...request, reason, ...extra },
      context,
    );
    expect(description(message)).toContain(`❌ 막힌 이유: ${blocked}`);
    expect(description(message)).toContain(`👉 해 주실 일: ${todo}`);
  });

  it("renders legacy payloads without the new fields through a sensible fallback", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        decisionRequestId: "one",
        type: "solo_review",
        feedIds: [1],
        title: "공지",
        url: request.url,
        options: [],
        expiresAt: "2026-11-05T03:12:00Z",
      },
      context,
    );
    expect(description(message).split("\n").slice(1, 3)).toEqual([
      "하려던 일: 솔로 레이드 일정 확정",
      "✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다",
    ]);
    expect(description(message)).toContain(
      "❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다",
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual(["일정 수정", "관련 없음"]);
  });

  it("keeps an unknown reason actionable instead of crashing", () => {
    const message = solo({ reason: "some_future_code" });
    expect(description(message)).toContain("❌ 막힌 이유: 자동 판단을 마치지 못했습니다.");
    expect(description(message)).toContain(
      "👉 해 주실 일: 공지 원문을 확인해 맞으면 [일정 수정]으로 시작·종료를 직접 입력하고, 무관하면 [관련 없음]을 눌러 주세요.",
    );
  });

  it("labels option buttons in KST instead of raw ISO", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "maintenance",
        options: [
          {
            id: "source_0",
            label: "기존 점검(2026-10-23 09:00:00 ~ 2026-10-23 12:00:00)에 이 공지 시간 적용",
          },
          { id: "window_0", label: "2026-10-23 11:00:00 ~ 2026-10-23 16:00:00 (KST)" },
          { id: "ignore", label: "기존 점검 유지" },
        ],
      },
      context,
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual([
      "기존 점검(10/23(금) 09:00 ~ 10/23(금) 12:00)에 이 공지 시간 적용",
      "10/23(금) 11:00 ~ 10/23(금) 16:00",
      "기존 점검 유지",
      "일정 수정",
    ]);
  });

  it("renders the reminder with the original post, goal and blocked reason", () => {
    const message = renderForecastV2Notification(
      "decision_reminder",
      {
        decisionRequestId: "one",
        title: "솔로 레이드 시즌 41",
        url: request.url,
        goal: "솔로 레이드 일정 확정",
        reason: "solo_period_unresolved",
        blocked: "진행 기간 줄을 찾지 못했습니다.",
        expiresAt: "2026-11-05T03:12:00Z",
      },
      context,
    );
    const lines = description(message).split("\n");
    expect(lines[0]).toContain(
      "🔎 [솔로 레이드 시즌 41](https://game.naver.com/lounge/nikke/board/detail/1)",
    );
    expect(lines).toContain("하려던 일: 솔로 레이드 일정 확정");
    expect(lines).toContain("❌ 막힌 이유: 진행 기간 줄을 찾지 못했습니다.");
    expect(lines.at(-1)).toBe("만료 11/05(목) 12:12 KST");
  });

  it("never shows a raw ISO instant in a rendered message", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "maintenance",
        postedAt: "2026-10-22T02:00:00.000Z",
        guess: { startAt: "2026-10-23T02:00:00.000Z", endAt: "2026-10-23T07:00:00.000Z" },
      },
      context,
    );
    const text = `${description(message)} ${buttonsOf(message)
      .map((b) => b.label)
      .join(" ")}`;
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(description(message)).toContain("10/23(금) 11:00 ~ 10/23(금) 16:00");
  });

  // Internal codes and row ids must never reach the approver: the payloads below
  // mirror every message the collector produces, including option labels.
  const goldens: [string, ForecastV2NotificationKind, object][] = [
    [
      "solo unresolved",
      "decision_request",
      {
        ...request,
        type: "solo_review",
        options: [],
        extracted: { complete: false },
        goal: "솔로 레이드 일정 확정",
        reason: "solo_period_unresolved",
        confirmed: ["감지한 키워드: 솔로 레이드, 진행 기간"],
      },
    ],
    [
      "solo guess, maintenance missing",
      "decision_request",
      {
        ...request,
        type: "solo_review",
        options: [],
        extracted: { complete: true },
        goal: "솔로 레이드 일정 확정",
        reason: "maintenance_missing",
        guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-04T19:59:59Z" },
      },
    ],
    [
      "grant date precision",
      "decision_request",
      {
        ...request,
        type: "grant_date",
        options: [
          { id: "date_0", label: "2026-10-23" },
          { id: "date_1", label: "2026-10-24" },
        ],
        goal: "보상 지급일 확정",
        reason: "grant_date_precision",
        confirmed: ["공지에서 읽은 수량: 관리 키트 II 10 · 상자 0"],
        guessed: [
          "10/23(금) (시각 미확인, 공지에 지급일 명시)",
          "10/24(토) (시각 미확인, 공지에 지급일 명시)",
        ],
      },
    ],
    [
      "grant quantity conflict",
      "decision_request",
      {
        ...request,
        type: "grant_quantity",
        options: [
          { id: "separate", label: "별도 지급" },
          { id: "correction", label: "정정" },
        ],
        reason: "grant_quantity",
      },
    ],
    [
      "collaboration start unresolved",
      "decision_request",
      {
        ...request,
        type: "collaboration",
        options: [
          { id: "window_0", label: "2026-10-23 11:00:00 ~ 2026-10-23 16:00:00 (KST)" },
          { id: "ignore", label: "관련 없음" },
        ],
        reason: "collaboration_start_unresolved",
      },
    ],
    [
      "grant quantity ambiguous",
      "decision_request",
      {
        ...request,
        type: "grant_quantity",
        options: [
          { id: "separate", label: "별도 지급" },
          { id: "correction", label: "정정" },
        ],
        reason: "grant_quantity_ambiguous",
      },
    ],
    [
      "maintenance conflict",
      "decision_request",
      {
        ...request,
        type: "maintenance",
        options: [
          {
            id: "source_0",
            label: "기존 점검(2026-10-23 09:00:00 ~ 2026-10-23 12:00:00)에 이 공지 시간 적용",
          },
          { id: "ignore", label: "기존 점검 유지" },
        ],
        reason: "maintenance_conflict",
        confirmed: [
          "이 공지의 점검: 10/23(금) 11:00 ~ 10/23(금) 16:00",
          "달력의 기존 점검: 10/23(금) 09:00 ~ 10/23(금) 12:00",
        ],
      },
    ],
    [
      "legacy decision request",
      "decision_request",
      { ...request, type: "solo_review", options: [] },
    ],
    ["legacy reminder", "decision_reminder", { decisionRequestId: "one" }],
    [
      "collaboration overlap",
      "decision_request",
      {
        ...request,
        type: "collaboration",
        title: "콜라보 재안내",
        options: [
          { id: "new", label: "새 콜라보" },
          { id: "same", label: "기존 콜라보" },
          { id: "ignore", label: "관련 없음" },
        ],
        extracted: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
        reason: "collaboration_overlap",
        confirmed: [
          "이번 공지의 콜라보 기간: 10/23(금) 11:00 ~ 10/23(금) 16:00",
          "달력의 기존 콜라보: 10/23(금) 09:00 ~ 10/23(금) 12:00",
        ],
        guessed: ["10/23(금) 09:00 ~ 10/23(금) 12:00"],
      },
    ],
    [
      "b report",
      "b_report",
      {
        feedId: 1,
        title: "중단",
        url: request.url,
        postedAt: request.expiresAt,
        decisionRequestId: "one",
        extracted: {
          complete: true,
          segments: [
            {
              kind: "suspend",
              startAt: "2026-10-23T02:00:00Z",
              endAt: "2026-10-23T07:00:00Z",
            },
          ],
          kits: [{ gameDay: "2026-10-18", ii: 3, box: 4 }],
        },
        decision: {
          complete: true,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
    ],
    [
      "b report without a complete decision window",
      "b_report",
      {
        feedId: 1,
        title: "중단",
        url: request.url,
        postedAt: request.expiresAt,
        decisionRequestId: "one",
        extracted: {
          complete: false,
          segments: [{ kind: "suspend", startAt: "2026-10-23T02:00:00Z" }],
          kits: [],
        },
        decision: { complete: false, startAt: "2026-10-23T02:00:00Z" },
      },
    ],
  ];
  it.each(goldens)("renders %s without internal identifiers", (_label, kind, payload) => {
    const message = renderForecastV2Notification(kind, payload, context);
    const text = `${description(message)}\n${buttonsOf(message)
      .map((b) => b.label)
      .join("\n")}`;
    expect(text).not.toMatch(/\b[a-z]+_[a-z0-9_]+\b/);
    // Calendar/decision/grant event ids and their prefixes have a shape of their own.
    expect(text).not.toMatch(/\b(?:maintenance|solo|collaboration|grant|decision)_\d/);
    expect(text).not.toMatch(/\bd_[0-9a-f]{24}\b/);
  });

  it.each(goldens)(
    "names only existing buttons and every action button in %s's todo",
    (_label, kind, payload) => {
      const message = renderForecastV2Notification(kind, payload, context);
      const todo = description(message)
        .split("\n")
        .find((line) => line.startsWith("👉 해 주실 일:"));
      expect(todo).toBeDefined();
      const labels = buttonsOf(message).map((button) => button.label);
      // "[확정]" style references must be buttons this message actually renders.
      for (const referenced of todo?.matchAll(/\[([^\]]+)\]/g) ?? [])
        expect(labels).toContain(referenced[1]);
      // Every action button (not an option) must be offered by the todo.
      const actions = buttonsOf(message)
        .filter((button) => !button.custom_id.includes(":opt:"))
        .map((button) => button.label);
      for (const action of actions) expect(todo).toContain(`[${action}]`);
      // Direct-input wording only where a [일정 수정] button exists.
      if (!labels.includes("일정 수정"))
        expect(description(message)).not.toContain("일정 직접 입력");
    },
  );

  it("escapes evidence as display text and keeps each section on one line", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "solo_review",
        options: [],
        goal: "@everyone [확정](https://evil.example) **굵게**",
        confirmed: ["<@123> 줄1\n줄2", "`code` [링크](https://evil.example)"],
        blocked: "@here https://evil.example",
        todo: "<#456> **지금** 누르세요",
      },
      context,
    );
    const text = description(message);
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("@here");
    expect(text).not.toContain("<@123>");
    expect(text).not.toContain("<#456>");
    // No markdown link or bold can form out of evidence text.
    expect(text).not.toContain("](https://evil.example)");
    expect(text).not.toContain("**굵게**");
    expect(text).not.toContain("**지금**");
    // Injected newlines are collapsed so sections cannot be forged.
    expect(text).not.toContain("줄1\n줄2");
    expect(text).toContain("줄1 줄2");
    expect(text.split("\n").filter((line) => line.includes("하려던 일:"))).toHaveLength(1);
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

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

  it("offers the B confirm only for a complete decision window", () => {
    const base = {
      feedId: 1,
      title: "중단",
      url: request.url,
      postedAt: request.expiresAt,
      decisionRequestId: "one",
      extracted: {
        segments: [{ kind: "suspend" as const, startAt: "2026-10-23T02:00:00Z" }],
        kits: [],
      },
    };
    const complete = renderForecastV2Notification(
      "b_report",
      {
        ...base,
        extracted: {
          segments: [
            {
              kind: "suspend" as const,
              startAt: "2026-10-23T02:00:00Z",
              endAt: "2026-10-23T07:00:00Z",
            },
          ],
          kits: [],
        },
        decision: {
          complete: true,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(complete).map((b) => b.label)).toContain("이 일정으로 확정");
    expect(description(complete)).toContain(
      "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?",
    );
    // A complete flag without a usable window cannot back a confirm either.
    for (const decision of [
      { complete: false, startAt: "2026-10-23T02:00:00Z" },
      { complete: true },
      { complete: true, startAt: "2026-10-23T07:00:00Z", endAt: "2026-10-23T02:00:00Z" },
    ]) {
      const message = renderForecastV2Notification("b_report", { ...base, decision }, context);
      expect(buttonsOf(message).map((b) => b.label)).not.toContain("이 일정으로 확정");
      expect(description(message)).toContain("🤔 추측한 것: 읽은 구간: ");
      expect(description(message)).not.toContain("으로 하면 될까요?");
    }
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

  it("keeps the guidance and expiry for a B report with dozens of segments", () => {
    const segments = Array.from({ length: 60 }, (_, index) => ({
      kind: "suspend" as const,
      startAt: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T02:00:00Z`,
      endAt: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T07:00:00Z`,
    }));
    const message = renderForecastV2Notification(
      "b_report",
      {
        feedId: 1,
        title: "중단",
        url: request.url,
        postedAt: request.expiresAt,
        decisionRequestId: "one",
        extracted: { segments, kits: [] },
        // No complete decision window: the 읽은 구간 line is built from every segment.
        decision: {
          complete: false,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    const text = description(message);
    // A B report carries no expiry, so the sections it does have must all survive.
    for (const section of [
      "🔎",
      "하려던 일:",
      "✅ 확인한 것:",
      "🤔 추측한 것:",
      "❌ 막힌 이유:",
      "👉 해 주실 일:",
    ])
      expect(text).toContain(section);
    expect(text).toContain("B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.");
    expect(text).toContain("[일정 수정]으로 시작·종료를 직접 입력");
    // The 읽은 구간 line is one bounded item, never a 60-segment wall of text.
    const guessLine = text.split("\n").find((line) => line.startsWith("🤔 추측한 것:"));
    expect(guessLine?.length).toBeLessThanOrEqual("🤔 추측한 것: ".length + 160);
    // Nothing was cut by the final cap: the message fits the budget with room to spare.
    expect(text).not.toContain("…(생략)");
    expect(text.endsWith("[관련 없음].")).toBe(true);
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

  it("asks the B confirm question only when the confirm button is rendered", () => {
    const base = {
      feedId: 1,
      title: "중단",
      url: request.url,
      postedAt: request.expiresAt,
      decisionRequestId: "one",
      extracted: {
        segments: [{ kind: "suspend" as const, startAt: "2026-10-23T02:00:00Z" }],
        kits: [],
      },
    };
    // A window without `complete` renders no [이 일정으로 확정]: no question either.
    const incomplete = renderForecastV2Notification(
      "b_report",
      {
        ...base,
        decision: {
          complete: false,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(incomplete).map((b) => b.label)).not.toContain("이 일정으로 확정");
    expect(description(incomplete)).not.toContain("으로 하면 될까요?");
    expect(description(incomplete)).toContain("🤔 추측한 것: 읽은 구간: ");
    expect(
      description(incomplete)
        .split("\n")
        .find((line) => line.startsWith("👉 해 주실 일:")),
    ).toContain("[일정 수정]");
    // The complete window keeps both the button and the question.
    const complete = renderForecastV2Notification(
      "b_report",
      {
        ...base,
        decision: {
          complete: true,
          startAt: "2026-10-23T02:00:00Z",
          endAt: "2026-10-23T07:00:00Z",
        },
      },
      context,
    );
    expect(buttonsOf(complete).map((b) => b.label)).toContain("이 일정으로 확정");
    expect(description(complete)).toContain(
      "🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?",
    );
  });

  it("keeps the legacy reminder neutral and never invents a reason", () => {
    const message = renderForecastV2Notification(
      "decision_reminder",
      {
        decisionRequestId: "one",
        type: "solo_review",
        title: "솔로 레이드 시즌 41",
        url: request.url,
        expiresAt: "2026-11-05T03:12:00Z",
      },
      context,
    );
    const lines = description(message).split("\n");
    expect(lines[1]).toBe("하려던 일: 솔로 레이드 일정 확정");
    expect(lines[2]).toBe("✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다");
    expect(lines[3]).toBe("🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다");
    expect(lines[4]).toBe("❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다");
    expect(description(message)).not.toContain("진행 기간(시작·종료)을 확정하지 못했습니다");
  });

  it("parses option labels with any offset sign and escapes unparsable ones", () => {
    const message = renderForecastV2Notification(
      "decision_request",
      {
        ...request,
        type: "maintenance",
        options: [
          { id: "a", label: "2026-10-23T02:00:00Z ~ 2026-10-23T07:00:00Z" },
          { id: "b", label: "2026-10-23T02:00:00-05:00 ~ 2026-10-23T07:00:00-05:00" },
          { id: "c", label: "2026-10-23T02:00:00+0530 ~ 2026-10-23T07:00:00+0530" },
          { id: "d", label: "[깨진 라벨](https://evil.example)" },
        ],
      },
      context,
    );
    expect(buttonsOf(message).map((b) => b.label)).toEqual([
      "10/23(금) 11:00 ~ 10/23(금) 16:00",
      "10/23(금) 16:00 ~ 10/23(금) 21:00",
      "10/23(금) 05:30 ~ 10/23(금) 10:30",
      "［깨진 라벨］(https://evil.example)",
      "일정 수정",
    ]);
  });
});
