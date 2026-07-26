import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

export const ARTIFACT_TARGETS = [
  "dist",
  "test-results",
  "playwright-report",
  "playwright/.cache",
  "debug.log",
  "benchmarks/results",
  "public/solver_rs.wasm",
  "rust/solver-rs/target",
];

function trackedFiles() {
  const result = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ls-files failed with status ${result.status}`);
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, "/")),
  );
}

function hasTrackedFileAtOrBelow(target: string, tracked: Set<string>) {
  if (tracked.has(target)) return true;
  const prefix = `${target}/`;
  for (const file of tracked) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

export function plannedArtifactRemovals(
  targets = ARTIFACT_TARGETS,
  options: {
    exists?: (target: string) => boolean;
    tracked?: Set<string>;
  } = {},
) {
  const tracked = options.tracked ?? trackedFiles();
  const exists = options.exists ?? existsSync;
  return targets
    .map((target) => target.replace(/\\/g, "/").replace(/\/$/, ""))
    .filter((target) => exists(target))
    .filter((target) => !hasTrackedFileAtOrBelow(target, tracked));
}

export function cleanArtifacts({ apply }: { apply: boolean }) {
  const targets = plannedArtifactRemovals();
  if (!apply) return targets;
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
  }
  return targets;
}

export function shouldApplyCleanArtifacts(args: readonly string[]): boolean {
  return args.includes("--apply") && !args.includes("--dry-run");
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/clean-artifacts.ts");

if (isCli) {
  const apply = shouldApplyCleanArtifacts(process.argv);
  const targets = cleanArtifacts({ apply });
  if (targets.length === 0) {
    console.log("No generated artifacts to clean.");
  } else {
    const verb = apply ? "Removed" : "Would remove";
    for (const target of targets) console.log(`${verb} ${target}`);
  }
  if (!apply) console.log("Run with --apply to delete these generated artifacts.");
}
