import { describe, expect, it } from "vitest";
import { errorCode } from "../../shared/errorCodes";
import { HttpError } from "./http-error";

describe("stats Worker log codes", () => {
  it("keeps the Worker's own HttpError and plain-Error codes so callers stay diagnosable", () => {
    expect(errorCode(new HttpError(503, "storage_unavailable", true))).toBe("storage_unavailable");
    expect(errorCode(new HttpError(503, "telemetry_budget_disabled", false))).toBe(
      "telemetry_budget_disabled",
    );
    expect(errorCode(new Error("database_schema_mismatch"))).toBe("database_schema_mismatch");
    // A plain Error whose message is not a registered code is not ours to print.
    expect(errorCode(new Error("provider_quota_exceeded"))).toBe("unexpected");
  });

  it("grants an HttpError no trust by class: an unregistered message is still unexpected", () => {
    const forged = new HttpError(500, "invalid_payload");
    forged.message = "SENTINEL_forged_http_secret";
    expect(errorCode(forged)).toBe("unexpected");
  });

  it("keeps the D1 prefix but never the table or column text after it", () => {
    expect(
      errorCode(new Error("D1_ERROR: no such table: SENTINEL_secret_table: SQLITE_ERROR")),
    ).toBe("D1_ERROR");
  });

  it("maps unknown messages to the error's fixed name, or to unexpected", () => {
    expect(errorCode(new TypeError("SENTINEL_type_secret"))).toBe("TypeError");
    expect(errorCode(new Error("SENTINEL_freeform_secret"))).toBe("unexpected");
    class ProviderFailure extends Error {
      override name = "ProviderFailure";
    }
    expect(errorCode(new ProviderFailure("SENTINEL_provider_secret"))).toBe("unexpected");
    expect(errorCode("SENTINEL_thrown_string")).toBe("unexpected");
  });

  it("never emits the thrown message for any category it maps", () => {
    const forged = new HttpError(400, "invalid_payload");
    forged.message = "SENTINEL_e";
    const thrown = [
      new Error("SENTINEL_a"),
      new TypeError("SENTINEL_b"),
      new Error("D1_ERROR: SENTINEL_c: SQLITE_ERROR"),
      new HttpError(400, "invalid_payload"),
      forged,
      { message: "SENTINEL_d" },
    ];
    for (const value of thrown) expect(errorCode(value)).not.toContain("SENTINEL_");
  });
});
