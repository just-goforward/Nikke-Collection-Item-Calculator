// Approval inventory is source-static, never learned from a framework run.
const v3 = "v3 population prior and weekly supply wire contract > ";
const real = "real Rust/WASM certified computation > ";
const dates = "Rust/WASM exact date expectations over physical supports > ";
const limits = "Rust/WASM execution limits > ";
export const approvedNames = {
  "numerical-boundary": [
    v3 + "completes v3 R0 [ 300, 50, 20 ] under the unchanged memo budget",
    v3 + "completes v3 R0 [ 150, 30, 8 ] under the unchanged memo budget",
    v3 + "passes the shared population prior separately from the personal posterior",
    v3 + "matches exact TypeScript rates including the Wednesday delta",
    ...["novel", "regular-box-v1", "deterministic:10,10,0"].map(id =>
      v3 + `rejects finite ${id} at the real WASM boundary, without host validation`),
    ...["novel", "deterministic:10,0,0"].map(id =>
      v3 + `rejects event ref ${id} before computing rates`),
    "four-cohort Rust/WASM certified computation > carries a positive fourth cohort through pricing and repeated future receipts",
    ...["regular-box-v1", "box-ii-v1", "dispatch-board-v1", "deterministic:1,2,3", "deterministic:custom", "custom"]
      .map(id => real + `prices explicit finite ${id} in the direct kernel without a JS result oracle`),
    real + "rejects substituted artifacts before instantiation and imports no host math",
    real + "matches exact P/B/C, consumption vectors, root ties and normal-prefix batching",
    real + "keeps fixed pricing, earliest day, H14 witness, completion, claims and source uncertainty",
    real + "performs conditional cohort convolution and expectations in Rust; preserves partial on support refusal",
    real + "bounds deadlines and memory without a JS fallback",
    real + "retains the exact current result when the shared post-current budget expires",
    real + "keeps safe-integer raw arrivals without u32 truncation and observes fixed price basis",
    dates + "groups distinct physical pieces by all capped units and keeps remainders for the next event",
    dates + "keeps each positive-prior latent cohort's own law and skips a zero-prior cohort",
    dates + "clamps physical pieces to state caps before counting support points",
    dates + "enforces the physical support limit even when every point maps to one whole use",
    limits + "never releases or reuses an instance after a RangeError escapes either WASM entry",
    limits + "checks deadlines inside Rust and discards an allocator-trapped instance",
    limits + "bounded representative exact comparison: SR10 and physical R0 including waiting",
  ],
  "production-policy": ["P001", "P002", "P003", "P004", "P005", "P006", "P007", "P008"],
  "analytics-policy": [
    "same acquired final stores Current AND WAIT; neither lazy fallback counts as exposure",
    ...["current", "wait"].map(leaf => `hidden ${leaf} leaf is not exposure even when the other leaf is visible`),
    ...["inert", "hidden", "synthetic-background"].map(condition => `${condition} shell excludes independently committed Current and WAIT`),
    "375px keeps one-line three-column inventory and probability cards plus conditional WAIT",
    "obsolete lazy leaves cannot publish presentation into a replacement episode",
    "R1 preservation: visible Current counts once while WAIT is still unloaded, then WAIT counts separately",
    ...["hidden", "inert"].map(condition => `R1 preservation: ${condition} Current is excluded until genuinely revealed`),
    "R1 preservation: retired Current cannot attach to the replacement calculation",
    "R1 preservation: unrelated final-target callout creates no Current or WAIT episode",
    ...["error", "limit", "cancel"].map(reason => `${reason} with a retained nonfinal checkpoint never creates a calculation episode`),
    ...["restore", "forecast", "unmount"].map(reason => `${reason} during deferred cleanup rejects the old completed candidate`),
    ...["success", "fail"].map(outcome => `accepted ${outcome} belongs to old run before a failing automatic solve`),
    ...["positive", "null"].map(attempt => `explicit success remains observed after ${attempt} modal submission; count is separate`),
    "captured real modal/outcome callbacks cannot rebind after restore and a new accepted run",
    "normalized no-ops preserve the episode; genuine edit captures action before retirement",
    "outcome follow-up final enters the same acquired-run acceptance path",
    "real R15 conversion creates only the accepted SR5 episode",
    "OFF and unconfigured integrations add no analytics resources relative to actual App baseline",
    "volatile profile ignores and preserves legacy personal records and suspends account initialization",
    "storage-denied edits outcomes conversion and undo work in RAM; reload discards state and pending queue",
    "fresh durable state is theme only; language follows URL while calculator state resets on reload",
    "fixture startup retains local layout CSS without devclient transport or solver requests",
  ],
};
export const suiteSources = {
  "numerical-boundary": "src/certified/wasmBackend.spec.ts",
  "production-policy": "e2e/operational-production.spec.ts",
  "analytics-policy": "e2e/decision-analytics.spec.ts",
};
