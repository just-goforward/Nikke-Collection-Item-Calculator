import { COMPACT_GRAPH_DIMENSIONS, compactTransitionTable } from "../compact-exact-graph";
import { createWebGpuFrontierSession } from "./compact-frontier-kernel";

declare global {
  interface Window {
    runCompactFrontierGpu(input: { keys: number[]; repeats: number }): Promise<{
      keys: number[];
      metadata: unknown;
      samplesMs: number[];
      setupMs: number;
    }>;
    runCompactFrontierCensusGpu(input: {
      maxLayers: number;
      maxStates: number;
      rootKey: number;
    }): Promise<{
      elapsedMs: number;
      layers: number;
      maxFrontier: number;
      metadata: unknown;
      outcome: "completed" | "budget_exceeded";
      states: number;
    }>;
  }
}

window.runCompactFrontierGpu = async ({ keys, repeats }) => {
  const setupStartedAt = performance.now();
  const session = await createWebGpuFrontierSession(
    compactTransitionTable(),
    COMPACT_GRAPH_DIMENSIONS,
    keys.length,
  );
  const setupMs = performance.now() - setupStartedAt;
  try {
    const samplesMs: number[] = [];
    let result: number[] = [];
    for (let repeat = 0; repeat < Math.max(1, Math.trunc(repeats)); repeat += 1) {
      const startedAt = performance.now();
      result = await session.expand(keys);
      samplesMs.push(performance.now() - startedAt);
    }
    return { keys: result, metadata: session.metadata, samplesMs, setupMs };
  } finally {
    session.close();
  }
};

window.runCompactFrontierCensusGpu = async ({ rootKey, maxStates, maxLayers }) => {
  const session = await createWebGpuFrontierSession(
    compactTransitionTable(),
    COMPACT_GRAPH_DIMENSIONS,
    maxStates,
  );
  const startedAt = performance.now();
  let frontier = [rootKey];
  let layers = 0;
  let states = 0;
  let maxFrontier = 0;
  try {
    while (frontier.length > 0 && layers < maxLayers) {
      if (states + frontier.length > maxStates) {
        return {
          elapsedMs: performance.now() - startedAt,
          layers,
          maxFrontier,
          metadata: session.metadata,
          outcome: "budget_exceeded",
          states,
        };
      }
      states += frontier.length;
      maxFrontier = Math.max(maxFrontier, frontier.length);
      frontier = await session.expand(frontier);
      layers += 1;
    }
    return {
      elapsedMs: performance.now() - startedAt,
      layers,
      maxFrontier,
      metadata: session.metadata,
      outcome: frontier.length === 0 ? "completed" : "budget_exceeded",
      states,
    };
  } finally {
    session.close();
  }
};
