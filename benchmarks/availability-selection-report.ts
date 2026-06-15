import type { SelectionOutput } from "./availability-selection-types.ts";

function fmt(value: number | null | undefined, digits = 6): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

export function renderSelectionReport(out: SelectionOutput): string {
  const lines: string[] = [];
  lines.push("# Availability slider selection result");
  lines.push("");
  lines.push(`- Generated at: ${out.generatedAt}`);
  lines.push(`- Source: \`${out.source}\``);
  lines.push(`- Delta P budget: ${out.deltaPBudget}`);
  lines.push(`- Gate scenarios: ${out.gateScenarioIds.join(", ")}`);
  lines.push("");
  lines.push(`## Outcome: \`${out.outcome ?? "unknown"}\``);
  if (out.reason) lines.push(`- Reason: ${out.reason}`);
  if (out.monotone !== undefined)
    lines.push(`- Output monotonicity: ${out.monotone ? "pass" : "fail"}`);
  lines.push(
    `- Significance evidence: ${out.significanceAvailable ? "available" : "absent/provisional"}`,
  );

  if (out.improvedDefault) {
    const improved = out.improvedDefault;
    lines.push("");
    lines.push(
      `- Improved default candidate: \`${improved.modelId}\` (P-loss ${fmt(improved.worstExactLoss)}, supplyDebt ${fmt(out.baselineSupplyDebt, 1)} -> ${fmt(improved.supplyDebtCvar90, 1)}, delta ${fmt(improved.supplyDebtVsA, 1)}).`,
    );
  }
  if (out.preservationProvisional) {
    lines.push("- Preservation stage is provisional because significance evidence is absent.");
  }
  if (out.preservationEscalationSuggested) {
    lines.push("- Preservation escalation suggested: evaluate p in {4, Infinity}.");
  }

  if (out.stages) {
    lines.push("");
    lines.push("## Stages");
    lines.push("");
    lines.push(
      "| Stage | Candidate | Worst exact P loss | Relative loss | supplyDebt CVaR90 | Tail significant | Guardrail degraded |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const stage of out.stages) {
      const tail =
        stage.tailSignificantImprovement === null
          ? "-"
          : stage.tailSignificantImprovement
            ? "yes"
            : "no";
      lines.push(
        `| ${stage.stage} | \`${stage.modelId}\` | ${fmt(stage.worstExactLoss)} | ${fmt(stage.worstRelativeLoss)} | ${fmt(stage.supplyDebtCvar90, 3)} | ${tail} | ${stage.guardrailDegraded ? `yes (${stage.guardrailDegradations.join("; ")})` : "no"} |`,
      );
    }
  }

  if (out.paretoFrontier) {
    lines.push("");
    lines.push("## 2D Pareto Frontier");
    lines.push("");
    lines.push(out.paretoFrontier.map((id) => `\`${id}\``).join(", "));
  }

  lines.push("");
  lines.push("## Candidates");
  lines.push("");
  lines.push("| Candidate | Exact P loss | supplyDebt CVaR90 | Gate judged | eligibleEmpty |");
  lines.push("|---|---|---|---|---|");
  for (const candidate of out.candidates) {
    lines.push(
      `| \`${candidate.modelId}\` | ${fmt(candidate.worstExactLoss)} | ${fmt(candidate.supplyDebtCvar90, 3)} | ${candidate.gateJudged}${candidate.gateComplete ? "" : " (incomplete)"} | ${candidate.gateEvidence.eligibleEmptyCount} |`,
    );
  }
  lines.push("");
  lines.push("> supplyDebt is measured only on completion-sufficient journey panels.");
  lines.push("> exact P loss is the blocking gate; MC fallback is not used for exact P.");
  return `${lines.join("\n")}\n`;
}
