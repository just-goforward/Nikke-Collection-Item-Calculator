import { describe, expect, it, vi } from "vitest";
import type { CollectorEnv } from "./types";
import worker from "./worker";

describe("forecast collector admin boundary", () => {
  it("checks the admin rate limiter before bearer authentication", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const response = await invokeAdmin({
      ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
      ADMIN_TOKEN: "expected-token",
    });

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "admin-api" });
  });

  it("rejects an invalid bearer after an allowed rate-limit check", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const response = await invokeAdmin({
      ADMIN_RATE_LIMITER: { limit } as unknown as RateLimit,
      ADMIN_TOKEN: "expected-token",
    });

    expect(response.status).toBe(401);
    expect(limit).toHaveBeenCalledOnce();
  });
});

async function invokeAdmin(bindings: Pick<CollectorEnv, "ADMIN_RATE_LIMITER" | "ADMIN_TOKEN">) {
  const env = { ...bindings, ENVIRONMENT: "staging" } as CollectorEnv;
  const context = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  return worker.fetch(
    new Request("https://collector.example/admin/candidates", {
      headers: { authorization: "Bearer wrong-token" },
    }) as unknown as Parameters<typeof worker.fetch>[0],
    env,
    context,
  );
}
