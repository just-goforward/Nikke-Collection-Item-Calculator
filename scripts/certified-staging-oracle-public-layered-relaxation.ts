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
export type PublicLayeredInput = State & {
  prices: QTriple;
  beforeStock: Triple;
  afterStock: Triple;
  finiteColors: readonly Color[];
};
export type PublicLayeredLimits = {
  deadlineAt?: number;
  maxLogicalBytes?: number;
  maxLiveRows?: number;
};
export type PublicLayeredPlan = {
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
  invariance: { unlimitedColors: readonly Color[]; beforeUses: Triple; afterUses: Triple };
};
type ExactEndpoint = OracleValue & { consumed: QTriple; mask: number; chosen: number };
export type PublicLayeredResult = {
  status: "PASS" | "NOTRUN";
  reason: string | null;
  plan: PublicLayeredPlan | null;
  before: ExactEndpoint | null;
  after: ExactEndpoint | null;
  strictOrder: -1 | 0 | 1 | null;
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
type Row = { consumed: readonly [bigint, bigint, bigint]; burden: bigint; mask: number };
const EMPTY: Row = { consumed: [0n, 0n, 0n], burden: 0n, mask: 0 };
const MAX_BYTES = 160 * 1024 * 1024;

class Budget {
  readonly deadlineAt: number;
  readonly maxLiveRows: number;
  readonly maxLogicalBytes: number;
  graphBytes = 0;
  constructor(limits: PublicLayeredLimits, started: number) {
    const rows = limits.maxLiveRows ?? 125_000;
    const bytes = limits.maxLogicalBytes ?? MAX_BYTES;
    if (![rows, bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error("public_layered_invalid_limits");
    this.maxLiveRows = Math.min(rows, 125_000);
    this.maxLogicalBytes = Math.min(bytes, MAX_BYTES);
    this.deadlineAt = Math.min(limits.deadlineAt ?? started + 10_000, started + 10_000);
    if (!Number.isFinite(this.deadlineAt)) throw new Error("public_layered_invalid_deadline");
    this.check();
  }
  check(): void {
    if (performance.now() >= this.deadlineAt) throw new Error("public_layered_deadline");
  }
  graphNode(): void {
    this.check();
    if (this.graphBytes + 200 > this.maxLogicalBytes)
      throw new Error("public_layered_graph_admission");
    this.graphBytes += 200;
  }
  graphOrder(nodes: number): void {
    const bytes = nodes * 8 + 128;
    if (this.graphBytes + bytes > this.maxLogicalBytes)
      throw new Error("public_layered_graph_admission");
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
    throw new Error("public_layered_invalid_state");
}
function validateInput(input: PublicLayeredInput): void {
  validateState(input);
  for (const stock of [input.beforeStock, input.afterStock]) {
    if (
      stock.length !== 3 ||
      ![0, 1, 2].every((color) => Number.isSafeInteger(stock[color]) && stock[color]! >= 0)
    )
      throw new Error("public_layered_invalid_stock");
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
    throw new Error("public_layered_invalid_prices");
  if (
    input.finiteColors.length > 2 ||
    new Set(input.finiteColors).size !== input.finiteColors.length ||
    !Array.from({ length: input.finiteColors.length }, (_, index) =>
      [0, 1, 2].includes(input.finiteColors[index]!),
    ).every(Boolean)
  )
    throw new Error("public_layered_requires_unlimited_color");
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
      .sort((a, b) => this.nodes[a]!.depth - this.nodes[b]!.depth);
  }
  private edge(state: State, color: number): Edge {
    const probability = independentProbability(state.grade, state.level, color);
    const numerator = probability.n * 1000n;
    if (numerator % probability.d !== 0n) throw new Error("public_layered_probability_denominator");
    const p = Number(numerator / probability.d);
    if (!Number.isInteger(p) || p <= 0 || p > 1000)
      throw new Error("public_layered_positive_great_probability_invariant");
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
      if (this.nodes[previous]!.depth < 0) throw new Error("public_layered_public_graph_cycle");
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
            this.nodes[edge.great]!.depth,
            this.nodes[edge.ordinary]!.depth,
          ]),
        );
    }
    return id;
  }
}

function adjacentTuples(finite: readonly Color[], units: Triple): number {
  if (!finite.length) return 1;
  if (finite.length === 1) return units[finite[0]!] ? 2 : 1;
  const a = units[finite[0]!]!,
    b = units[finite[1]!]!;
  return a === b ? 2 * a + 1 : 2 * (Math.min(a, b) + 1);
}
function invariance(input: PublicLayeredInput, finite: readonly Color[], depth: number) {
  const beforeUses = makeTriple((color) => Math.floor(input.beforeStock[color]! / 10));
  const afterUses = makeTriple((color) => Math.floor(input.afterStock[color]! / 10));
  const unlimitedColors = ([0, 1, 2] as const).filter((color) => !finite.includes(color));
  if (!unlimitedColors.every((color) => Math.min(beforeUses[color], afterUses[color]) >= depth))
    throw new Error("public_layered_stock_invariance_not_proved");
  return { unlimitedColors, beforeUses, afterUses };
}
function planFor(input: PublicLayeredInput, graph: PublicGraph, budget: Budget): PublicLayeredPlan {
  const finiteColors = [...input.finiteColors].sort((a, b) => a - b);
  const rootDepth = graph.nodes[graph.root]!.depth;
  const proof = invariance(input, finiteColors, rootDepth);
  const units = makeTriple((color) =>
    finiteColors.includes(color as Color)
      ? Math.max(proof.beforeUses[color]!, proof.afterUses[color]!)
      : 0,
  );
  const widths = makeTriple((color) => units[color]! + 1);
  const widthProduct = widths.reduce((product, width) => product * width, 1);
  const nonterminalNodes = graph.nodes.filter((node) => node.depth > 0).length;
  const maximumKey = graph.nodes.length * widthProduct - 1;
  const finiteLayers = units.reduce((total, n) => total + n, 0) + 1;
  if (![maximumKey, finiteLayers].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("public_layered_numeric_key_domain");
  const numeratorBits = input.prices.map((price) => price.n.toString(2).length);
  const denominatorBits = input.prices.map((price) => price.d.toString(2).length);
  const scaleBits = denominatorBits.reduce((total, bits) => total + bits, 0);
  const integralBits = makeTriple(
    (color) => numeratorBits[color]! + scaleBits - denominatorBits[color]!,
  );
  const consumedBits = 10 * rootDepth + Math.max(1, (10 * rootDepth).toString(2).length) + 1;
  const maximumRowBytes =
    104 +
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
  const reason =
    maximumLiveRows > budget.maxLiveRows
      ? "public_layered_live_row_admission"
      : logicalUpperBytes > budget.maxLogicalBytes
        ? "public_layered_logical_admission"
        : null;
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
    invariance: proof,
  };
}
function prepare(input: PublicLayeredInput, limits: PublicLayeredLimits, started: number) {
  validateInput(input);
  const budget = new Budget(limits, started);
  const graph = new PublicGraph(input, budget);
  return { budget, graph, plan: planFor(input, graph, budget) };
}
export function estimatePublicLayeredRelaxationPair(
  input: PublicLayeredInput,
  limits: PublicLayeredLimits = {},
): PublicLayeredPlan {
  return prepare(input, limits, performance.now()).plan;
}

function* tuples(layer: number, finite: readonly Color[], widths: Triple): Generator<Triple> {
  if (!finite.length) {
    yield [0, 0, 0];
    return;
  }
  if (finite.length === 1) {
    yield makeTriple((color) => (color === finite[0] ? layer : 0));
    return;
  }
  const a = finite[0]!,
    b = finite[1]!;
  for (let n = Math.max(0, layer - widths[b] + 1); n <= Math.min(widths[a] - 1, layer); n++)
    yield makeTriple((color) => (color === a ? n : color === b ? layer - n : 0));
}
function choose(best: Row | null, value: Row): Row {
  if (!best || value.burden < best.burden) return value;
  if (value.burden > best.burden) return best;
  const sum = (row: Row) => row.consumed[0] + row.consumed[1] + row.consumed[2];
  if (sum(value) < sum(best)) return value;
  if (sum(value) > sum(best)) return best;
  return { ...best, mask: best.mask | value.mask };
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
    input: PublicLayeredInput,
    private readonly graph: PublicGraph,
    private readonly plan: PublicLayeredPlan,
    private readonly budget: Budget,
  ) {
    if (!plan.admitted) throw new Error(plan.reason ?? "public_layered_not_admitted");
    this.scale = input.prices.reduce((a, price) => a * price.d, 1n);
    this.prices = makeTriple(
      (color) => input.prices[color]!.n * (this.scale / input.prices[color]!.d),
    );
    this.finite = [0, 1, 2].map((color) => plan.finiteColors.includes(color as Color));
    for (let d = 1; d <= plan.rootDepth; d++) this.powers.push(this.powers[d - 1]! * 1000n);
  }
  private key(id: number, units: Triple): number {
    if (
      ![0, 1, 2].every(
        (color) =>
          Number.isInteger(units[color]) &&
          units[color]! >= 0 &&
          units[color]! < this.plan.finiteWidths[color]!,
      )
    )
      throw new Error("public_layered_outside_key_domain");
    return (
      id * this.plan.widthProduct +
      (units[0] * this.plan.finiteWidths[1] + units[1]) * this.plan.finiteWidths[2] +
      units[2]
    );
  }
  private child(id: number, units: Triple, table: ReadonlyMap<number, Row>): Row {
    if (this.graph.nodes[id]!.depth === 0) return EMPTY;
    const value = table.get(this.key(id, units));
    if (!value) throw new Error("public_layered_missing_positive_child");
    return value;
  }
  private action(node: Node, units: Triple, color: number): Row {
    const remaining = makeTriple(
      (index) => units[index]! - (this.finite[color] && index === color ? 1 : 0),
    );
    const table = this.finite[color] ? this.previous : this.current;
    const edge = node.edges[color]!;
    const great = this.child(edge.great, remaining, table);
    const ordinary = edge.p < 1000 ? this.child(edge.ordinary, remaining, table) : EMPTY;
    const gd = node.depth - 1 - this.graph.nodes[edge.great]!.depth;
    const nd = edge.p < 1000 ? node.depth - 1 - this.graph.nodes[edge.ordinary]!.depth : 0;
    if (gd < 0 || nd < 0) throw new Error("public_layered_denominator_lift");
    const gm = BigInt(edge.p) * this.powers[gd]!;
    const nm = edge.p < 1000 ? BigInt(1000 - edge.p) * this.powers[nd]! : 0n;
    const denominator = this.powers[node.depth]!;
    return {
      consumed: makeTriple(
        (index) =>
          gm * great.consumed[index]! +
          nm * ordinary.consumed[index]! +
          (index === color ? 10n * denominator : 0n),
      ),
      burden: gm * great.burden + nm * ordinary.burden + 10n * this.prices[color]! * denominator,
      mask: 1 << color,
    };
  }
  private row(node: Node, units: Triple): Row {
    let best: Row | null = null;
    for (let color = 0; color < 3; color++) {
      if (this.finite[color] && units[color] === 0) continue;
      best = choose(best, this.action(node, units, color));
    }
    if (!best) throw new Error("public_layered_unlimited_completion_invariant");
    return best;
  }
  private record(id: number, units: Triple): void {
    this.budget.check();
    const live = this.previous.size + this.current.size + 1;
    if (live > this.plan.maximumLiveRows || live > this.budget.maxLiveRows)
      throw new Error("public_layered_runtime_live_admission");
    const value = this.row(this.graph.nodes[id]!, units);
    const limb = (n: bigint) => Math.ceil(n.toString(2).length / 8);
    const bytes = 104 + value.consumed.reduce((a, n) => a + limb(n), 0) + limb(value.burden);
    if (bytes > this.plan.maximumRowBytes) throw new Error("public_layered_runtime_limb_admission");
    this.current.set(this.key(id, units), value);
    this.peakLiveRows = Math.max(this.peakLiveRows, live);
    this.cumulativeRows++;
  }
  private view(row: Row): ExactEndpoint {
    const denominator = this.powers[this.plan.rootDepth]!;
    return {
      P: q(1),
      B: q(row.burden, denominator * this.scale),
      C: q(row.consumed[0] + row.consumed[1] + row.consumed[2], denominator),
      consumed: makeTriple((color) => q(row.consumed[color]!, denominator)),
      mask: row.mask,
      chosen: [0, 1, 2].find((color) => row.mask & (1 << color)) ?? -1,
    };
  }
  evaluate(input: PublicLayeredInput): { before: ExactEndpoint; after: ExactEndpoint } {
    const before = makeTriple((color) =>
      this.finite[color] ? Math.floor(input.beforeStock[color]! / 10) : 0,
    );
    const after = makeTriple((color) =>
      this.finite[color] ? Math.floor(input.afterStock[color]! / 10) : 0,
    );
    let beforeValue: ExactEndpoint | null = null,
      afterValue: ExactEndpoint | null = null;
    for (let layer = 0; layer < this.plan.finiteLayers; layer++) {
      this.budget.check();
      for (const units of tuples(layer, this.plan.finiteColors, this.plan.finiteWidths)) {
        for (const id of this.graph.order)
          if (this.graph.nodes[id]!.depth > 0) this.record(id, units);
        const root =
          this.graph.nodes[this.graph.root]!.depth === 0
            ? EMPTY
            : this.current.get(this.key(this.graph.root, units));
        if (!root) throw new Error("public_layered_missing_root");
        if (units.every((n, color) => n === before[color])) beforeValue = this.view(root);
        if (units.every((n, color) => n === after[color])) afterValue = this.view(root);
      }
      this.previous = this.current;
      this.current = new Map();
    }
    if (!beforeValue || !afterValue) throw new Error("public_layered_missing_endpoint");
    return { before: beforeValue, after: afterValue };
  }
}

/** Actual finite values under a proved ALL-policy unlimited-color stock invariant.
 * Only adjacent finite-inventory sum layers survive; same-layer dependencies use
 * child-before-parent public-DAG order. Cumulative work is distinct from live rows. */
export function evaluatePublicLayeredRelaxationPair(
  input: PublicLayeredInput,
  limits: PublicLayeredLimits = {},
): PublicLayeredResult {
  const started = performance.now();
  const result: PublicLayeredResult = {
    status: "NOTRUN",
    reason: null,
    plan: null,
    before: null,
    after: null,
    strictOrder: null,
    diagnostics: { elapsedMs: 0, cumulativeRows: 0, peakLiveRows: 0, logicalUpperBytes: 0 },
    rawException: null,
  };
  let table: LayerTable | null = null;
  try {
    const { budget, graph, plan } = prepare(input, limits, started);
    result.plan = plan;
    if (!plan.admitted) throw new Error(plan.reason ?? "public_layered_not_admitted");
    table = new LayerTable(input, graph, plan, budget);
    const values = table.evaluate(input);
    result.before = values.before;
    result.after = values.after;
    result.strictOrder = compareValue(values.after, values.before);
    budget.check();
    result.status = "PASS";
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
