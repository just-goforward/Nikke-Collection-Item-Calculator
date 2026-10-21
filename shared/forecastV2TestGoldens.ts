// Payloads mirroring every message the collector produces.
import type { ForecastV2NotificationKind } from "./forecastV2Notifications.ts";
import { request } from "./forecastV2TestFixtures.ts";

// Internal codes and row ids must never reach the approver: the payloads below
// mirror every message the collector produces, including option labels.
export const goldens: [string, ForecastV2NotificationKind, object][] = [
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
  ["legacy decision request", "decision_request", { ...request, type: "solo_review", options: [] }],
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
