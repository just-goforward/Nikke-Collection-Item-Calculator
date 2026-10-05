import { eq, fromWire, type Q, q, sum, toWire } from "../../shared/certifiedRational";
import { assertCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { CertifiedLimit } from "./budget";
import { eventOffset } from "./events";
import type { CertifiedInput, Triple } from "./types";

const ONE = q(1);
const DEFAULT_PRIORS = [toWire(q(1, 3)), toWire(q(1, 3)), toWire(q(1, 3))] as const;
export function requireInput(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new CertifiedLimit(reason);
}
function validateTriple(stock: Triple, name: string): void {
  requireInput(
    Array.isArray(stock) &&
      stock.length === 3 &&
      stock.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000),
    name,
  );
}
export function validate(input: CertifiedInput, checkBudget?: () => void): readonly [Q, Q, Q] {
  validateState(input);
  validateSnapshot(input, checkBudget);
  requireInput(
    input.batchLimit === undefined ||
      (Number.isSafeInteger(input.batchLimit) && input.batchLimit >= 1 && input.batchLimit <= 1000),
    "invalid_batch_limit",
  );
  const priors = (input.cohortWeights ?? DEFAULT_PRIORS).map(fromWire) as [Q, Q, Q];
  requireInput(
    priors.length === 3 && priors.every((p) => p.n >= 0n) && eq(sum(priors), ONE),
    "invalid_cohort_weights",
  );
  return priors;
}
function validateState(input: CertifiedInput): void {
  requireInput(input.grade === "R" || input.grade === "SR", "invalid_grade");
  requireInput(
    Number.isSafeInteger(input.level) && input.level >= 0 && input.level <= 15,
    "invalid_level",
  );
  requireInput(
    Number.isSafeInteger(input.exp) &&
      input.exp >= 0 &&
      input.exp % 100 === 0 &&
      input.exp < (input.grade === "R" ? 1000 : 3000) &&
      (input.level < 15 || input.exp === 0),
    "invalid_exp",
  );
  validateTriple(input.stock, "invalid_stock");
  validateTriple(input.priceBasisStock ?? input.stock, "invalid_price_basis_stock");
  requireInput(Number.isFinite(Date.parse(input.asOf)), "invalid_asof");
}
function validateSnapshot(input: CertifiedInput, checkBudget?: () => void): void {
  assertCertifiedSupplySnapshot(input.snapshot, checkBudget);
  requireInput(
    input.snapshot?.version === "certified-daily-v1" &&
      Date.parse(input.snapshot.asOf) === Date.parse(input.asOf),
    "snapshot_asof_mismatch",
  );
  requireInput(
    input.snapshot.events.length <= 2048 && input.snapshot.rules.length <= 256,
    "snapshot_size_limit",
  );
  const ids = new Set<string>();
  for (const event of input.snapshot.events) {
    requireInput(!ids.has(event.id), "duplicate_snapshot_event_id");
    ids.add(event.id);
    requireInput(
      Number.isFinite(Date.parse(event.at)) && Number.isSafeInteger(eventOffset(input, event)),
      "invalid_snapshot_event_date",
    );
    requireInput(
      event.refs.every(
        (ref) =>
          Number.isSafeInteger(ref.count) &&
          ref.count >= 0 &&
          ref.count <= 64 &&
          (ref.lawId !== "dispatch-board-v1" || ref.count <= 1),
      ),
      "invalid_law_count",
    );
  }
}
