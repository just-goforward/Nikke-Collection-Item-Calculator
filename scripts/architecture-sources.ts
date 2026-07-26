import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { CHECK_ROOTS, SOURCE_EXTENSIONS } from "./architecture-config.ts";

export function normalizeFile(file: string) {
  return file.replace(/\\/g, "/");
}

export function gitTrackedFiles(roots = CHECK_ROOTS) {
  const tracked = gitLsFiles(["ls-files", ...roots]);
  const untracked = gitLsFiles(["ls-files", "--others", "--exclude-standard", ...roots]);
  return [...new Set([...tracked, ...untracked])]
    .filter((file) => existsSync(file))
    .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)));
}

function gitLsFiles(args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `${args.join(" ")} failed with status ${result.status}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean).map(normalizeFile);
}

export function sourceOf(file: string) {
  return readFileSync(file, "utf8");
}

export function lineCount(file: string) {
  return sourceOf(file).split(/\r?\n/).length;
}

export function resolveImport(from: string, specifier: string, files: Set<string>) {
  if (specifier.startsWith("/")) {
    const projectAbsolute = normalizeFile(specifier.slice(1));
    return files.has(projectAbsolute) ? projectAbsolute : null;
  }
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (files.has(base)) return base;
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}
