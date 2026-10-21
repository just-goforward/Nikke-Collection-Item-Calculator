import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorCode, persistedErrorCode } from "../../shared/errorCodes.ts";
import schemaSql from "../schema.sql?raw";
import type { UsageGuardEnv } from "./types";
import { runUsageGuard } from "./worker";

const safeErrorCode = (error: unknown) => errorCode(error, "usage_guard");

const testEnv: UsageGuardEnv = {
  GUARD_DB: env.GUARD_DB,
  ENVIRONMENT: env.ENVIRONMENT,
  DEPLOY_SHA: env.DEPLOY_SHA,
  CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_D1_ANALYTICS_TOKEN: env.CLOUDFLARE_D1_ANALYTICS_TOKEN,
  CLOUDFLARE_BILLING_READ_TOKEN: env.CLOUDFLARE_BILLING_READ_TOKEN,
  DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
  DISCORD_ALERT_CHANNEL_ID: env.DISCORD_ALERT_CHANNEL_ID,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
};
const NOW = Date.parse("2026-09-01T02:00:00.000Z");

describe("usage guard log and record codes", () => {
  it("records only allowlisted codes, never an arbitrary error message", () => {
    // A recognised application code survives so a real failure stays diagnosable.
    expect(safeErrorCode(new Error("cloudflare_paid_quota_period_invalid"))).toBe(
      "cloudflare_paid_quota_period_invalid",
    );
    expect(safeErrorCode(new Error("usage_guard_evidence_missing"))).toBe(
      "usage_guard_evidence_missing",
    );
    // A suffix-bearing code drops to its fixed family token, so ids never leak.
    expect(safeErrorCode(new Error("cloudflare_d1_database_missing:SENTINEL_database_id"))).toBe(
      "cloudflare_d1_database_missing",
    );
    // An enumerated HTTP status is kept; any other status drops to the family token.
    expect(safeErrorCode(new Error("cloudflare_subscription_http_403"))).toBe(
      "cloudflare_subscription_http_403",
    );
    expect(safeErrorCode(new Error("cloudflare_subscription_http_599"))).toBe(
      "cloudflare_subscription_http",
    );
    // D1 keeps only its fixed prefix token, never the table name.
    expect(
      safeErrorCode(new Error("D1_ERROR: no such table: SENTINEL_secret_table: SQLITE_ERROR")),
    ).toBe("D1_ERROR");
    // Unknown names and foreign messages fall back to fixed categories; a runtime name is
    // log vocabulary only, a column takes the Worker's registered fallback.
    expect(safeErrorCode(new TypeError("SENTINEL_type_secret"))).toBe("TypeError");
    expect(persistedErrorCode(new TypeError("SENTINEL_type_secret"), "usage_guard")).toBe(
      "usage_guard_unknown_error",
    );
    expect(safeErrorCode(new Error("SENTINEL_freeform_secret"))).toBe("usage_guard_unknown_error");
    class ProviderFailure extends Error {
      override name = "ProviderFailure";
    }
    expect(safeErrorCode(new ProviderFailure("SENTINEL_provider_secret"))).toBe(
      "usage_guard_unknown_error",
    );
    expect(safeErrorCode("SENTINEL_thrown_string")).toBe("usage_guard_unknown_error");
  });

  it("never emits a sentinel secret for any category it maps", () => {
    const sentinel = "SENTINEL_leak_canary";
    class UnknownNameError extends Error {
      override name = "UnknownNameError";
    }
    const thrown: unknown[] = [
      new Error(sentinel),
      new TypeError(sentinel),
      new Error(`D1_ERROR: ${sentinel}: SQLITE_ERROR`),
      new Error(`cloudflare_d1_database_missing:${sentinel}`),
      new UnknownNameError(sentinel),
      { message: sentinel },
    ];
    for (const value of thrown) expect(safeErrorCode(value)).not.toContain(sentinel);
  });
});

describe("usage guard failed-run code", () => {
  beforeEach(async () => {
    await reset();
    for (const statement of schemaSql
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      await testEnv.GUARD_DB.prepare(statement).run();
    }
  });

  it.each([
    ["a plain Error", new Error("SENTINEL_fetch_secret"), "usage_guard_unknown_error"],
    ["a runtime TypeError", new TypeError("SENTINEL_fetch_secret"), "TypeError"],
  ])(
    "stores the registered fallback and never the thrown message for %s",
    async (_, thrown, loggedCode) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      // The analytics/billing fetch rejects: the run must still fail with the Worker's
      // registered fallback, and neither the record nor the log may contain the sentinel.
      vi.spyOn(globalThis, "fetch").mockRejectedValue(thrown);

      await expect(runUsageGuard(testEnv, NOW)).rejects.toThrow();

      const run = await testEnv.GUARD_DB.prepare(
        "SELECT status, error_code FROM usage_guard_runs",
      ).first<{ status: string; error_code: string }>();
      // A foreign message and a runtime error name both map to the Worker's fixed fallback
      // in the column; the log keeps the diagnostic output (the fixed runtime name).
      expect(run).toMatchObject({ status: "failure", error_code: "usage_guard_unknown_error" });
      const failure = errorLog.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { event: string; errorCode: string })
        .find((entry) => entry.event === "usage_guard_failure");
      expect(failure).toMatchObject({ errorCode: loggedCode });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("SENTINEL_fetch_secret");
      vi.restoreAllMocks();
    },
  );
});
