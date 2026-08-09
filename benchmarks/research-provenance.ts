import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type ResearchSourceFingerprint = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ResearchArtifactFingerprint = ResearchSourceFingerprint;

export type ResearchProvenance = {
  version: 1;
  studyId: string;
  protocolVersion: number;
  contractSha256: string;
  repoCommit: string;
  dirtyPaths: string[];
  sourceFingerprint: string;
  sourceFiles: ResearchSourceFingerprint[];
  wasm: ResearchArtifactFingerprint | null;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
};

type CollectResearchProvenanceOptions = {
  repoRoot: string;
  studyId: string;
  protocolVersion: number;
  contract: unknown;
  sourceFiles: readonly string[];
  wasmPath?: string;
};

type ReportWithOptionalProvenance = {
  provenance?: ResearchProvenance;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function collectResearchProvenance({
  repoRoot,
  studyId,
  protocolVersion,
  contract,
  sourceFiles,
  wasmPath,
}: CollectResearchProvenanceOptions): ResearchProvenance {
  const normalizedRoot = resolve(repoRoot);
  const fingerprints = [...new Set(sourceFiles)]
    .map((path) => fingerprintFile(normalizedRoot, path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const wasm = wasmPath ? fingerprintFile(normalizedRoot, wasmPath) : null;

  return {
    version: 1,
    studyId,
    protocolVersion,
    contractSha256: sha256(canonicalJson(contract)),
    repoCommit: git(normalizedRoot, ["rev-parse", "HEAD"]),
    dirtyPaths: git(normalizedRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
      .split(/\r?\n/u)
      .filter(Boolean),
    sourceFingerprint: sha256(
      fingerprints.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`).join("\n"),
    ),
    sourceFiles: fingerprints,
    wasm,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export function fingerprintResearchArtifact(
  repoRoot: string,
  path: string,
): ResearchArtifactFingerprint {
  return fingerprintFile(resolve(repoRoot), path);
}

export function assertResearchReportCanBeWritten(
  existing: ReportWithOptionalProvenance | null,
  next: ResearchProvenance,
  allowReplace = process.env["RESEARCH_REPLACE"] === "1",
): void {
  if (!existing) return;
  if (!existing.provenance) {
    throw new Error(
      "Existing report has no provenance. Preserve it as legacy evidence or set RESEARCH_REPLACE=1 explicitly.",
    );
  }
  if (sameResearchIdentity(existing.provenance, next)) {
    throw new Error(
      "An identical research contract is already recorded. Reuse that result or set RESEARCH_REPLACE=1 explicitly.",
    );
  }
  if (!allowReplace) {
    throw new Error(
      "The output belongs to a different research contract. Use a new output path or set RESEARCH_REPLACE=1 explicitly.",
    );
  }
}

export function sameResearchIdentity(left: ResearchProvenance, right: ResearchProvenance): boolean {
  return (
    left.version === right.version &&
    left.studyId === right.studyId &&
    left.protocolVersion === right.protocolVersion &&
    left.contractSha256 === right.contractSha256 &&
    left.repoCommit === right.repoCommit &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.wasm?.sha256 === right.wasm?.sha256
  );
}

function fingerprintFile(repoRoot: string, path: string): ResearchSourceFingerprint {
  const absolutePath = resolve(repoRoot, path);
  const contents = readFileSync(absolutePath);
  return {
    path: normalizePath(relative(repoRoot, absolutePath)),
    bytes: statSync(absolutePath).size,
    sha256: sha256(contents),
  };
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
