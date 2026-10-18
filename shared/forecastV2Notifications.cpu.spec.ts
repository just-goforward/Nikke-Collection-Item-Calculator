import { expect, it } from "vitest";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";

it("Node proxy: bounded render dispatch unit retains headroom below 25 ms", () => {
  const payload = {
    decisionRequestId: "one",
    type: "grant_date",
    feedIds: [1],
    title: "**공지** @everyone",
    url: "https://game.naver.com/lounge/nikke/board/detail/1",
    options: Array.from({ length: 25 }, (_, i) => ({ id: String(i), label: "날짜 선택" })),
    expiresAt: "2026-11-01T00:00:00Z",
  };
  const context = { environment: "staging" as const, expectedRevision: 7, idempotencyKey: "one" };
  for (let i = 0; i < 20; i++) renderForecastV2Notification("decision_request", payload, context);
  const elapsed: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    JSON.stringify(renderForecastV2Notification("decision_request", payload, context));
    elapsed.push(performance.now() - start);
  }
  expect(Math.max(...elapsed)).toBeLessThan(20);
});
