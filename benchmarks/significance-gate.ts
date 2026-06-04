// Pure seed-level completion gating for the significance re-collection, kept CRN-paired.
//
// The deep journey y-axis (run-availability-deep-slice.ts `aggregateJourneyDemand`) drops a
// (panel, seed) trajectory job whose completionRate < JOURNEY_COMPLETION_THRESHOLD. The
// significance re-collection compares A vs a candidate on the same panel by pairing per-run samples
// across the SHARED seeds, so to match the deep gate WITHOUT breaking the paired-bootstrap CRN
// structure it must drop a seed from BOTH arms whenever EITHER arm under-completes it. Keeping this
// decision pure (no I/O) lets it be unit-tested in isolation; the runner only does the collection.

export const JOURNEY_COMPLETION_THRESHOLD = 0.995;

export type SeedSamples = {
  seed: number;
  completionRate: number;
  samples: number[]; // per-run maxSupplyDebtDays for this seed
};

export type GatedSeed = {
  seed: number;
  baseCompletion: number;
  candCompletion: number;
};

export type GatedPair = {
  status: "completed" | "judgement_incomplete";
  reason: string | null;
  basePool: number[]; // CRN-paired with candPool (same kept seeds, same index)
  candPool: number[];
  completionMin: number; // min completionRate over base+cand across all seeds (NaN if no seeds)
  seedsTotal: number;
  seedsKept: number;
  seedsGated: GatedSeed[];
};

export function gatePairedSeeds(
  base: SeedSamples[],
  cand: SeedSamples[],
  threshold: number = JOURNEY_COMPLETION_THRESHOLD,
): GatedPair {
  const basePool: number[] = [];
  const candPool: number[] = [];
  const seedsGated: GatedSeed[] = [];
  let completionMin = Number.POSITIVE_INFINITY;
  const n = Math.min(base.length, cand.length);
  for (let i = 0; i < n; i += 1) {
    const b = base[i];
    const c = cand[i];
    completionMin = Math.min(completionMin, b.completionRate, c.completionRate);
    // Drop this seed from BOTH arms when either side under-completes it. Excluding the same seed
    // from both keeps the per-index CRN pairing (and equal lengths) intact for paired bootstrap.
    if (b.completionRate < threshold || c.completionRate < threshold) {
      seedsGated.push({
        seed: b.seed,
        baseCompletion: b.completionRate,
        candCompletion: c.completionRate,
      });
      continue;
    }
    const m = Math.min(b.samples.length, c.samples.length);
    for (let j = 0; j < m; j += 1) {
      basePool.push(b.samples[j]);
      candPool.push(c.samples[j]);
    }
  }
  const seedsKept = n - seedsGated.length;
  const completionMinOut = Number.isFinite(completionMin) ? completionMin : Number.NaN;
  if (basePool.length === 0) {
    return {
      status: "judgement_incomplete",
      reason: n === 0 ? "no_seeds" : "all_seeds_gated",
      basePool,
      candPool,
      completionMin: completionMinOut,
      seedsTotal: n,
      seedsKept,
      seedsGated,
    };
  }
  return {
    status: "completed",
    reason: null,
    basePool,
    candPool,
    completionMin: completionMinOut,
    seedsTotal: n,
    seedsKept,
    seedsGated,
  };
}
