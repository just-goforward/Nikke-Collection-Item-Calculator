import {
  canonicalState,
  compareValue,
  independentFailure,
  independentProbability,
  independentSuccess,
  makeTriple,
  type OracleInput,
  type OracleValue,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";

type Color = 0 | 1 | 2;
type State = Pick<OracleInput, "grade" | "level" | "exp">;
export type PublicPathRelaxationInput = State & {
  prices: QTriple;
  beforeStock: Triple;
  afterStock: Triple;
  finiteColors: readonly Color[];
};
export type PublicPathRelaxationLimits = {
  deadlineAt?: number;
  maxLogicalBytes?: number;
  maxRows?: number;
};
export type PublicPathRelaxationPlan = {
  admitted: boolean;
  reason: string | null;
  reachablePublicNodes: number;
  rootDepth: number;
  finiteColors: readonly Color[];
  finiteWidths: Triple;
  widthProduct: number;
  maxRows: number;
  maxKey: number;
  maximumRowBytes: number;
  admittedLogicalUpperBytes: number;
  logicalBreakdown: {
    graph: number;
    powers: number;
    prices: number;
    temporary: number;
    output: number;
  };
  limits: { maxLogicalBytes: number; maxRows: number };
  limbBasis: {
    consumedNumeratorBits: number;
    burdenNumeratorBits: number;
    integralPriceBits: Triple;
  };
};
type RelaxedValue = OracleValue & {
  consumed: QTriple;
  worst: Triple;
  mask: number;
  chosen: number;
};
export type PublicPathRelaxationResult = {
  status: "PASS_ENDPOINTS_EQUALITY" | "PASS_N_ONLY" | "UNKNOWN" | "NOTRUN";
  reason: string | null;
  plan: PublicPathRelaxationPlan | null;
  before: RelaxedValue | null;
  after: RelaxedValue | null;
  strictOrder: -1 | 0 | 1 | null;
  beforeFits: boolean;
  afterFits: boolean;
  diagnostics: {
    elapsedMs: number;
    memoRows: number;
    actions: number;
    logicalPayloadBytes: number;
  };
  rawException: { name: string; message: string; stack?: string } | null;
};
type Edge = { probability: number; great: number; ordinary: number };
type Node = { state: State; depth: number; edges: Edge[] };
type Row = {
  consumed: QTripleNumerators;
  burden: bigint;
  worst: Triple;
  mask: number;
  chosen: number;
};
type QTripleNumerators = readonly [bigint, bigint, bigint];
const MAX_LOGICAL = 160 * 1024 * 1024;
const EMPTY: Row = { consumed: [0n, 0n, 0n], burden: 0n, worst: [0, 0, 0], mask: 0, chosen: -1 };

class ProofBudget {
  readonly deadlineAt: number;
  readonly maxLogicalBytes: number;
  readonly maxRows: number;
  graphBytes = 0;
  constructor(limits: PublicPathRelaxationLimits, started: number) {
    const values = [limits.maxLogicalBytes ?? MAX_LOGICAL, limits.maxRows ?? 1_000_000];
    if (values.some((n) => !Number.isSafeInteger(n) || n < 1))
      throw new Error("independent_public_relaxation_invalid_limits");
    this.maxLogicalBytes = Math.min(values[0]!, MAX_LOGICAL);
    this.maxRows = Math.min(values[1]!, 1_000_000);
    this.deadlineAt = Math.min(limits.deadlineAt ?? started + 10_000, started + 10_000);
    if (!Number.isFinite(this.deadlineAt))
      throw new Error("independent_public_relaxation_invalid_deadline");
    this.check();
  }
  check(): void {
    if (performance.now() >= this.deadlineAt)
      throw new Error("independent_public_relaxation_deadline");
  }
  reserveGraph(): void {
    if (this.graphBytes + 200 > this.maxLogicalBytes)
      throw new Error("independent_public_relaxation_graph_admission");
    this.graphBytes += 200;
  }
}

function validateState(input: State): void {
  const required = input.grade === "R" ? 1000 : 3000;
  if (
    !["R", "SR"].includes(input.grade) ||
    !Number.isInteger(input.level) ||
    input.level < 0 ||
    input.level > 15 ||
    !Number.isInteger(input.exp) ||
    input.exp < 0 ||
    input.exp % 100 !== 0 ||
    (input.level < 15 ? input.exp >= required : input.exp !== 0)
  )
    throw new Error("independent_public_relaxation_invalid_state");
}
function validateInput(input: PublicPathRelaxationInput): void {
  validateState(input);
  if (
    [input.beforeStock, input.afterStock].some(
      (stock) => stock.length !== 3 || stock.some((n) => !Number.isSafeInteger(n) || n < 0),
    )
  )
    throw new Error("independent_public_relaxation_invalid_stock");
  if (
    input.prices.length !== 3 ||
    input.prices.some(
      (price) =>
        typeof price.n !== "bigint" || typeof price.d !== "bigint" || price.n < 0n || price.d <= 0n,
    )
  )
    throw new Error("independent_public_relaxation_invalid_prices");
  if (
    input.finiteColors.length > 2 ||
    new Set(input.finiteColors).size !== input.finiteColors.length ||
    input.finiteColors.some((color) => ![0, 1, 2].includes(color))
  )
    throw new Error("independent_public_relaxation_requires_unlimited_color");
}

/** A public-game graph only. No candidate state IDs, caps or transitions. */
class PublicDag {
  readonly nodes: Node[] = [];
  private readonly ids = new Map<string, number>();
  readonly root: number;
  constructor(
    state: State,
    private readonly budget: ProofBudget,
  ) {
    this.root = this.visit(state);
  }
  private edge(state: State, color: number): Edge {
    const probability = independentProbability(state.grade, state.level, color);
    const numerator = probability.n * 1000n;
    if (numerator % probability.d !== 0n)
      throw new Error("independent_public_relaxation_non_per_mille_probability");
    const p = Number(numerator / probability.d);
    if (!Number.isInteger(p) || p <= 0 || p > 1000)
      throw new Error("independent_public_relaxation_positive_probability_invariant");
    const great = this.visit(independentSuccess(state.grade, state.level));
    const ordinary =
      p < 1000 ? this.visit(independentFailure(state.grade, state.level, state.exp, color)) : great;
    return { probability: p, great, ordinary };
  }
  private visit(raw: State): number {
    this.budget.check();
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    const key = `${state.grade}:${state.level}:${state.exp}`;
    const previous = this.ids.get(key);
    if (previous !== undefined) {
      if (this.nodes[previous]!.depth < 0)
        throw new Error("independent_public_relaxation_graph_cycle");
      return previous;
    }
    this.budget.reserveGraph();
    const id = this.nodes.length,
      node: Node = { state, depth: -1, edges: [] };
    this.nodes.push(node);
    this.ids.set(key, id);
    if (state.grade === "SR" && state.level === 15) {
      node.depth = 0;
      return id;
    }
    for (let color = 0; color < 3; color++) node.edges.push(this.edge(state, color));
    node.depth =
      1 +
      Math.max(
        ...node.edges.flatMap((edge) => [
          this.nodes[edge.great]!.depth,
          edge.probability < 1000 ? this.nodes[edge.ordinary]!.depth : 0,
        ]),
      );
    return id;
  }
}

function planFor(
  input: PublicPathRelaxationInput,
  dag: PublicDag,
  budget: ProofBudget,
): PublicPathRelaxationPlan {
  const finiteColors = [...input.finiteColors].sort((a, b) => a - b);
  const widths = makeTriple((color) =>
    finiteColors.includes(color as Color)
      ? Math.floor(Math.max(input.beforeStock[color]!, input.afterStock[color]!) / 10) + 1
      : 1,
  );
  const widthProduct = widths.reduce((product, width) => product * width, 1);
  const rootDepth = dag.nodes[dag.root]!.depth;
  const maxRows = rootDepth === 0 ? 0 : dag.nodes.length * widthProduct;
  if (!Number.isSafeInteger(widthProduct) || !Number.isSafeInteger(maxRows))
    throw new Error("independent_public_relaxation_numeric_key_domain");
  const numeratorBits = input.prices.map((price) => price.n.toString(2).length);
  const denominatorBits = input.prices.map((price) => price.d.toString(2).length);
  const scaleBits = denominatorBits.reduce((sum, bits) => sum + bits, 0);
  const integralPriceBits = makeTriple(
    (color) => numeratorBits[color]! + scaleBits - denominatorBits[color]!,
  );
  const consumedBits = 10 * rootDepth + Math.max(1, (10 * rootDepth).toString(2).length) + 1;
  const burdenBits = consumedBits + Math.max(...integralPriceBits) + 2;
  const maximumRowBytes = 104 + 3 * Math.ceil(consumedBits / 8) + Math.ceil(burdenBits / 8);
  const logicalBreakdown = {
    graph: budget.graphBytes + 128,
    powers: Array.from(
      { length: rootDepth + 1 },
      (_, depth) => 32 + Math.ceil((10 * depth + 1) / 8),
    ).reduce((sum, n) => sum + n, 0),
    prices:
      7 * 32 +
      Math.ceil(scaleBits / 8) +
      integralPriceBits.reduce((sum, bits) => sum + Math.ceil(bits / 8), 0) +
      [...numeratorBits, ...denominatorBits].reduce((sum, bits) => sum + Math.ceil(bits / 8), 0),
    temporary: rootDepth * 6 * maximumRowBytes,
    output: 16 * maximumRowBytes,
  };
  const admittedLogicalUpperBytes =
    maxRows * maximumRowBytes + Object.values(logicalBreakdown).reduce((sum, n) => sum + n, 0);
  const reason =
    maxRows > budget.maxRows
      ? "independent_public_relaxation_row_admission"
      : admittedLogicalUpperBytes > budget.maxLogicalBytes
        ? "independent_public_relaxation_logical_admission"
        : null;
  return {
    admitted: reason === null,
    reason,
    reachablePublicNodes: dag.nodes.length,
    rootDepth,
    finiteColors,
    finiteWidths: widths,
    widthProduct,
    maxRows,
    maxKey: maxRows - 1,
    maximumRowBytes,
    admittedLogicalUpperBytes,
    logicalBreakdown,
    limits: { maxLogicalBytes: budget.maxLogicalBytes, maxRows: budget.maxRows },
    limbBasis: {
      consumedNumeratorBits: consumedBits,
      burdenNumeratorBits: burdenBits,
      integralPriceBits,
    },
  };
}

function prepare(
  input: PublicPathRelaxationInput,
  limits: PublicPathRelaxationLimits,
  started: number,
) {
  validateInput(input);
  const budget = new ProofBudget(limits, started);
  const dag = new PublicDag(input, budget);
  return { budget, dag, plan: planFor(input, dag, budget) };
}
/** Serializable rectangular-domain and exact-limb admission, before any worktable. */
export function estimatePublicPathRelaxationPair(
  input: PublicPathRelaxationInput,
  limits: PublicPathRelaxationLimits = {},
): PublicPathRelaxationPlan {
  return prepare(input, limits, performance.now()).plan;
}

function rowChoice(best: Row | null, candidate: Row): Row {
  if (!best) return candidate;
  if (candidate.burden < best.burden) return candidate;
  if (candidate.burden > best.burden) return best;
  const total = (row: Row) => row.consumed[0] + row.consumed[1] + row.consumed[2];
  if (total(candidate) < total(best)) return candidate;
  if (total(candidate) > total(best)) return best;
  return { ...best, mask: best.mask | candidate.mask };
}

/** At least one unlimited kit gives P=1 through this finite acyclic public DAG.
 * STOP's P=0 cannot tie; B then C are compared as exact integer numerators. */
class RelaxationTable {
  private readonly memo = new Map<number, Row>();
  private readonly powers = [1n];
  private readonly scale: bigint;
  private readonly prices: QTripleNumerators;
  private readonly finite: readonly boolean[];
  actions = 0;
  rowBytes = 0;
  constructor(
    input: PublicPathRelaxationInput,
    private readonly dag: PublicDag,
    private readonly plan: PublicPathRelaxationPlan,
    private readonly budget: ProofBudget,
  ) {
    if (!plan.admitted)
      throw new Error(plan.reason ?? "independent_public_relaxation_not_admitted");
    this.scale = input.prices.reduce((scale, price) => scale * price.d, 1n);
    this.prices = makeTriple(
      (color) => input.prices[color]!.n * (this.scale / input.prices[color]!.d),
    );
    this.finite = [0, 1, 2].map((color) => input.finiteColors.includes(color as Color));
    for (let depth = 1; depth <= plan.rootDepth; depth++)
      this.powers.push(this.powers[depth - 1]! * 1000n);
  }
  get memoRows(): number {
    return this.memo.size;
  }
  get logicalPayloadBytes(): number {
    return (
      this.rowBytes +
      this.plan.logicalBreakdown.graph +
      this.plan.logicalBreakdown.powers +
      this.plan.logicalBreakdown.prices
    );
  }
  private key(id: number, units: Triple): number {
    if (
      units.some((n, color) => !Number.isInteger(n) || n < 0 || n >= this.plan.finiteWidths[color]!)
    )
      throw new Error("independent_public_relaxation_outside_domain");
    return (
      id * this.plan.widthProduct +
      (units[0] * this.plan.finiteWidths[1] + units[1]) * this.plan.finiteWidths[2] +
      units[2]
    );
  }
  private action(node: Node, kit: number, units: Triple): Row {
    this.actions++;
    const edge = node.edges[kit]!,
      p = edge.probability;
    const remaining = makeTriple(
      (color) => units[color]! - (this.finite[kit] && color === kit ? 1 : 0),
    );
    const great = this.get(edge.great, remaining),
      ordinary = p < 1000 ? this.get(edge.ordinary, remaining) : EMPTY;
    const gd = node.depth - 1 - this.dag.nodes[edge.great]!.depth;
    const nd = p < 1000 ? node.depth - 1 - this.dag.nodes[edge.ordinary]!.depth : 0;
    if (gd < 0 || nd < 0) throw new Error("independent_public_relaxation_denominator_lift");
    const gm = BigInt(p) * this.powers[gd]!,
      nm = p < 1000 ? BigInt(1000 - p) * this.powers[nd]! : 0n;
    const denominator = this.powers[node.depth]!;
    return {
      consumed: makeTriple(
        (color) =>
          gm * great.consumed[color]! +
          nm * ordinary.consumed[color]! +
          (color === kit ? 10n * denominator : 0n),
      ),
      burden: gm * great.burden + nm * ordinary.burden + 10n * this.prices[kit]! * denominator,
      worst: makeTriple(
        (color) =>
          Math.max(great.worst[color]!, p < 1000 ? ordinary.worst[color]! : 0) +
          (color === kit ? 1 : 0),
      ),
      mask: 1 << kit,
      chosen: kit,
    };
  }
  private record(key: number, row: Row): void {
    const limb = (n: bigint) => Math.ceil(n.toString(2).length / 8);
    const bytes = 104 + row.consumed.reduce((sum, n) => sum + limb(n), 0) + limb(row.burden);
    if (bytes > this.plan.maximumRowBytes)
      throw new Error("independent_public_relaxation_limb_bound");
    this.rowBytes += bytes;
    const allowance = this.plan.logicalBreakdown.temporary + this.plan.logicalBreakdown.output;
    if (
      this.memo.size >= this.budget.maxRows ||
      this.logicalPayloadBytes + allowance > this.budget.maxLogicalBytes
    )
      throw new Error("independent_public_relaxation_runtime_admission");
    this.memo.set(key, row);
  }
  private get(id: number, units: Triple): Row {
    this.budget.check();
    const node = this.dag.nodes[id]!;
    if (node.depth === 0) return EMPTY;
    const key = this.key(id, units),
      previous = this.memo.get(key);
    if (previous) return previous;
    let best: Row | null = null;
    for (let kit = 0; kit < 3; kit++) {
      if (this.finite[kit] && units[kit] === 0) continue;
      best = rowChoice(best, this.action(node, kit, units));
    }
    if (!best) throw new Error("independent_public_relaxation_unlimited_completion_invariant");
    this.record(key, best);
    return best;
  }
  evaluate(stock: Triple): RelaxedValue {
    const units = makeTriple((color) => (this.finite[color] ? Math.floor(stock[color]! / 10) : 0));
    const row = this.get(this.dag.root, units),
      denominator = this.powers[this.plan.rootDepth]!;
    return {
      P: q(1),
      B: q(row.burden, denominator * this.scale),
      C: q(row.consumed[0] + row.consumed[1] + row.consumed[2], denominator),
      consumed: makeTriple((color) => q(row.consumed[color]!, denominator)),
      worst: row.worst,
      mask: row.mask,
      chosen: row.chosen,
    };
  }
}

function fits(value: RelaxedValue, stock: Triple): boolean {
  return value.worst.every((uses, color) => uses <= Math.floor(stock[color]! / 10));
}
function classify(result: PublicPathRelaxationResult): void {
  if (!result.afterFits) {
    result.reason = "independent_public_relaxation_after_policy_infeasible";
    return;
  }
  if (result.strictOrder !== 1) {
    result.reason = "independent_public_relaxation_no_strict_improvement";
    return;
  }
  result.status = result.beforeFits ? "PASS_ENDPOINTS_EQUALITY" : "PASS_N_ONLY";
}
/** Wafter exact+feasible and Wafter>Wbefore>=Vbefore proves finite strictness.
 * Both selected policies must fit for BOTH finite endpoint equalities. Receipt
 * support, cohort independence and date coupling are separate caller proofs. */
export function evaluatePublicPathRelaxationPair(
  input: PublicPathRelaxationInput,
  limits: PublicPathRelaxationLimits = {},
): PublicPathRelaxationResult {
  const started = performance.now();
  const result: PublicPathRelaxationResult = {
    status: "UNKNOWN",
    reason: null,
    plan: null,
    before: null,
    after: null,
    strictOrder: null,
    beforeFits: false,
    afterFits: false,
    diagnostics: { elapsedMs: 0, memoRows: 0, actions: 0, logicalPayloadBytes: 0 },
    rawException: null,
  };
  let table: RelaxationTable | null = null;
  try {
    const { budget, dag, plan } = prepare(input, limits, started);
    result.plan = plan;
    if (!plan.admitted)
      throw new Error(plan.reason ?? "independent_public_relaxation_not_admitted");
    table = new RelaxationTable(input, dag, plan, budget);
    result.before = table.evaluate(input.beforeStock);
    result.after = table.evaluate(input.afterStock);
    result.beforeFits = fits(result.before, input.beforeStock);
    result.afterFits = fits(result.after, input.afterStock);
    result.strictOrder = compareValue(result.after, result.before);
    classify(result);
    budget.check();
  } catch (error) {
    result.status = "NOTRUN";
    const exception = error instanceof Error ? error : new Error(String(error));
    result.reason = exception.message;
    result.rawException = {
      name: exception.name,
      message: exception.message,
      ...(exception.stack ? { stack: exception.stack } : {}),
    };
  }
  result.diagnostics = {
    elapsedMs: performance.now() - started,
    memoRows: table?.memoRows ?? 0,
    actions: table?.actions ?? 0,
    logicalPayloadBytes: table?.logicalPayloadBytes ?? 0,
  };
  return result;
}
