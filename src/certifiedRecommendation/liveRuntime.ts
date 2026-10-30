import type { CertifiedInput, CertifiedOutput, CertifiedEvidenceBudget } from "../certified/types";
import type { RecommendationContext } from "./evidence";
import { liveRecommendationEvidence } from "./liveEvidence";
import { liveRecommendationGuidance } from "./liveGuidance";
import { selectRecommendation } from "./policy";
import { payloadBytes } from "../certifiedRuntime/protocol";

export interface LiveRequestIdentity { id: number; generation: number; sessionId: string }

/** UTF-16 JSON escaping (six characters per input unit), copies and container slots. */
export function liveJsonWorkspace(value: unknown): number {
  if (typeof value === "string") return 32 + 24 * value.length;
  if (typeof value === "bigint") return 64 + 8 * value.toString().length;
  if (value === null || typeof value !== "object") return 64;
  let bytes = 128;
  for (const key of Object.keys(value))
    bytes += 128 + 24 * key.length + liveJsonWorkspace(Reflect.get(value, key));
  return bytes;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => [k, canonical(v)]));
}

/** Exact canonical identity strings, not new hashes or substitutes for forecast authentication. */
export function liveContext(
  input: CertifiedInput, identity: LiveRequestIdentity, engine: unknown, forecast: unknown,
): RecommendationContext {
  return {
    requestId: JSON.stringify([identity.sessionId, identity.generation, identity.id]),
    inputFingerprint: JSON.stringify(canonical(input)),
    stateFingerprint: JSON.stringify(canonical({
      grade: input.grade, level: input.level, exp: input.exp, stock: input.stock,
      receivedEventIds: input.receivedEventIds, priceBasisStock: input.priceBasisStock,
    })),
    engineFingerprint: JSON.stringify(canonical(engine)),
    modelFingerprint: JSON.stringify(canonical(forecast)),
    asOf: input.asOf, horizonDays: 14,
  };
}

export function liveRuntimeRecommendation(
  input: CertifiedInput, output: CertifiedOutput, identity: LiveRequestIdentity,
  engine: unknown, forecast: unknown, budget: CertifiedEvidenceBudget,
) {
  // Bounds canonical copies/escaping and rational arithmetic workspace before conversion.
  // The selector performs a bounded number of operations on at most fifteen rationals.
  const workspace = liveJsonWorkspace({ input, identity, engine, forecast }) +
    // At most 15 probabilities; reduced score differences and comparisons use
    // at most four source rational widths per intermediate, with 16 live slots.
    65536 + 64 * payloadBytes(output.completedEvidence);
  budget.check();
  try {
    budget.reserve(workspace);
    const context = liveContext(input, identity, engine, forecast);
    budget.check();
    const evidence = liveRecommendationEvidence(input, output, context, budget);
    budget.check();
    const recommendation = evidence ? selectRecommendation(context, evidence) : null;
    budget.check();
    const guidance = liveRecommendationGuidance(input, output, recommendation, false, budget);
    budget.check();
    return { context, recommendation, guidance };
  } finally {
    budget.release(workspace);
  }
}

export type LiveRuntimeRecommendation = ReturnType<typeof liveRuntimeRecommendation>;
