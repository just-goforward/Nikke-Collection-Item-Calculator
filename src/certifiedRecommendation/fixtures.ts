/**
 * Independent policy data, not solver evidence.
 *
 * Every policy vector specifies all fifteen dates. Expected decisions below
 * are handwritten from the stated fractions, never obtained from policy.ts.
 * B/C do not enter this policy. These constants are internal-policy examples,
 * not a user-selectable policy or a replacement for evidence admission.
 */
export interface FixtureQ {
  readonly numerator: string;
  readonly denominator: string;
}

export type ProbabilityVector = readonly [
  FixtureQ, FixtureQ, FixtureQ, FixtureQ, FixtureQ,
  FixtureQ, FixtureQ, FixtureQ, FixtureQ, FixtureQ,
  FixtureQ, FixtureQ, FixtureQ, FixtureQ, FixtureQ,
];

export type ExpectedDecision =
  | { readonly kind: "NOW"; readonly day: 0 }
  | { readonly kind: "WAIT"; readonly day: number };

export interface PolicyCase {
  readonly id: string;
  readonly probabilities: ProbabilityVector;
  readonly expected: ExpectedDecision;
  readonly handReason: string;
  readonly costMetadata?: {
    readonly days0Through13: { readonly B: FixtureQ; readonly C: FixtureQ };
    readonly day14: { readonly B: FixtureQ; readonly C: FixtureQ };
  };
}

export const fixtureQ = (numerator: string, denominator = "1"): FixtureQ => ({
  numerator,
  denominator,
});

const zero = fixtureQ("0");
const one = fixtureQ("1");
const half = fixtureQ("1", "2");
const now = { kind: "NOW", day: 0 } as const;
const wait = (day: number): ExpectedDecision => ({ kind: "WAIT", day });

export const examplePolicy = {
  lambda: fixtureQ("1", "400"),
  delta: fixtureQ("1", "200"),
} as const;

/** P0..P13 = first, P14 = last. */
function lastDay(first: FixtureQ, last: FixtureQ): ProbabilityVector {
  return [
    first, first, first, first, first,
    first, first, first, first, first,
    first, first, first, first, last,
  ];
}

/** P0 = current, P1..P14 = future. */
function afterToday(current: FixtureQ, future: FixtureQ): ProbabilityVector {
  return [
    current, future, future, future, future,
    future, future, future, future, future,
    future, future, future, future, future,
  ];
}

/** P0 = current, P1 = tomorrow, P2..P14 = plateau. */
function afterTomorrow(
  current: FixtureQ,
  tomorrow: FixtureQ,
  plateau: FixtureQ,
): ProbabilityVector {
  return [
    current, tomorrow, plateau, plateau, plateau,
    plateau, plateau, plateau, plateau, plateau,
    plateau, plateau, plateau, plateau, plateau,
  ];
}

const baseCases: readonly PolicyCase[] = [
  {
    id: "base-01-tiny",
    probabilities: lastDay(fixtureQ("4", "5"), fixtureQ("801", "1000")),
    expected: now,
    handReason: "W14 = 1/1000 - 14/400 = -34/1000; all future W < 0.",
  },
  {
    id: "base-02-late",
    probabilities: lastDay(fixtureQ("1", "5"), fixtureQ("4", "5")),
    expected: wait(14),
    handReason: "W14 = 3/5 - 14/400 = 113/200 > 1/200.",
  },
  {
    id: "base-03-near-one",
    probabilities: lastDay(fixtureQ("999", "1000"), one),
    expected: now,
    handReason: "W14 = 1/1000 - 14/400 < 0; earlier dates have no gain.",
  },
  {
    id: "base-04-low",
    probabilities: lastDay(fixtureQ("1", "100"), fixtureQ("1", "50")),
    expected: now,
    handReason: "W14 = 1/100 - 14/400 = -1/40.",
  },
  {
    id: "base-05-zero-to-3.5pp",
    probabilities: lastDay(zero, fixtureQ("7", "200")),
    expected: now,
    handReason: "W14 = 7/200 - 14/400 = 0; W0 = 0.",
  },
  {
    id: "base-06-high",
    probabilities: lastDay(fixtureQ("4", "5"), one),
    expected: wait(14),
    handReason: "W14 = 1/5 - 14/400 = 33/200 > 1/200.",
  },
  {
    id: "base-07-step",
    probabilities: [
      half, half, half, half, half,
      fixtureQ("13", "25"), fixtureQ("13", "25"), fixtureQ("13", "25"),
      fixtureQ("13", "25"), fixtureQ("13", "25"), fixtureQ("13", "25"),
      fixtureQ("13", "25"), fixtureQ("13", "25"), fixtureQ("13", "25"),
      fixtureQ("27", "50"),
    ],
    expected: wait(5),
    handReason: "W5 = 1/50 - 5/400 = 3/400; W14 = 1/25 - 14/400 = 1/200.",
  },
  {
    id: "base-08-all-one",
    probabilities: lastDay(one, one),
    expected: now,
    handReason: "Every future Wd = -d/400.",
  },
  {
    id: "base-09-all-zero",
    probabilities: lastDay(zero, zero),
    expected: now,
    handReason: "Every future Wd = -d/400; NOW is not an actionability claim.",
  },
  {
    id: "base-10-old-score-tie",
    probabilities: afterToday(half, fixtureQ("201", "400")),
    expected: now,
    handReason: "W1 = 201/400 - 1/2 - 1/400 = 0.",
  },
  {
    id: "base-11-cost-metadata-irrelevant",
    probabilities: lastDay(fixtureQ("4", "5"), fixtureQ("4", "5")),
    expected: now,
    handReason: "Every future Wd = -d/400 regardless of improving B/C metadata.",
    costMetadata: {
      days0Through13: { B: fixtureQ("10"), C: fixtureQ("100") },
      day14: { B: fixtureQ("1"), C: fixtureQ("10") },
    },
  },
  {
    id: "base-12-extremely-low",
    probabilities: lastDay(fixtureQ("1", "1000000"), fixtureQ("2", "1000000")),
    expected: now,
    handReason: "W14 = 1/1000000 - 14/400 < 0.",
  },
  {
    id: "base-13-zero-to-tiny",
    probabilities: lastDay(zero, fixtureQ("1", "1000000")),
    expected: now,
    handReason: "W14 = 1/1000000 - 14/400 < 0.",
  },
  {
    id: "base-14-mid",
    probabilities: [
      fixtureQ("1", "5"), fixtureQ("1", "5"), fixtureQ("1", "5"),
      fixtureQ("1", "5"), fixtureQ("1", "5"), fixtureQ("1", "5"),
      fixtureQ("1", "5"),
      fixtureQ("4", "5"), fixtureQ("4", "5"), fixtureQ("4", "5"),
      fixtureQ("4", "5"), fixtureQ("4", "5"), fixtureQ("4", "5"),
      fixtureQ("4", "5"), fixtureQ("4", "5"),
    ],
    expected: wait(7),
    handReason: "W7 = 3/5 - 7/400 = 233/400; the later plateau costs more.",
  },
];

const oldBoundaryCases: readonly PolicyCase[] = [
  {
    id: "old-absolute-minus-eta",
    probabilities: lastDay(fixtureQ("779999", "1000000"), fixtureQ("4", "5")),
    expected: now,
    handReason: "W14 = -14999/1000000 < 0.",
  },
  {
    id: "old-absolute-equality",
    probabilities: lastDay(fixtureQ("39", "50"), fixtureQ("4", "5")),
    expected: now,
    handReason: "W14 = -3/200 < 0.",
  },
  {
    id: "old-absolute-plus-eta",
    probabilities: lastDay(fixtureQ("780001", "1000000"), fixtureQ("4", "5")),
    expected: now,
    handReason: "W14 = -15001/1000000 < 0.",
  },
  {
    id: "old-relative-minus-eta",
    probabilities: lastDay(fixtureQ("8999", "1000000"), fixtureQ("1", "100")),
    expected: now,
    handReason: "W14 = -33999/1000000 < 0.",
  },
  {
    id: "old-relative-equality",
    probabilities: lastDay(fixtureQ("9", "1000"), fixtureQ("1", "100")),
    expected: now,
    handReason: "W14 = -34/1000 < 0.",
  },
  {
    id: "old-relative-plus-eta",
    probabilities: lastDay(fixtureQ("9001", "1000000"), fixtureQ("1", "100")),
    expected: now,
    handReason: "W14 = -34001/1000000 < 0.",
  },
  {
    id: "old-score-minus-eta",
    probabilities: afterToday(half, fixtureQ("502499", "1000000")),
    expected: now,
    handReason: "W1 = -1/1000000 < 1/200; later W is smaller.",
  },
  {
    id: "old-score-equality",
    probabilities: afterToday(half, fixtureQ("201", "400")),
    expected: now,
    handReason: "W1 = 0 < 1/200; later W is smaller.",
  },
  {
    id: "old-score-plus-eta",
    probabilities: afterToday(half, fixtureQ("502501", "1000000")),
    expected: now,
    handReason: "W1 = 1/1000000 < 1/200; later W is smaller.",
  },
];

const deltaBoundaryCases: readonly PolicyCase[] = [
  {
    id: "delta-minus-eta",
    probabilities: afterToday(half, fixtureQ("507499", "1000000")),
    expected: now,
    handReason: "W1 = 4999/1000000 < 1/200.",
  },
  {
    id: "delta-equality",
    probabilities: afterToday(half, fixtureQ("203", "400")),
    expected: now,
    handReason: "W1 = 1/200 exactly; score1 = score0, so NOW wins.",
  },
  {
    id: "delta-plus-eta",
    probabilities: afterToday(half, fixtureQ("507501", "1000000")),
    expected: wait(1),
    handReason: "W1 = 5001/1000000 > 1/200; later W is smaller.",
  },
];

/** The requested 14 + 9 + 3 inventory; repeated vectors are intentional. */
export const exactPolicyCases: readonly PolicyCase[] = [
  ...baseCases,
  ...oldBoundaryCases,
  ...deltaBoundaryCases,
];

export const narrowPolicyCases: readonly PolicyCase[] = [
  {
    id: "first-delta-crossing-is-not-global-max",
    probabilities: afterTomorrow(half, fixtureQ("508", "1000"), fixtureQ("515", "1000")),
    expected: wait(2),
    handReason: "W1 = 11/2000 > delta, but W2 = 1/100 is strictly larger.",
  },
  {
    id: "positive-future-W-tie-earlier",
    probabilities: afterTomorrow(half, fixtureQ("51", "100"), fixtureQ("41", "80")),
    expected: wait(1),
    handReason: "W1 = W2 = 3/400 > delta; all later W is smaller.",
  },
  {
    id: "WAIT-3.25pp-sharp-and-positive-tie",
    probabilities: [
      zero,
      fixtureQ("7501", "1000000"), fixtureQ("7501", "1000000"),
      fixtureQ("7501", "1000000"), fixtureQ("7501", "1000000"),
      fixtureQ("7501", "1000000"), fixtureQ("7501", "1000000"),
      fixtureQ("7501", "1000000"), fixtureQ("7501", "1000000"),
      fixtureQ("7501", "1000000"), fixtureQ("7501", "1000000"),
      fixtureQ("7501", "1000000"), fixtureQ("7501", "1000000"),
      fixtureQ("7501", "1000000"), fixtureQ("40001", "1000000"),
    ],
    expected: wait(1),
    handReason: "W1 = W14 = 5001/1000000 > delta; P14 - P1 = 13/400 (3.25pp).",
  },
  {
    id: "NOW-4pp-sharp-equality",
    probabilities: lastDay(fixtureQ("24", "25"), one),
    expected: now,
    handReason: "P14 - P0 = 1/25 (4pp); W14 = 1/200 exactly.",
  },
  {
    id: "NOW-zero-to-4pp-does-not-imply-actionable",
    probabilities: lastDay(zero, fixtureQ("1", "25")),
    expected: now,
    handReason: "W14 = 1/200 exactly; actionability must be supplied separately.",
  },
  {
    id: "reset-original-request",
    probabilities: afterTomorrow(half, fixtureQ("2537", "5000"), fixtureQ("511", "1000")),
    expected: wait(2),
    handReason: "W1 = 49/10000 <= delta; W2 = 3/500 > delta.",
  },
  {
    id: "reset-next-day-request",
    probabilities: afterToday(fixtureQ("2537", "5000"), fixtureQ("511", "1000")),
    expected: now,
    handReason: "New W1 = 11/10000 <= delta; NOW is original day1, not original day2.",
  },
];

/**
 * Independent score oracle: integer common-denominator scores, not the
 * production W selector, production rational helpers, or expected-data builder.
 * The product is an exact common denominator (not necessarily the least one).
 * Strict improvement while traversing dates in order gives NOW/earlier ties.
 * This is defined only for these valid, complete probability vectors.
 */
export function independentScoreDecision(
  probabilities: ProbabilityVector,
): ExpectedDecision {
  const scale = probabilities.reduce(
    (product, probability) => product * BigInt(probability.denominator),
    400n,
  );
  const scores = probabilities.map((probability, day) => {
    const probabilityUnits =
      BigInt(probability.numerator) * (scale / BigInt(probability.denominator));
    return day === 0
      ? probabilityUnits
      : probabilityUnits - BigInt(day) * (scale / 400n) - scale / 200n;
  });
  let bestDay = 0;
  let bestScore = scores[0]!;
  for (let day = 1; day <= 14; day++) {
    const score = scores[day]!;
    if (score > bestScore) {
      bestDay = day;
      bestScore = score;
    }
  }
  return bestDay === 0 ? now : wait(bestDay);
}

/**
 * Actual saved observations, NOT admissible F proofs.
 *
 * Source locations are relative to the named historical capture directory;
 * there is no dependency on its original machine-specific absolute path.
 * Hashes below were read from the source, except rawSha256, which was computed
 * over the saved raw file bytes. No context hash or proof has been fabricated.
 * Exact model material / proof admission must use the settled evidence API;
 * neither these hashes nor the old waiting.evidence strings establish truth.
 */
const observedEngine = {
  baseline: "fd211095dc95e795c7aeb871de54d7ab958e7ccf",
  sourceHash: "a2a9327944ff2a6bf326847773646b6fc950db6d240420c14184346e0c6b857b",
  codeHash: "b66808e3f6fa127f7bec86928a2e5d2f2ca05a2e83856150c46a60e994a719c7",
  actualWasmHash: "74862d1b92fe131878a9e027665097501ebad80dcd5e699dfe5d11c9da094498",
} as const;

const observedModel = {
  version: "certified-daily-v3",
  revision: "supply-2026-10-15-v3:4047dfaf56307763",
  sourceHash: "4047dfaf563077639ef98a947af97cf0a2e252ca421983e1353079a24b86c302",
  futureLawSemantics: "independent_given_cohort-v1",
} as const;

const observedWeights = [
  fixtureQ("1", "7"),
  fixtureQ("2", "7"),
  fixtureQ("3", "7"),
  fixtureQ("1", "7"),
] as const;

export const savedObservations = {
  hard: {
    kind: "historical-observation-not-proof",
    sourceCapture: "target-v1-check-NY7KKg",
    sourceFile: "hard/raw.json",
    rawSha256: "9ecaa5ecb3758fd17633ecf25e3f894fc6acb9ec9f3306685102028092ac7a61",
    requestHash: "1e8cf3148543945b4dbd1b9824dd6a530a609b78b7c34a4dfae9efb6bd984946",
    receiptHash: "b8a5cc5ddfcd2202b4e24cea249af26251a79800e0c2fab9d94c501eb906fe7e",
    engine: observedEngine,
    model: observedModel,
    state: {
      asOf: "2026-10-19T20:00:00.000Z",
      snapshotAsOf: "2026-10-19T20:00:00.000Z",
      grade: "SR",
      level: 14,
      exp: 1600,
      stock: [66, 3, 1],
      batchLimit: 10,
      cohortWeights: observedWeights,
      receivedEventIds: ["dispatch:2026-10-20", "shop:2026-10-20"],
    },
    capturedProbabilities: [
      { day: 0, successP: fixtureQ("468559", "1000000") },
      { day: 1, successP: one },
    ],
    currentAction: { status: "use_certified", kit: "blue", uses: 6, pieces: 60, optimalActionMask: 1 },
    waiting: {
      status: "certified",
      evaluatedDays: [0, 1],
      recommendedDays: 1,
      rangeBoundary: false,
      valueSuccessP: one,
      successProbabilityInterval: { lower: one, upper: one },
      successImprovementUpperBound: zero,
    },
    expectedIfBoundEvidenceAdmitted: wait(1),
    handW1: fixtureQ("528941", "1000000"),
    handReason: "W1 = 1 - 468559/1000000 - 1/400 = 528941/1000000 (52.8941pp).",
  },
  boundary: {
    kind: "historical-observation-not-proof",
    sourceCapture: "target-v1-check-NY7KKg",
    sourceFile: "boundary/raw.json",
    rawSha256: "757d3ed24e9031761e46fdf54d3db87a3b0eacb8f47bd031148583d91e284fbe",
    requestHash: "aa84eff4ea0ff02e7fe07bfda878a1de1f90a06d46395d1f539e89dc3a3093e4",
    receiptHash: "08bd51f0c4fc0f84e0530c27f5cc11fc37cd0e58be5802a6c34be75b61edd024",
    engine: observedEngine,
    model: observedModel,
    state: {
      asOf: "2026-10-20T20:00:00.000Z",
      snapshotAsOf: "2026-10-20T20:00:00.000Z",
      grade: "SR",
      level: 14,
      exp: 0,
      stock: [72, 29, 5],
      batchLimit: 10,
      cohortWeights: observedWeights,
      receivedEventIds: ["dispatch:2026-10-21", "weekly-kits:2026-10-21"],
    },
    capturedProbabilities: [
      { day: 0, successP: fixtureQ("3421260751", "4000000000") },
    ],
    currentAction: { status: "use_certified", kit: "purple", uses: 2, pieces: 20, optimalActionMask: 2 },
    waiting: {
      status: "certified",
      evaluatedDays: [0],
      recommendedDays: 14,
      rangeBoundary: true,
      valueSuccessP: null,
      successProbabilityInterval: {
        lower: fixtureQ("3421260751", "4000000000"),
        upper: one,
      },
      successImprovementUpperBound: fixtureQ("578739249", "4000000000"),
    },
    handReason: "Only D0 = 0.85531518775 was captured; witness14 does not supply dates1..14.",
  },
} as const;
