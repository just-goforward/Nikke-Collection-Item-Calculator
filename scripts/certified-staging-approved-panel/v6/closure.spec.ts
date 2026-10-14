import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { parseSync } from "oxc-parser";
import { expect, it } from "vitest";
import { GENERATION_SOURCES, V6_ROOT } from "./evidence.ts";

const generator = "scripts/generate-certified-staging-approved-panel.ts";
const reader = "scripts/certified-staging-approved-panel.ts";
const builtins: Record<string, readonly string[]> = {
  [generator]: [],
  [reader]: ["node:assert/strict", "node:crypto", "node:fs"],
  [`${V6_ROOT}/calculate.ts`]: ["node:assert/strict", "node:fs"],
  [`${V6_ROOT}/evidence.ts`]: ["node:assert/strict", "node:fs", "node:path"],
  [`${V6_ROOT}/generate.ts`]: [
    "node:assert/strict",
    "node:child_process",
    "node:fs",
    "node:os",
    "node:path",
  ],
  [`${V6_ROOT}/history.ts`]: ["node:assert/strict", "node:crypto", "node:fs", "node:path"],
  "scripts/certified-staging-oracle-physical-supply.ts": [
    "node:assert/strict",
    "node:crypto",
    "node:fs",
    "node:path",
  ],
  "scripts/certified-staging-oracle-fixtures.ts": ["node:crypto"],
  "scripts/certified-staging-oracle-tuples.ts": [],
  "scripts/certified-staging-oracle.ts": [],
  "shared/game.ts": [],
};
type Ast = { type: string; [key: string]: unknown };
function ast(value: unknown): value is Ast {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
function identifier(value: unknown, name: string) {
  return ast(value) && value.type === "Identifier" && value["name"] === name;
}
function member(value: unknown, object: string, property: string) {
  return (
    ast(value) &&
    value.type === "MemberExpression" &&
    !value["computed"] &&
    identifier(value["object"], object) &&
    identifier(value["property"], property)
  );
}
function meta(value: unknown) {
  return (
    ast(value) &&
    value.type === "MetaProperty" &&
    identifier(value["meta"], "import") &&
    identifier(value["property"], "meta")
  );
}
function metaMember(value: unknown, property: string) {
  return (
    ast(value) &&
    value.type === "MemberExpression" &&
    !value["computed"] &&
    meta(value["object"]) &&
    identifier(value["property"], property)
  );
}
function literal(value: unknown): string {
  assert.ok(
    ast(value) && value.type === "Literal" && typeof value["value"] === "string",
    "Unsupported nonliteral module reference",
  );
  return value["value"];
}
function childProcessImport(node: Ast) {
  const source = node["source"];
  if (!ast(source) || source["value"] !== "node:child_process") return;
  assert.equal(node.type, "ImportDeclaration", "Unsupported child-process loading form");
  const specifiers = node["specifiers"];
  assert.ok(
    Array.isArray(specifiers) && specifiers.length === 1,
    "Only the declared calculation spawn capability is allowed",
  );
  const binding = specifiers[0];
  assert.ok(
    ast(binding) &&
      binding.type === "ImportSpecifier" &&
      identifier(binding["imported"], "execFileSync") &&
      identifier(binding["local"], "execFileSync"),
    "Only the declared calculation spawn capability is allowed",
  );
}
function spawnReference(file: string, parent: Ast | undefined, relative: Set<string>) {
  assert.ok(file === `${V6_ROOT}/generate.ts`, "Only the generator may spawn");
  if (parent?.type === "ImportSpecifier") {
    assert.ok(
      identifier(parent["imported"], "execFileSync") && identifier(parent["local"], "execFileSync"),
      "Unsupported spawn alias",
    );
    return;
  }
  assert.ok(
    parent?.type === "CallExpression" &&
      identifier(parent["callee"], "execFileSync") &&
      Array.isArray(parent["arguments"]),
    "Unsupported spawn reference",
  );
  const args = parent["arguments"];
  assert.ok(
    args.length === 3 && member(args[0], "process", "execPath"),
    "Only the current Node executable may be spawned",
  );
  assert.ok(
    ast(args[1]) && args[1].type === "ArrayExpression" && Array.isArray(args[1]["elements"]),
    "Unsupported spawn arguments",
  );
  assert.deepEqual(
    args[1]["elements"].map(literal),
    [generator, "--calculate"],
    "Spawn target must be the calculation entry in the closure",
  );
  relative.add(generator);
}
function identifierReference(
  file: string,
  node: Ast,
  parent: Ast | undefined,
  relative: Set<string>,
) {
  const name = node["name"];
  assert.ok(
    !["require", "createRequire", "eval", "Function", "global", "globalThis", "dlopen"].includes(
      String(name),
    ),
    `Forbidden runtime loader: ${String(name)}`,
  );
  if (name === "process") {
    assert.ok(
      parent?.type === "MemberExpression" &&
        parent["object"] === node &&
        !parent["computed"] &&
        ast(parent["property"]) &&
        ["argv", "env", "cwd", "execPath", "execArgv", "version"].includes(
          String(parent["property"]["name"]),
        ),
      "Unsupported process capability",
    );
  }
  if (name === "URL")
    assert.ok(
      parent?.type === "NewExpression" &&
        parent["callee"] === node &&
        Array.isArray(parent["arguments"]) &&
        metaMember(parent["arguments"][1], "url"),
      "Unsupported URL construction",
    );
  if (name === "execFileSync") spawnReference(file, parent, relative);
}
function metaReference(node: Ast, parent: Ast | undefined, add: (specifier: string) => void) {
  if (node.type === "MetaProperty") {
    assert.ok(
      meta(node) && parent && (metaMember(parent, "resolve") || metaMember(parent, "url")),
      "Unsupported import.meta use",
    );
  }
  if (metaMember(node, "resolve")) {
    assert.ok(
      parent?.type === "CallExpression" &&
        parent["callee"] === node &&
        Array.isArray(parent["arguments"]) &&
        parent["arguments"].length === 1,
      "Unsupported import.meta.resolve use",
    );
    add(literal(parent["arguments"][0]));
  }
  if (metaMember(node, "url")) {
    assert.ok(
      parent?.type === "NewExpression" &&
        identifier(parent["callee"], "URL") &&
        Array.isArray(parent["arguments"]) &&
        parent["arguments"].length === 2 &&
        parent["arguments"][1] === node,
      "Unsupported import.meta.url use",
    );
    add(literal(parent["arguments"][0]));
  }
}
/** Parse Node's actual erased JavaScript, not a bundler's tree-shaken import set. */
function references(file: string, source: string) {
  const result = parseSync(file, stripTypeScriptTypes(source), {
    lang: "js",
    sourceType: "module",
  });
  assert.deepEqual(result.errors, [], `Invalid JavaScript in ${file}`);
  const relative = new Set<string>();
  const importedBuiltins = new Set<string>();
  const add = (specifier: string) => {
    if (specifier.startsWith("node:")) {
      assert.ok(builtins[file]?.includes(specifier), `Forbidden builtin ${specifier} in ${file}`);
      importedBuiltins.add(specifier);
      return;
    }
    assert.ok(
      specifier.startsWith("./") || specifier.startsWith("../"),
      `Bare or unsupported module reference: ${specifier}`,
    );
    assert.ok(!/[\\?#%]/.test(specifier), "Unsupported relative module reference");
    const path = posix.normalize(posix.join(posix.dirname(file), specifier));
    assert.ok(
      !path.startsWith("../") && /\.(ts|js|mjs)$/.test(path),
      "Module reference escapes the source closure",
    );
    assert.ok(
      !/src\/certified\/|certifiedRational|certifiedSupplyModel|\/v[2-5]\//.test(path),
      `Candidate or archived implementation import: ${path}`,
    );
    relative.add(path);
  };
  const walk = (node: Ast, parent?: Ast) => {
    childProcessImport(node);
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node["source"]) {
        assert.ok(
          !node["attributes"] || (Array.isArray(node["attributes"]) && !node["attributes"].length),
          "Unsupported import attributes",
        );
        add(literal(node["source"]));
      }
    }
    if (node.type === "ImportExpression") {
      assert.ok(!node["options"], "Unsupported dynamic import options");
      add(literal(node["source"]));
    }
    metaReference(node, parent, add);
    if (node.type === "Identifier") identifierReference(file, node, parent, relative);
    for (const value of Object.values(node)) {
      if (ast(value)) walk(value, node);
      else if (Array.isArray(value)) for (const child of value) if (ast(child)) walk(child, node);
    }
  };
  assert.ok(ast(result.program), "Parser must return a JavaScript AST");
  walk(result.program);
  return { relative, importedBuiltins };
}
function closure(overrides = new Map<string, string>()) {
  const pending = [generator, reader];
  const reachable = new Set<string>();
  while (pending.length) {
    const file = pending.pop();
    assert.ok(file);
    if (reachable.has(file)) continue;
    assert.ok(
      GENERATION_SOURCES.some((path) => path === file),
      `Unlisted relative module: ${file}`,
    );
    reachable.add(file);
    const imported = references(file, overrides.get(file) ?? readFileSync(file, "utf8"));
    assert.deepEqual(
      [...imported.importedBuiltins].sort(),
      [...(builtins[file] ?? [])].sort(),
      `Builtin inventory drift: ${file}`,
    );
    pending.push(...imported.relative);
  }
  assert.deepEqual(
    [...reachable].sort(),
    [...GENERATION_SOURCES].sort(),
    "Live-compared sources must equal the entire runtime closure in both directions",
  );
  return reachable;
}
it("live-compares exactly both entry points' independent runtime closure", () => {
  expect(closure().size).toBe(GENERATION_SOURCES.length);
});
it.each([
  'import x from "bare";',
  'export { x } from "bare";',
  'import "bare";',
  'import /* comment */ \n ("bare");',
  'import { createRequire as aliased } from "node:module"; aliased(import.meta.url)("bare");',
  'import "node:vm";',
  'import "node:worker_threads";',
  'import "./unlisted.ts";',
  'import "../src/certified/runtime.ts";',
  'import { type X } from "bare";',
  "import(name);",
  'export * from "bare";',
  'import.meta.resolve("bare");',
  'new URL("bare", import.meta.url);',
  'import "./certified-staging-approved-panel/v5/evidence.ts";',
  'process.dlopen(null, "native");',
  'const p = process; p.dlopen(null, "native");',
  'import "node:child_process";',
])("fails closed on unsupported runtime loading: %s", (extra) => {
  const source = `${readFileSync(reader, "utf8")}\n${extra}`;
  expect(() => closure(new Map([[reader, source]]))).toThrow();
});
it("erases genuinely type-only imports without inventing a runtime load", () => {
  const source = `${readFileSync(reader, "utf8")}\nimport type { X } from "bare";\nexport type { X } from "bare";`;
  expect(closure(new Map([[reader, source]]))).toEqual(closure());
});
it.each([
  'export { q } from "./certified-staging-oracle.ts";',
  'export * from "./certified-staging-oracle.ts";',
  'import "./certified-staging-oracle.ts";',
  'import /* comment */ ("./certified-staging-oracle.ts");',
  'import.meta.resolve("./certified-staging-oracle.ts");',
  'new URL("./certified-staging-oracle.ts", import.meta.url);',
  'import { type X } from "./certified-staging-oracle.ts";',
])("traverses each supported runtime module-reference form: %s", (source) => {
  expect([...references(reader, source).relative]).toEqual(["scripts/certified-staging-oracle.ts"]);
});
it("rejects a live-compared source that is no longer reachable", () => {
  expect(() =>
    closure(
      new Map([
        [generator, ""],
        [reader, ""],
      ]),
    ),
  ).toThrow();
});
it("rejects a spawn target outside the closure", () => {
  const file = `${V6_ROOT}/generate.ts`;
  expect(() =>
    closure(
      new Map([
        [
          file,
          readFileSync(file, "utf8").replace(
            '["scripts/generate-certified-staging-approved-panel.ts", "--calculate"]',
            '["outside.ts", "--calculate"]',
          ),
        ],
      ]),
    ),
  ).toThrow(/Spawn target/);
});
it.each([
  'import { spawn } from "node:child_process";',
  'import { execFileSync as run } from "node:child_process";',
  'import * as subprocess from "node:child_process";',
  'import subprocess from "node:child_process";',
  'import "node:child_process";',
  'export { execFileSync } from "node:child_process";',
  'import("node:child_process");',
])("rejects undeclared child-process capabilities: %s", (extra) => {
  const file = `${V6_ROOT}/generate.ts`;
  expect(() => closure(new Map([[file, `${readFileSync(file, "utf8")}\n${extra}`]]))).toThrow();
});
