import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WireQ } from "../shared/certifiedRational.ts";
import type { CertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import type { CertifiedInput, CertifiedMinimumWaitProbe, Triple } from "../src/certified/types.ts";
import { loadCertifiedWasm } from "../src/certified/wasmBackend.ts";
import { solveCertifiedWasm } from "../src/certified/wasmSolver.ts";
import { prepareCertifiedForecast } from "../src/lib/certifiedForecast.ts";
import { FIXTURE_DIRECTORY, sha256 } from "./certified-wait-label-oracle.ts";

/** Product-vs-oracle comparison of the minimum-wait label.
 * System under test: the JSON probe (scripts/certified-minimum-wait-probe.ts,
 * all_days=true, run as a child process over stdin) and the normal runtime path
 * (solveCertifiedWasm, all_days=false, label only). Expected values come only
 * from the pre-registered files below, verified by sha256; this file never
 * computes an expectation. A NOTRUN/unknown product result is a failure. */
const PINS: Record<string, string> = {
  "fixtures.json": "43dcdf764a2129b4087e8d42eacd7da2974fa66a6e7aa1b54ba9aa2ebbfbf37f",
  "expected/R0.json": "0fbae392d9222af45dbdc035b03648382aa072b09489dd1d55dcb016bf1aae84",
  "expected/R10.json": "400e0399255d9e4470be792f555a69f0022ba7f49e690a2ee2288666dd97eecb",
  "expected/R14.json": "5737ab4c5af2ac5a007faab4b6e94842c531f7801ae172d8a8472a878a788118",
  "expected/SR5.json": "d654768a0ba3b5cdd75597698326b825abc6c1d32094ea6ae8dd9b02160bd046",
  "expected/SR10.json": "08708b38cb43d0f311fd22d52fd3dd6817c042b636541fb640b9743435223c38",
  "expected/SR13.json": "ed3404ed3a4982d2449f8ce16427f88605d27e0cf4ed04d664d008fcf8d76326",
  "fixtures-tie.json": "fb09cfc419912a5e36ce16d21be15b44472771655809f175696845ce323d29bf",
  "expected/TIE-R5.json": "c6d015947923184ea4226b03630326c9a58bae4869eca2205192c49c68de8d43",
};
const pinned = (path: string) => {
  const bytes = readFileSync(resolve(FIXTURE_DIRECTORY, path));
  expect([path, sha256(bytes)]).toEqual([path, PINS[path]]);
  return JSON.parse(bytes.toString("utf8")) as unknown;
};
type FixtureFile = {
  common: {
    currentDay: string;
    receivedEventIds: string[];
    cohortWeights: [WireQ, WireQ, WireQ, WireQ];
    batchLimit: number;
    horizonDays: number;
    schedule: { id: string; day: number; refs: { lawId: string; count: number }[] }[];
  };
  fixtures: {
    id: string;
    grade: "R" | "SR";
    level: number;
    exp: number;
    stock: Triple;
    priceBasisStock: Triple;
    asOf: string;
    /** Tie fixtures only: the oracle's exact root tie set. */
    optimalKits?: ("blue" | "purple" | "yellow")[];
  }[];
};
type Expected = {
  fixtureFileSha256: string;
  result: {
    status: "EXACT";
    recommendation: { kit: "blue" | "purple" | "yellow"; uses: number };
    rates: WireQ[];
    certificateApplies: boolean;
    label: number | "7+";
    perDay: { day: number; crossing: boolean; supportUnits: Triple[]; crossingUnits: Triple[] }[];
  };
};
const file = pinned("fixtures.json") as FixtureFile;
const tieFile = pinned("fixtures-tie.json") as FixtureFile;
const FIXTURES = [
  ...file.fixtures.map((fixture) => ({ fixture, source: "fixtures.json" })),
  ...tieFile.fixtures.map((fixture) => ({ fixture, source: "fixtures-tie.json" })),
];
const IDS = FIXTURES.map(({ fixture }) => fixture.id);
const TIE_IDS = tieFile.fixtures.map((fixture) => fixture.id);
const expected = (id: string) => {
  const document = pinned(`expected/${id}.json`) as Expected;
  const source = FIXTURES.find(({ fixture }) => fixture.id === id)?.source ?? "";
  expect(document.fixtureFileSha256).toBe(PINS[source]);
  expect(document.result.status).toBe("EXACT");
  return document.result;
};
/** Reduced rational, so equal values with different wire spellings compare equal. */
const reduced = (value: WireQ) => {
  let [n, d] = [BigInt(value.numerator), BigInt(value.denominator)];
  if (d < 0n) [n, d] = [-n, -d];
  let [a, b] = [n < 0n ? -n : n, d];
  while (b !== 0n) [a, b] = [b, a % b];
  return `${n / a}/${d / a}`;
};
const unitSet = (units: readonly (readonly number[])[]) =>
  [...new Set(units.map((u) => u.join(",")))].sort();

const inputs = new Map<string, CertifiedInput>();
let module: WebAssembly.Module;
beforeAll(async () => {
  module = await loadCertifiedWasm(() => readFile("public/certified_solver.wasm"));
  // The tie file's common block equals fixtures.json's (checked by the oracle spec).
  expect(tieFile.common).toEqual(file.common);
  for (const { fixture } of FIXTURES) {
    const snapshot: CertifiedSupplySnapshot = await prepareCertifiedForecast(fixture.asOf);
    inputs.set(fixture.id, {
      grade: fixture.grade,
      level: fixture.level,
      exp: fixture.exp,
      stock: fixture.stock,
      priceBasisStock: fixture.priceBasisStock,
      asOf: fixture.asOf,
      snapshot,
      cohortWeights: file.common.cohortWeights,
      receivedEventIds: file.common.receivedEventIds,
      batchLimit: file.common.batchLimit,
      computeMinimumWait: true,
      computeWaiting: false,
    });
  }
}, 120_000);
const input = (id: string) => {
  const value = inputs.get(id);
  if (!value) throw new Error(`missing input ${id}`);
  return value;
};

describe("product input binding to the pinned fixtures", () => {
  it.each(IDS)("%s: the product snapshot has the fixture's day and 7-day schedule", (id) => {
    const { snapshot, asOf } = input(id);
    expect(snapshot.version).toBe("certified-daily-v2");
    expect(snapshot.coverage.currentDay).toBe(file.common.currentDay);
    expect(snapshot.coverage.future.complete).toBe(true);
    const dayMs = 86_400_000;
    const received = new Set(file.common.receivedEventIds);
    const schedule = snapshot.events
      .map((event) => {
        const offset =
          (Date.parse(`${event.gameDate}T00:00:00Z`) -
            Date.parse(`${snapshot.coverage.currentDay}T00:00:00Z`)) /
          dayMs;
        const day = offset === 0 && Date.parse(event.at) > Date.parse(asOf) ? 1 : offset;
        return {
          id: event.id,
          day,
          refs: event.refs.map(({ lawId, count }) => ({ lawId, count })),
        };
      })
      .filter((event) => event.day >= 1 && event.day <= file.common.horizonDays)
      .filter((event) => !received.has(event.id));
    const order = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(schedule.sort(order)).toEqual([...file.common.schedule].sort(order));
    expect(
      snapshot.events
        .filter((event) => event.gameDate === file.common.currentDay)
        .map((event) => event.id)
        .sort(),
    ).toEqual([...file.common.receivedEventIds].sort());
  });
});

describe("JSON probe (all_days=true) against the pinned oracle results", () => {
  let probe: (CertifiedMinimumWaitProbe & { id: string })[] = [];
  beforeAll(() => {
    const stdout = execFileSync(process.execPath, ["scripts/certified-minimum-wait-probe.ts"], {
      input: JSON.stringify(IDS.map((id) => ({ id, input: input(id) }))),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    probe = JSON.parse(stdout) as typeof probe;
    expect(probe.map((record) => record.id)).toEqual(IDS);
  }, 900_000);
  const record = (id: string) => {
    const value = probe.find((entry) => entry.id === id);
    if (!value) throw new Error(`missing probe record ${id}`);
    return value;
  };

  it.each(IDS)("%s: EXACT, batch, label and certificate flag", (id) => {
    const actual = record(id);
    const pin = expected(id);
    // NOTRUN never counts as a pass.
    expect([actual.status, actual.complete, actual.reason]).toEqual(["EXACT", true, null]);
    expect(actual.recommendation).toEqual({
      kit: pin.recommendation.kit,
      uses: pin.recommendation.uses,
    });
    expect(actual.label).toBe(pin.label);
    expect(actual.certificateApplies).toBe(pin.certificateApplies);
    expect(actual.supportUnitsCapped).toBe(false);
    const rates = actual.minimumWait?.mixedDailyRate;
    expect(rates?.map(reduced)).toEqual(pin.rates.map(reduced));
  });

  it.each(IDS)("%s: per-day supports and P-crossing sets", (id) => {
    const actual = record(id);
    const pin = expected(id);
    expect(actual.perDay.map((day) => day.day)).toEqual(pin.perDay.map((day) => day.day));
    pin.perDay.forEach((day, index) => {
      const mine = actual.perDay[index];
      if (!mine) throw new Error(`missing probe day ${day.day}`);
      expect([day.day, mine.crossing]).toEqual([day.day, day.crossing]);
      expect([day.day, unitSet(mine.supportUnits)]).toEqual([day.day, unitSet(day.supportUnits)]);
      expect([day.day, unitSet(mine.crossingUnits)]).toEqual([day.day, unitSet(day.crossingUnits)]);
    });
  });
});

describe("normal runtime path (all_days=false), label only", () => {
  it.each(IDS)(
    "%s: solveCertifiedWasm publishes the pinned batch and label",
    (id) => {
      const pin = expected(id);
      const output = solveCertifiedWasm(module, input(id));
      expect(output.refusal).toBeNull();
      const wait = output.minimumWait;
      if (!wait) throw new Error("missing minimumWait");
      // UNKNOWN (budget, coverage, guard) never counts as a pass.
      expect(["certified", "beyond_horizon"]).toContain(wait.status);
      const label = wait.status === "certified" ? wait.minimumDays : "7+";
      expect([output.current?.kit, output.current?.uses, wait.kit, wait.uses, label]).toEqual([
        pin.recommendation.kit,
        pin.recommendation.uses,
        pin.recommendation.kit,
        pin.recommendation.uses,
        pin.label,
      ]);
    },
    300_000,
  );

  /** Tie path: the product root must carry the pinned exact tie set, so its
   * minimum-wait stage evaluates the tied candidates. No reachable tie was found
   * where the first tied kit lacks the certificate (see the census in the oracle
   * spec), so the label/batch switch branch has no reachable case here. */
  it.each(TIE_IDS)("%s: the product root carries the pinned tie set", (id) => {
    const fixture = tieFile.fixtures.find((entry) => entry.id === id);
    const kits = fixture?.optimalKits ?? [];
    expect(kits.length).toBeGreaterThanOrEqual(2);
    const mask = kits.reduce(
      (bits, kit) => bits | (1 << ["blue", "purple", "yellow"].indexOf(kit)),
      0,
    );
    const output = solveCertifiedWasm(module, input(id));
    expect(output.current?.optimalActionMask).toBe(mask);
  });
});
