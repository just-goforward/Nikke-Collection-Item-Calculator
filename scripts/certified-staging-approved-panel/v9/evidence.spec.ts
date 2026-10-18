import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { assertTrustedCertifiedForecast } from "../../../src/lib/certifiedForecastTrust.ts";
import {
  add,
  approx,
  cmp,
  type ExactQ,
  mul,
  type QTriple,
  q,
  wire,
} from "../../certified-staging-oracle.ts";
import {
  independentVersionedPricing,
  priceFourCohortSupply,
} from "../../certified-staging-oracle-four-cohort-pricing.ts";
import { normalizeExact } from "../v6/evidence.ts";
import { sha256 } from "../v6/history.ts";
import { readV7Evidence } from "../v7/evidence.ts";
import { V8_PINS_SHA } from "../v8/anchor.ts";
import { panelPriors } from "../v8/calculate.ts";
import {
  COHORT_MIGRATION,
  POPULATION,
  RULE_ID,
  readV8Evidence,
  receivedEventIds,
  V8_ROOT,
  validateFourCohorts,
  WEEKLY_LAW_ID,
} from "../v8/evidence.ts";
import {
  BOARD_SLOTS,
  independentBoardDistributions,
  independentFourCohorts,
} from "../v8/physical.ts";
import { prepareSnapshot, V8_AS_OF } from "../v8/snapshot.ts";
import {
  ANCHOR_FILE,
  ARCHIVE_FILES,
  EVIDENCE_FILES,
  type EvidenceProvenance,
  GENERATION_SOURCES,
  PUBLICATION_FILES,
  readV9Evidence,
  V9_ROOT,
} from "./evidence.ts";
import { generatePublication } from "./generate.ts";
import { loadIndependentApprovedPanel } from "./panel.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
let boards: ReturnType<typeof independentBoardDistributions> | undefined;
const distributions = () => {
  boards ??= independentBoardDistributions();
  return boards;
};
let cohorts: ReturnType<typeof independentFourCohorts> | undefined;
const fourCohorts = () => {
  cohorts ??= independentFourCohorts(distributions());
  return cohorts;
};
const sum = (values: readonly ExactQ[]) => values.reduce(add, q(0));
const neg = (value: ExactQ) => q(-value.n, value.d);
/** Product-free pricing inputs: the sealed v7 v2 snapshot and the same rule data
 * moved to the public v3 contract (weekly fixed grant, schedule-kit-v3 rule). */
function pricingSnapshots() {
  const v2 = readV7Evidence().snapshot;
  const [rule] = v2.rules;
  if (!rule) throw new Error("missing rule");
  const v3: CertifiedSupplySnapshot = {
    ...v2,
    version: "certified-daily-v3",
    rules: [{ ...rule, id: RULE_ID, weeklyFixed: [{ lawId: WEEKLY_LAW_ID, count: 1 }] }],
  };
  return { v2, v3 };
}

describe("independent four-cohort physical supply", () => {
  it("gives every reroll cohort a full-board distribution of exact mass 1", () => {
    const rounds = distributions();
    expect(rounds).toHaveLength(4);
    for (const round of rounds) {
      expect(cmp(sum(round.map((board) => board.mass)), q(1))).toBe(0);
      for (const board of round) {
        expect(board.counts.reduce((total, count) => total + count, 0)).toBe(BOARD_SLOTS);
        expect(Math.max(...board.counts)).toBeLessThanOrEqual(4);
        expect(board.mass.n > 0n).toBe(true);
      }
    }
  }, 120_000);

  it("matches exact small-case draw probabilities without replacement", () => {
    const [cohort0] = distributions();
    const mass = (counts: readonly number[]) =>
      cohort0?.find((board) => board.counts.join(",") === counts.join(","))?.mass;
    const only = (klass: number, count: number) =>
      Array.from({ length: 14 }, (_, index) => (index === klass ? count : 0));
    // Class 5 (per-card weight 2 of 400): all four copies drawn in a row.
    expect(mass(only(5, 4))).toEqual(q(8 * 6 * 4 * 2, 400 * 398 * 396 * 394));
    // Class 0 (per-card weight 15): 60/400 * 45/385 * 30/370 * 15/355.
    expect(mass(only(0, 4))).toEqual(q(60 * 45 * 30 * 15, 400 * 385 * 370 * 355));
  }, 120_000);

  it("reproduces the oracle targets and both sealed independent references exactly", () => {
    const [c0, c1, c2, c3] = fourCohorts();
    const targets = [
      [8.175245784822762, 1.36454659174132, 0.459024458516156],
      [9.05704314456469, 2.102280174069004, 0.748168058537295],
      [9.609910117853358, 2.576813704937052, 0.935431962184824],
      [9.966514778612282, 2.888196645234681, 1.058874332768239],
    ];
    for (const [index, cohort] of [c0, c1, c2, c3].entries())
      for (const [color, value] of cohort.entries())
        expect(approx(value)).toBeCloseTo(targets[index]?.[color] ?? Number.NaN, 12);
    expect(() =>
      validateFourCohorts([c0, c1, c2, c3].map((cohort) => cohort.map(wire)) as never),
    ).not.toThrow();
    const D = ([0, 1, 2] as const).map((color) =>
      mul(q(1, 7), sum([c0[color], mul(q(2), c1[color]), mul(q(3), c2[color]), c3[color]])),
    );
    expect(D.map(approx)).toEqual([
      expect.closeTo(9.297939600874928, 12),
      expect.closeTo(2.312534957132167, 12),
      expect.closeTo(0.831504399273351, 12),
    ]);
  }, 120_000);
});

describe("independent v3 four-cohort pricing", () => {
  it("adds exactly (10/7,10/7,0) for the Wednesday weekly grant and keeps v2 pricing", () => {
    const { v2, v3 } = pricingSnapshots();
    const fresh = fourCohorts();
    const rate3 = priceFourCohortSupply(v3, POPULATION, fresh);
    const rate2 = priceFourCohortSupply(v2, POPULATION, fresh);
    expect(rate3.map((value, color) => add(value, neg(rate2[color] as ExactQ)))).toEqual([
      q(10, 7),
      q(10, 7),
      q(0),
    ]);
    expect(v3.cadence).toMatchObject({ numerator: 1197, denominator: 39 });
    expect(rate3.map(approx)).toEqual([
      expect.closeTo(22.2320248, 6),
      expect.closeTo(5.0172969, 6),
      expect.closeTo(1.4174693, 6),
    ]);
    // Normal shop 5 box II = (35/2, 2, 1); solo 16 regular + 68 box II over 1197/39 days.
    const common: QTriple = [
      add(mul(q(35, 2), q(1, 7)), mul(q(1382, 5), q(39, 1197))),
      add(mul(q(2), q(1, 7)), mul(q(152, 5), q(39, 1197))),
      add(mul(q(1), q(1, 7)), mul(q(68, 5), q(39, 1197))),
    ];
    for (const color of [0, 1, 2] as const) {
      const dispatch = sum(
        POPULATION.map((prior, cohort) => mul(prior, fresh[cohort]?.[color] as ExactQ)),
      );
      expect(rate2[color]).toEqual(add(common[color], dispatch));
    }
    expect(rate2.map(approx)).toEqual([
      expect.closeTo(20.80345338533608, 10),
      expect.closeTo(3.588725433322643, 10),
      expect.closeTo(1.4174693115540526, 10),
    ]);
    // The authenticated adapter (sealed v6 + pinned cohort 3) agrees exactly.
    expect(independentVersionedPricing(v3, POPULATION)).toEqual(rate3);
    expect(independentVersionedPricing(v2, POPULATION)).toEqual(rate2);
  }, 120_000);

  it("refuses inputs outside the documented v3 contract", () => {
    const { v2, v3 } = pricingSnapshots();
    const [rule] = v3.rules;
    if (!rule) throw new Error("missing rule");
    const variants: CertifiedSupplySnapshot[] = [
      { ...v3, rules: [{ ...rule, weeklyFixed: [{ lawId: "deterministic:10,10,1", count: 1 }] }] },
      { ...v3, rules: [{ ...rule, weeklyFixed: [{ lawId: WEEKLY_LAW_ID, count: 2 }] }] },
      { ...v3, rules: [{ ...rule, id: "schedule-kit-v2:documented-physical-supply-v2" }] },
      {
        ...v3,
        laws: [
          ...v3.laws,
          {
            id: "dispatch-board-v1",
            kind: "finite",
            modelVersion: "documented-physical-supply-v2",
            outcomes: [{ pieces: [0, 0, 0], mass: wire(q(1)) }],
          },
        ],
      },
      { ...v2, rules: [{ ...rule, id: v2.rules[0]?.id ?? "" }] },
    ];
    for (const snapshot of variants)
      expect(() => independentVersionedPricing(snapshot, POPULATION)).toThrow();
  });

  it("assigns positive cohort-3 mass to every approved row", () => {
    for (let position = 0; position < 24; position += 1) {
      const priors = panelPriors(position, [q(1, 3), q(1, 3), q(1, 3)]);
      expect(cmp(priors[3], q(0))).toBe(1);
      expect(sum(priors)).toEqual(q(1));
    }
  });

  it("keeps product reconstruction outside the independent calculation closure", async () => {
    const result = await build({
      entryPoints: [`${V9_ROOT}/calculate.ts`],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    // The only non-generation input is the reviewed anchor, which holds nothing but
    // the tracked pins digest and so cannot influence a calculated expectation.
    expect(inputs.filter((path) => !GENERATION_SOURCES.includes(path))).toEqual([ANCHOR_FILE]);
    const anchor = readFileSync(ANCHOR_FILE, "utf8").replace(/^(\/\*\*?[\s\S]*?\*\/\n)/, "");
    expect(anchor).toMatch(/^export const V9_PINS_SHA = "[a-f0-9]{64}";\n$/);
    expect(inputs.filter((path) => path.startsWith("src/"))).toEqual([]);
    expect(inputs.filter((path) => path.startsWith("shared/"))).toEqual(["shared/game.ts"]);
    expect(inputs).not.toContain("scripts/certified-staging-approved-panel/v8/snapshot.ts");
    expect(inputs).not.toContain("scripts/certified-staging-oracle-physical-supply.ts");
  });
});

describe("v9 publication pipeline (disposable root, product input)", () => {
  let root = "";
  let rootPins = "";
  let input: CertifiedSupplySnapshot | undefined;
  it("prepares a trusted Wednesday approved input from product code", async () => {
    const { snapshot } = await prepareSnapshot();
    input = snapshot;
    expect(snapshot.asOf).toBe(V8_AS_OF);
    // Wednesday 17:00 KST: that day's 05:00 KST weekly grant has been received.
    expect(new Date(Date.parse(V8_AS_OF) + 9 * 3_600_000).getUTCDay()).toBe(3);
    expect(receivedEventIds(snapshot)).toContain(`weekly-kits:${snapshot.coverage.currentDay}`);
    expect(snapshot.coverage.future.days).toBeGreaterThanOrEqual(56);
    expect(snapshot.coverage.future.complete).toBe(true);
    await expect(assertTrustedCertifiedForecast(snapshot, () => {})).resolves.toBeDefined();
  }, 120_000);

  it("generates, authenticates and independently regenerates a complete v9 publication", async () => {
    root = mkdtempSync(resolve(tmpdir(), "approved24-v9-disposable-"));
    roots.push(root);
    for (const path of EVIDENCE_FILES.filter((path) => !PUBLICATION_FILES.includes(path))) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      copyFileSync(path, resolve(root, path));
    }
    expect(existsSync(resolve(root, V9_ROOT, "calculate.ts"))).toBe(true);
    // Generation forbids inherited Node options/loaders, so it runs as a clean child.
    execFileSync(process.execPath, [`${V9_ROOT}/generate.ts`, root], {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|PATH)$/i.test(key),
        ),
      ),
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const provenance = JSON.parse(
      readFileSync(resolve(root, V9_ROOT, "provenance.json"), "utf8"),
    ) as EvidenceProvenance;
    for (const { path } of provenance.snapshot.sources) {
      if (existsSync(resolve(root, path))) continue;
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      copyFileSync(path, resolve(root, path));
    }
    rootPins = sha256(readFileSync(resolve(root, V9_ROOT, "pins.json")));
    // A fresh publication is never the reviewed tracked one.
    expect(() => readV9Evidence(root)).toThrow();
    const evidence = readV9Evidence(root, rootPins);
    expect(evidence.snapshot).toEqual(input);
    expect(evidence.provenance.generation.independentWaiting).toBe("UNVERIFIED_NOT_REGENERATED");
    const rows = evidence.panel as { expected: { cohortWeights: ReturnType<typeof wire>[] } }[];
    for (const row of rows) expect(row.expected.cohortWeights[3]?.numerator).not.toBe("0");
    await expect(generatePublication(root)).rejects.toThrow("Refusing to replace sealed evidence");
  }, 600_000);

  it.each([
    "snapshot.json",
    "panel.json",
    "independent-physical-cohorts.json",
    "provenance.json",
    "pins.json",
    "calculate.ts",
  ])("rejects changed %s bytes in the disposable publication", (name) => {
    expect(root).not.toBe("");
    const mutated = mkdtempSync(resolve(tmpdir(), "approved24-v9-mutation-"));
    roots.push(mutated);
    const provenance = readV9Evidence(root, rootPins).provenance;
    for (const path of new Set([
      ...EVIDENCE_FILES,
      ...provenance.snapshot.sources.map(({ path }) => path),
    ])) {
      mkdirSync(dirname(resolve(mutated, path)), { recursive: true });
      copyFileSync(resolve(root, path), resolve(mutated, path));
    }
    expect(readV9Evidence(mutated, rootPins).panel).toHaveLength(24);
    writeFileSync(resolve(mutated, V9_ROOT, name), "changed");
    expect(() => readV9Evidence(mutated, rootPins)).toThrow();
  });
});

describe("tracked v9 publication", () => {
  it("checks every archived source against its unchanged pinned sha256", () => {
    const { provenance } = readV9Evidence();
    const sources = [...provenance.generation.sources, ...provenance.snapshot.sources];
    expect(ARCHIVE_FILES).toHaveLength(sources.length);
    for (const source of sources)
      expect(sha256(readFileSync(`${V9_ROOT}/source/${source.path}.txt`))).toBe(source.sha256);
  });
  it("authenticates and exactly regenerates the tracked v3 approved24 expectations", () => {
    const panel = loadIndependentApprovedPanel();
    expect(panel).toHaveLength(24);
    const { physical, provenance } = readV9Evidence();
    expect(normalizeExact(physical.population)).toEqual(normalizeExact(POPULATION.map(wire)));
    expect(sha256(readFileSync("scripts/certified-staging-approved-panel/v8/pins.json"))).toBe(
      provenance.historical.v8PinsSha256,
    );
    expect(provenance.historical).toEqual({
      v8PinsSha256: V8_PINS_SHA,
      cohortMigration: COHORT_MIGRATION,
    });
  }, 300_000);

  it("refuses to overwrite the tracked publication", async () => {
    await expect(generatePublication()).rejects.toThrow("Refusing to replace sealed evidence");
  });
});

it("keeps the approved input, panel and physical supply identical to sealed v8", () => {
  // Both publications are authenticated through their pins before bytes are compared.
  const v8 = readV8Evidence();
  const v9 = readV9Evidence();
  for (const name of ["snapshot.json", "panel.json"])
    expect(readFileSync(`${V9_ROOT}/${name}`).equals(readFileSync(`${V8_ROOT}/${name}`))).toBe(
      true,
    );
  expect(v9.physical.cohorts).toEqual(v8.physical.cohorts);
  expect(v9.physical.population).toEqual(v8.physical.population);
  expect(v9.physical.rate).toEqual(v8.physical.rate);
});
