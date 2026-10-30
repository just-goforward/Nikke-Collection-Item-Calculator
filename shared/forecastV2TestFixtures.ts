// Fixtures shared by the forecast v2 notification specs.
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";

export const context = {
  environment: "staging" as const,
  expectedRevision: 7,
  idempotencyKey: "decision:one",
};
export const request = {
  decisionRequestId: "one",
  type: "grant_date",
  feedIds: [1],
  title: "@everyone **공지**",
  url: "https://game.naver.com/lounge/nikke/board/detail/1",
  options: [{ id: "a", label: "오늘" }],
  expiresAt: "2026-11-01T00:00:00Z",
};
export const description = (message: ReturnType<typeof renderForecastV2Notification>) =>
  message.embeds[0]?.description ?? "";
export const buttonsOf = (message: ReturnType<typeof renderForecastV2Notification>) =>
  message.components.flatMap((row) => row.components);

export const solo = (extra: object) =>
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
