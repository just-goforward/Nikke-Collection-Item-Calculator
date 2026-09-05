import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_ENTRYPOINTS,
  CHECK_ROOTS,
  WORKER_SOURCE_ROOTS,
} from "./architecture-config.ts";
import {
  architectureIssues,
  containsAdHocTextAlignment,
  formatArchitectureResult,
  gitTrackedFiles,
  measureFunctions,
  violatesModuleBoundary,
} from "./architecture-rules.ts";

describe("architecture rules", () => {
  it("covers every production Worker source root and entrypoint", () => {
    for (const root of WORKER_SOURCE_ROOTS) {
      expect(CHECK_ROOTS).toContain(root);
      expect(APPLICATION_ENTRYPOINTS).toContain(`${root}/worker.ts`);
    }
  });

  it("measures function length, nesting depth, and approximate complexity", () => {
    const metrics = measureFunctions(
      `
function sample(input: boolean) {
  if (input) {
    for (const value of [1, 2, 3]) {
      if (value > 1) return value;
    }
  }
  return 0;
}
`,
      "fixture.ts",
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      file: "fixture.ts",
      name: "sample",
      startLine: 2,
      endLine: 9,
      maxDepth: 3,
      complexity: 4,
    });
  });

  it("uses the TypeScript AST instead of counting braces inside strings", () => {
    const metrics = measureFunctions(
      `
function outer() {
  const marker = "}";
  if (marker) return 1;
  return 0;
}
`,
      "fixture.ts",
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ name: "outer", endLine: 6, maxDepth: 1, complexity: 2 });
  });

  it("rejects imports that cross product runtime boundaries", () => {
    expect(violatesModuleBoundary("src/app.ts", "cloudflare/src/worker.ts")).toBe(true);
    expect(violatesModuleBoundary("src/app.ts", "forecast-dispatcher/src/worker.ts")).toBe(true);
    expect(violatesModuleBoundary("cloudflare/src/worker.ts", "src/types.ts")).toBe(true);
    expect(violatesModuleBoundary("cloudflare/src/worker.ts", "shared/game.ts")).toBe(false);
    expect(
      violatesModuleBoundary("forecast-dispatcher/src/worker.ts", "forecast-collector/src/db.ts"),
    ).toBe(true);
    expect(violatesModuleBoundary("forecast-dispatcher/src/worker.ts", "shared/forecast.ts")).toBe(
      false,
    );
    expect(violatesModuleBoundary("shared/game.ts", "src/types.ts")).toBe(true);
    expect(violatesModuleBoundary("src/app.ts", "src/types.ts")).toBe(false);
    expect(violatesModuleBoundary("cloudflare/src/worker.ts", "cloudflare/src/http.ts")).toBe(
      false,
    );
  });

  it("formats pass and fail results for the CLI wrapper", () => {
    expect(formatArchitectureResult(["src/a.ts"], [])).toContain("Architecture lint passed");
    expect(
      formatArchitectureResult(
        ["src/a.ts"],
        [{ code: "re-export", file: "src/a.ts", message: "re-export is not allowed: src/a.ts" }],
      ),
    ).toContain("Architecture lint failed");
  });

  it("rejects direct one-pixel text offsets outside the alignment contract", () => {
    expect(containsAdHocTextAlignment('const label = "relative top-px leading-none";')).toBe(true);
    expect(
      containsAdHocTextAlignment('const label = "relative max-mobile:top-px leading-none";'),
    ).toBe(true);
    expect(containsAdHocTextAlignment('const button = "enabled:active:translate-y-px";')).toBe(
      false,
    );
  });

  it("flags structural fixtures for boundaries and complexity", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "architecture-rules-")).replace(/\\/g, "/");
    const unsafeCast = "as " + "any";
    const emptyCatch = "catch " + "{}";
    const files = {
      a: `${fixtureRoot}/a.ts`,
      b: `${fixtureRoot}/b.ts`,
      reExport: `${fixtureRoot}/re-export.ts`,
      facade: `${fixtureRoot}/facade.ts`,
      unsafe: `${fixtureRoot}/unsafe.ts`,
      emptyCatch: `${fixtureRoot}/empty-catch.ts`,
      nested: `${fixtureRoot}/nested.ts`,
      entry: `${fixtureRoot}/entry.test.ts`,
      dynamic: `${fixtureRoot}/dynamic.ts`,
      orphan: `${fixtureRoot}/orphan.ts`,
    };

    try {
      writeFileSync(files.a, 'import { b } from "./b";\nexport const a = b;\n');
      writeFileSync(files.b, 'import { a } from "./a";\nexport const b = a;\n');
      writeFileSync(files.reExport, 'export { a } from "./a";\n');
      writeFileSync(files.facade, 'import { a } from "./a";\nexport { a };\n');
      writeFileSync(files.unsafe, `const value = {} ${unsafeCast};\nvoid value;\n`);
      writeFileSync(files.emptyCatch, `try {\n  JSON.parse("bad");\n} ${emptyCatch}\n`);
      writeFileSync(
        files.entry,
        'export async function load() {\n  return import("./dynamic.ts");\n}\n',
      );
      writeFileSync(files.dynamic, "export const reachable = true;\n");
      writeFileSync(files.orphan, "export const unreachable = true;\n");
      writeFileSync(
        files.nested,
        `
function tooNested(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) return 1;
        }
      }
    }
  }
  return 0;
}
`,
      );

      const issues = architectureIssues([...gitTrackedFiles(), ...Object.values(files)]);
      expect(issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "cycle",
          "empty-catch",
          "function-depth",
          "re-export",
          "unreachable-source",
          "unsafe-type-escape",
        ]),
      );
      expect(issues.some((issue) => issue.file === files.dynamic)).toBe(false);
      expect(issues.some((issue) => issue.file === files.orphan)).toBe(true);
      expect(
        issues.some((issue) => issue.code === "re-export" && issue.file === files.facade),
      ).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
