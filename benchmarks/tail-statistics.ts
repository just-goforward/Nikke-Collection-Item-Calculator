type Statistic = (values: number[]) => number;

type BootstrapOptions = {
  higherIsBetter: boolean;
  statistic: Statistic;
  resamples?: number;
  confidence?: number;
  seed?: number;
};

type CvarBootstrapOptions = {
  alpha: number;
  resamples?: number;
  confidence?: number;
  seed?: number;
};

export type PairedBootstrapResult = {
  pointImprovement: number;
  confidenceLower: number;
  confidenceUpper: number;
  adversePValue: number;
  resamples: number;
};

export type PairedCvarBootstrapResult = PairedBootstrapResult & {
  reverseAdversePValue: number;
};

export type TailHypothesis = {
  id: string;
  adversePValue: number;
};

export type HolmDecision = {
  id: string;
  adversePValue: number;
  threshold: number;
  confirmedWorsening: boolean;
};

function makeRandom(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function quantile(values: number[], fraction: number) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return Number.NaN;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function improvement(
  baselineValues: number[],
  candidateValues: number[],
  statistic: Statistic,
  higherIsBetter: boolean,
) {
  const difference = statistic(candidateValues) - statistic(baselineValues);
  return higherIsBetter ? difference : -difference;
}

export function pairedBootstrapImprovement(
  baselineValues: number[],
  candidateValues: number[],
  options: BootstrapOptions,
): PairedBootstrapResult {
  if (baselineValues.length !== candidateValues.length || baselineValues.length === 0) {
    throw new Error("Paired bootstrap requires equally sized, non-empty samples.");
  }

  const resamples = Math.max(1, Math.trunc(options.resamples ?? 10_000));
  const confidence = Math.max(0, Math.min(1, options.confidence ?? 0.95));
  const random = makeRandom(Math.max(0, Math.trunc(options.seed ?? 20260505)));
  const improvements: number[] = [];

  for (let iteration = 0; iteration < resamples; iteration += 1) {
    const baselineSample: number[] = [];
    const candidateSample: number[] = [];
    for (let draw = 0; draw < baselineValues.length; draw += 1) {
      const index = Math.floor(random() * baselineValues.length);
      const baselineValue = baselineValues[index];
      const candidateValue = candidateValues[index];
      if (baselineValue === undefined || candidateValue === undefined) continue;
      baselineSample.push(baselineValue);
      candidateSample.push(candidateValue);
    }
    improvements.push(
      improvement(baselineSample, candidateSample, options.statistic, options.higherIsBetter),
    );
  }

  const tail = (1 - confidence) / 2;
  const nonAdverseCount = improvements.filter((value) => value >= 0).length;
  return {
    pointImprovement: improvement(
      baselineValues,
      candidateValues,
      options.statistic,
      options.higherIsBetter,
    ),
    confidenceLower: quantile(improvements, tail),
    confidenceUpper: quantile(improvements, 1 - tail),
    adversePValue: (nonAdverseCount + 1) / (resamples + 1),
    resamples,
  };
}

export function pairedBootstrapCvarImprovement(
  baselineValues: number[],
  candidateValues: number[],
  options: CvarBootstrapOptions,
): PairedCvarBootstrapResult {
  if (baselineValues.length !== candidateValues.length || baselineValues.length === 0) {
    throw new Error("Paired bootstrap requires equally sized, non-empty samples.");
  }

  const resamples = Math.max(1, Math.trunc(options.resamples ?? 10_000));
  const confidence = Math.max(0, Math.min(1, options.confidence ?? 0.95));
  const alpha = Math.max(0, Math.min(1, options.alpha));
  const random = makeRandom(Math.max(0, Math.trunc(options.seed ?? 20260505)));
  const baselineHistogram = createHistogram(baselineValues);
  const candidateHistogram = createHistogram(candidateValues);
  const baselineCounts = new Uint32Array(baselineHistogram.values.length);
  const candidateCounts = new Uint32Array(candidateHistogram.values.length);
  const improvements = new Array<number>(resamples);
  let nonAdverseCount = 0;
  let reverseNonAdverseCount = 0;

  for (let iteration = 0; iteration < resamples; iteration += 1) {
    baselineCounts.fill(0);
    candidateCounts.fill(0);
    for (let draw = 0; draw < baselineValues.length; draw += 1) {
      const index = Math.floor(random() * baselineValues.length);
      const baselineBin = baselineHistogram.binByObservation[index];
      const candidateBin = candidateHistogram.binByObservation[index];
      if (baselineBin === undefined || candidateBin === undefined) continue;
      baselineCounts[baselineBin] = (baselineCounts[baselineBin] ?? 0) + 1;
      candidateCounts[candidateBin] = (candidateCounts[candidateBin] ?? 0) + 1;
    }
    const improvement =
      cvarFromHistogram(baselineHistogram.values, baselineCounts, baselineValues.length, alpha) -
      cvarFromHistogram(candidateHistogram.values, candidateCounts, candidateValues.length, alpha);
    improvements[iteration] = improvement;
    if (improvement >= 0) nonAdverseCount += 1;
    if (improvement <= 0) reverseNonAdverseCount += 1;
  }

  const tail = (1 - confidence) / 2;
  return {
    pointImprovement:
      cvarFromValues(baselineValues, alpha) - cvarFromValues(candidateValues, alpha),
    confidenceLower: quantile(improvements, tail),
    confidenceUpper: quantile(improvements, 1 - tail),
    adversePValue: (nonAdverseCount + 1) / (resamples + 1),
    reverseAdversePValue: (reverseNonAdverseCount + 1) / (resamples + 1),
    resamples,
  };
}

function createHistogram(values: number[]) {
  const uniqueValues = [...new Set(values)].sort((left, right) => left - right);
  const binByValue = new Map(uniqueValues.map((value, index) => [value, index]));
  const binByObservation = Uint32Array.from(values, (value) => {
    const bin = binByValue.get(value);
    if (bin === undefined) throw new Error("Missing bootstrap histogram bin.");
    return bin;
  });
  return { values: uniqueValues, binByObservation };
}

function cvarFromValues(values: number[], alpha: number): number {
  const histogram = createHistogram(values);
  const counts = new Uint32Array(histogram.values.length);
  for (const bin of histogram.binByObservation) counts[bin] = (counts[bin] ?? 0) + 1;
  return cvarFromHistogram(histogram.values, counts, values.length, alpha);
}

function cvarFromHistogram(
  values: number[],
  counts: Uint32Array,
  sampleSize: number,
  alpha: number,
): number {
  if (sampleSize === 0) return Number.NaN;
  const position = (sampleSize - 1) * alpha;
  const lowerValue = valueAtRank(values, counts, Math.floor(position));
  const upperValue = valueAtRank(values, counts, Math.ceil(position));
  const threshold = lowerValue + (upperValue - lowerValue) * (position - Math.floor(position));
  let tailCount = 0;
  let tailSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const count = counts[index] ?? 0;
    if (value === undefined || value < threshold || count === 0) continue;
    tailCount += count;
    tailSum += value * count;
  }
  return tailCount === 0 ? threshold : tailSum / tailCount;
}

function valueAtRank(values: number[], counts: Uint32Array, rank: number): number {
  let cumulative = 0;
  for (let index = 0; index < values.length; index += 1) {
    cumulative += counts[index] ?? 0;
    if (rank < cumulative) {
      const value = values[index];
      if (value !== undefined) return value;
    }
  }
  const fallback = values.at(-1);
  if (fallback === undefined) throw new Error("Cannot select a value from an empty histogram.");
  return fallback;
}

export function holmBonferroniWorseningDecisions(
  hypotheses: TailHypothesis[],
  alpha = 0.05,
): HolmDecision[] {
  const ordered = [...hypotheses].sort(
    (left, right) => left.adversePValue - right.adversePValue || left.id.localeCompare(right.id),
  );
  const decisions = new Map<string, HolmDecision>();
  let continueRejecting = true;

  for (let index = 0; index < ordered.length; index += 1) {
    const hypothesis = ordered[index];
    if (!hypothesis) continue;
    const threshold = alpha / (ordered.length - index);
    const confirmedWorsening = continueRejecting && hypothesis.adversePValue <= threshold;
    if (!confirmedWorsening) continueRejecting = false;
    decisions.set(hypothesis.id, {
      id: hypothesis.id,
      adversePValue: hypothesis.adversePValue,
      threshold,
      confirmedWorsening,
    });
  }

  return hypotheses.map((hypothesis) => {
    const decision = decisions.get(hypothesis.id);
    if (!decision) throw new Error(`Missing Holm decision for ${hypothesis.id}.`);
    return decision;
  });
}
