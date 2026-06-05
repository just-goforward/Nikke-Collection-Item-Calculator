import type { CollectionState } from "../src/types";

export type RustBenchmarkScenarioSource = "fixed-grid" | "gain28-supplemental";
export type RustBenchmarkWeightProfile = "uniform" | "usage-proxy-v1" | "risk-proxy-v1";

export type RustBenchmarkScenarioLike = {
  id: string;
  group: string;
  source: RustBenchmarkScenarioSource;
  start: CollectionState;
};

export type RustBenchmarkWeightSpec = {
  profile: RustBenchmarkWeightProfile;
  defaultWeight: number;
  scenario: Map<string, number>;
  group: Map<string, number>;
  source: Map<RustBenchmarkScenarioSource, number>;
};

const DEFAULT_WEIGHT = 1;
const PROFILE_NAMES = new Set(["uniform", "usage-proxy-v1", "risk-proxy-v1"]);

function parseProfile(value: string | undefined): RustBenchmarkWeightProfile {
  const profile = String(value || "uniform").trim();
  return PROFILE_NAMES.has(profile) ? (profile as RustBenchmarkWeightProfile) : "uniform";
}

function stageWeight(state: CollectionState) {
  if (state.grade === "R") {
    if (state.level <= 1) return 1.4;
    if (state.level >= 14) return 1.2;
    return 1;
  }
  if (state.level <= 1) return 1.3;
  if (state.level >= 10) return 1.1;
  return 1;
}

function profileWeight(scenario: RustBenchmarkScenarioLike, profile: RustBenchmarkWeightProfile) {
  if (profile === "uniform") return 1;

  if (profile === "usage-proxy-v1") {
    // This is not D1 telemetry. It is a transparent stand-in that gives product-like traffic more
    // influence than stress-only probes until private aggregate weights are wired in.
    const sourceWeight = scenario.source === "fixed-grid" ? 1 : 0.35;
    const groupWeight = scenario.group === "balanced" ? 1.25 : 0.85;
    return sourceWeight * groupWeight * stageWeight(scenario.start);
  }

  const sourceWeight = scenario.source === "fixed-grid" ? 1 : 0.7;
  const groupWeight = scenario.group === "scarcity" ? 1.6 : 1;
  const lateJourneyWeight = scenario.start.level >= 10 ? 1.2 : 1;
  return sourceWeight * groupWeight * lateJourneyWeight;
}

export function parseRustBenchmarkWeightSpec(
  value: string | undefined,
  profileValue: string | undefined,
): RustBenchmarkWeightSpec {
  const spec: RustBenchmarkWeightSpec = {
    profile: parseProfile(profileValue),
    defaultWeight: DEFAULT_WEIGHT,
    scenario: new Map(),
    group: new Map(),
    source: new Map(),
  };
  for (const rawItem of String(value || "").split(",")) {
    const [rawKey, rawValue] = rawItem.split("=");
    const key = rawKey?.trim();
    const weight = Number(rawValue);
    if (!key || !Number.isFinite(weight) || weight < 0) continue;
    if (key === "default") {
      spec.defaultWeight = weight;
    } else if (key === "profile") {
      spec.profile = parseProfile(rawValue);
    } else if (key.startsWith("scenario:")) {
      spec.scenario.set(key.slice("scenario:".length), weight);
    } else if (key.startsWith("group:")) {
      spec.group.set(key.slice("group:".length), weight);
    } else if (key.startsWith("source:")) {
      const source = key.slice("source:".length);
      if (source === "fixed-grid" || source === "gain28-supplemental") {
        spec.source.set(source, weight);
      }
    } else {
      spec.scenario.set(key, weight);
    }
  }
  return spec;
}

export function rustBenchmarkWeightForScenario(
  scenario: RustBenchmarkScenarioLike,
  spec: RustBenchmarkWeightSpec,
) {
  const override =
    spec.scenario.get(scenario.id) ??
    spec.group.get(scenario.group) ??
    spec.source.get(scenario.source);
  if (override !== undefined) return override;
  return spec.defaultWeight * profileWeight(scenario, spec.profile);
}

export function serializeRustBenchmarkWeightSpec(spec: RustBenchmarkWeightSpec) {
  return {
    profile: spec.profile,
    defaultWeight: spec.defaultWeight,
    scenario: Object.fromEntries(spec.scenario),
    group: Object.fromEntries(spec.group),
    source: Object.fromEntries(spec.source),
    note:
      spec.profile === "usage-proxy-v1"
        ? "usage-proxy-v1 is a transparent proxy, not private D1 telemetry."
        : undefined,
  };
}
