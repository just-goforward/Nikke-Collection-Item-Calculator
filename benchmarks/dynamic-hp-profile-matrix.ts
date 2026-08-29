import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScheduleForecastProfiles, gameDayStartMs } from "../shared/supplyForecastModel.ts";
import type { SupplyForecastContext } from "../src/wasm/rustTypes.ts";

export type Registry = {
  version: 2;
  approvedForecastId: string;
  forecasts: Array<{
    id: string;
    rulesVersion: string;
    profiles: Array<{
      id: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      scheduleStatus: "confirmed" | "estimated";
      expectedGain: { blue: number; purple: number; yellow: number };
    }>;
  }>;
};

export type DynamicHpEvidenceProfile = {
  id: string;
  cycleDays: 21 | 28 | 35 | null;
  scheduleStatus: "confirmed" | "estimated";
  phase: "approved" | "normal" | "solo_day1" | "solo_day2" | "solo_day3";
  context: SupplyForecastContext;
};

export type DynamicHpProfile = DynamicHpEvidenceProfile & {
  gainVectorSha256: string;
  evidenceProfiles: DynamicHpEvidenceProfile[];
};

export type DynamicHpProfileDeduplication = "off" | "gain-vector-v1";

export function createDynamicHpProfileMatrix(
  registry: Registry,
  deduplication: DynamicHpProfileDeduplication = "gain-vector-v1",
): DynamicHpProfile[] {
  const approved = registry.forecasts.find(
    (forecast) => forecast.id === registry.approvedForecastId,
  );
  if (!approved) throw new Error(`Approved forecast is missing: ${registry.approvedForecastId}`);
  const result: DynamicHpEvidenceProfile[] = approved.profiles.map((profile, index) => ({
    id: `approved-${index.toString().padStart(2, "0")}`,
    cycleDays: null,
    scheduleStatus: profile.scheduleStatus,
    phase: "approved",
    context: {
      forecastId: approved.id,
      forecastProfileId: profile.id,
      expectedGain: profile.expectedGain,
    },
  }));

  const base = Date.parse("2026-01-01T05:00:00+09:00");
  for (const cycleDays of [21, 28, 35] as const) {
    const soloStart = base + cycleDays * 86_400_000 + 7 * 60 * 60 * 1000;
    for (const scheduleStatus of ["confirmed", "estimated"] as const) {
      const forecastDate =
        cycleDays === 21 ? "2026-01-22" : cycleDays === 28 ? "2026-01-29" : "2026-02-05";
      const forecastId = `supply-${forecastDate}-v${scheduleStatus === "confirmed" ? 1 : 2}`;
      const soloDuration = 7 * 86_400_000 - 7 * 60 * 60 * 1000 - 60 * 1000;
      const soloPeriods = [-2, -1, 0, 1, 2, 3, 4].map((offset) => {
        const start = soloStart + offset * cycleDays * 86_400_000;
        return {
          effectiveFrom: new Date(start).toISOString(),
          effectiveUntil: new Date(start + soloDuration).toISOString(),
          scheduleStatus,
        };
      });
      const profiles = buildScheduleForecastProfiles({
        forecastId,
        effectiveFrom: new Date(base).toISOString(),
        soloPeriods,
        collaborationPeriods: [],
      });
      const targets = [
        ["normal", base],
        ["solo_day1", soloStart],
        ["solo_day2", gameDayStartMs(soloStart) + 86_400_000],
        ["solo_day3", gameDayStartMs(soloStart) + 2 * 86_400_000],
      ] as const;
      for (const [phase, target] of targets) {
        const profile = profileAt(profiles, target);
        result.push({
          id: `cycle-${cycleDays}-${scheduleStatus}-${phase}`,
          cycleDays,
          scheduleStatus,
          phase,
          context: {
            forecastId,
            forecastProfileId: profile.id,
            expectedGain: profile.expectedGain,
          },
        });
      }
    }
  }
  return finalizeProfileMatrix(result, deduplication);
}

export async function writeDynamicHpProfileMatrix(
  registry: Registry,
  outputPath: URL,
  deduplication: DynamicHpProfileDeduplication = "gain-vector-v1",
) {
  const matrix = createDynamicHpProfileMatrix(registry, deduplication);
  await mkdir(new URL("./", outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  return matrix;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const registryPath = new URL("../shared/supplyForecasts.json", import.meta.url);
  const outputPath = process.argv[2]
    ? new URL(process.argv[2], new URL("./results/", import.meta.url))
    : new URL("./results/dynamic-hp-profile-matrix.json", import.meta.url);
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
  const { HP_PROFILE_DEDUPLICATION } = process.env;
  const deduplication = parseDeduplication(HP_PROFILE_DEDUPLICATION);
  const matrix = await writeDynamicHpProfileMatrix(registry, outputPath, deduplication);
  const evidenceProfiles = new Set(
    matrix.flatMap((profile) => profile.evidenceProfiles.map((entry) => entry.id)),
  );
  console.log(
    JSON.stringify(
      {
        profiles: matrix.length,
        evidenceProfiles: evidenceProfiles.size,
        duplicatesRemoved: evidenceProfiles.size - matrix.length,
        deduplication,
        output: outputPath.pathname,
      },
      null,
      2,
    ),
  );
}

export function gainVectorSha256(expectedGain: SupplyForecastContext["expectedGain"]): string {
  for (const value of [expectedGain.blue, expectedGain.purple, expectedGain.yellow]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_dynamic_hp_gain_vector");
  }
  const identity = JSON.stringify([expectedGain.blue, expectedGain.purple, expectedGain.yellow]);
  return createHash("sha256").update(identity).digest("hex");
}

function finalizeProfileMatrix(
  profiles: DynamicHpEvidenceProfile[],
  deduplication: DynamicHpProfileDeduplication,
): DynamicHpProfile[] {
  if (deduplication === "off") {
    return profiles.map((profile) => ({
      ...profile,
      gainVectorSha256: gainVectorSha256(profile.context.expectedGain),
      evidenceProfiles: [profile],
    }));
  }

  const groups = new Map<string, DynamicHpEvidenceProfile[]>();
  for (const profile of profiles) {
    const identity = gainVectorSha256(profile.context.expectedGain);
    const group = groups.get(identity) ?? [];
    group.push(profile);
    groups.set(identity, group);
  }
  return [...groups.entries()].map(([identity, evidenceProfiles]) => {
    const canonical = evidenceProfiles[0];
    if (!canonical) throw new Error("dynamic_hp_gain_group_empty");
    return {
      ...canonical,
      gainVectorSha256: identity,
      evidenceProfiles,
    };
  });
}

function parseDeduplication(value: string | undefined): DynamicHpProfileDeduplication {
  const normalized = value ?? "gain-vector-v1";
  if (normalized === "off" || normalized === "gain-vector-v1") return normalized;
  throw new Error(`Unknown H/p profile deduplication mode: ${normalized}`);
}

function profileAt(
  profiles: ReturnType<typeof buildScheduleForecastProfiles>,
  timestampMs: number,
) {
  const profile = profiles.find((entry) => {
    const until =
      entry.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(entry.effectiveUntil);
    return timestampMs >= Date.parse(entry.effectiveFrom) && timestampMs < until;
  });
  if (!profile)
    throw new Error(`No synthetic forecast profile covers ${new Date(timestampMs).toISOString()}.`);
  return profile;
}
