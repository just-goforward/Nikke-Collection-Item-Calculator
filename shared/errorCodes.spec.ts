import { describe, expect, it } from "vitest";
import {
  APP_ERROR_CODES,
  ERROR_CATEGORIES,
  ERROR_CODE_POLICIES,
  type ErrorCodePolicy,
  errorCode,
  isAppErrorCode,
  isD1TriggerAbort,
  type PersistedErrorCodePolicy,
  persistedErrorCode,
  SAFE_ERROR_NAMES,
  type SafeErrorCode,
} from "./errorCodes.ts";

const SENTINEL = "SENTINEL_secret_9f3a";
const OUTPUTS = new Set<string>([...APP_ERROR_CODES, ...SAFE_ERROR_NAMES, ...ERROR_CATEGORIES]);
const POLICIES = Object.keys(ERROR_CODE_POLICIES) as ErrorCodePolicy[];
const PERSISTED_POLICIES = POLICIES.filter(
  (policy): policy is PersistedErrorCodePolicy => policy !== "default",
);
const isSafe = (value: string): value is SafeErrorCode => OUTPUTS.has(value);
/** Inputs that exercise every sanitizer branch with a sentinel that must never escape. */
function sentinelInputs(): unknown[] {
  class Named extends Error {
    constructor(
      message: string,
      name: string,
      readonly code?: unknown,
    ) {
      super(message);
      this.name = name;
    }
  }
  return [
    SENTINEL,
    null,
    42,
    { message: SENTINEL },
    new Error(SENTINEL),
    new Error(`publication_${SENTINEL}`),
    new Error(`D1_ERROR: ${SENTINEL}: SQLITE_ERROR`),
    new Error(`D1_ERROR: ${SENTINEL}: SQLITE_CONSTRAINT`),
    new Error(`cloudflare_d1_database_missing:${SENTINEL}`),
    new Error(`discord_create_message_${SENTINEL}`),
    new Error(`${SENTINEL}_json`),
    new TypeError(SENTINEL),
    new DOMException(SENTINEL, "AbortError"),
    new Named(SENTINEL, SENTINEL),
    new Named(SENTINEL, "TypeError", SENTINEL),
    new Named(SENTINEL, "HttpError", 503),
    new Named("telemetry_budget_disabled", SENTINEL, SENTINEL),
    new Named(SENTINEL, "DiscordObserverError", `discord_${SENTINEL}`),
  ];
}

describe("errorCode keeps the registry's own codes", () => {
  it("keeps registered codes from plain and typed errors", () => {
    expect(errorCode(new Error("publication_review_stale"))).toBe("publication_review_stale");
    expect(errorCode(new TypeError("invalid_payload"))).toBe("invalid_payload");
    class Coded extends Error {
      constructor(readonly code: string) {
        super("Siteverify transport failed.");
        this.name = "Coded";
      }
    }
    expect(errorCode(new Coded("telemetry_budget_disabled"))).toBe("telemetry_budget_disabled");
    expect(errorCode(new Coded("jwks_unavailable"), "usage_guard")).toBe("jwks_unavailable");
    expect(errorCode(new Error("discord_create_message_429"))).toBe("discord_create_message_429");
    expect(errorCode(new Error("discord_403"), "stats_observer")).toBe("discord_403");
  });

  it("drops suffix data and keeps only the family code", () => {
    expect(errorCode(new Error(`cloudflare_d1_database_missing:${SENTINEL}`))).toBe(
      "cloudflare_d1_database_missing",
    );
    expect(errorCode(new Error(`cloudflare_paid_quota_duplicate_${SENTINEL}`))).toBe(
      "cloudflare_paid_quota_duplicate",
    );
    expect(errorCode(new Error(`cloudflare_paid_graphql_${SENTINEL}_invalid`))).toBe(
      "cloudflare_paid_graphql",
    );
    expect(errorCode(new Error("discord_create_message_599"))).toBe("discord_create_message_http");
    expect(errorCode(new Error("cloudflare_subscription_http_418"))).toBe(
      "cloudflare_subscription_http",
    );
    expect(
      errorCode(new Error(`runtime_baseline_worker_invalid:${SENTINEL}`), "canary_runtime"),
    ).toBe("runtime_baseline_worker_invalid");
  });

  it("grants no trust to a code-shaped prefix", () => {
    expect(errorCode(new Error("publication_sentinel_secret_9f3a"), "publication")).toBe(
      "publication_operation_failed",
    );
    expect(errorCode(new Error("runtime_sentinel_secret"), "publication")).toBe(
      "publication_operation_failed",
    );
    expect(errorCode(new Error("usage_guard_sentinel"), "usage_guard")).toBe(
      "usage_guard_unknown_error",
    );
    expect(errorCode(new Error("discord_sentinel"), "v2_delivery")).toBe("v2_delivery_failed");
    expect(errorCode(new Error("discord_4290"))).toBe("unexpected");
    expect(errorCode(new Error("cloudflare_d1_database_missing"))).toBe(
      "cloudflare_d1_database_missing",
    );
    expect(errorCode(new Error(" cloudflare_d1_database_missing:x"))).toBe("unexpected");
  });

  it("keeps only the D1 token, or the registered trigger code a D1 abort carried", () => {
    expect(errorCode(new Error(`D1_ERROR: no such table: ${SENTINEL}: SQLITE_ERROR`))).toBe(
      "D1_ERROR",
    );
    expect(
      errorCode(new Error("D1_ERROR: publication_sentinel_secret: SQLITE_ERROR"), "publication"),
    ).toBe("D1_ERROR");
    expect(
      errorCode(new Error("D1_ERROR: publication_review_stale: SQLITE_CONSTRAINT"), "publication"),
    ).toBe("D1_ERROR");
    expect(
      errorCode(new Error("D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT"), "publication"),
    ).toBe("runtime_activation_stale");
    // The shape observed from the Workers runtime (Miniflare) for RAISE(ABORT, …).
    expect(
      errorCode(
        new Error(
          "D1_ERROR: runtime_approval_ineligible: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
        ),
        "publication",
      ),
    ).toBe("runtime_approval_ineligible");
    expect(
      errorCode(
        new Error(`D1_ERROR: ${SENTINEL}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`),
      ),
    ).toBe("D1_ERROR");
    expect(
      errorCode(
        new Error(`D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT (extended: ${SENTINEL})`),
      ),
    ).toBe("D1_ERROR");
    expect(errorCode(new Error(`D1_ERROR: ${SENTINEL}: SQLITE_CONSTRAINT`))).toBe("D1_ERROR");
    expect(
      errorCode(new Error("D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT: extra")),
    ).toBe("D1_ERROR");
    expect(
      errorCode(new Error(`${SENTINEL} D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT`)),
    ).toBe("unexpected");
  });

  it("rejects forged typed-error messages and codes", () => {
    class Forged extends Error {
      constructor(
        readonly code: unknown,
        message: string,
        name: string,
      ) {
        super(message);
        this.name = name;
      }
    }
    expect(errorCode(new Forged(SENTINEL, SENTINEL, "HttpError"))).toBe("unexpected");
    expect(errorCode(new Forged(SENTINEL, SENTINEL, "DiscordMessageError"), "v2_delivery")).toBe(
      "v2_delivery_failed",
    );
    expect(
      errorCode(new Forged(undefined, SENTINEL, "DiscordObserverError"), "stats_observer"),
    ).toBe("observer_internal_error");
    expect(errorCode(new Forged(["invalid_payload"], SENTINEL, "AccessError"))).toBe("unexpected");
    expect(errorCode(new Forged(SENTINEL, "publication_review_stale", "Error"))).toBe(
      "publication_review_stale",
    );
    expect(errorCode(new Forged(SENTINEL, SENTINEL, "Error"))).toBe("unexpected");
  });
});

describe("errorCode collapses everything else to a fixed category", () => {
  it("reports fixed runtime error names, never a renamed subclass", () => {
    expect(errorCode(new TypeError(SENTINEL))).toBe("TypeError");
    expect(errorCode(new RangeError("Invalid instant"), "usage_guard")).toBe("RangeError");
    const timeout = new Error(SENTINEL);
    timeout.name = "TimeoutError";
    expect(errorCode(timeout, "ops_alert_delivery")).toBe("TimeoutError");
    expect(errorCode(new DOMException(SENTINEL, "AbortError"))).toBe("AbortError");
    class Provider extends Error {
      override name = SENTINEL;
    }
    expect(errorCode(new Provider(SENTINEL))).toBe("unexpected");
    expect(errorCode(new Error(SENTINEL))).toBe("unexpected");
  });

  it("uses the closed policy fallback and never a caller-supplied one", () => {
    expect(errorCode(undefined)).toBe("unexpected");
    expect(errorCode(SENTINEL, "usage_guard")).toBe("usage_guard_unknown_error");
    expect(errorCode({ message: SENTINEL, code: SENTINEL }, "stats_observer")).toBe(
      "observer_internal_error",
    );
    expect(errorCode(new Error(SENTINEL), "publication")).toBe("publication_operation_failed");
    expect(errorCode(new Error(SENTINEL), "v2_delivery")).toBe("v2_delivery_failed");
    expect(errorCode(new Error(SENTINEL), "ops_alert_delivery")).toBe("alert_delivery_failed");
    expect(errorCode(new Error(SENTINEL), "ops_record")).toBe("record_failed");
    expect(errorCode(new Error(SENTINEL), "canary_runtime")).toBe("runtime_telemetry_invalid");
    // A policy identifier forged at runtime (or inherited from Object.prototype) is not a
    // fallback: it collapses to the default category.
    expect(errorCode(new Error(SENTINEL), SENTINEL as ErrorCodePolicy)).toBe("unexpected");
    expect(errorCode(new Error(SENTINEL), "toString" as ErrorCodePolicy)).toBe("unexpected");
    expect(errorCode(new Error(SENTINEL), "__proto__" as ErrorCodePolicy)).toBe("unexpected");
  });

  it("only ever emits a registered code, a fixed name, or a fixed category", () => {
    for (const policy of POLICIES) {
      for (const input of sentinelInputs()) {
        const output = errorCode(input, policy);
        expect(output).not.toContain(SENTINEL);
        expect(isSafe(output), `${policy}: ${output}`).toBe(true);
      }
    }
  });
});

describe("persistedErrorCode keeps a column inside the registry", () => {
  it("replaces a runtime error name with the policy's registered fallback", () => {
    expect(persistedErrorCode(new TypeError(SENTINEL), "publication")).toBe(
      "publication_operation_failed",
    );
    expect(persistedErrorCode(new SyntaxError(SENTINEL), "v2_delivery")).toBe("v2_delivery_failed");
    const timeout = new Error(SENTINEL);
    timeout.name = "TimeoutError";
    expect(persistedErrorCode(timeout, "ops_alert_delivery")).toBe("alert_delivery_failed");
    expect(persistedErrorCode(new RangeError(SENTINEL), "stats_observer")).toBe(
      "observer_internal_error",
    );
    expect(persistedErrorCode(new TypeError(SENTINEL), "usage_guard")).toBe(
      "usage_guard_unknown_error",
    );
    // The log variant keeps the name for the same input.
    expect(errorCode(new TypeError(SENTINEL), "publication")).toBe("TypeError");
  });

  it("keeps registered codes, enumerated statuses and the fixed D1 category", () => {
    expect(persistedErrorCode(new TypeError("publication_review_stale"), "publication")).toBe(
      "publication_review_stale",
    );
    expect(persistedErrorCode(new Error("discord_429"), "stats_observer")).toBe("discord_429");
    expect(
      persistedErrorCode(
        new Error(`D1_ERROR: no such table: ${SENTINEL}: SQLITE_ERROR`),
        "publication",
      ),
    ).toBe("D1_ERROR");
    expect(
      persistedErrorCode(
        new Error("D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT"),
        "publication",
      ),
    ).toBe("runtime_activation_stale");
  });

  it("only ever persists a registered code or the D1 category, for every policy", () => {
    for (const policy of PERSISTED_POLICIES) {
      for (const input of sentinelInputs()) {
        const output = persistedErrorCode(input, policy);
        expect(output).not.toContain(SENTINEL);
        expect(isAppErrorCode(output) || output === "D1_ERROR", `${policy}: ${output}`).toBe(true);
      }
    }
  });
});

describe("isD1TriggerAbort compares the registered token for a branch decision", () => {
  it.each([
    "D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT",
    "D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
    `Error: D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT: ${SENTINEL}`,
    `${SENTINEL}: runtime_activation_stale`,
    "runtime_activation_stale",
  ])("recognises the token in %j", (message) => {
    expect(isD1TriggerAbort(new Error(message), "runtime_activation_stale")).toBe(true);
    // The layout only decides the branch; whatever is emitted is still the registry's.
    const emitted = errorCode(new Error(message), "publication");
    expect(isSafe(emitted)).toBe(true);
    expect(emitted).not.toContain(SENTINEL);
  });

  it.each([
    "D1_ERROR: runtime_activation_stale_9f3a: SQLITE_CONSTRAINT",
    "D1_ERROR: xruntime_activation_stale: SQLITE_CONSTRAINT",
    "D1_ERROR: Xruntime_activation_stale: SQLITE_CONSTRAINT",
    "D1_ERROR: runtime_activation_staleX: SQLITE_CONSTRAINT",
    "Xruntime_activation_stale",
    "runtime_activation_staleX",
    "D1_ERROR: runtime_activation_staleness: SQLITE_CONSTRAINT",
    "D1_ERROR: runtime_review_stale: SQLITE_CONSTRAINT",
    "RUNTIME_ACTIVATION_STALE",
  ])("rejects %j", (message) => {
    expect(isD1TriggerAbort(new Error(message), "runtime_activation_stale")).toBe(false);
  });

  it("ignores non-errors and a code property", () => {
    expect(isD1TriggerAbort("runtime_activation_stale", "runtime_activation_stale")).toBe(false);
    expect(
      isD1TriggerAbort(
        Object.assign(new Error(SENTINEL), { code: "runtime_activation_stale" }),
        "runtime_activation_stale",
      ),
    ).toBe(false);
  });
});
