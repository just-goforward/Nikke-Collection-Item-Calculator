import { describe, expect, it } from "vitest";
import { cmp, fromWire, q, toWire } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplyEvent,
} from "../../shared/certifiedSupply";
import { WorkBudget } from "./budget";
import { eventOffset, futureEvents } from "./events";
import { encode } from "./game";
import { FiniteKernel } from "./kernel";
import { nearBoundWitness } from "./nearBoundWitness";
import { solveCertified } from "./solver";
import type { CertifiedInput, CertifiedValue, Triple } from "./types";
import { certifiedValueView } from "./views";
import type { WaitingContext } from "./waitingContext";

const AS_OF = "2026-09-30T03:00:00.000Z";
function physicalInput(grade: "R" | "SR", blue: number): CertifiedInput {
  const snapshot = buildCertifiedSupplySnapshot({
    asOf: AS_OF,
    revision: "mixed-bound-physical-regression",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  return {
    grade,
    level: 0,
    exp: 0,
    stock: [blue, 200, 100],
    priceBasisStock: [blue, 200, 100],
    asOf: AS_OF,
    snapshot,
    receivedEventIds: ["dispatch:2026-09-30"],
  };
}

function strictOrder(after: CertifiedValue, before: CertifiedValue): number {
  const success = cmp(fromWire(after.successP), fromWire(before.successP));
  if (success) return success;
  const burden = cmp(
    fromWire(before.weightedExpectedConsumptionB),
    fromWire(after.weightedExpectedConsumptionB),
  );
  return (
    burden ||
    cmp(fromWire(before.expectedTotalConsumptionC), fromWire(after.expectedTotalConsumptionC))
  );
}

describe("mixed-color physical boundary witness", () => {
  it.each([
    ["R", 300],
    ["R", 400],
    ["R", 600],
    ["SR", 400],
    ["SR", 600],
    ["SR", 800],
  ] as const)(
    "certifies %s0 [%i,200,100] within its shared request budget",
    (grade, blue) => {
      const request = physicalInput(grade, blue);
      expect(request.snapshot.events).toHaveLength(79);
      const started = performance.now();
      const budgetMs = grade === "R" && blue === 300 ? 5_000 : 15_000;
      let currentAvailableMs = 0;
      const result = solveCertified(request, {
        deadlineAt: started + budgetMs,
        maxManagedPayloadBytes: 160 * 1024 * 1024,
        onCurrent: () => {
          currentAvailableMs = performance.now() - started;
        },
      });
      console.info(
        JSON.stringify({
          case: `${grade}0-${blue}-200-100`,
          fixture: "same physical laws/events/asOf/receipts; test-only provenance metadata",
          elapsedMs: performance.now() - started,
          budgetMs,
          currentAvailableMs,
          status: result.status,
          waiting: result.waiting.status,
          reason: result.waiting.reason,
          diagnostics: result.diagnostics,
        }),
      );
      expect(result.current).not.toBeNull();
      expect(result.status).toBe("completed");
      expect(result.waiting.status).toBe("certified");
      expect(result.waiting.recommendedDays).toBe(56);
      expect(result.waiting.value).toBeNull();
      const witness = result.waiting.strictBoundaryWitness!;
      expect(strictOrder(witness.afterValue, witness.beforeValue)).toBe(1);
      const cohortMass = fromWire(result.pricing!.cohortWeights[witness.cohort]);
      expect(cohortMass.n).toBeGreaterThan(0n);
      let before: Triple = request.stock;
      let after: Triple = request.stock;
      for (const receipt of witness.receipts) {
        expect(fromWire(receipt.mass).n).toBeGreaterThan(0n);
        const event = request.snapshot.events.find(
          (candidate) => candidate.id === receipt.eventId,
        )!;
        expect(event).toBeDefined();
        after = [0, 1, 2].map((color) => after[color]! + receipt.pieces[color]!) as [
          number,
          number,
          number,
        ];
        if (eventOffset(request, event) !== 56)
          before = [0, 1, 2].map((color) => before[color]! + receipt.pieces[color]!) as [
            number,
            number,
            number,
          ];
      }
      expect(before).toEqual(witness.beforeStock);
      expect(after).toEqual(witness.afterStock);
      expect(result.diagnostics.elapsedMs).toBeLessThan(budgetMs);
      expect(result.diagnostics.managedPayloadBytes).toBeLessThanOrEqual(160 * 1024 * 1024);
    },
    20_000,
  );
});

function tinyEvent(day: number, lawId: string): CertifiedSupplyEvent {
  const gameDate = new Date(Date.parse("2026-09-30T00:00:00Z") + day * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `dispatch:${gameDate}`,
    gameDate,
    at: `${gameDate}T08:00:00Z`,
    kind: "dispatch",
    status: "confirmed",
    refs: [{ lawId, count: 1 }],
    ruleId: "test-rule",
  };
}
function tinyContext(): WaitingContext {
  const input = { ...physicalInput("SR", 0), level: 14, exp: 2900, stock: [0, 0, 0] as const };
  const kernel = new FiniteKernel([q(1), q(2), q(3)], new WorkBudget({}, performance.now()));
  const sid = encode(input.grade, input.level, input.exp);
  return {
    input,
    sid,
    kernel,
    current: kernel.solve(sid, input.stock),
    priors: [q(1), q(0), q(0)],
    view: (value) => certifiedValueView(kernel.actualValue(value)),
  };
}
describe("unsuccessful boundary selection stays UNKNOWN", () => {
  it("returns null with no future receipts", () => {
    expect(nearBoundWitness(tinyContext(), [], [])).toBeNull();
  });
  it("does not treat an exact P/B/C endpoint tie as a strict witness", () => {
    const context = tinyContext();
    expect(nearBoundWitness(context, [], [tinyEvent(56, "deterministic:5,0,0")])).toBeNull();
  });
  it("skips a zero-prior cohort even when only that cohort can improve", () => {
    const context = tinyContext();
    context.priors = [q(0), q(1), q(0)];
    const event = tinyEvent(56, "cohort-test");
    const outcome = (blue: number) => [{ pieces: [blue, 0, 0] as const, mass: toWire(q(1)) }];
    context.input = {
      ...context.input,
      snapshot: {
        ...context.input.snapshot,
        events: [event],
        laws: [
          {
            id: "cohort-test",
            kind: "finite",
            modelVersion: "zero-prior-test",
            outcomesByCohort: [outcome(10), outcome(5), outcome(5)],
          },
        ],
      },
    };
    expect(nearBoundWitness(context, [], futureEvents(context.input))).toBeNull();
  });
});
