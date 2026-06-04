import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import type { solveWithResearchCostModel } from "../src/solver";
import type { SolverInput } from "../src/types";
import type { SolverScenario } from "./scenarios/fixed-grid";

type PilotModel = {
  id: "A" | "B" | "C";
  solve: (input: SolverInput) => ReturnType<typeof solveWithResearchCostModel>;
};

const OUTPUT_FILE = new URL("./results/shadow-pilot-root.json", import.meta.url);
const PILOT_IDS = [
  "R0-balanced100",
  "R14e900-skewBlue",
  "SR0-balanced100",
  "SR5-blue30",
  "SR10-blue10",
  "SR10-purple10",
  "SR10-yellow10",
  "SR14e2900-skewYellow",
];

await mkdir(new URL("./results/", import.meta.url), { recursive: true });
const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const solver = (await server.ssrLoadModule("/src/solver.ts")) as typeof import("../src/solver");
  const metrics = (await server.ssrLoadModule(
    "/benchmarks/metrics.ts",
  )) as typeof import("./metrics");
  const grid = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const shadow = (await server.ssrLoadModule(
    "/benchmarks/models/shadow-price.ts",
  )) as typeof import("./models/shadow-price");
  const models: PilotModel[] = [
    {
      id: "A",
      solve: (input) => solver.solveWithResearchCostModel(input, { kind: "availability-pnorm" }),
    },
    { id: "B", solve: shadow.solveSingleUpdateShadow },
    { id: "C", solve: shadow.solveBoundedShadow },
  ];

  const results = [];
  for (const scenarioId of PILOT_IDS) {
    const scenario: SolverScenario | undefined = grid.FIXED_SAFETY_GRID.find(
      (candidate) => candidate.id === scenarioId,
    );
    if (!scenario) throw new Error(`Missing pilot scenario: ${scenarioId}`);
    const modelResults = [];
    for (const model of models) {
      const startedAt = performance.now();
      const result = model.solve({
        start: scenario.start,
        stock: scenario.stock,
        strategy: "supply",
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!result.possible || !result.best) {
        modelResults.push({ model: model.id, elapsedMs, possible: false });
        continue;
      }
      modelResults.push({
        model: model.id,
        elapsedMs,
        firstAction: result.best.firstAction,
        runCount: result.best.run?.count || 1,
        successProbability: result.best.successProbability,
        probabilityGap: result.best.probabilityGap,
        rootF: metrics.availabilityPnormObjective(result.best.vector, scenario.stock),
        gateViolations: result.stats?.gateAudit?.violationCount || 0,
        shadow: result.stats?.researchShadow || null,
      });
    }
    const baseline = modelResults[0];
    results.push({
      scenario: scenario.id,
      group: scenario.group,
      models: modelResults,
      changedModels: modelResults
        .slice(1)
        .filter(
          (result) =>
            result.firstAction !== baseline.firstAction || result.runCount !== baseline.runCount,
        )
        .map((result) => result.model),
    });
  }

  const report = { kind: "root-policy-pilot", scenarios: results };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await server.close();
}
