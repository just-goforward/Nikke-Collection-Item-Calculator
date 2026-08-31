import { describe, expect, it } from "vitest";
import { evaluateCronCapacity, readCronSchedules } from "./cloudflare-cron-capacity";

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

  it("reads the nested schedules object returned by the Cloudflare API", async () => {
    const responses = [
      Response.json({ success: true, result: [{ id: "collector" }, { id: "dispatcher" }] }),
      Response.json({
        success: true,
        result: { schedules: [{ cron: "*/3 * * * *" }] },
      }),
      Response.json({ success: true, result: { schedules: [] } }),
    ];
    const fetchImpl = async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Cloudflare API request.");
      return response;
    };

    await expect(
      readCronSchedules("15be33fd20ea78eb3d60b719be831148", "token", fetchImpl as typeof fetch),
    ).resolves.toEqual(
      new Map([
        ["collector", 1],
        ["dispatcher", 0],
      ]),
    );
    expect(responses).toHaveLength(0);
  });
});
