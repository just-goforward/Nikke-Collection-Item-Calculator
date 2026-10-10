import {
  canonicalState,
  independentFailure,
  independentProbability,
  independentSuccess,
  type OracleInput,
  type OracleValue,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";

type Color = 0 | 1 | 2;
type State = Pick<OracleInput, "grade" | "level" | "exp">;
export type PublicFeasibilityInput = State & {
  prices: QTriple;
  stock: Triple;
  finiteColors: readonly Color[];
};
export type PublicFeasibilityLimits = {
  deadlineAt?: number;
  maxLogicalBytes?: number;
  maxLiveRows?: number;
};
export type PublicFeasibilityPlan = {
  admitted: boolean;
  reason: string | null;
  publicNodes: number;
  nonterminalNodes: number;
  rootDepth: number;
  finiteColors: readonly Color[];
  finiteWidths: Triple;
  widthProduct: number;
  finiteLayers: number;
  cumulativeRows: number;
  maximumLiveRows: number;
  maximumKey: number;
  maximumRowBytes: number;
  logicalUpperBytes: number;
  logicalBreakdown: { graph: number; powers: number; prices: number; temporaryAndOutput: number };
  limits: { maxLiveRows: number; maxLogicalBytes: number };
  feasibility: { unlimitedColors: readonly Color[]; actualUses: Triple };
};
type ExactEndpoint = OracleValue & { consumed: QTriple; mask: number; chosen: number };
type RelaxedEndpoint = ExactEndpoint & { worstAll: Triple };
export type PublicFeasibilityResult = {
  status: "PASS" | "UNKNOWN" | "NOTRUN";
  reason: string | null;
  plan: PublicFeasibilityPlan | null;
  value: ExactEndpoint | null;
  relaxed: RelaxedEndpoint | null;
  allOptimalPoliciesFit: boolean | null;
  diagnostics: {
    elapsedMs: number;
    cumulativeRows: number;
    peakLiveRows: number;
    logicalUpperBytes: number;
  };
  rawException: { name: string; message: string; stack?: string } | null;
};
type Edge = { p: number; great: number; ordinary: number };
type Node = { state: State; depth: number; edges: Edge[] };
// Array reads remain possibly missing. These named-property boundaries
// preserve the original native property reads (including undefined errors);
// no numeric index is claimed to be total or refined by a cast.
const graphProperty = ((value: Partial<Node & Edge>, key: keyof (Node & Edge)) => value[key]) as {
  (value: undefined, key: keyof (Node & Edge)): never;
  (value: Node | undefined, key: "depth"): number;
  (value: Node | undefined, key: "edges"): Edge[];
  (value: Edge | undefined, key: "p" | "great" | "ordinary"): number;
};
// A missing power is an operand of the original bigint multiplication, not
// a successful table read. Native multiplication preserves its TypeError.
const multiplyPower = ((left: bigint, right: bigint) => left * right) as {
  (left: bigint, right: bigint | undefined): bigint;
  (left: bigint | undefined, right: bigint): bigint;
};
type Row = {
  consumed: readonly [bigint, bigint, bigint];
  burden: bigint;
  mask: number;
  worstAll: Triple;
};
const EMPTY: Row = { consumed: [0n, 0n, 0n], burden: 0n, mask: 0, worstAll: [0, 0, 0] };
const MAX_BYTES = 160 * 1024 * 1024;

class Budget {
  readonly deadlineAt: number;
  readonly maxLiveRows: number;
  readonly maxLogicalBytes: number;
  graphBytes = 0;
  constructor(limits: PublicFeasibilityLimits, started: number) {
    const rows = limits.maxLiveRows ?? 125_000;
    const bytes = limits.maxLogicalBytes ?? MAX_BYTES;
    if (![rows, bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error("public_feasibility_invalid_limits");
    this.maxLiveRows = Math.min(rows, 125_000);
    this.maxLogicalBytes = Math.min(bytes, MAX_BYTES);
    this.deadlineAt = Math.min(limits.deadlineAt ?? started + 10_000, started + 10_000);
    if (!Number.isFinite(this.deadlineAt)) throw new Error("public_feasibility_invalid_deadline");
    this.check();
  }
  check(): void {
    if (performance.now() >= this.deadlineAt) throw new Error("public_feasibility_deadline");
  }
  graphNode(): void {
    this.check();
    if (this.graphBytes + 200 > this.maxLogicalBytes)
      throw new Error("public_feasibility_graph_admission");
    this.graphBytes += 200;
  }
  graphOrder(nodes: number): void {
    const bytes = nodes * 8 + 128;
    if (this.graphBytes + bytes > this.maxLogicalBytes)
      throw new Error("public_feasibility_graph_admission");
    this.graphBytes += bytes;
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
    throw new Error("public_feasibility_invalid_state");
}
function validateInput(input: PublicFeasibilityInput): void {
  validateState(input);
  for (const stock of [input.stock]) {
    if (
      stock.length !== 3 ||
      !([0, 1, 2] as const).every(
        (color) => Number.isSafeInteger(stock[color]) && stock[color] >= 0,
      )
    )
      throw new Error("public_feasibility_invalid_stock");
  }
  if (
    input.prices.length !== 3 ||
    ![0, 1, 2].every((color) => {
      const price = input.prices[color];
      return (
        price &&
        typeof price.n === "bigint" &&
        typeof price.d === "bigint" &&
        price.n >= 0n &&
        price.d > 0n
      );
    })
  )
    throw new Error("public_feasibility_invalid_prices");
  if (
    input.finiteColors.length > 2 ||
    new Set(input.finiteColors).size !== input.finiteColors.length ||
    !Array.from({ length: input.finiteColors.length }, (_, index) => {
      const color = input.finiteColors[index];
      return color !== undefined && [0, 1, 2].includes(color);
    }).every(Boolean)
  )
    throw new Error("public_feasibility_requires_unlimited_color");
}

/** Public transitions only. Depth and child order include every positive branch. */
class PublicGraph {
  readonly nodes: Node[] = [];
  readonly root: number;
  readonly order: number[];
  private readonly ids = new Map<string, number>();
  constructor(
    state: State,
    private readonly budget: Budget,
  ) {
    this.root = this.visit(state);
    this.budget.graphOrder(this.nodes.length);
    this.order = this.nodes
      .map((_node, id) => id)
      .sort(
        (a, b) => graphProperty(this.nodes[a], "depth") - graphProperty(this.nodes[b], "depth"),
      );
  }
  private edge(state: State, color: number): Edge {
    const probability = independentProbability(state.grade, state.level, color);
    const numerator = probability.n * 1000n;
    if (numerator % probability.d !== 0n)
      throw new Error("public_feasibility_probability_denominator");
    const p = Number(numerator / probability.d);
    if (!Number.isInteger(p) || p <= 0 || p > 1000)
      throw new Error("public_feasibility_positive_great_probability_invariant");
    const great = this.visit(independentSuccess(state.grade, state.level));
    const ordinary =
      p < 1000 ? this.visit(independentFailure(state.grade, state.level, state.exp, color)) : great;
    return { p, great, ordinary };
  }
  private visit(raw: State): number {
    this.budget.check();
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    const key = `${state.grade}:${state.level}:${state.exp}`;
    const previous = this.ids.get(key);
    if (previous !== undefined) {
      if (graphProperty(this.nodes[previous], "depth") < 0)
        throw new Error("public_feasibility_public_graph_cycle");
      return previous;
    }
    this.budget.graphNode();
    const id = this.nodes.length;
    const node: Node = { state, depth: -1, edges: [] };
    this.nodes.push(node);
    this.ids.set(key, id);
    if (state.grade === "SR" && state.level === 15) node.depth = 0;
    else {
      for (let color = 0; color < 3; color++) node.edges.push(this.edge(state, color));
      node.depth =
        1 +
        Math.max(
          ...node.edges.flatMap((edge) => [
            graphProperty(this.nodes[edge.great], "depth"),
            graphProperty(this.nodes[edge.ordinary], "depth"),
          ]),
        );
    }
    return id;
  }
}

function adjacentTuples(finite: readonly Color[], units: Triple): number {
  const [first, second] = finite;
  if (first === undefined) return 1;
  const a = units[first];
  if (second === undefined) return a ? 2 : 1;
  const b = units[second];
  return a === b ? 2 * a + 1 : 2 * (Math.min(a, b) + 1);
}
function feasibility(input: PublicFeasibilityInput, finite: readonly Color[]) {
  const actualUses = makeTriple((color) => Math.floor(input.stock[color] / 10));
  const unlimitedColors = ([0, 1, 2] as const).filter((color) => !finite.includes(color));
  return { unlimitedColors, actualUses };
}
function planFor(
  input: PublicFeasibilityInput,
  graph: PublicGraph,
  budget: Budget,
): PublicFeasibilityPlan {
  const finiteColors = [...input.finiteColors].sort((a, b) => a - b);
  const rootDepth = graphProperty(graph.nodes[graph.root], "depth");
  const proof = feasibility(input, finiteColors);
  const units = makeTriple((color) =>
    finiteColors.includes(color as Color) ? proof.actualUses[color] : 0,
  );
  const widths = makeTriple((color) => units[color] + 1);
  const widthProduct = widths.reduce((product, width) => product * width, 1);
  const nonterminalNodes = graph.nodes.filter((node) => node.depth > 0).length;
  const maximumKey = graph.nodes.length * widthProduct - 1;
  const finiteLayers = units.reduce((total, n) => total + n, 0) + 1;
  if (![maximumKey, finiteLayers].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("public_feasibility_numeric_key_domain");
  const numeratorBits = mapTriple(input.prices, (price) => price.n.toString(2).length);
  const denominatorBits = mapTriple(input.prices, (price) => price.d.toString(2).length);
  const scaleBits = denominatorBits.reduce((total, bits) => total + bits, 0);
  const integralBits = makeTriple(
    (color) => numeratorBits[color] + scaleBits - denominatorBits[color],
  );
  const consumedBits = 10 * rootDepth + Math.max(1, (10 * rootDepth).toString(2).length) + 1;
  const maximumRowBytes =
    128 +
    3 * Math.ceil(consumedBits / 8) +
    Math.ceil((consumedBits + Math.max(...integralBits) + 2) / 8);
  const maximumLiveRows = nonterminalNodes * adjacentTuples(finiteColors, units);
  const logicalBreakdown = {
    graph: budget.graphBytes,
    powers: Array.from(
      { length: rootDepth + 1 },
      (_, d) => 32 + Math.ceil((10 * d + 1) / 8),
    ).reduce((a, b) => a + b, 0),
    prices:
      7 * 32 +
      Math.ceil(scaleBits / 8) +
      integralBits.reduce((a, bits) => a + Math.ceil(bits / 8), 0) +
      [...numeratorBits, ...denominatorBits].reduce((a, bits) => a + Math.ceil(bits / 8), 0),
    temporaryAndOutput: 40 * maximumRowBytes,
  };
  const logicalUpperBytes =
    maximumLiveRows * maximumRowBytes + Object.values(logicalBreakdown).reduce((a, b) => a + b, 0);
  let reason: string | null = null;
  if (maximumLiveRows > budget.maxLiveRows) {
    reason = "public_feasibility_live_row_admission";
  } else if (logicalUpperBytes > budget.maxLogicalBytes) {
    reason = "public_feasibility_logical_admission";
  }
  return {
    admitted: reason === null,
    reason,
    publicNodes: graph.nodes.length,
    nonterminalNodes,
    rootDepth,
    finiteColors,
    finiteWidths: widths,
    widthProduct,
    finiteLayers,
    cumulativeRows: nonterminalNodes * widthProduct,
    maximumLiveRows,
    maximumKey,
    maximumRowBytes,
    logicalUpperBytes,
    logicalBreakdown,
    limits: { maxLiveRows: budget.maxLiveRows, maxLogicalBytes: budget.maxLogicalBytes },
    feasibility: proof,
  };
}
function prepare(input: PublicFeasibilityInput, limits: PublicFeasibilityLimits, started: number) {
  validateInput(input);
  const budget = new Budget(limits, started);
  const graph = new PublicGraph(input, budget);
  return { budget, graph, plan: planFor(input, graph, budget) };
}
export function estimatePublicLayeredFeasibility(
  input: PublicFeasibilityInput,
  limits: PublicFeasibilityLimits = {},
): PublicFeasibilityPlan {
  return prepare(input, limits, performance.now()).plan;
}

function* tuples(layer: number, finite: readonly Color[], widths: Triple): Generator<Triple> {
  const [a, b] = finite;
  if (a === undefined) {
    yield [0, 0, 0];
    return;
  }
  if (b === undefined) {
    yield makeTriple((color) => (color === a ? layer : 0));
    return;
  }
  for (let n = Math.max(0, layer - widths[b] + 1); n <= Math.min(widths[a] - 1, layer); n++)
    yield makeTriple((color) => {
      if (color === a) return n;
      if (color === b) return layer - n;
      return 0;
    });
}
function choose(best: Row | null, value: Row): Row {
  if (!best || value.burden < best.burden) return value;
  if (value.burden > best.burden) return best;
  const sum = (row: Row) => row.consumed[0] + row.consumed[1] + row.consumed[2];
  if (sum(value) < sum(best)) return value;
  if (sum(value) > sum(best)) return best;
  return {
    ...best,
    mask: best.mask | value.mask,
    worstAll: makeTriple((color) => Math.max(best.worstAll[color], value.worstAll[color])),
  };
}

class LayerTable {
  private previous = new Map<number, Row>();
  private current = new Map<number, Row>();
  private readonly powers = [1n];
  private readonly scale: bigint;
  private readonly prices: readonly [bigint, bigint, bigint];
  private readonly finite: readonly boolean[];
  cumulativeRows = 0;
  peakLiveRows = 0;
  constructor(
    input: PublicFeasibilityInput,
    private readonly graph: PublicGraph,
    private readonly plan: PublicFeasibilityPlan,
    private readonly budget: Budget,
  ) {
    if (!plan.admitted) throw new Error(plan.reason ?? "public_feasibility_not_admitted");
    this.scale = input.prices.reduce((a, price) => a * price.d, 1n);
    this.prices = makeTriple(
      (color) => input.prices[color].n * (this.scale / input.prices[color].d),
    );
    this.finite = [0, 1, 2].map((color) => plan.finiteColors.includes(color as Color));
    let power = 1n;
    for (let d = 1; d <= plan.rootDepth; d++) {
      power *= 1000n;
      this.powers.push(power);
    }
  }
  private key(id: number, units: Triple): number {
    if (
      !([0, 1, 2] as const).every(
        (color) =>
          Number.isInteger(units[color]) &&
          units[color] >= 0 &&
          units[color] < this.plan.finiteWidths[color],
      )
    )
      throw new Error("public_feasibility_outside_key_domain");
    return (
      id * this.plan.widthProduct +
      (units[0] * this.plan.finiteWidths[1] + units[1]) * this.plan.finiteWidths[2] +
      units[2]
    );
  }
  private child(id: number, units: Triple, table: ReadonlyMap<number, Row>): Row {
    if (graphProperty(this.graph.nodes[id], "depth") === 0) return EMPTY;
    const value = table.get(this.key(id, units));
    if (!value) throw new Error("public_feasibility_missing_positive_child");
    return value;
  }
  private action(node: Node | undefined, units: Triple, color: Color): Row {
    const remaining = makeTriple(
      (index) => units[index] - (this.finite[color] && index === color ? 1 : 0),
    );
    const table = this.finite[color] ? this.previous : this.current;
    const edge = graphProperty(node, "edges")[color];
    const great = this.child(graphProperty(edge, "great"), remaining, table);
    const ordinary =
      graphProperty(edge, "p") < 1000
        ? this.child(graphProperty(edge, "ordinary"), remaining, table)
        : EMPTY;
    const gd =
      graphProperty(node, "depth") -
      1 -
      graphProperty(this.graph.nodes[graphProperty(edge, "great")], "depth");
    const nd =
      graphProperty(edge, "p") < 1000
        ? graphProperty(node, "depth") -
          1 -
          graphProperty(this.graph.nodes[graphProperty(edge, "ordinary")], "depth")
        : 0;
    if (gd < 0 || nd < 0) throw new Error("public_feasibility_denominator_lift");
    const gm = multiplyPower(BigInt(graphProperty(edge, "p")), this.powers[gd]);
    const nm =
      graphProperty(edge, "p") < 1000
        ? multiplyPower(BigInt(1000 - graphProperty(edge, "p")), this.powers[nd])
        : 0n;
    const denominator = this.powers[graphProperty(node, "depth")];
    return {
      consumed: makeTriple(
        (index) =>
          gm * great.consumed[index] +
          nm * ordinary.consumed[index] +
          (index === color ? multiplyPower(10n, denominator) : 0n),
      ),
      burden:
        gm * great.burden +
        nm * ordinary.burden +
        multiplyPower(10n * this.prices[color], denominator),
      mask: 1 << color,
      worstAll: makeTriple(
        (index) =>
          Math.max(great.worstAll[index], ordinary.worstAll[index]) + (index === color ? 1 : 0),
      ),
    };
  }
  private row(node: Node | undefined, units: Triple): Row {
    let best: Row | null = null;
    for (const color of [0, 1, 2] as const) {
      if (this.finite[color] && units[color] === 0) continue;
      best = choose(best, this.action(node, units, color));
    }
    if (!best) throw new Error("public_feasibility_unlimited_completion_invariant");
    return best;
  }
  private record(id: number, units: Triple): void {
    this.budget.check();
    const live = this.previous.size + this.current.size + 1;
    if (live > this.plan.maximumLiveRows || live > this.budget.maxLiveRows)
      throw new Error("public_feasibility_runtime_live_admission");
    const value = this.row(this.graph.nodes[id], units);
    const limb = (n: bigint) => Math.ceil(n.toString(2).length / 8);
    const bytes = 128 + value.consumed.reduce((a, n) => a + limb(n), 0) + limb(value.burden);
    if (bytes > this.plan.maximumRowBytes)
      throw new Error("public_feasibility_runtime_limb_admission");
    if (
      !value.worstAll.every(
        (n) =>
          Number.isSafeInteger(n) && n >= 0 && n <= graphProperty(this.graph.nodes[id], "depth"),
      )
    )
      throw new Error("public_feasibility_runtime_worst_use_invariant");
    this.current.set(this.key(id, units), value);
    this.peakLiveRows = Math.max(this.peakLiveRows, live);
    this.cumulativeRows++;
  }
  private view(row: Row): RelaxedEndpoint {
    const denominator = this.powers[this.plan.rootDepth];
    return {
      P: q(1),
      B: q(row.burden, multiplyPower(denominator, this.scale)),
      C: q(row.consumed[0] + row.consumed[1] + row.consumed[2], denominator),
      consumed: makeTriple((color) => q(row.consumed[color], denominator)),
      mask: row.mask,
      chosen: [0, 1, 2].find((color) => row.mask & (1 << color)) ?? -1,
      worstAll: row.worstAll,
    };
  }
  evaluate(input: PublicFeasibilityInput): RelaxedEndpoint {
    const target = makeTriple((color) =>
      this.finite[color] ? Math.floor(input.stock[color] / 10) : 0,
    );
    let rootValue: RelaxedEndpoint | null = null;
    for (let layer = 0; layer < this.plan.finiteLayers; layer++) {
      this.budget.check();
      for (const units of tuples(layer, this.plan.finiteColors, this.plan.finiteWidths)) {
        for (const id of this.graph.order)
          if (graphProperty(this.graph.nodes[id], "depth") > 0) this.record(id, units);
        const root =
          graphProperty(this.graph.nodes[this.graph.root], "depth") === 0
            ? EMPTY
            : this.current.get(this.key(this.graph.root, units));
        if (!root) throw new Error("public_feasibility_missing_root");
        if (units.every((n, color) => n === target[color])) rootValue = this.view(root);
      }
      this.previous = this.current;
      this.current = new Map();
    }
    if (!rootValue) throw new Error("public_feasibility_missing_endpoint");
    return rootValue;
  }
}

/** Exact relaxed P/B/C, ALL tied-policy worst uses and adjacent-layer retirement.
 * Finite-value and ALL-mask claims require every optimal policy's worst omitted
 * stock use to fit actual stock. Failure remains UNKNOWN, not a finite value. */
export function evaluatePublicLayeredFeasibility(
  input: PublicFeasibilityInput,
  limits: PublicFeasibilityLimits = {},
): PublicFeasibilityResult {
  const started = performance.now();
  const result: PublicFeasibilityResult = {
    status: "NOTRUN",
    reason: null,
    plan: null,
    value: null,
    relaxed: null,
    allOptimalPoliciesFit: null,
    diagnostics: { elapsedMs: 0, cumulativeRows: 0, peakLiveRows: 0, logicalUpperBytes: 0 },
    rawException: null,
  };
  let table: LayerTable | null = null;
  try {
    const { budget, graph, plan } = prepare(input, limits, started);
    result.plan = plan;
    if (!plan.admitted) throw new Error(plan.reason ?? "public_feasibility_not_admitted");
    table = new LayerTable(input, graph, plan, budget);
    const relaxed = table.evaluate(input);
    result.relaxed = relaxed;
    result.allOptimalPoliciesFit = plan.feasibility.unlimitedColors.every(
      (color) => relaxed.worstAll[color] <= plan.feasibility.actualUses[color],
    );
    budget.check();
    if (result.allOptimalPoliciesFit) {
      result.value = relaxed;
      result.status = "PASS";
    } else {
      result.status = "UNKNOWN";
      result.reason = "public_feasibility_all_optimal_policies_exceed_stock";
    }
  } catch (error) {
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
    cumulativeRows: table?.cumulativeRows ?? 0,
    peakLiveRows: table?.peakLiveRows ?? 0,
    logicalUpperBytes: result.plan?.logicalUpperBytes ?? 0,
  };
  return result;
}
