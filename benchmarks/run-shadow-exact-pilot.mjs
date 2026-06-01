import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const OUTPUT_FILE = new URL("./results/shadow-pilot-exact.json", import.meta.url);
const TIME_BUDGET_MS = 60_000;
const PILOT_IDS = [
  "R14e900-yellow30",
  "SR5-blue30",
  "SR10-yellow10",
  "SR0-balanced100",
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
  const evaluator = await server.ssrLoadModule("/benchmarks/evaluator/exact-replan.ts");
  const grid = await server.ssrLoadModule("/benchmarks/scenarios/fixed-grid.ts");
  const shadow = await server.ssrLoadModule("/benchmarks/models/shadow-price.ts");
  const models = [
    { id: "A", policySolver: undefined },
    { id: "B", policySolver: shadow.solveSingleUpdateShadow },
    { id: "C", policySolver: shadow.solveBoundedShadow },
  ];
  const results = [];

  for (const scenarioId of PILOT_IDS) {
    const scenario = grid.FIXED_SAFETY_GRID.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw new Error(`Missing exact pilot scenario: ${scenarioId}`);
    const modelResults = [];
    for (const model of models) {
      const result = evaluator.evaluateExactInteractiveReplan(scenario, {
        modelId: model.id,
        policySolver: model.policySolver,
        timeBudgetMs: TIME_BUDGET_MS,
      });
      modelResults.push(
        result.status === "completed"
          ? {
              model: model.id,
              status: result.status,
              elapsedMs: result.elapsedMs,
              solveCalls: result.solveCalls,
              successProbability: result.successProbability,
              interactiveF: result.interactiveF,
              manualEntryProbability: result.manualEntryProbability,
              expectedManualEntries: result.expectedManualEntries,
              internalViolations: result.gateEvidence.internalViolationCount,
              boundaryViolations: result.gateEvidence.boundaryViolationCount,
            }
          : {
              model: model.id,
              status: result.status,
              elapsedMs: result.elapsedMs,
              solveCalls: result.solveCalls,
              internalViolations: result.gateEvidence.internalViolationCount,
              boundaryViolations: result.gateEvidence.boundaryViolationCount,
            },
      );
    }
    results.push({ scenario: scenario.id, group: scenario.group, models: modelResults });
  }

  const report = { kind: "exact-interactive-pilot", timeBudgetMs: TIME_BUDGET_MS, scenarios: results };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await server.close();
}
