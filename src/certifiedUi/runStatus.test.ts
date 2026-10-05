import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { solveCertified } from "../certified/solver";
import { CertifiedRuntimeError } from "../certifiedRuntime/client";
import { interruptedCertifiedWaiting } from "../certifiedRuntime/partial";
import {
  certifiedBackgroundPartial,
  certifiedRunError,
  showCertifiedRunResults,
} from "./runStatus";

describe("request-bound visibility interruption classification", () => {
  it("classifies the actual aborted rejection bound to its own hidden cause", () => {
    const controller = new AbortController();
    const cause = { kind: "certified_visibility_hidden" as const, run: 1, hiddenAtMs: 12 };
    controller.abort(cause);
    expect(
      certifiedRunError(new CertifiedRuntimeError("aborted", "Aborted during compute"), {
        signal: controller.signal,
        cause,
      }),
    ).toBe("background");
    expect(certifiedRunError(cause, { signal: controller.signal, cause })).toBe("background");
    expect(certifiedRunError({ ...cause }, { signal: controller.signal, cause })).toBe("error");
    expect(
      certifiedRunError(new Error("forecast_prepare_failed"), { signal: controller.signal, cause }),
    ).toBe("error");
    expect(
      certifiedRunError(new Error("certified_total_deadline"), {
        signal: controller.signal,
        cause,
      }),
    ).toBe("limit");
  });

  it.each(["deadline", "memory", "profile", "worker"] as const)(
    "preserves %s classification even after observing hidden",
    (code) => {
      const controller = new AbortController();
      const cause = { kind: "certified_visibility_hidden" as const, run: 2, hiddenAtMs: 13 };
      controller.abort(cause);
      expect(
        certifiedRunError(new CertifiedRuntimeError(code, code), {
          signal: controller.signal,
          cause,
        }),
      ).toBe(code === "deadline" || code === "memory" ? "limit" : "error");
    },
  );

  it("does not label a manual or differently bound abort as background", () => {
    const controller = new AbortController();
    const cause = { kind: "certified_visibility_hidden" as const, run: 3, hiddenAtMs: 14 };
    controller.abort("user_cancel");
    expect(
      certifiedRunError(new CertifiedRuntimeError("aborted", "Manual"), {
        signal: controller.signal,
        cause,
      }),
    ).toBe("error");
  });
});

describe("completed current result visibility interruption", () => {
  const snapshot = buildCertifiedSupplySnapshot({
    asOf: "2026-09-30T03:00:00Z",
    revision: "visibility-unit",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  const current = solveCertified({
    grade: "SR",
    level: 14,
    exp: 2900,
    stock: [45, 0, 0],
    asOf: snapshot.asOf,
    snapshot,
    computeWaiting: false,
  });
  const controller = new AbortController();
  const cause = { kind: "certified_visibility_hidden" as const, run: 4, hiddenAtMs: 15 };
  controller.abort(cause);
  const context = { signal: controller.signal, cause };

  it("retains an actual exact current result for a bound waiting abort", () => {
    const partial = interruptedCertifiedWaiting(current, "aborted");
    expect(certifiedBackgroundPartial(partial, context)).toBe(true);
    expect(showCertifiedRunResults("background", partial)).toBe(true);
    expect(partial.current).toEqual(current.current);
  });

  it("does not relabel deadline, worker failure, or completed output after hidden", () => {
    for (const output of [
      current,
      interruptedCertifiedWaiting(current, "deadline"),
      interruptedCertifiedWaiting(current, "worker"),
    ]) {
      expect(certifiedBackgroundPartial(output, context)).toBe(false);
    }
    expect(showCertifiedRunResults("background", null)).toBe(false);
    expect(showCertifiedRunResults("limit", current)).toBe(false);
  });

  it("requires retained current and the same request's visibility cause", () => {
    const partial = interruptedCertifiedWaiting(current, "aborted");
    expect(certifiedBackgroundPartial({ ...partial, current: null }, context)).toBe(false);
    const manual = new AbortController();
    manual.abort("user_cancel");
    expect(certifiedBackgroundPartial(partial, { signal: manual.signal, cause })).toBe(false);
    for (const reason of [
      "managed_payload_ceiling",
      "request_budget_exhausted",
      "profile_mismatch",
    ]) {
      expect(
        certifiedBackgroundPartial({ ...partial, refusal: { phase: "waiting", reason } }, context),
      ).toBe(false);
    }
  });
});
