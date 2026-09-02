import { describe, expect, it } from "vitest";
import { EventSubmissionSchema } from "../cloudflare/src/schemas";
import { makeSolverRecoveryEvent } from "../src/hooks/calculatorDiagnostics";
import { makeSolverRecoveryEventV2 } from "../src/hooks/calculatorDiagnosticsV2";

describe("solver recovery client and Worker contract", () => {
  it("accepts the event produced by the current client builder", () => {
    const event = makeSolverRecoveryEvent(
      {
        start: { grade: "R", level: 0, exp: 0 },
        stock: { blue: 400, purple: 200, yellow: 100 },
        strategy: "supply",
      },
      {
        jsExit: "not_attempted",
        minEfExit: "memo_full",
        phase2Exit: "success",
        policyVersion: "ladder_v2",
        requestedBackend: "rust-min-ef",
        terminalBackend: "rust-phase2",
        terminalOutcome: "success",
      },
    );

    expect(event).not.toBeNull();
    expect(
      EventSubmissionSchema.safeParse({
        version: 1,
        eventId: "solver-current-client01",
        turnstileToken: "test-turnstile-token-value",
        event,
      }).success,
    ).toBe(true);
  });

  it("emits the closed diagnostic identity when v2 is enabled server-first", () => {
    const event = makeSolverRecoveryEventV2(
      {
        start: { grade: "R", level: 0, exp: 0 },
        stock: { blue: 400, purple: 200, yellow: 100 },
        strategy: "supply",
      },
      {
        jsExit: "not_attempted",
        minEfExit: "memo_full",
        phase2Exit: "success",
        policyVersion: "ladder_v2",
        requestedBackend: "rust-min-ef",
        terminalBackend: "rust-phase2",
        terminalOutcome: "success",
      },
    );

    expect(event).toMatchObject({
      recoveryVersion: 2,
      appRevision: "unknown",
      solverVersions: {
        rustMinEf: "phase3_rust_min_ef",
        rustPhase2: "phase2_availability_h075_tau0_p3_rust_segmented_v1",
        jsPhase2: "phase2_availability_h075_tau0_p3",
      },
    });
    expect(
      EventSubmissionSchema.safeParse({
        version: 1,
        eventId: "solver-current-client02",
        turnstileToken: "test-turnstile-token-value",
        event,
      }).success,
    ).toBe(true);
  });
});
