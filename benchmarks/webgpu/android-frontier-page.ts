import {
  buildCompactStateGraph,
  COMPACT_GRAPH_DIMENSIONS,
  compactTransitionTable,
  expandFrontierKeysCpu,
  stateStockKey,
} from "../compact-exact-graph";
import { createWebGpuFrontierSession } from "./compact-frontier-kernel";

type AndroidFrontierResult =
  | {
      outcome: "completed";
      exactSetMatch: boolean;
      runs: Array<{ elapsedMs: number; exactSetMatch: boolean; metadata: unknown }>;
      graph: { states: number; edges: number; inputKeys: number; outputKeys: number };
      census: {
        outcome: "completed" | "budget_exceeded";
        states: number;
        layers: number;
        maxFrontier: number;
        elapsedMs: number;
        metadata: unknown;
      };
    }
  | { outcome: "device_unavailable" | "device_lost" | "failure"; error: string };

async function run(): Promise<AndroidFrontierResult> {
  const built = buildCompactStateGraph(
    { grade: "SR", level: 10, exp: 2900 },
    { blue: 30, purple: 30, yellow: 30 },
    { stateBudget: 250_000 },
  );
  if (built.outcome !== "completed") {
    throw new Error("Android WebGPU parity fixture exceeded its CPU graph budget.");
  }
  const layers = new Map<number, number[]>();
  for (const node of built.graph.nodes) {
    if (node.edges.length === 0) continue;
    const layer = layers.get(node.stockTotal) ?? [];
    layer.push(node.key);
    layers.set(node.stockTotal, layer);
  }
  const selected = [...layers.entries()].sort(
    (left, right) => right[1].length - left[1].length || right[0] - left[0],
  )[0];
  if (!selected) throw new Error("Android WebGPU parity fixture has no expandable layer.");
  const inputKeys = selected[1].sort((left, right) => left - right);
  const expected = expandFrontierKeysCpu(inputKeys);
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    const session = await createWebGpuFrontierSession(
      compactTransitionTable(),
      COMPACT_GRAPH_DIMENSIONS,
      inputKeys.length,
    );
    try {
      const startedAt = performance.now();
      const keys = await session.expand(inputKeys);
      runs.push({
        elapsedMs: performance.now() - startedAt,
        exactSetMatch: JSON.stringify(keys) === JSON.stringify(expected),
        metadata: session.metadata,
      });
    } finally {
      session.close();
    }
  }

  const censusSession = await createWebGpuFrontierSession(
    compactTransitionTable(),
    COMPACT_GRAPH_DIMENSIONS,
    1_200_000,
  );
  let frontier = [
    stateStockKey({ grade: "R", level: 10, exp: 0 }, { blue: 30, purple: 30, yellow: 30 }),
  ];
  let states = 0;
  let layersVisited = 0;
  let maxFrontier = 0;
  const censusStartedAt = performance.now();
  try {
    while (frontier.length > 0 && layersVisited < 91) {
      if (states + frontier.length > 1_200_000) break;
      states += frontier.length;
      maxFrontier = Math.max(maxFrontier, frontier.length);
      frontier = await censusSession.expand(frontier);
      layersVisited += 1;
    }
    const census = {
      outcome: frontier.length === 0 ? ("completed" as const) : ("budget_exceeded" as const),
      states,
      layers: layersVisited,
      maxFrontier,
      elapsedMs: performance.now() - censusStartedAt,
      metadata: censusSession.metadata,
    };
    return {
      outcome: "completed",
      exactSetMatch: runs.every((item) => item.exactSetMatch),
      runs,
      graph: {
        states: built.graph.nodes.length,
        edges: built.graph.edgeCount,
        inputKeys: inputKeys.length,
        outputKeys: expected.length,
      },
      census,
    };
  } finally {
    censusSession.close();
  }
}

function classify(error: unknown): AndroidFrontierResult {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return {
    outcome: message.includes("device_lost")
      ? "device_lost"
      : message.includes("device_unavailable")
        ? "device_unavailable"
        : "failure",
    error: message,
  };
}

const result = await run().catch(classify);
document.body.dataset["outcome"] = result.outcome;
document.body.textContent = JSON.stringify(result, null, 2);
await fetch("/__webgpu_result", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(result),
});
