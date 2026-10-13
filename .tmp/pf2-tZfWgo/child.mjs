// Candidate trial body; execution requires Lead approval of the pinned identity.
// The exported body has an independent admission gate before dynamic imports.
// Native Node 24 TypeScript requires --experimental-transform-types for the
// unchanged helper's parameter properties. No bundle or dependency change.
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { createHash } from "node:crypto";
import {
  CONTROLS, TARGET, WORK_CAP, TABLE_PEAK_CAP, CALL_CAP, HELPER_MAX_LOGICAL_BYTES, HEAP_CAP_MIB, FIXTURE_SHA,
  admission, inputShape, fixtureShape, approvedNodeVersion,
} from "./contract.mjs";
import { pathToFileURL } from "node:url";
import {
  REQUEST_BYTES, boundedFrameReader, decodeRequest, encodeResponse,
} from "./protocol.mjs";

class TrialFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
class TrialRefusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) {
  if (!condition) throw new TrialFailure(code);
}
function integerBound(value, maximum, code) {
  requireThat(Number.isSafeInteger(value) && value >= 0 && value <= maximum, code);
}
function sameArray(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);
}
function oracleMask(result) {
  return result.ties.reduce((mask, action) => {
    const index = ["blue", "purple", "yellow"].indexOf(action);
    requireThat(index >= 0, "pf2_unexpected_oracle_action");
    return mask | (1 << index);
  }, 0);
}
function equalEndpoint(actual, expected, api, mask, chosen) {
  for (const field of ["P", "B", "C"])
    requireThat(api.cmp(actual[field], expected[field]) === 0, "pf2_endpoint_scalar");
  requireThat(actual.consumed.length === 3 &&
    actual.consumed.every((value, i) => api.cmp(value, expected.consumed[i]) === 0),
  "pf2_endpoint_consumption");
  requireThat(mask === expected.mask && chosen === expected.chosen, "pf2_endpoint_mask_chosen");
}
function expectation(id, api, game) {
  const { q, add, mul, decimal } = api;
  const endpoint = (P, B, C, consumed, mask, chosen) => ({ P, B, C, consumed, mask, chosen });
  if (id === "P" || id === "U")
    return endpoint(q(1), q(10), q(10), [q(10), q(0), q(0)], id === "P" ? 7 : 3, 0);
  if (id === "PROMOTION")
    return endpoint(q(3, 100), q(12), q(12), [q(0), q(0), q(12)], 4, 2);
  if (id === "S_PLUS")
    return endpoint(q(1), q(19), q(19), [q(19), q(0), q(0)], 1, 0);
  if (id === "S_MINUS")
    return endpoint(q(1), q(20), q(10), [q(0), q(10), q(0)], 6, 1);
  requireThat(id === "R", "pf2_control_identity");
  // Independent recurrence from public yellow percentages, not helper output.
  // One certain R action; each SR stage ends with certain yellow at 9 or 14.
  function stage(first, last) {
    requireThat(game.GREAT_SUCCESS.SR.yellow[last] === 100, "pf2_public_stage_boundary");
    let value = q(1);
    for (let level = last - 1; level >= first; level--) {
      const probability = mul(decimal(String(game.GREAT_SUCCESS.SR.yellow[level])), q(1, 100));
      const failure = add(q(1), mul(q(-1), probability));
      const squared = mul(failure, failure);
      value = add(add(add(q(1), failure), squared), mul(mul(squared, failure), value));
    }
    return value;
  }
  requireThat(game.GREAT_SUCCESS.R.yellow[14] === 100, "pf2_public_R_boundary");
  const consumed = mul(q(10), add(q(1), add(stage(5, 9), stage(10, 14))));
  return endpoint(q(1), q(0), consumed, [q(0), q(0), consumed], 4, 2);
}

function checkHelper(result, input, bound, localLogicalBytes, api) {
  if (result.status === "NOTRUN" && result.reason === "public_feasibility_deadline") {
    requireThat(result.rawException?.name === "Error", "pf2_deadline_exception_type");
    throw new TrialRefusal("pf2_cooperative_deadline");
  }
  // An admitted bound breach or unexpected helper exception is an invariant
  // failure, even if its original reason happens to contain "admission".
  requireThat(result.status === "PASS" || result.status === "UNKNOWN", "pf2_helper_unexpected_refusal");
  requireThat(result.rawException === null && result.plan?.admitted === true, "pf2_helper_exception");
  const plan = result.plan;
  integerBound(plan.nonterminalNodes, bound.nonterminal, "pf2_nonterminal_bound");
  integerBound(plan.publicNodes, bound.nodes, "pf2_graph_bound");
  integerBound(plan.rootDepth, bound.depth, "pf2_depth_bound");
  const width = Math.floor(input.stock[0] / 10) + 1;
  requireThat(sameArray(plan.finiteColors, [0]) &&
    sameArray(plan.finiteWidths, [width, 1, 1]) &&
    plan.widthProduct === width && plan.finiteLayers === width, "pf2_finite_shape");
  requireThat(plan.cumulativeRows === plan.nonterminalNodes * width &&
    result.diagnostics.cumulativeRows === plan.cumulativeRows, "pf2_actual_plan_rows");
  integerBound(plan.cumulativeRows, bound.rows, "pf2_cumulative_rows_bound");
  requireThat(plan.maximumLiveRows === plan.nonterminalNodes * (width > 1 ? 2 : 1),
    "pf2_adjacent_layer_plan");
  integerBound(plan.maximumLiveRows, Math.min(bound.peak, TABLE_PEAK_CAP), "pf2_plan_peak_bound");
  integerBound(result.diagnostics.peakLiveRows, plan.maximumLiveRows, "pf2_actual_peak_bound");
  const observed = {
    nonterminal: plan.nonterminalNodes, nodes: plan.publicNodes, depth: plan.rootDepth,
    rows: result.diagnostics.cumulativeRows, peak: result.diagnostics.peakLiveRows,
  };
  for (const [field, expected] of Object.entries(bound.exact))
    requireThat(observed[field] === expected, "pf2_exact_helper_identity");
  integerBound(plan.logicalUpperBytes, localLogicalBytes, "pf2_helper_partial_logical_bound");
  requireThat(result.diagnostics.logicalUpperBytes === plan.logicalUpperBytes, "pf2_logical_diagnostics");
  requireThat(result.relaxed && api.cmp(result.relaxed.P, api.q(1)) === 0, "pf2_relaxed_probability");
  requireThat(Number.isInteger(result.relaxed.mask) && result.relaxed.mask > 0 &&
    result.relaxed.mask <= 7 &&
    result.relaxed.chosen === [0, 1, 2].find(color => result.relaxed.mask & (1 << color)),
  "pf2_relaxed_mask_domain");
  requireThat(Array.isArray(result.relaxed.worstAll) && result.relaxed.worstAll.length === 3 &&
    result.relaxed.worstAll.every(value => Number.isSafeInteger(value) &&
      value >= 0 && value <= plan.rootDepth), "pf2_worst_use_domain");
  if (result.status === "PASS") {
    requireThat(result.allOptimalPoliciesFit === true && result.value !== null, "pf2_pass_contract");
    requireThat(api.cmp(result.value.P, api.q(1)) === 0, "pf2_finite_probability");
  } else {
    requireThat(result.allOptimalPoliciesFit === false && result.value === null &&
      result.reason === "public_feasibility_all_optimal_policies_exceed_stock", "pf2_unknown_contract");
  }
}

// Admission reflects the candidate release flags, not authority to execute now.
// Parent owns the authoritative deadline and publication commit.
async function runTrialBody(request) {
  const gate = admission();
  if (gate.status !== "ADMITTED") return { ...gate, evaluatorCalls: 0 };
  const heapLimit = getHeapStatistics().heap_size_limit;
  requireThat(heapLimit > 0 && heapLimit <= (HEAP_CAP_MIB + 192) * 1024 * 1024,
    "pf2_heap_cap_not_applied");
  requireThat(request.supervisorReviewed === true, "pf2_supervisor_required");
  requireThat(Number.isFinite(request.deadlineAt), "pf2_shared_deadline_required");
  if (request.deadlineAt <= performance.now())
    throw new TrialRefusal("pf2_cooperative_deadline");
  // A caller-provided boolean is NOT fixture authentication. Pin the original
  // exact bytes before parsing or accepting any price values.
  const fixtureSource = request.fixtureSource;
  requireThat(typeof fixtureSource === "string" &&
    Buffer.byteLength(fixtureSource, "utf8") === 22814, "pf2_fixture_size");
  requireThat(createHash("sha256").update(fixtureSource, "utf8").digest("hex") === FIXTURE_SHA,
    "pf2_fixture_sha");
  const fixture = JSON.parse(fixtureSource);
  requireThat(fixtureShape(fixture), "pf2_fixture_domain");
  const [api, helper, game] = await Promise.all([
    import("../../scripts/certified-staging-oracle.ts"),
    import("../../scripts/certified-staging-oracle-public-layered-feasibility.ts"),
    import("../../shared/game.ts"),
  ]);
  let calls = 0;
  let reservedWork = 0;
  const summaries = [];
  function timeCheck() {
    if (performance.now() >= request.deadlineAt) throw new TrialRefusal("pf2_cooperative_deadline");
  }
  function reserve(caseSpec) {
    // Whole-case static reservation, not a measured entry counter.
    reservedWork += caseSpec.work;
    requireThat(reservedWork <= WORK_CAP, "pf2_work_bound_breach");
    timeCheck();
    return HELPER_MAX_LOGICAL_BYTES;
  }
  function countCall() {
    requireThat(++calls <= CALL_CAP, "pf2_call_bound_breach");
    timeCheck();
  }
  try {
    requireThat(CONTROLS.reduce((sum, item) => sum + item.work, TARGET.work) === WORK_CAP,
      "pf2_work_contract");
    for (const control of CONTROLS) {
      const localLogicalBytes = reserve(control);
      const input = { grade: control.grade, level: control.level, exp: control.exp,
        stock: [...control.stock], prices: control.prices.map(value => api.q(value)), finiteColors: [0] };
      requireThat(inputShape(input), "pf2_control_domain");
      const expected = expectation(control.id, api, game);
      countCall();
      let actual = helper.evaluatePublicLayeredFeasibility(input, {
        deadlineAt: request.deadlineAt, maxLiveRows: TABLE_PEAK_CAP, maxLogicalBytes: localLogicalBytes,
      });
      checkHelper(actual, input, control.helper, localLogicalBytes, api);
      requireThat(actual.status === control.expectedStatus, "pf2_control_status");
      if (control.worst)
        requireThat(sameArray(actual.relaxed.worstAll, control.worst), "pf2_control_worst");
      if (control.relaxedMask !== undefined)
        requireThat(actual.relaxed.mask === control.relaxedMask, "pf2_control_relaxed_mask");
      countCall();
      // solveOracle creates a new evaluator/memo for EVERY control call.
      let reference = api.solveOracle(input);
      timeCheck();
      integerBound(reference.nodes, control.oracle.memo, "pf2_oracle_memo_bound");
      if (control.oracle.exactMemo !== null)
        requireThat(reference.nodes === control.oracle.exactMemo, "pf2_oracle_exact_memo");
      equalEndpoint(reference, expected, api, oracleMask(reference),
        ["blue", "purple", "yellow"].indexOf(reference.action));
      if (actual.status === "PASS") {
        equalEndpoint(actual.value, expected, api, actual.value.mask, actual.value.chosen);
        equalEndpoint(actual.value, {
          ...reference, mask: oracleMask(reference),
          chosen: ["blue", "purple", "yellow"].indexOf(reference.action),
        }, api, actual.value.mask, actual.value.chosen);
      }
      summaries.push({ id: control.id, status: "PASS", helperStatus: actual.status,
        rows: actual.diagnostics.cumulativeRows, peakRows: actual.diagnostics.peakLiveRows,
        oracleNodes: reference.nodes, staticallyReservedWork: control.work });
      // Drop full helper/oracle results and root candidate map before next case.
      actual = null;
      reference = null;
    }
    const localLogicalBytes = reserve(TARGET);
    const prices = fixture.input.prices.map(price => api.fromWire(price));
    requireThat(prices.every(price => price.n > 0n && price.d > 0n &&
      price.n.toString(2).length <= 1024 && price.d.toString(2).length <= 1024),
    "pf2_authenticated_price_bits");
    const input = { grade: TARGET.grade, level: TARGET.level, exp: TARGET.exp,
      stock: [...TARGET.stock], prices, finiteColors: [0] };
    requireThat(inputShape(input), "pf2_target_domain");
    countCall();
    const actual = helper.evaluatePublicLayeredFeasibility(input, {
      deadlineAt: request.deadlineAt, maxLiveRows: TABLE_PEAK_CAP, maxLogicalBytes: localLogicalBytes,
    });
    checkHelper(actual, input, TARGET.helper, localLogicalBytes, api);
    timeCheck();
    requireThat(calls === CALL_CAP && reservedWork === WORK_CAP, "pf2_trial_cardinality");
    const endpoint = actual.status === "PASS" ? {
      P: api.wire(actual.value.P), B: api.wire(actual.value.B), C: api.wire(actual.value.C),
      consumed: actual.value.consumed.map(api.wire), mask: actual.value.mask,
      chosen: actual.value.chosen, worstAll: actual.relaxed.worstAll,
    } : null;
    timeCheck();
    return { status: actual.status, scope: "B09-first-normal-only", controls: summaries,
      evaluatorCalls: calls, staticallyReservedWork: reservedWork,
      memoryObservation: { maxRSSKiB: process.resourceUsage().maxRSS, certifying: false },
      target: { status: actual.status, finiteEndpoint: endpoint,
        rows: actual.diagnostics.cumulativeRows, peakRows: actual.diagnostics.peakLiveRows } };
  } catch (error) {
    // No partially passed controls or target certificate escape on failure.
    return { status: error instanceof TrialRefusal ? "NOTRUN" : "FAIL",
      reason: error instanceof TrialRefusal || error instanceof TrialFailure
        ? error.code : "pf2_unexpected_exception",
      evaluatorCalls: calls };
  }
}

export async function runReviewedTrial(request) {
  try {
    return await runTrialBody(request);
  } catch (error) {
    // Pre-evaluation validation and module-loading failures are structured too.
    return {
      status: error instanceof TrialRefusal ? "NOTRUN" : "FAIL",
      reason: error instanceof TrialRefusal || error instanceof TrialFailure
        ? error.code : "pf2_unexpected_exception",
      evaluatorCalls: 0,
    };
  }
}

async function bootstrap() {
  const args = process.argv.slice(2);
  const nonce = args.length === 3 && /^[0-9a-f]{64}$/.test(args[2]) ? args[2] : "0".repeat(64);
  let deadlineAt = null;
  let result;
  try {
    requireThat(args.length === 3 && args[0] === "--pf2-child" && args[1] === "--nonce",
      "pf2_direct_child_launch_forbidden");
    requireThat(approvedNodeVersion(process.version), "pf2_bootstrap_arguments");
    const gate = admission();
    if (gate.status !== "ADMITTED") result = { ...gate, evaluatorCalls: 0 };
    else {
      const frame = await new Promise((resolveFrame, reject) => {
        const collected = boundedFrameReader(process.stdin, REQUEST_BYTES, () => {
          process.stdin.destroy();
          reject(new TrialFailure("pf2_bootstrap_overflow"));
        });
        process.stdin.once("error", () => reject(new TrialFailure("pf2_bootstrap_input")));
        process.stdin.once("end", () => {
          try { resolveFrame(collected()); } catch (error) { reject(error); }
        });
      });
      const request = decodeRequest(frame);
      requireThat(request.nonce === nonce,
        "pf2_bootstrap_identity");
      const bytes = Buffer.from(request.fixtureBase64, "base64");
      requireThat(bytes.length === 22814 && bytes.toString("base64") === request.fixtureBase64,
        "pf2_fixture_encoding");
      // Advisory child-local deadline. Parent includes launch/startup/transfer
      // and rejects late output independently; clock origins are never shared.
      deadlineAt = performance.now() + request.remainingMs;
      result = await runReviewedTrial({
        supervisorReviewed: true, deadlineAt,
        fixtureSource: bytes.toString("utf8"),
      });
    }
  } catch (error) {
    result = { status: error instanceof TrialRefusal ? "NOTRUN" : "FAIL",
      reason: error instanceof TrialFailure || error instanceof TrialRefusal
        ? error.code : "pf2_bootstrap_exception", evaluatorCalls: 0 };
  }
  if (deadlineAt !== null && performance.now() >= deadlineAt && result.status !== "FAIL")
    result = { status: "NOTRUN", reason: "pf2_cooperative_deadline", evaluatorCalls: null };
  let response;
  try { response = encodeResponse({ version: 1, nonce, result }); }
  catch {
    result = { status: "FAIL", reason: "pf2_child_response_schema", evaluatorCalls: null };
    response = encodeResponse({ version: 1, nonce, result });
  }
  process.stdout.once("error", () => process.exit(1));
  process.stdout.write(response, error => {
    if (error) process.exit(1);
    if (deadlineAt !== null && performance.now() >= deadlineAt && result.status !== "FAIL")
      process.exit(2);
    process.exit(result.status === "FAIL" ? 1 : result.status === "NOTRUN" ? 2 : 0);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await bootstrap();
