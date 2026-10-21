import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Expression, Node, SourceFile } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";
import { beforeAll, describe, expect, it } from "vitest";
import {
  APP_ERROR_CODES,
  type AppErrorCode,
  D1_TRIGGER_CODES,
  ERROR_CATEGORIES,
  ERROR_CODE_POLICIES,
  errorCode,
  HTTP_STATUS_FAMILIES,
  HTTP_STATUSES,
  isAppErrorCode,
  SAFE_ERROR_NAMES,
  SUFFIX_FAMILIES,
} from "../shared/errorCodes.ts";

/*
 * Drift guard for shared/errorCodes.ts.
 *
 * The TypeScript 7 compiler API (typescript/unstable/*) parses each Worker entry's project
 * and this test walks the entry's relative value-import closure. Every `new <Error>(…)`
 * and every call to a code-carrying helper is collected; a string literal there must be a
 * registered code, and every template or dynamic site must be classified in the explicit
 * lists below. Nothing is skipped silently: an unclassified site, a stale classification,
 * or an unknown error constructor fails the test.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SENTINEL = "SENTINEL_secret_9f3a";

const WORKER_ENTRIES = [
  { tsconfig: "cloudflare/tsconfig.json", entry: "cloudflare/src/worker.ts" },
  { tsconfig: "forecast-collector/tsconfig.json", entry: "forecast-collector/src/worker.ts" },
  { tsconfig: "forecast-dispatcher/tsconfig.json", entry: "forecast-dispatcher/src/worker.ts" },
  { tsconfig: "forecast-interactions/tsconfig.json", entry: "forecast-interactions/src/worker.ts" },
  { tsconfig: "stats-observer/tsconfig.json", entry: "stats-observer/src/worker.ts" },
  { tsconfig: "usage-guard/tsconfig.json", entry: "usage-guard/src/worker.ts" },
  { tsconfig: "forecast-admin/tsconfig.json", entry: "forecast-admin/src/worker.ts" },
  { tsconfig: "site-worker/tsconfig.json", entry: "site-worker/src/worker.ts" },
  // Sanitizer consumer outside a Worker entry: canary runtime evidence is evaluated by the
  // collector and by CI scripts, and its evidence errors go through the same registry.
  { tsconfig: "tsconfig.json", entry: "shared/forecastCanaryRuntime.ts" },
] as const;

/** Modules the walk stops at: legacy certified-solver internals and bulk generated data are
 * outside the registry's contract (their messages collapse to a policy fallback). */
const EXCLUDED_MODULES = ["shared/certifiedSupply.ts", "shared/generated/"] as const;

type ConstructorRule =
  | { codeArgument: number }
  | { fixedCode: AppErrorCode }
  | { fixedMessage: string };

/** Which constructor argument carries the code. An unlisted `*Error` constructor fails. */
const ERROR_CONSTRUCTORS: Readonly<Record<string, ConstructorRule>> = {
  Error: { codeArgument: 0 },
  TypeError: { codeArgument: 0 },
  RangeError: { codeArgument: 0 },
  HttpError: { codeArgument: 1 },
  DiscordMessageError: { codeArgument: 0 },
  DiscordObserverError: { codeArgument: 0 },
  AccessError: { codeArgument: 0 },
  CalendarDataError: { codeArgument: 0 },
  UsageGuardError: { fixedCode: "telemetry_budget_disabled" },
  SiteverifyTransportError: { fixedMessage: "Siteverify transport failed." },
};

type CallRule = {
  callee: string;
  codeArgument: number;
  /** Module-private helpers match only in their own file (other modules reuse the name). */
  files?: readonly string[];
  /** Prefix the helper prepends to the argument before throwing. */
  prefix?: string;
  /** Suffixes the helper may append to the argument for derived codes. */
  derived?: readonly string[];
};

/** Helpers whose string argument becomes a thrown message. */
const CODE_CARRYING_CALLS: readonly CallRule[] = [
  { callee: "readBoundedBytes", codeArgument: 2 },
  { callee: "readBoundedText", codeArgument: 2 },
  { callee: "readBoundedJson", codeArgument: 2, derived: ["_encoding", "_json"] },
  { callee: "fail", codeArgument: 0, files: ["forecast-admin/src/calendar.ts"] },
  { callee: "parseJson", codeArgument: 1, files: ["forecast-admin/src/calendar.ts"] },
  {
    callee: "assertEqual",
    codeArgument: 2,
    files: ["shared/d1QuotaEvidence.ts"],
  },
  {
    callee: "snapshotError",
    codeArgument: 0,
    files: ["shared/certifiedSupplyValidation.ts"],
    prefix: "certified_snapshot_",
  },
  ...[
    "requiredString",
    "requiredFinite",
    "requiredTimestamp",
    "requiredVersionId",
    "optionalString",
  ].map((callee) => ({
    callee,
    codeArgument: 1,
    files: ["shared/forecastCanaryRuntimeEvidence.ts", "shared/forecastCanaryRuntime.ts"],
  })),
];

/** Thrown messages that are prose, not codes. The sanitizer never emits them: such an error
 * reports its fixed runtime name (TypeError, RangeError) or the policy fallback. */
const PROSE_MESSAGES: ReadonlyArray<{ file: string; message: string }> = [
  { file: "forecast-collector/src/v2/rules/game-day.ts", message: "Invalid instant" },
  { file: "forecast-collector/src/v2/rules/game-day.ts", message: "Invalid game day" },
  { file: "forecast-collector/src/v2/rules/game-day.ts", message: "Expected whole game days" },
  { file: "forecast-collector/src/v2/rules/game-day.ts", message: "Invalid notice time" },
  { file: "forecast-collector/src/v2/rules/notice-dates.ts", message: "Invalid post time" },
  { file: "forecast-collector/src/v2/rules/grant-judgment.ts", message: "Invalid kit quantity" },
  { file: "shared/certifiedRational.ts", message: "rational: unsafe integer numerator" },
  { file: "shared/certifiedRational.ts", message: "rational: unsafe integer denominator" },
  { file: "shared/certifiedRational.ts", message: "rational: zero denominator" },
  { file: "shared/certifiedRational.ts", message: "rational: division by zero" },
  { file: "shared/certifiedRational.ts", message: "rational: bad wire" },
  { file: "shared/certifiedRational.ts", message: "rational: non-finite double" },
  { file: "shared/supplyForecastCandidate.ts", message: "Solo Raid schedule is inverted." },
  {
    file: "shared/supplyForecastCandidate.ts",
    message: "Solo Raid cadence must be a whole number of game days.",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    message: "Primary Solo Raid schedule is missing from its period ledger.",
  },
  { file: "shared/supplyForecastCandidate.ts", message: "Forecast profiles are not contiguous." },
  {
    file: "shared/supplyForecastCandidate.ts",
    message: "Final forecast profile must be open-ended.",
  },
];

/**
 * How a template-literal throw site reaches the registry:
 * - family: the sanitizer maps every instance to one fixed family code;
 * - enumerated: the placeholder ranges over a closed set and every instance is registered;
 * - derived: the placeholder is itself a registered code and the derived forms are
 *   registered per call site;
 * - prose: free text, never emitted (the sanitizer reports a name or the fallback).
 */
type TemplateSite = { file: string; template: string } & (
  | { kind: "family"; family: AppErrorCode; placeholder?: string }
  | { kind: "enumerated"; codes: readonly AppErrorCode[] }
  | { kind: "derived" }
  | { kind: "prose" }
);

/** Template-literal throw sites and how each instance reaches the registry. */
const TEMPLATE_SITES: readonly TemplateSite[] = [
  {
    file: "forecast-dispatcher/src/discord.ts",
    template: "`discord_create_message_${response.status}`",
    kind: "family",
    family: "discord_create_message_http",
    placeholder: "599",
  },
  {
    file: "forecast-dispatcher/src/discord.ts",
    template: "`discord_${kind}_channel_id_invalid`",
    kind: "enumerated",
    codes: ["discord_activity_channel_id_invalid", "discord_alert_channel_id_invalid"],
  },
  {
    file: "forecast-dispatcher/src/discord.ts",
    template: "`discord_${suffix}`",
    kind: "enumerated",
    codes: ["discord_timeout", "discord_network"],
  },
  {
    file: "forecast-dispatcher/src/v2-outbox.ts",
    template: "`v2_reconcile_${response.status}`",
    kind: "family",
    family: "v2_reconcile_http",
    placeholder: "599",
  },
  {
    file: "stats-observer/src/discord.ts",
    template: "`discord_${code}`",
    kind: "enumerated",
    codes: ["discord_timeout", "discord_network"],
  },
  {
    file: "stats-observer/src/discord.ts",
    template: "`discord_${response.status}`",
    kind: "family",
    family: "discord_http",
    placeholder: "599",
  },
  { file: "shared/boundedHttp.ts", template: "`${errorCode}_encoding`", kind: "derived" },
  { file: "shared/boundedHttp.ts", template: "`${errorCode}_json`", kind: "derived" },
  {
    file: "forecast-collector/src/admin-routes-canary.ts",
    template: "`cloudflare_paid_guard_${guard.action}`",
    kind: "enumerated",
    codes: [
      "cloudflare_paid_guard_warning",
      "cloudflare_paid_guard_disable_staging",
      "cloudflare_paid_guard_disable_forecast_production",
      "cloudflare_paid_guard_disable_statistics_writes",
      "cloudflare_paid_guard_hard_stop",
    ],
  },
  {
    file: "forecast-collector/src/v2/rules/decisions.ts",
    template: "`Invalid ${kind} payload`",
    kind: "prose",
  },
  {
    file: "forecast-collector/src/candidate.ts",
    template: "`${label} is missing.`",
    kind: "prose",
  },
  { file: "shared/certifiedRational.ts", template: "`rational: cannot parse ${s}`", kind: "prose" },
  {
    file: "shared/certifiedSupplyLaws.ts",
    template: "`certified_law_unknown:${finite.id}`",
    kind: "family",
    family: "certified_law_unknown",
  },
  {
    file: "shared/certifiedSupplyLaws.ts",
    template: "`certified_law_unknown:${lawId}`",
    kind: "family",
    family: "certified_law_unknown",
  },
  {
    file: "shared/cloudflareD1Catalog.ts",
    template: "`cloudflare_d1_list_http_${response.status}`",
    kind: "family",
    family: "cloudflare_d1_list_http",
    placeholder: "599",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_d1_database_missing:${databaseId}`",
    kind: "family",
    family: "cloudflare_d1_database_missing",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_paid_counter_regression:${field}`",
    kind: "family",
    family: "cloudflare_paid_counter_regression",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_subscription_http_${response.status}`",
    kind: "family",
    family: "cloudflare_subscription_http",
    placeholder: "599",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_workers_paid_subscription_count:${paid.length}`",
    kind: "family",
    family: "cloudflare_workers_paid_subscription_count",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_paid_graphql_http_${response.status}`",
    kind: "family",
    family: "cloudflare_paid_graphql_http",
    placeholder: "599",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_paid_graphql_${name}_limit_reached`",
    kind: "family",
    family: "cloudflare_paid_graphql",
  },
  {
    file: "shared/cloudflarePaidUsage.ts",
    template: "`cloudflare_paid_graphql_${name}_invalid`",
    kind: "family",
    family: "cloudflare_paid_graphql",
  },
  {
    file: "shared/d1QuotaEvidence.ts",
    template: "`cloudflare_paid_quota_required_database_missing:${databaseId}`",
    kind: "family",
    family: "cloudflare_paid_quota_database_missing",
  },
  {
    file: "shared/d1QuotaEvidence.ts",
    template: "`cloudflare_paid_quota_duplicate_${kind}`",
    kind: "family",
    family: "cloudflare_paid_quota_duplicate",
  },
  {
    file: "shared/forecastCanaryRuntime.ts",
    template: "`runtime_baseline_worker_invalid:${component}`",
    kind: "family",
    family: "runtime_baseline_worker_invalid",
  },
  {
    file: "shared/forecastCanaryRuntime.ts",
    template: "`runtime_baseline_distribution_invalid:${component}:${segment}`",
    kind: "family",
    family: "runtime_baseline_distribution_invalid",
  },
  {
    file: "shared/forecastCanaryRuntime.ts",
    template: "`runtime_baseline_average_invalid:${component}:${segment}`",
    kind: "family",
    family: "runtime_baseline_average_invalid",
  },
  {
    file: "shared/forecastCanaryRuntime.ts",
    template: "`runtime_baseline_p95_invalid:${component}:${segment}`",
    kind: "family",
    family: "runtime_baseline_p95_invalid",
  },
  {
    file: "shared/certifiedSupplyValidation.ts",
    template: "`certified_snapshot_${reason}`",
    kind: "derived",
  },
  {
    file: "shared/certifiedSupplyValidation.ts",
    template: "`unknown_field:${String(key)}`",
    kind: "family",
    family: "certified_snapshot_unknown_field",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    template: "`${label} period is inverted.`",
    kind: "prose",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    template: "`${label} period is duplicated.`",
    kind: "prose",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    template: "`${label} periods must be ordered and non-overlapping.`",
    kind: "prose",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    template: "`Source URL is not allowlisted: ${evidence.url}`",
    kind: "prose",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    template: "`Profile does not belong to ${candidate.forecastId}.`",
    kind: "prose",
  },
  {
    file: "shared/supplyForecastCandidate.ts",
    template: "`Forecast gain is invalid at ${current.id}.`",
    kind: "prose",
  },
];

type DynamicSite = {
  file: string;
  expression: string;
  reason: string;
  /** The closed set of codes the expression can carry, when it is not already sanitized. */
  codes?: readonly AppErrorCode[];
};

/** Constructor arguments that are not literals, each with the closed set it ranges over. */
const DYNAMIC_SITES: readonly DynamicSite[] = [
  {
    file: "cloudflare/src/event-submission.ts",
    expression: "rejection.rejectionCode",
    reason: "classifyRejectedPayload assigns one of these literals",
    codes: [
      "invalid_payload",
      "unsupported_recovery_version",
      "unsupported_recovery_policy",
      "unsupported_solver_version",
    ],
  },
  {
    file: "cloudflare/src/quota-guard.ts",
    expression: "error.code",
    reason: "UsageGuardError.code is the fixed telemetry_budget_disabled",
    codes: ["telemetry_budget_disabled"],
  },
  {
    file: "forecast-admin/src/calendar.ts",
    expression: "code",
    reason: "fail(code) forwards its literal argument (collected as a code-carrying call)",
  },
  {
    file: "shared/boundedHttp.ts",
    expression: "errorCode",
    reason: "readBounded* forward the caller's literal (collected as code-carrying calls)",
  },
  {
    file: "shared/d1QuotaEvidence.ts",
    expression: "code",
    reason:
      "assertEqual(…, code) forwards its literal argument (collected as a code-carrying call)",
  },
  {
    file: "forecast-collector/src/canary-start-contract.ts",
    expression: "code",
    reason: "assertVersionId forwards its literal argument (collected as a code-carrying call)",
    codes: ["canary_collector_version_id_invalid", "canary_dispatcher_version_id_invalid"],
  },
  {
    file: "shared/forecast-publication/store.ts",
    expression: "coverageError",
    reason: "candidateCoverageError returns one of these literals",
    codes: ["publication_unsupported_cadence", "publication_evidence_uncovered"],
  },
  {
    file: "shared/forecastCanaryRuntimeEvidence.ts",
    expression: "code",
    reason:
      "required*/optionalString forward their literal argument (collected as code-carrying calls)",
  },
  {
    file: "stats-observer/src/worker.ts",
    expression: "code",
    reason: "rethrows the sanitizer's own output",
  },
];

type Argument =
  | { kind: "literal"; code: string }
  | { kind: "template"; text: string; prefix: string }
  | { kind: "dynamic"; text: string }
  | { kind: "missing" };

type Site = {
  file: string;
  line: number;
  callee: string;
  argument: Argument;
  derived: readonly string[];
};

type Collected = {
  files: string[];
  sites: Site[];
  constructorsSeen: Set<string>;
  unknownConstructors: Array<{ file: string; line: number; callee: string }>;
};

function toProjectPath(file: string) {
  return relative(ROOT, file).replaceAll("\\", "/");
}

function resolveRelativeImport(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Unresolved relative import ${specifier} from ${toProjectPath(from)}`);
}

function valueImports(sourceFile: SourceFile) {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      const typeOnly = statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword;
      if (!typeOnly && isStringLiteral(statement.moduleSpecifier))
        specifiers.push(statement.moduleSpecifier.text);
    } else if (isExportDeclaration(statement)) {
      if (
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        isStringLiteral(statement.moduleSpecifier)
      )
        specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

function calleeName(expression: Expression) {
  if (isIdentifier(expression)) return expression.text;
  if (isPropertyAccessExpression(expression) && isIdentifier(expression.name))
    return expression.name.text;
  return null;
}

function walkNodes(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild(
    (child) => walkNodes(child, visit),
    (children) => {
      for (const child of children) walkNodes(child, visit);
    },
  );
}

function classifyArgument(
  sourceFile: SourceFile,
  argument: Expression | undefined,
  prefix: string,
): Argument {
  if (!argument) return { kind: "missing" };
  if (isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument))
    return { kind: "literal", code: `${prefix}${argument.text}` };
  if (isTemplateExpression(argument))
    return { kind: "template", text: argument.getText(sourceFile), prefix };
  return { kind: "dynamic", text: argument.getText(sourceFile) };
}

function collectSites(sourceFile: SourceFile, file: string, collected: Collected) {
  const line = (node: Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  walkNodes(sourceFile, (node) => {
    if (isNewExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee === null || !/Error$|^DOMException$/.test(callee)) return;
      const rule = ERROR_CONSTRUCTORS[callee];
      if (!rule) {
        collected.unknownConstructors.push({ file, line: line(node), callee });
        return;
      }
      collected.constructorsSeen.add(callee);
      if (!("codeArgument" in rule)) return;
      collected.sites.push({
        file,
        line: line(node),
        callee,
        argument: classifyArgument(sourceFile, node.arguments?.[rule.codeArgument], ""),
        derived: [],
      });
      return;
    }
    if (!isCallExpression(node)) return;
    const callee = calleeName(node.expression);
    if (callee === null) return;
    for (const rule of CODE_CARRYING_CALLS) {
      if (rule.callee !== callee || (rule.files && !rule.files.includes(file))) continue;
      collected.sites.push({
        file,
        line: line(node),
        callee,
        argument: classifyArgument(
          sourceFile,
          node.arguments[rule.codeArgument],
          rule.prefix ?? "",
        ),
        derived: rule.derived ?? [],
      });
    }
  });
}

function collectClosures() {
  const api = new API({ cwd: ROOT });
  try {
    const configs = [...new Set(WORKER_ENTRIES.map((entry) => resolve(ROOT, entry.tsconfig)))];
    const snapshot = api.updateSnapshot({ openProjects: configs });
    const collected: Collected = {
      files: [],
      sites: [],
      constructorsSeen: new Set(),
      unknownConstructors: [],
    };
    const visited = new Set<string>();
    for (const entry of WORKER_ENTRIES) {
      const project = snapshot.getProject(resolve(ROOT, entry.tsconfig));
      if (!project) throw new Error(`Project ${entry.tsconfig} did not open`);
      const stack = [resolve(ROOT, entry.entry)];
      while (stack.length > 0) {
        const file = stack.pop();
        if (file === undefined) continue;
        const projectPath = toProjectPath(file);
        if (visited.has(projectPath)) continue;
        visited.add(projectPath);
        if (EXCLUDED_MODULES.some((excluded) => projectPath.startsWith(excluded))) continue;
        const sourceFile = project.program.getSourceFile(file);
        if (!sourceFile) throw new Error(`${projectPath} is not part of ${entry.tsconfig}`);
        collected.files.push(projectPath);
        collectSites(sourceFile, projectPath, collected);
        for (const specifier of valueImports(sourceFile))
          stack.push(resolveRelativeImport(file, specifier));
      }
    }
    collected.files.sort();
    return collected;
  } finally {
    api.close();
  }
}

function describeSite(site: Site) {
  return `${site.file}:${site.line} ${site.callee}`;
}

const CODE_SHAPE = /^[a-z][a-z0-9_]{0,79}$/;

function migrationTriggerCodes() {
  const directory = resolve(ROOT, "forecast-collector/migrations");
  const codes = new Set<string>();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(resolve(directory, name), "utf8");
    for (const match of sql.matchAll(
      /RAISE\s*\(\s*(?:ABORT|FAIL|ROLLBACK)\s*,\s*'([A-Za-z0-9_]+)'/g,
    ))
      codes.add(match[1] ?? "");
  }
  return codes;
}

function instantiate(template: string, placeholder: string) {
  return template.replace(/^`|`$/g, "").replaceAll(/\$\{[^}]*\}/g, placeholder);
}

describe("error code registry drift", () => {
  let collected: Collected;
  beforeAll(() => {
    collected = collectClosures();
  }, 120_000);

  it("walks every Worker entry's value-import closure", () => {
    for (const entry of WORKER_ENTRIES) expect(collected.files).toContain(entry.entry);
    expect(collected.files).toContain("shared/forecast-publication/store.ts");
    expect(collected.files).toContain("shared/usageGuard.ts");
    expect(collected.files).toContain("shared/cloudflareD1Catalog.ts");
    expect(collected.files).toContain("shared/cloudflareWorkerRuntimeWindow.ts");
    expect(collected.files).toContain("shared/d1QuotaEvidence.ts");
    expect(collected.files).toContain("shared/forecastPublicationBytes.ts");
    for (const excluded of EXCLUDED_MODULES)
      expect(collected.files.some((file) => file.startsWith(excluded))).toBe(false);
    expect(collected.sites.length).toBeGreaterThan(300);
  });

  it("knows every error constructor it meets", () => {
    expect(collected.unknownConstructors).toEqual([]);
    for (const [callee, rule] of Object.entries(ERROR_CONSTRUCTORS)) {
      expect(collected.constructorsSeen, `${callee} is listed but never constructed`).toContain(
        callee,
      );
      if ("fixedCode" in rule) expect(isAppErrorCode(rule.fixedCode)).toBe(true);
      if ("fixedMessage" in rule) expect(rule.fixedMessage).not.toMatch(CODE_SHAPE);
    }
  });

  it("registers every literal code thrown in the closure", () => {
    const prose = new Set(PROSE_MESSAGES.map((entry) => `${entry.file}\0${entry.message}`));
    const unregistered: string[] = [];
    for (const site of collected.sites) {
      if (site.argument.kind !== "literal") continue;
      const literal = site.argument.code;
      if (prose.has(`${site.file}\0${literal}`)) continue;
      for (const code of [literal, ...site.derived.map((suffix) => literal + suffix)])
        if (!isAppErrorCode(code)) unregistered.push(`${describeSite(site)} "${code}"`);
    }
    expect(unregistered).toEqual([]);
  });

  it("lists prose messages that never look like codes, each at a real site", () => {
    const literals = new Set(
      collected.sites.flatMap((site) =>
        site.argument.kind === "literal" ? [`${site.file}\0${site.argument.code}`] : [],
      ),
    );
    for (const entry of PROSE_MESSAGES) {
      expect(entry.message, entry.message).not.toMatch(CODE_SHAPE);
      expect(literals, `${entry.file} "${entry.message}" is not thrown`).toContain(
        `${entry.file}\0${entry.message}`,
      );
    }
    for (const site of collected.sites) {
      if (site.argument.kind !== "literal" || CODE_SHAPE.test(site.argument.code)) continue;
      const literal = site.argument.code;
      expect(
        PROSE_MESSAGES.some((entry) => entry.file === site.file && entry.message === literal),
        `${describeSite(site)} "${literal}" is neither a code nor listed prose`,
      ).toBe(true);
    }
  });

  it("classifies every template-literal site explicitly", () => {
    const templates = collected.sites.flatMap((site) =>
      site.argument.kind === "template"
        ? [{ site, text: site.argument.text, prefix: site.argument.prefix }]
        : [],
    );
    const unclassified = templates
      .filter(
        ({ site, text }) =>
          !TEMPLATE_SITES.some((entry) => entry.file === site.file && entry.template === text),
      )
      .map(({ site, text }) => `${describeSite(site)} ${text}`);
    expect(unclassified).toEqual([]);
    for (const entry of TEMPLATE_SITES) {
      const matched = templates.filter(
        ({ site, text }) => site.file === entry.file && text === entry.template,
      );
      expect(matched.length > 0, `${entry.file} ${entry.template} is no longer a throw site`).toBe(
        true,
      );
      for (const { prefix } of matched) {
        const thrown = (placeholder: string) => prefix + instantiate(entry.template, placeholder);
        if (entry.kind === "family") {
          expect(errorCode(new Error(thrown(entry.placeholder ?? SENTINEL)))).toBe(entry.family);
          expect(errorCode(new Error(thrown(SENTINEL)))).not.toContain(SENTINEL);
        } else if (entry.kind === "enumerated") {
          for (const code of entry.codes) expect(isAppErrorCode(code)).toBe(true);
          expect(errorCode(new Error(thrown(SENTINEL)))).not.toContain(SENTINEL);
        } else if (entry.kind === "prose") {
          expect(thrown("x")).not.toMatch(CODE_SHAPE);
        }
      }
    }
  });

  it("classifies every dynamic site explicitly", () => {
    const dynamics = collected.sites.flatMap((site) =>
      site.argument.kind === "dynamic"
        ? [{ site, text: site.argument.text }]
        : site.argument.kind === "missing"
          ? [{ site, text: "<missing argument>" }]
          : [],
    );
    const unclassified = dynamics
      .filter(
        ({ site, text }) =>
          !DYNAMIC_SITES.some((entry) => entry.file === site.file && entry.expression === text),
      )
      .map(({ site, text }) => `${describeSite(site)} ${text}`);
    expect(unclassified).toEqual([]);
    for (const entry of DYNAMIC_SITES) {
      const matched = dynamics.some(
        ({ site, text }) => site.file === entry.file && text === entry.expression,
      );
      expect(matched, `${entry.file} ${entry.expression} is no longer a throw site`).toBe(true);
      for (const code of entry.codes ?? []) expect(isAppErrorCode(code)).toBe(true);
    }
  });

  it("keeps the registry itself well formed", () => {
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
    for (const code of APP_ERROR_CODES) expect(code, code).toMatch(CODE_SHAPE);
    for (const name of SAFE_ERROR_NAMES) expect(isAppErrorCode(name)).toBe(false);
    for (const category of ERROR_CATEGORIES) expect(isAppErrorCode(category)).toBe(false);
    expect(SAFE_ERROR_NAMES).not.toContain("Error");
    for (const fallback of Object.values(ERROR_CODE_POLICIES))
      expect(fallback === "unexpected" || isAppErrorCode(fallback)).toBe(true);
    for (const [prefix, family] of SUFFIX_FAMILIES) {
      expect(isAppErrorCode(family)).toBe(true);
      expect(isAppErrorCode(prefix)).toBe(false);
    }
    for (const [prefix, family] of Object.entries(HTTP_STATUS_FAMILIES)) {
      expect(isAppErrorCode(family)).toBe(true);
      for (const status of HTTP_STATUSES) expect(isAppErrorCode(`${prefix}${status}`)).toBe(true);
    }
  });

  it("registers exactly the codes the D1 migrations raise", () => {
    expect([...D1_TRIGGER_CODES].sort()).toEqual([...migrationTriggerCodes()].sort());
    for (const code of D1_TRIGGER_CODES) expect(isAppErrorCode(code)).toBe(true);
  });
});
