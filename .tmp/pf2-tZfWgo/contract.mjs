// PF2 temporary-only candidate contract; only the approved runner invocation releases execution.
// No evaluator, estimator, or product module is imported by this file.
export const HEAD = "80260350a715f09300366f38fbe96cf025c1636c";
export const NODE_VERSION = "v24.21.0";
export const WORK_CAP = 73135;
export const TABLE_PEAK_CAP = 900;
export const CALL_CAP = 13;
export const WINDOW_MS = 5000;
export const HEAP_CAP_MIB = 256;
// Pending runtime pinning by a separately approved Lead probe.
export const OOM_BANNER_SUBSTRING = "JavaScript heap out of memory";
export const HELPER_MAX_LOGICAL_BYTES = 160 * 1024 * 1024;
export const RELEASE_GATES = Object.freeze({
  executionReleasedByLead: true,
  supervisorAndAtomicPublicationReviewed: true,
});
export const FIXTURE = "scripts/certified-staging-oracle-fixtures/large-current-R1000.json.txt";
export const FIXTURE_SHA = "5b478ab1a16a4f8774a82ffeaba662cbcf168b8453d83ade08bcf18b280bddb4";

// These are exact source/metadata pins, not candidate-generated expectations.
export const PINS = Object.freeze([
  ["scripts/certified-staging-oracle-public-layered-feasibility.ts", 21820, "0972352241456f54300e88d022213031b23d3cbff234c0453be8330ede429ba4"],
  ["scripts/certified-staging-oracle.ts", 12244, "44169b169bb1487ce952ba6026b697654f541a234384fed4964fe1aa9f43a69f"],
  ["scripts/certified-staging-oracle-tuples.ts", 520, "d20f932934a9de5ec416a22b1d1b04097f279e32373431880db353546f4a0f39"],
  ["shared/game.ts", 2411, "79a7563059171121b0331687fc2caab8563f03a6cb64060b475d1fe7d8a96850"],
  ["scripts/certified-staging-oracle-current-coverage.ts", 4985, "abec6ee81686597c445ec4144d6216ef5849be6753fe8fbeaf154a24f021bec5"],
  [FIXTURE, 22814, FIXTURE_SHA],
  ["package.json", 16534, "821741019c0fec4294b36dec8b2e7f1a94bfc1183bac2b13c75883db1a864f93"],
  ["package-lock.json", 297216, "0e03da5c8ea9adbebaaf8107521003c9b9a74cb3d01d168ece72965f4ff69643"],
  [".nvmrc", 8, "73fb1b615e2043a933be1c0895cde4358036acc28d785692509b822aa53c761f"],
  ["scripts/certified-staging-oracle-lane.ts", 18895, "9f705b9b3be0beffda260b97de8b4ada421b5f15f92e5a8e80c092098bfcd887"],
  ["rust/certified/src/lib.rs", 23415, "ebae6dff0f04b0c14676d0dd95fa9c82364a2ba1d54a2276557c34359d2e6502"],
  ["rust/certified/src/guidance.rs", 10843, "033306477a5797d0286a569783c4e6ef946ef0b62c44bb671c501d5e8ca43ac9"],
  ["rust/certified/src/waiting.rs", 26480, "3cf36600a45caee8a7b57d4e8e4cd273564ae9fc08bc79c1870a6ea0b16673a2"],
  ["public/certified_solver.wasm", 818752, "8e48c7d1a806b9cf9fe05ccb4cc2ae4c9cc87d97b2443f96dd0c180d1c134238"],
  ["shared/generated/certifiedEngineBuild.ts", 315, "5f11e05aa6f31bd10ff92a53a71a4d8eb31e64b9f4aafbe1d4b710e1862ceda3"],
  ["shared/generated/certifiedWasmBuild.ts", 262, "cd7ede84b561f3e2b41a99478e5ac7f00cb02f8ecdcec3a43a5c7f2e8b8e2156"],
  ["src/certified/wasmBackend.spec.ts", 23993, "b374dbe5f75675709873f5d1fa63dac9a0b562417814871f4d0954f86b3eff0f"],
  [".tmp/certified-phase3-SG1-yb6GaD/identity.json", 34525, "71e359f8c21b6f1de4aa25c2bf35c9a106b1ed9a939c59d357aa5db12bbee3c0"],
  [".tmp/certified-phase3-ljNRNV/arm-count.json", 20, "549d41d7895f27ace5d3e514370f2db151098a9f2ed7151206fa647402ab0b19"],
  [".tmp/certified-phase3-candidate-I7clUr/arm-count.json", 20, "bbca43c46fdd97d29698f308f552a5130ebd2be2b3a458a64de7eac1c54d1d0c"],
  [".tmp/vg1-prototype-8jmaK7/trial.ts", 7361, "ad576a1e01646b6930bc5fe6706c0f0981d595ea8a8ad602bdcace9dc117966d"],
  [".tmp/vg1-prototype-8jmaK7/identity.json", 3880, "7c51f932ed2abbe543c0bbf025bbf81baa716e13abf8b554bca4e6f040b871c0"],
  [".tmp/vg1-prototype-8jmaK7/results.json", 895, "1d66dad00328d5a48bb29272abcdb489ea0ed705c843eab573a2b1fb57bff405"],
  [".github/dependabot.yml", 1176, "9f9862f99f56ae04b614de4f93a6bd0210bf5926aae1f4d264b5d38d23309739"],
]);

// Candidate flags describe the identity under review, not execution authority.
// Lead's later externally pinned invocation is the release act after approval.
export const RESOURCE_MODEL = Object.freeze({
  admissionBasis: "work/table/call/time caps plus child V8 old-space cap",
  staticLedgerReferenceOnly: true,
  heapOrRssGuarantee: false,
  maxRSS: "KiB observation only; non-certifying",
  cleanupPolicy: "D2 accepted for this single run: no cleanup deadline; operator intervention if close never arrives",
  complete: false,
  minimumCombinedLogicalBytes: null,
  helperLogicalBytesById: null,
  publicationMaximumBytes: null,
  transportSourceValueReservationBytes: null,
  knownB09ExistingModelSubtotalBytes: 1676905,
  knownB09ExistingModelUniformPowersSubtotalBytes: 1708489,
  knownSubtotalsAreNotCompleteReservations: true,
  nativeBoundary: "UNRESOLVED: materialized source values versus native-private workspace",
  unresolved: Object.freeze([
    "declared logical record widths and complete allocation-site/lifetime summaries",
    "native-private sort, BigInt, parsing, conversion, serialization and IPC boundary",
    "materialized helper exception message/stack bounds before harness truncation",
    "parent/child fixed state, price input parsing, retained result and summary charges",
    "unreduced products, GCD and binary/decimal string scratch reservations",
    "fresh oracle memo/candidate-map/pending-frame reservations",
    "combined accounting of the implemented bounded protocol, parser and native queues",
    "review of supervisor and provisional-frame PLUS parent-exit commit protocol",
    "outer authenticated reader, source-pin buffers, notices and cleanup-lifetime reservation",
    "operator disposition if parent dies before child close or close never arrives; no cleanup deadline adopted",
    "static ledger remains incomplete and is reference-only, not an admission gate",
  ]),
  lifetimeContract: Object.freeze([
    "Reserve whole synchronous operations before entry; no internal instrumentation claim.",
    "Keep each helper result charged during its fresh original-oracle call.",
    "Discard both full results/candidate maps after comparison; retain bounded summaries.",
    "After all six controls, evaluate B09 k1 only; no original oracle on B09.",
    "Reserve parent/child publication overlap and all materialized representations.",
    "Logical retirement is not GC, heap, RSS or allocator-release evidence.",
    "A publication frame is provisional; only complete frame plus parent exit zero commits.",
    "A late/partial frame with parent exit two decodes to whole-trial NOTRUN, never a certificate.",
    "Keep child/parent process handles referenced until close is observed; report pending cleanup without retry.",
    "Outer reader authenticates externally pinned parent and accepts only after parent close; no standalone stdout verdict.",
  ]),
});

// Bounds are source-derived upper bounds, not measurements. Work counts graph
// visits (hits included), table records and original-oracle recursive entries.
// oracle.frames bounds pending solve frames by total inventory uses + 1.
// It is conservative, not the exact recursion depth; caller frames are separate.
export const CONTROLS = Object.freeze([
  { id: "P", grade: "SR", level: 14, exp: 2900, stock: [10, 10, 10], prices: [1, 1, 1],
    expectedStatus: "PASS", worst: [1, 1, 1],
    helper: { nonterminal: 1, nodes: 2, depth: 1, rows: 2, peak: 2, visits: 6,
      exact: { nonterminal: 1, nodes: 2, depth: 1, rows: 2, peak: 2 } },
    oracle: { memo: 4, exactMemo: 4, entries: 7, frames: 4 }, work: 15 },
  { id: "U", grade: "SR", level: 14, exp: 2900, stock: [10, 10, 0], prices: [1, 1, 1],
    expectedStatus: "UNKNOWN", worst: [1, 1, 1], relaxedMask: 7,
    helper: { nonterminal: 1, nodes: 2, depth: 1, rows: 2, peak: 2, visits: 6,
      exact: { nonterminal: 1, nodes: 2, depth: 1, rows: 2, peak: 2 } },
    oracle: { memo: 3, exactMemo: 3, entries: 5, frames: 3 }, work: 13 },
  { id: "PROMOTION", grade: "R", level: 15, exp: 0, stock: [0, 0, 20], prices: [1, 1, 1],
    expectedStatus: "UNKNOWN",
    helper: { nonterminal: 300, nodes: 301, depth: 150, rows: 300, peak: 300, visits: 1801,
      exact: { depth: 150 } },
    oracle: { memo: 7, exactMemo: 7, entries: 7, frames: 3 }, work: 2108 },
  { id: "R", grade: "R", level: 14, exp: 900, stock: [10, 0, 270], prices: [1, 1, 0],
    syntheticZeroPricesOnly: true, expectedStatus: "PASS", worst: [0, 0, 27],
    helper: { nonterminal: 301, nodes: 302, depth: 151, rows: 602, peak: 602, visits: 1807,
      exact: { depth: 151 } },
    oracle: { memo: 3472, exactMemo: null, entries: 20833, frames: 29 }, work: 23242 },
  { id: "S_PLUS", grade: "SR", level: 14, exp: 2600, stock: [20, 10, 10], prices: [1, 2, 2],
    expectedStatus: "PASS", worst: [2, 0, 0],
    helper: { nonterminal: 2, nodes: 3, depth: 2, rows: 6, peak: 4, visits: 11,
      exact: { nonterminal: 2, nodes: 3, depth: 2, rows: 6, peak: 4 } },
    oracle: { memo: 8, exactMemo: 8, entries: 13, frames: 5 }, work: 30 },
  { id: "S_MINUS", grade: "SR", level: 14, exp: 2600, stock: [10, 10, 10], prices: [1, 2, 2],
    expectedStatus: "PASS", worst: [0, 1, 1],
    helper: { nonterminal: 2, nodes: 3, depth: 2, rows: 4, peak: 4, visits: 11,
      exact: { nonterminal: 2, nodes: 3, depth: 2, rows: 4, peak: 4 } },
    oracle: { memo: 7, exactMemo: 7, entries: 11, frames: 4 }, work: 26 },
]);
export const TARGET = Object.freeze({
  id: "B09_K1", grade: "R", level: 0, exp: 200, stock: [990, 200, 100],
  helper: { nonterminal: 450, nodes: 451, depth: 224, rows: 45000, peak: 900, visits: 2701,
    exact: { depth: 224 } },
  work: 47701,
});

export function approvedNodeVersion(value) {
  return value === NODE_VERSION;
}

export function admission(gates = RELEASE_GATES) {
  if (gates.executionReleasedByLead !== true)
    return { status: "NOTRUN", reason: "pf2_lead_release_required" };
  if (gates.supervisorAndAtomicPublicationReviewed !== true)
    return { status: "NOTRUN", reason: "pf2_supervisor_publication_not_reviewed" };
  return { status: "ADMITTED" };
}

export function inputShape(input) {
  const required = input.grade === "R" ? 1000 : 3000;
  return ["R", "SR"].includes(input.grade) &&
    Number.isInteger(input.level) && input.level >= 0 && input.level <= 15 &&
    Number.isInteger(input.exp) && input.exp >= 0 && input.exp % 100 === 0 &&
    (input.level === 15 ? input.exp === 0 : input.exp < required) &&
    Array.isArray(input.stock) && input.stock.length === 3 &&
    input.stock.every(n => Number.isSafeInteger(n) && n >= 0 && n % 10 === 0);
}

export function fixtureShape(record) {
  const input = record?.input;
  return record?.status === "PASS" && record.sourceStable === true &&
    input?.grade === "R" && input.level === 0 && input.exp === 0 &&
    JSON.stringify(input.stock) === "[1000,200,100]" &&
    record.result?.P?.numerator === "1" && record.result.P.denominator === "1" &&
    record.result.action === "blue" && JSON.stringify(record.result.ties) === '["blue"]' &&
    Array.isArray(input.prices) && input.prices.length === 3 &&
    input.prices.every(price => typeof price?.numerator === "string" &&
      typeof price.denominator === "string" &&
      /^[1-9]\d{0,255}$/.test(price.numerator) &&
      /^[1-9]\d{0,255}$/.test(price.denominator));
}
