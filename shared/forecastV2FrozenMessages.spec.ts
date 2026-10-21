import { describe, expect, it } from "vitest";
import { frozenMessages } from "./forecastV2FrozenMessages.ts";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";

const context = {
  environment: "staging" as const,
  expectedRevision: 7,
  idempotencyKey: "decision:one",
};

describe("frozen output of the pre-split renderer", () => {
  // Covers every payload kind (request, reminder, B report, calendar change), every
  // guidance reason reachable per kind, with and without a guess span, plus the
  // truncation paths (long title, long URL, evidence overflow, 70-segment B report).
  it.each(frozenMessages.map((message) => [message.name, message] as const))(
    "renders %s byte-identically",
    (_name, message) => {
      const rendered = renderForecastV2Notification(message.kind, message.payload, context);
      expect(rendered.embeds[0]?.description).toBe(message.expected.description);
      expect(
        rendered.components
          .flatMap((row) => row.components)
          .map((button) => ({ label: button.label, custom_id: button.custom_id })),
      ).toEqual(message.expected.buttons ?? []);
    },
  );
});
