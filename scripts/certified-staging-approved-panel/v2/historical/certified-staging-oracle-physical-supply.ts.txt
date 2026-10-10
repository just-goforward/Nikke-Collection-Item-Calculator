import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  add,
  cmp,
  type ExactQ,
  fromWire,
  makeTriple,
  mapTriple,
  mul,
  type QTriple,
  q,
  wire,
} from "./certified-staging-oracle.ts";

/** Independently written exhaustive ordered-draw dispatch histories, followed by
 * exact box expectations. No candidate supply/rational/enumeration imports. */
const CLASSES = [
  { weight: 15, keep: false, gain: [q(2), q(0), q(0)] },
  { weight: 15, keep: false, gain: [q(3), q(0), q(0)] },
  { weight: 6, keep: true, gain: [q(0), q(2), q(0)] },
  { weight: 3, keep: true, gain: [q(0), q(3), q(0)] },
  { weight: 4, keep: true, gain: [q(0), q(0), q(1)] },
  { weight: 2, keep: true, gain: [q(0), q(0), q(2)] },
  { weight: 15, keep: false, gain: [q(12, 5), q(1, 5), q(0)] },
  { weight: 8, keep: true, gain: [q(24, 5), q(2, 5), q(0)] },
  { weight: 8, keep: true, gain: [q(7, 2), q(2, 5), q(1, 5)] },
  { weight: 4, keep: true, gain: [q(7), q(4, 5), q(2, 5)] },
  { weight: 3, keep: false, gain: [q(0), q(0), q(0)] },
  { weight: 7, keep: false, gain: [q(0), q(0), q(0)] },
  { weight: 7, keep: false, gain: [q(0), q(0), q(0)] },
  { weight: 3, keep: false, gain: [q(0), q(0), q(0)] },
] as const;
type Board = { counts: readonly number[]; mass: ExactQ };
export function independentDispatchExpectations(): readonly [QTriple, QTriple, QTriple] {
  let retained: Board[] = [{ counts: CLASSES.map(() => 0), mass: q(1) }];
  const result: QTriple[] = [];
  for (let round = 0; round <= 2; round += 1) {
    const expectation: [ExactQ, ExactQ, ExactQ] = [q(0), q(0), q(0)];
    const next = new Map<string, Board>();
    let roundMass = q(0);
    for (const prior of retained) {
      const counts = [...prior.counts];
      const drawCount = 4 - counts.reduce((sum, count) => sum + count, 0);
      const ordered = (remaining: number, probability: ExactQ) => {
        if (remaining === 0) {
          roundMass = add(roundMass, probability);
          for (let color = 0; color < 3; color += 1) {
            let conditional = q(0);
            for (let klass = 0; klass < CLASSES.length; klass += 1)
              conditional = add(conditional, mul(q(counts[klass]!), CLASSES[klass]!.gain[color]!));
            expectation[color] = add(expectation[color]!, mul(probability, conditional));
          }
          const kept = counts.map((count, klass) => (CLASSES[klass]!.keep ? count : 0));
          const key = kept.join(",");
          const previous = next.get(key);
          next.set(key, {
            counts: kept,
            mass: previous ? add(previous.mass, probability) : probability,
          });
          return;
        }
        const totalWeight = CLASSES.reduce(
          (sum, klass, index) => sum + (4 - counts[index]!) * klass.weight,
          0,
        );
        for (let klass = 0; klass < CLASSES.length; klass += 1) {
          const weight = (4 - counts[klass]!) * CLASSES[klass]!.weight;
          if (weight === 0) continue;
          counts[klass] = counts[klass]! + 1;
          ordered(remaining - 1, mul(probability, q(weight, totalWeight)));
          counts[klass] = counts[klass]! - 1;
        }
      };
      ordered(drawCount, prior.mass);
    }
    if (cmp(roundMass, q(1)) !== 0)
      throw new Error("Independent ordered dispatch histories do not have mass1");
    result.push(expectation);
    retained = [...next.values()];
  }
  return [result[0]!, result[1]!, result[2]!];
}
const path = "benchmarks/results/certified-staging-validation-independent-physical-rates.json";
let memoizedRates: QTriple | null = null;
function sourceIdentity() {
  const sources = [
    "scripts/certified-staging-oracle-physical-supply.ts",
    "scripts/certified-staging-oracle.ts",
  ].map((source) => ({
    path: source,
    sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
  }));
  return { sources, hash: createHash("sha256").update(JSON.stringify(sources)).digest("hex") };
}
export function independentPhysicalRecurringRates(): QTriple {
  if (memoizedRates) return memoizedRates;
  const identity = sourceIdentity();
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as {
      sourceHash: string;
      rate: readonly [ReturnType<typeof wire>, ReturnType<typeof wire>, ReturnType<typeof wire>];
    };
    if (cached.sourceHash === identity.hash) {
      memoizedRates = mapTriple(cached.rate, fromWire);
      return memoizedRates;
    }
  }
  const started = performance.now();
  const cohorts = independentDispatchExpectations();
  // Normal weekly shop:5 boxII. Seven raid days:16 regular +68 boxII.
  const shop = [q(35, 2), q(2), q(1)] as const;
  const solo = [q(1382, 5), q(152, 5), q(68, 5)] as const;
  const rate = makeTriple((color) => {
    const dispatch = cohorts.reduce((sum, cohort) => add(sum, mul(q(1, 3), cohort[color]!)), q(0));
    return add(add(dispatch, mul(shop[color]!, q(1, 7))), mul(solo[color]!, q(39, 1197)));
  });
  writeFileSync(
    path,
    `${JSON.stringify({ version: "independent-ordered-physical-supply-rates-v1", generatedAt: new Date().toISOString(), sourceHash: identity.hash, sources: identity.sources, interpretation: "documented modeled physical odds; exhaustive ordered weighted-without-replacement card draws, fixed latent0/1/2-reroll cohort, regular/II box exactmeans, weekly5II, raid7days/1197-over39", cohorts: cohorts.map((cohort) => cohort.map(wire)), rate: rate.map(wire), computeMs: performance.now() - started }, null, 2)}\n`,
  );
  memoizedRates = rate;
  return rate;
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("certified-staging-oracle-physical-supply.ts")) {
  const rates = independentPhysicalRecurringRates();
  console.log(
    JSON.stringify({
      report: path,
      approximateRates: rates.map((rate) => Number((rate.n * 1_000_000_000_000n) / rate.d) / 1e12),
    }),
  );
}
