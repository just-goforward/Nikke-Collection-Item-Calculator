import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { parseSync } from "oxc-parser";
import type { ColdCandidateData } from "./test-cold-candidate-worker";
import type { CollectorEnv } from "./types";

type Measurement = {
  cpuMs: number;
  wallMs: number;
  result: { outcome: string; candidateCreated: boolean };
  stages: Record<string, number>;
};
const stages = new Set([
  "readScheduleLedger",
  "loadRuntimeEvents",
  "persistedReviewEvidence",
  "resolveSoloSchedule",
  "buildForecastCandidate",
  "buildScheduleForecastSnapshot",
  "sha256Hex",
  "stableJson",
  "candidateAlreadyStored",
  "ingestionSettlement",
]);

export async function coldCandidate(
  sqlite: DatabaseSync,
  env: CollectorEnv,
  now: number,
  fixture: string,
  phase: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "forecast-cold-"));
  try {
    const results: Measurement[] = [];
    for (const instrumented of [false, true]) {
      const database = join(directory, `${instrumented}.sqlite`);
      await backup(sqlite, database);
      const outfile = join(directory, `${instrumented}.mjs`);
      await build({
        entryPoints: [fileURLToPath(new URL("./test-cold-candidate-worker.ts", import.meta.url))],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        plugins: instrumented
          ? [
              {
                name: "local-candidate-stage-timers",
                setup(builder) {
                  builder.onLoad({ filter: /\.ts$/ }, async (args) => {
                    const source = await readFile(args.path, "utf8");
                    const parsed = parseSync(args.path, source, {
                      astType: "ts",
                      lang: "ts",
                      sourceType: "module",
                    });
                    if (parsed.errors.length) throw new Error(`profile_parse_failed:${args.path}`);
                    const edits: { start: number; end: number; text: string }[] = [];
                    for (const statement of parsed.program.body) {
                      const node =
                        statement.type === "ExportNamedDeclaration"
                          ? statement.declaration
                          : statement;
                      if (
                        node?.type !== "FunctionDeclaration" ||
                        !node.id ||
                        !node.body ||
                        !stages.has(node.id.name)
                      )
                        continue;
                      const name = JSON.stringify(node.id.name);
                      const body = source.slice(node.body.start + 1, node.body.end - 1);
                      edits.push({
                        start: node.body.start,
                        end: node.body.end,
                        text: `{
                  const timings = globalThis.__candidateStages ??= {};
                  const depths = globalThis.__candidateDepths ??= {};
                  const outer = !(depths[${name}] ?? 0);
                  depths[${name}] = (depths[${name}] ?? 0) + 1;
                  const started = outer ? performance.now() : 0;
                  try { ${body} } finally {
                    depths[${name}]--;
                    if (outer) timings[${name}] = (timings[${name}] ?? 0) + performance.now() - started;
                  }
                }`,
                      });
                    }
                    let contents = source;
                    for (const edit of edits.sort((a, b) => b.start - a.start))
                      contents =
                        contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
                    return { contents, loader: "ts" };
                  });
                },
              },
            ]
          : [],
      });
      results.push(
        await new Promise<Measurement>((resolve, reject) => {
          const worker = new Worker(outfile, {
            workerData: {
              database,
              now,
              deploySha: env.DEPLOY_SHA,
              instrumented,
            } satisfies ColdCandidateData,
          });
          let measurement: Measurement | undefined;
          worker.once("message", (value: Measurement) => {
            measurement = value;
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0 || !measurement) reject(new Error(`cold_worker_exit_${code}`));
            else resolve(measurement);
          });
        }),
      );
    }
    const measured = {
      fixture,
      phase,
      cold: results[0],
      diagnosticStagesWallMs: results[1]?.stages,
    };
    console.log(JSON.stringify(measured));
    return measured;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
