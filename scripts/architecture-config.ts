import type {
  DebtEntry,
  FunctionDebtEntry,
  ModuleBoundaryDebtEntry,
  RuleLimits,
} from "./architecture-types.ts";

export const WORKER_SOURCE_ROOTS = [
  "cloudflare/src",
  "forecast-collector/src",
  "forecast-dispatcher/src",
  "forecast-interactions/src",
  "stats-observer/src",
  "usage-guard/src",
] as const;

// Shared D1/backend code is reusable by Workers, never by the browser or pure shared contracts.
export const BACKEND_SHARED_ROOTS = ["shared/forecast-publication"] as const;

export const APPLICATION_ENTRYPOINTS = [
  "src/main.tsx",
  "src/worker.ts",
  // These executable Worker bundles are loaded through new URL()/esbuild, not static imports.
  "src/certifiedRuntime/browserWorker.ts",
  "src/certifiedRuntime/nodeWorker.ts",
  "src/certifiedRuntime/browserFixtureWorker.ts",
  "src/certifiedRuntime/nodeFixtureWorker.ts",
  "src/certifiedRuntime/nodeClient.ts",
  ...WORKER_SOURCE_ROOTS.map((root) => `${root}/worker.ts`),
] as const;

export const CHECK_ROOTS = [
  "src",
  "shared",
  ...WORKER_SOURCE_ROOTS,
  "benchmarks",
  "scripts",
  "e2e",
  "rust/solver-rs/src",
  "rust/certified/src",
  "personal-data/src",
  "forecast-admin/src",
  "site-worker/src",
];

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".rs"];
export const DEFAULT_MAX_FILE_LINES = 900;
const BIOME_IGNORE_TOKEN = `biome${"-ignore"}`;

export const LONG_FILE_ALLOWLIST: DebtEntry[] = [
  {
    file: "rust/solver-rs/src/lib.rs",
    owner: "solver",
    reason:
      "The phase2 memo, Bellman recursion, root capture, and exported ABI share one bit-equivalent kernel lifecycle.",
    removalTarget:
      "Split only after instance-owned kernel state can replace the current global memo without changing floating-point order.",
  },
  {
    file: "rust/solver-rs/src/minef.rs",
    owner: "solver",
    reason:
      "The min-E[f] memo table, Bellman recursion, root capture, and WASM ABI form one bit-equivalent kernel boundary.",
    removalTarget:
      "Split only after a module boundary can preserve memo lifetime and floating-point evaluation order without cross-file navigation overhead.",
  },
  {
    file: "e2e/smoke.spec.ts",
    owner: "test",
    reason:
      "The browser smoke suite keeps cross-layout product workflows in one discoverable regression entry.",
    removalTarget:
      "Split a cohesive stats-runtime or outcome-flow suite once it has enough independent setup to avoid duplicating preview lifecycle code.",
  },
  {
    file: "personal-data/src/auth.test.ts",
    owner: "test",
    reason:
      "OIDC and account-lifecycle cases share one local D1 harness, fake issuer, and cookie/session helpers.",
    removalTarget:
      "Extract the shared harness into a test helper module, then split OIDC, consent/deletion, and cron suites.",
  },
];

export const TYPE_ESCAPE_BOUNDARY_ALLOWLIST: DebtEntry[] = [
  {
    file: "cloudflare/src/worker.test.ts",
    owner: "test",
    reason: "The Worker test harness needs Cloudflare runtime boundary casts.",
    removalTarget: "Introduce typed test helpers for env, request, and execution context.",
  },
  {
    file: "forecast-admin/src/worker.test.ts",
    owner: "test",
    reason:
      "The Admin test harness adapts the Miniflare environment and the JWKS fetch double to generated Worker bindings.",
    removalTarget: "Provide typed Admin Miniflare environment and fetch-double factories.",
  },
  {
    file: "forecast-admin/src/worker.cpu.spec.ts",
    owner: "test",
    reason:
      "The CPU-budget spec builds an AdminEnv snapshot whose allowlisted emails are not in the binding type.",
    removalTarget:
      "Expose a typed AdminEnv test builder once access config is a standalone module.",
  },
  {
    file: "src/wasm/rustLoader.ts",
    owner: "wasm",
    reason: "Raw WebAssembly exports enter TypeScript through a single wrapper boundary.",
    removalTarget: "Use per-export runtime validators before constructing RustCoreExports.",
  },
  {
    file: "src/wasm/rustPhase2Parity.test.ts",
    owner: "test",
    reason: "Parity tests instantiate raw WASM exports to compare Rust and JS policies.",
    removalTarget: "Create a typed WASM test loader shared with rustCore tests.",
  },
  {
    file: "forecast-collector/src/db.test.ts",
    owner: "test",
    reason: "The Miniflare D1 fixture is adapted to the generated Worker binding contract.",
    removalTarget: "Provide a typed forecast-collector Miniflare environment factory.",
  },
  {
    file: "forecast-collector/src/worker.test.ts",
    owner: "test",
    reason: "Worker boundary tests adapt request, execution-context, and rate-limit test doubles.",
    removalTarget: "Introduce typed Worker request and execution-context fixture builders.",
  },
  {
    file: "usage-guard/src/worker.test.ts",
    owner: "test",
    reason: "Usage Guard tests adapt the Miniflare environment to generated Worker bindings.",
    removalTarget: "Provide a typed Usage Guard Miniflare environment factory.",
  },
  {
    file: "forecast-dispatcher/src/db.test.ts",
    owner: "test",
    reason: "The Dispatcher D1 fixture is adapted to the generated Worker binding contract.",
    removalTarget: "Provide a typed Dispatcher Miniflare environment factory.",
  },
  {
    file: "forecast-dispatcher/src/dispatcher.test.ts",
    owner: "test",
    reason: "The Dispatcher integration fixture is adapted to the generated Worker bindings.",
    removalTarget: "Provide a typed Dispatcher environment and GitHub API fixture factory.",
  },
  {
    file: "forecast-interactions/src/worker.test.ts",
    owner: "test",
    reason: "The Interaction Router fixture is adapted to two generated D1 binding contracts.",
    removalTarget: "Provide a typed Interaction Router Miniflare environment factory.",
  },
];

export const MODULE_BOUNDARY_ALLOWLIST: ModuleBoundaryDebtEntry[] = [
  {
    file: "cloudflare/src/site-gateway.test.ts",
    dependency: "site-worker/src/worker.ts",
    owner: "test",
    reason:
      "The gateway test proves the site Worker rejects unallowlisted paths behind the Cloudflare proxy.",
    removalTarget: "Compare the gateway allowlist against an exported site route table instead.",
  },
  {
    file: "forecast-collector/src/v2/rules/prediction-identity.test.ts",
    dependency: "forecast-admin/src/calendar.ts",
    owner: "test",
    reason:
      "The collector rule test reuses the Admin business-day calendar the schedule is evaluated against.",
    removalTarget: "Move the business-day calendar into a shared module both Workers import.",
  },
  {
    file: "forecast-collector/src/v2/rules/decisions.projection.test.ts",
    dependency: "forecast-admin/src/calendar.ts",
    owner: "test",
    reason:
      "The projection test reuses the Admin business-day calendar the production schedule is evaluated against.",
    removalTarget: "Move the business-day calendar into a shared module both Workers import.",
  },
  {
    file: "forecast-dispatcher/src/dispatcher.test.ts",
    dependency: "forecast-collector/src/ops.ts",
    owner: "test",
    reason: "The integration test verifies the Collector-owned workflow callback contract.",
    removalTarget: "Move the workflow callback contract and fixture to shared/forecast-ops.",
  },
  ...["crypto.ts", "discord-approval.ts", "manual-review.ts", "ops.ts"].map((dependency) => ({
    file: "forecast-interactions/src/worker.ts",
    dependency: `forecast-collector/src/${dependency}`,
    owner: "worker" as const,
    reason:
      "The Router is a separate trust boundary but currently consumes Collector-owned D1 contracts.",
    removalTarget:
      "Move the stable interaction, review, and operations contracts into a shared forecast module.",
  })),
];

export const BIOME_IGNORE_ALLOWLIST: DebtEntry[] = [
  {
    file: "scripts/architecture-rules.ts",
    owner: "architecture",
    reason: `Rule messages intentionally mention ${BIOME_IGNORE_TOKEN} while checking that token elsewhere.`,
    removalTarget:
      "Tokenize rule strings or move rule names to data before removing this exception.",
  },
  {
    file: "src/components/StatePanel.tsx",
    owner: "app",
    reason: "Existing grouped controls rely on div role=group and stable visual/test contract.",
    removalTarget:
      "Replace grouped controls with semantic fieldset/radio UI in a separate UI refactor.",
  },
  {
    file: "src/components/StatsRateBar.tsx",
    owner: "app",
    reason: "Passive pointer tracking is scoped to the difficulty interval visualization.",
    removalTarget: "Move interval tooltip interaction to button/focusable marks.",
  },
  {
    file: "src/components/TopBar.tsx",
    owner: "app",
    reason: "Theme segmented control uses existing grouped control styling and tests.",
    removalTarget: "Replace with semantic radio group in a separate UI refactor.",
  },
];

export const EMPTY_CATCH_ALLOWLIST: DebtEntry[] = [];

export const COMPLEXITY_ALLOWLIST: FunctionDebtEntry[] = [
  {
    file: "personal-data/src/fake-issuer.ts",
    function: "fakeIssuer",
    owner: "test",
    reason:
      "The local OIDC issuer keeps discovery, JWKS, token and PKCE verification in one fixture lifetime.",
    removalTarget:
      "Split discovery/JWKS serving from token exchange once each has its own fixture.",
  },
  {
    file: "personal-data/src/fake-issuer.ts",
    function: "fetchImpl",
    owner: "test",
    reason: "The fixture fetch routes three fixed Google endpoints and validates PKCE per request.",
    removalTarget: "Route each endpoint to its own typed handler after the fixture gains a router.",
  },
  {
    file: "personal-data/src/google.ts",
    function: "googleProvider",
    owner: "worker",
    reason:
      "One isolate-lifetime provider owns discovery caching, shared outbound flight control for the three pinned Google endpoints, and the authorization-code exchange with its issuer rejection.",
    removalTarget:
      "Extract outbound flight control once discovery caching can be separated from claim validation.",
  },
  {
    file: "personal-data/src/http.ts",
    function: "stageSummary",
    owner: "worker",
    reason:
      "The stage projection predicate validates all seven persisted fields and their arithmetic range.",
    removalTarget: "Represent the stage schema as data and validate fields through shared helpers.",
  },
  {
    file: "personal-data/src/publication.ts",
    function: "publishWeekly",
    owner: "worker",
    reason:
      "Fence acquisition, cross-store snapshot, disclosure, rank freeze, and activation form one publishable release.",
    removalTarget:
      "Extract snapshot/disclosure/activation stages after fence recovery is isolated.",
  },
  {
    file: "personal-data/src/store.ts",
    function: "putWorkspace",
    owner: "worker",
    reason:
      "Workspace CAS, summary projection, archive insertion, replay detection and quota outcome share one batch.",
    removalTarget: "Extract statement construction from result classification.",
  },
  {
    file: "personal-data/src/worker.ts",
    function: "createWorker",
    owner: "worker",
    reason:
      "The Worker closure owns provider lifetime plus the login, callback, session, and account handlers.",
    removalTarget:
      "Move each route family into a typed handler module bound to one provider instance.",
  },
  {
    file: "personal-data/src/worker.ts",
    function: "callback",
    owner: "worker",
    reason:
      "Callback validation, identity comparison, admission, and session creation form one atomic login flow.",
    removalTarget:
      "Extract admission and session issuance after the deletion-fence checks are isolated.",
  },
  {
    file: "personal-data/src/worker.ts",
    function: "fetch",
    owner: "worker",
    reason:
      "The route table, account context, consent/workspace/export routes, and error mapping share one contract.",
    removalTarget:
      "Replace route branching with typed handlers registered in the existing route table.",
  },
  {
    file: "personal-data/src/auth.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason:
      "OIDC and account-lifecycle cases share one local D1 harness, fake issuer, and cookie/session helpers.",
    removalTarget:
      "Extract the shared harness into a test helper module, then split OIDC, consent/deletion, and cron suites.",
  },
  {
    file: "personal-data/src/store.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Workspace, quota, and privacy-projection cases share one PERSONAL_DB fixture.",
    removalTarget: "Extract the fixture and split workspace CAS from privacy projection suites.",
  },
  {
    file: "forecast-admin/src/access.ts",
    function: "createAccessVerifier",
    owner: "worker",
    reason:
      "Split area: Admin access. One isolate-lifetime closure owns the bounded Cloudflare Access JWKS cache, its single-flight refresh, and the per-`kid` key lookup the verifier calls.",
    removalTarget:
      "Owned by the forecast-admin agent; extract the JWKS cache/single-flight into its own module.",
  },
  {
    file: "forecast-admin/src/access.ts",
    function: "download",
    owner: "worker",
    reason:
      "Split area: Admin access. One bounded fetch reads `<team>/cdn-cgi/access/certs` (manual redirect, 5 s timeout, 64 KiB cap) and imports only usable RS256 keys, at most 8.",
    removalTarget:
      "Owned by the forecast-admin agent; separate the bounded fetch from JWK filtering and key import.",
  },
  {
    file: "forecast-admin/src/access.ts",
    function: "<anonymous>",
    owner: "worker",
    reason:
      "Split area: Admin access. This returned verifier validates one Access JWT end to end: header algorithm pin, signature, then iss/aud/exp/nbf/email claims.",
    removalTarget:
      "Owned by the forecast-admin agent; extract claim validation from signature verification.",
  },
  {
    file: "forecast-admin/src/calendar.ts",
    function: "parseDay",
    owner: "worker",
    reason:
      "Split area: Admin calendar. One stored `payload_json` is validated into a day: kits/coop counts, grants, pending labels, and per-event titles.",
    removalTarget:
      "Owned by the forecast-admin agent; split kits/coop, grants/pending, and titles validation.",
  },
  {
    file: "forecast-admin/src/calendar.ts",
    function: "readActiveCalendar",
    owner: "worker",
    reason:
      "Split area: Admin calendar. One snapshot query's rows are validated into the snapshot header, day payloads, event revisions, and their cross-row consistency.",
    removalTarget:
      "Owned by the forecast-admin agent; extract snapshot header, day, and event-revision readers.",
  },
  {
    file: "forecast-admin/src/render.ts",
    function: "<anonymous>",
    owner: "worker",
    reason:
      "Split area: Admin render. This per-day callback builds one day's event/coop/grant items, accumulates the II and box totals, and tracks which events were shown.",
    removalTarget:
      "Owned by the forecast-admin agent; extract per-day item rendering and total accumulation.",
  },
  {
    file: "site-worker/src/forecast.ts",
    function: "load",
    owner: "worker",
    reason:
      "Split area: site Worker. The load path validates the upstream payload before caching it.",
    removalTarget: "Owned by the site-worker agent; split schema validation from normalize.",
  },
  {
    file: "site-worker/src/forecast.ts",
    function: "<anonymous>",
    owner: "worker",
    reason: "Split area: site Worker. Anonymous handlers are inline request closures.",
    removalTarget: "Owned by the site-worker agent; register named route handlers.",
  },
  {
    file: "site-worker/src/worker.ts",
    function: "fetch",
    owner: "worker",
    reason:
      "Split area: site Worker. The gateway routes static assets and forecast paths in one entry.",
    removalTarget: "Owned by the site-worker agent; extract the route table.",
  },
  {
    file: "forecast-dispatcher/src/dispatcher.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Dispatcher dispatch, retry, watchdog, and callback cases share one Miniflare fixture.",
    removalTarget: "Split dispatch lifecycle and operational-alert suites around a shared fixture.",
  },
  {
    file: "forecast-dispatcher/src/dispatcher.ts",
    function: "runDispatcher",
    owner: "worker",
    reason:
      "Lease acquisition, GitHub dispatch, durable status, and alert recovery form one scheduled run.",
    removalTarget:
      "Extract dispatch-attempt execution after lease and callback invariants are isolated.",
  },
  {
    file: "forecast-interactions/src/worker.ts",
    function: "fetch",
    owner: "worker",
    reason: "The Router validates the only two public routes before entering Discord verification.",
    removalTarget: "Move health and interaction routes into typed handlers.",
  },
  {
    file: "forecast-interactions/src/worker.ts",
    function: "authorizeAction",
    owner: "worker",
    reason:
      "Discord custom IDs map to environment-specific D1 records under one authorization decision.",
    removalTarget: "Use a data-driven action registry with per-action authorization handlers.",
  },
  {
    file: "stats-observer/src/canary.ts",
    function: "evaluateObserverCanary",
    owner: "worker",
    reason: "The certificate evaluates all immutable Observer evidence gates in one pure function.",
    removalTarget: "Represent canary gates as data and aggregate typed gate results.",
  },
  {
    file: "stats-observer/src/discord.ts",
    function: "deliverAlert",
    owner: "worker",
    reason:
      "Discord delivery handles create, update, retry scheduling, and durable result recording.",
    removalTarget: "Extract response classification from message mutation and D1 persistence.",
  },
  {
    file: "stats-observer/src/observer.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Observer baseline, delta, escalation, and delivery cases share one D1 fixture.",
    removalTarget: "Split observation, alert escalation, and Discord delivery suites.",
  },
  {
    file: "stats-observer/src/observer.ts",
    function: "runObserver",
    owner: "worker",
    reason:
      "Overlap reads, monotonic deltas, alert escalation, and cursor commit form one scheduled poll.",
    removalTarget: "Extract row-delta evaluation and keep only the final D1 commit in the runner.",
  },
  {
    file: "forecast-collector/src/candidate.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Candidate validation cases share one D1-independent fixture contract.",
    removalTarget: "Split parser, invariant, and payload-hash cases into separate describe blocks.",
  },
  {
    file: "forecast-collector/src/db.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Collector database lifecycle cases share one Miniflare D1 setup.",
    removalTarget: "Extract a reusable D1 fixture and split canary, health, and candidate suites.",
  },
  {
    file: "forecast-collector/src/db.ts",
    function: "readCanaryReport",
    owner: "worker",
    reason:
      "The canary certificate currently assembles invocation, queue, and integrity counters together.",
    removalTarget: "Extract independent counter queries and a pure canary decision assembler.",
  },
  {
    file: "forecast-collector/src/naver.ts",
    function: "parseNaverFeed",
    owner: "worker",
    reason: "Feed parsing validates several upstream response shapes before normalizing metadata.",
    removalTarget: "Separate upstream schema validation from normalized feed item construction.",
  },
  {
    file: "benchmarks/evaluator/exact-replan.ts",
    function: "createExactInteractiveReplanSession",
    owner: "benchmark",
    reason:
      "Exact replan session keeps memoized recursion and diagnostics in one benchmark closure.",
    removalTarget:
      "Extract memo storage, recursion, and diagnostic reporting into cohesive helpers.",
  },
  {
    file: "benchmarks/models/availability-grid.ts",
    function: "buildAvailabilityGridCandidates",
    owner: "benchmark",
    reason: "Grid generation nests model dimensions and escalation probes.",
    removalTarget: "Represent grid dimensions as data and flatten candidate generation.",
  },
  {
    file: "benchmarks/rust-benchmark-weights.ts",
    function: "parseRustBenchmarkWeightSpec",
    owner: "benchmark",
    reason: "Weight parser validates several optional dimensions and fallback forms.",
    removalTarget: "Parse each weight dimension through a shared schema-driven helper.",
  },
  {
    file: "src/hooks/useCalculatorApp.ts",
    function: "useCalculatorApp",
    owner: "app",
    reason:
      "The root hook composes cohesive calculator state, solver, validation, outcome, and view-model hooks without owning their internal logic.",
    removalTarget:
      "Remove when the app model accepts grouped runtime and view state without adding another navigation-only wrapper.",
  },
  {
    file: "src/solver.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Core solver behavior cases currently share one long describe callback.",
    removalTarget: "Split solver tests by probability, supply cost, and edge-case contracts.",
  },
  {
    file: "src/solver/mdp.ts",
    function: "finiteInventoryMdp",
    owner: "solver",
    reason: "Finite-inventory Bellman recursion keeps transition and tie-break logic together.",
    removalTarget: "Extract transition evaluation without changing memoization semantics.",
  },
  {
    file: "src/solver/mdp.ts",
    function: "value",
    owner: "solver",
    reason: "Bellman recursion keeps gate and candidate comparison in one memoized function.",
    removalTarget: "Extract candidate evaluation without changing floating-point operation order.",
  },
  {
    file: "src/wasm/rustCore.phase2Policy.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Phase2 policy wrapper scenarios share one fixture-heavy describe callback.",
    removalTarget: "Split policy build, stale handle, rollout, and parity test groups.",
  },
  {
    file: "src/wasm/rustPhase2Parity.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Rust/JS parity scenarios share expensive WASM setup and sentinel data.",
    removalTarget:
      "Extract shared WASM fixture and split root, walk, and Monte Carlo parity suites.",
  },
  {
    file: "benchmarks/analyze-availability.ts",
    function: "main",
    owner: "benchmark",
    reason: "Availability analyzer still combines parsing, aggregation, and console reporting.",
    removalTarget: "Split data loading, Pareto aggregation, and report formatting.",
  },
  {
    file: "benchmarks/run-availability-select.ts",
    function: "main",
    owner: "benchmark",
    reason: "Selection runner still combines decision rules, report construction, and file I/O.",
    removalTarget: "Extract selection model, guardrail summaries, and output writers.",
  },
];

export function debtFiles(entries: DebtEntry[]) {
  return new Set(entries.map((entry) => entry.file));
}

export function limitsFor(file: string): RuleLimits {
  if (file.includes(".test.") || file.includes(".spec.") || file.startsWith("benchmarks/")) {
    return { maxFunctionLines: 180, maxDepth: 5, maxComplexity: 25 };
  }
  return { maxFunctionLines: 120, maxDepth: 4, maxComplexity: 15 };
}
