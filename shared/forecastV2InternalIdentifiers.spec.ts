import { describe, expect, it } from "vitest";
import { renderForecastV2Notification } from "./forecastV2Notifications.ts";
import { buttonsOf, context, description } from "./forecastV2TestFixtures.ts";
import { goldens } from "./forecastV2TestGoldens.ts";

describe("v2 internal identifier hygiene", () => {
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
});
