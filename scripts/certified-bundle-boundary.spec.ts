import { resolve } from "node:path";
import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { certifiedBundleBoundaryPlugin } from "./certified-bundle-boundary";

const root = resolve(".tmp/certified-bundle-fixture");
const entry = `${root}/src/main.ts`;
function fixture(module: string, dynamic: boolean): Plugin {
  const dependency = `${root}/${module}`;
  return {
    name: "certified-boundary-virtual-fixture",
    resolveId(id) {
      return id === entry || id === dependency ? id : undefined;
    },
    load(id) {
      if (id === dependency) return "export const value=7;";
      if (id !== entry) return undefined;
      return dynamic
        ? `globalThis.load=()=>import(${JSON.stringify(dependency)});`
        : `import{value}from${JSON.stringify(dependency)};globalThis.value=value;`;
    },
  };
}
const compile = (module: string, dynamic: boolean, plugins: Plugin[]) =>
  build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [fixture(module, dynamic), ...plugins],
    build: { write: false, minify: false, rolldownOptions: { input: entry } },
  });

describe("actual bundler certified initial boundary", () => {
  it("demonstrates that the UI lazy boundary alone does not stop another eager certified module", async () => {
    const result = await compile("shared/certifiedRational.ts", false, []);
    if (Array.isArray(result) || !("output" in result)) throw new Error("fixture_bundle_missing");
    const chunks = result.output.filter((output) => output.type === "chunk");
    expect(chunks.some((chunk) => chunk.code.includes("globalThis.value = 7"))).toBe(true);
  });

  it.each([
    "shared/certifiedRational.ts",
    "src/certifiedRuntime/other.ts",
    "src/certified/other.ts",
    "shared/generated/certifiedForecastAuthority.ts",
    "src/lib/certifiedForecastTrust.ts",
  ])("rejects eager %s even while the calculator UI remains lazy", async (module) => {
    await expect(compile(module, false, [certifiedBundleBoundaryPlugin()])).rejects.toThrow(
      "certified_eager_initial_modules",
    );
  });

  it("allows a deferred module and emits the actual module boundary evidence", async () => {
    const result = await compile("shared/certifiedRational.ts", true, [
      certifiedBundleBoundaryPlugin(),
    ]);
    if (Array.isArray(result) || !("output" in result)) throw new Error("fixture_bundle_missing");
    const report = result.output.find(
      (output) => output.fileName === ".vite/certified-boundary.json",
    );
    expect(report?.type).toBe("asset");
    if (report?.type !== "asset") throw new Error("fixture_boundary_missing");
    const boundary = JSON.parse(String(report.source));
    expect(boundary.certifiedFiles).toHaveLength(1);
    expect(boundary.initialModules.some((id: string) => id.endsWith("certifiedRational.ts"))).toBe(
      false,
    );
  });

  it("rejects a modulepreload of an otherwise deferred module in localized HTML", async () => {
    const preload: Plugin = {
      name: "fixture-hidden-modulepreload",
      generateBundle(_options, bundle) {
        const chunk = Object.values(bundle).find(
          (output) => output.type === "chunk" && !output.isEntry,
        );
        if (!chunk) throw new Error("fixture_deferred_chunk_missing");
        this.emitFile({
          type: "asset",
          fileName: "en/index.html",
          source: `<link href="../${chunk.fileName}" rel="modulepreload">`,
        });
      },
    };
    await expect(
      compile("shared/certifiedRational.ts", true, [preload, certifiedBundleBoundaryPlugin()]),
    ).rejects.toThrow("certified_eager_modulepreload");
  });
});
