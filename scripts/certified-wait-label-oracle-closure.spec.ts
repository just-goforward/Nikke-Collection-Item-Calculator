import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";
import { expect, it } from "vitest";

/** Engine independence of scripts/certified-wait-label-oracle.ts: its runtime
 * module graph (Node's type-erased JavaScript) and the modules actually loaded by
 * a child process must exclude candidate solver code, the candidate rational and
 * supply implementations, and any WebAssembly. */
const ENTRY = "scripts/certified-wait-label-oracle.ts";
const FORBIDDEN = [
  /^src\/certified\//,
  /^shared\/certifiedRational\.ts$/,
  /^shared\/certifiedSupply/,
  /\.wasm$/i,
];
const forbidden = (path: string) => FORBIDDEN.some((pattern) => pattern.test(path));
type Ast = { type: string; [key: string]: unknown };
const isAst = (value: unknown): value is Ast =>
  value !== null && typeof value === "object" && typeof (value as Ast).type === "string";

function references(file: string, source: string) {
  const parsed = parseSync(file, source, { lang: "js", sourceType: "module" });
  expect(parsed.errors).toEqual([]);
  const modules: string[] = [];
  const data: string[] = [];
  const literal = (node: unknown) => {
    if (!isAst(node) || node.type !== "Literal" || typeof node["value"] !== "string")
      throw new Error(`nonliteral module reference in ${file}`);
    return node["value"];
  };
  const walk = (node: Ast) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node["source"]
    )
      modules.push(literal(node["source"]));
    if (node.type === "ImportExpression") modules.push(literal(node["source"]));
    if (
      node.type === "Identifier" &&
      ["require", "createRequire", "WebAssembly"].includes(String(node["name"]))
    )
      throw new Error(`forbidden runtime loader ${String(node["name"])} in ${file}`);
    if (
      node.type === "NewExpression" &&
      isAst(node["callee"]) &&
      node["callee"]["name"] === "URL"
    ) {
      const [first] = node["arguments"] as unknown[];
      if (isAst(first) && first.type === "Literal") data.push(literal(first));
    }
    for (const value of Object.values(node)) {
      if (isAst(value)) walk(value);
      else if (Array.isArray(value)) for (const child of value) if (isAst(child)) walk(child);
    }
  };
  walk(parsed.program as unknown as Ast);
  return { modules, data };
}
const relative = (file: string, specifier: string) =>
  posix.normalize(posix.join(posix.dirname(file), specifier));

function staticClosure() {
  const pending = [ENTRY];
  const files = new Set<string>();
  const dataFiles = new Set<string>();
  const erasedTypeOnly = new Set<string>();
  const builtins = new Set<string>();
  while (pending.length) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const runtime = references(file, stripTypeScriptTypes(source));
    const declared = parseSync(file, source, { lang: "ts", sourceType: "module" });
    const all = [
      ...declared.module.staticImports.map((entry) => entry.moduleRequest.value),
      ...declared.module.staticExports.flatMap((entry) =>
        entry.entries.flatMap((item) => (item.moduleRequest ? [item.moduleRequest.value] : [])),
      ),
    ];
    for (const specifier of runtime.modules) {
      if (specifier.startsWith("node:")) {
        builtins.add(specifier);
        continue;
      }
      if (!specifier.startsWith("."))
        throw new Error(`bare package ${specifier} in the oracle closure (${file})`);
      pending.push(relative(file, specifier));
    }
    for (const specifier of all)
      if (specifier.startsWith(".") && !runtime.modules.includes(specifier))
        erasedTypeOnly.add(`${file} -> ${relative(file, specifier)}`);
    for (const specifier of runtime.data) dataFiles.add(relative(file, specifier));
  }
  return { files, dataFiles, erasedTypeOnly, builtins };
}

it("keeps the static runtime closure free of candidate code and WebAssembly", () => {
  const closure = staticClosure();
  expect([...closure.files].filter(forbidden)).toEqual([]);
  expect([...closure.dataFiles].filter(forbidden)).toEqual([]);
  expect([...closure.files].sort()).toEqual([
    "scripts/certified-staging-approved-panel.ts",
    "scripts/certified-staging-approved-panel/v6/evidence.ts",
    "scripts/certified-staging-approved-panel/v6/history.ts",
    "scripts/certified-staging-oracle-fixtures.ts",
    "scripts/certified-staging-oracle-four-cohort-pricing.ts",
    "scripts/certified-staging-oracle-tuples.ts",
    "scripts/certified-staging-oracle.ts",
    "scripts/certified-wait-label-oracle.ts",
    "shared/game.ts",
  ]);
  expect([...closure.builtins].sort()).toEqual([
    "node:assert/strict",
    "node:crypto",
    "node:fs",
    "node:path",
    "node:url",
  ]);
  // Type-only imports are erased by Node before execution; listed so drift is visible.
  expect([...closure.erasedTypeOnly].sort()).toEqual([
    "scripts/certified-staging-approved-panel.ts -> shared/certifiedSupply.ts",
    "scripts/certified-staging-approved-panel.ts -> src/certified/types.ts",
    "scripts/certified-staging-oracle-fixtures.ts -> shared/certifiedSupply.ts",
    "scripts/certified-staging-oracle-fixtures.ts -> src/certified/types.ts",
    "scripts/certified-wait-label-oracle.ts -> shared/game.ts",
  ]);
  // The oracle itself declares no reference (type-only or runtime) to candidate code.
  const own = parseSync(ENTRY, readFileSync(ENTRY, "utf8"), { lang: "ts", sourceType: "module" });
  expect(
    own.module.staticImports
      .map((entry) => relative(ENTRY, entry.moduleRequest.value))
      .filter(forbidden),
  ).toEqual([]);
});

it("loads only the static closure at runtime, without WebAssembly", () => {
  const program = `
import { registerHooks } from "node:module";
const loaded = new Set();
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
const O = await import(${JSON.stringify(pathToFileURL(ENTRY).href)});
// Node's own type stripping uses WebAssembly while loading; the oracle may not.
globalThis.WebAssembly = new Proxy(globalThis.WebAssembly, { get() { throw new Error("wasm_forbidden"); } });
const fixture = O.loadWaitLabelFixtures().find((entry) => entry.id === "SR13");
const rates = O.independentRates(fixture);
const prices = O.independentPrices(rates, fixture.priceBasisStock);
const engine = O.createWaitLabelEngine(prices, 8);
const batch = O.recommendBatch(engine, fixture, [1, 1, 0], fixture.batchLimit);
const days = O.reachableUnits(fixture.stock, fixture.schedule, 1, [0, 1, 2, 3]);
console.log(JSON.stringify({ batch, day1: days[0].length, loaded: [...loaded] }));
`;
  const output = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as { batch: unknown; day1: number; loaded: string[] };
  expect(output.batch).toEqual({ kit: 1, uses: 1 });
  expect(output.day1).toBe(9);
  const root = pathToFileURL(`${process.cwd()}/`).href;
  const files = output.loaded
    .filter((url) => url.startsWith("file:"))
    .map((url) => decodeURIComponent(url.slice(root.length)));
  expect(files.filter(forbidden)).toEqual([]);
  expect(
    output.loaded.filter((url) => !url.startsWith("file:") && !url.startsWith("node:")),
  ).toEqual([]);
  expect(files.sort()).toEqual([...staticClosure().files].sort());
}, 120_000);
