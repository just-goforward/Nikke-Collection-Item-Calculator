import { describe, expect, it } from "vitest";
import { evaluateCronCapacity } from "./cloudflare-cron-capacity";

describe("Cloudflare Cron capacity", () => {
  it("does not charge an additional trigger when the target is already scheduled", () => {
    expect(
      evaluateCronCapacity(
        new Map([
          ["collector", 1],
          ["dispatcher-staging", 1],
        ]),
        "dispatcher-staging",
        2,
      ),
    ).toMatchObject({ currentCount: 2, additionalCount: 0, projectedCount: 2, allowed: true });
  });

  it("blocks a new Worker before it exceeds the account limit", () => {
    expect(
      evaluateCronCapacity(
        new Map([
          ["collector", 2],
          ["other", 3],
        ]),
        "dispatcher-production",
        5,
      ),
    ).toMatchObject({ currentCount: 5, additionalCount: 1, projectedCount: 6, allowed: false });
  });
});
