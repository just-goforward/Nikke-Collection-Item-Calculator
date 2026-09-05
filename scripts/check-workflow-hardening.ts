import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const DOCKER_DIGEST = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/i;

export type WorkflowHardeningIssue = {
  line: number;
  message: string;
};

type WorkflowJob = {
  id: string;
  line: number;
  hasTimeout: boolean;
  callsReusableWorkflow: boolean;
};

function usesReference(line: string): string | undefined {
  const match = line.match(/^\s*(?:-\s+)?uses:\s*(.*?)\s*$/);
  if (!match) return undefined;

  const rawReference = match[1];
  if (rawReference === undefined) return undefined;

  let reference = rawReference.replace(/\s+#.*$/, "").trim();
  if (
    (reference.startsWith('"') && reference.endsWith('"')) ||
    (reference.startsWith("'") && reference.endsWith("'"))
  ) {
    reference = reference.slice(1, -1);
  }
  return reference;
}

function externalReferenceIssue(reference: string): string | undefined {
  if (reference.startsWith("./")) return undefined;
  if (reference.startsWith("docker://")) {
    if (!DOCKER_DIGEST.test(reference)) {
      return `external Docker action "${reference}" must use a sha256 digest`;
    }
    return undefined;
  }

  const separator = reference.lastIndexOf("@");
  const repository = separator >= 0 ? reference.slice(0, separator) : reference;
  const revision = separator >= 0 ? reference.slice(separator + 1) : "";
  if (!repository.includes("/") || !FULL_COMMIT_SHA.test(revision)) {
    return `external action "${reference}" must use a full 40-character commit SHA`;
  }
  return undefined;
}

export function validateWorkflowSource(source: string): WorkflowHardeningIssue[] {
  const issues: WorkflowHardeningIssue[] = [];
  const lines = source.split(/\r?\n/);
  let inJobs = false;
  let currentJob: WorkflowJob | undefined;

  const finishJob = () => {
    if (currentJob && !currentJob.hasTimeout && !currentJob.callsReusableWorkflow) {
      issues.push({
        line: currentJob.line,
        message: `job "${currentJob.id}" is missing timeout-minutes`,
      });
    }
    currentJob = undefined;
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const reference = usesReference(line);
    if (reference !== undefined) {
      const message = externalReferenceIssue(reference);
      if (message) issues.push({ line: lineNumber, message });
    }

    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      finishJob();
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      finishJob();
      inJobs = false;
      continue;
    }

    const jobMatch = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      if (jobId === undefined) continue;

      finishJob();
      currentJob = {
        id: jobId,
        line: lineNumber,
        hasTimeout: false,
        callsReusableWorkflow: false,
      };
      continue;
    }
    if (!currentJob) continue;

    if (/^ {4}timeout-minutes:\s*[^#\s]/.test(line)) currentJob.hasTimeout = true;
    if (/^ {4}uses:\s*[^#\s]/.test(line)) currentJob.callsReusableWorkflow = true;
  }

  finishJob();
  return issues.sort((left, right) => left.line - right.line);
}

function workflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return workflowFiles(path);
    return /\.ya?ml$/i.test(entry.name) ? [path] : [];
  });
}

function run() {
  const root = process.cwd();
  const files = workflowFiles(resolve(root, ".github/workflows")).sort();
  const failures = files.flatMap((file) =>
    validateWorkflowSource(readFileSync(file, "utf8")).map(
      (issue) => `${relative(root, file).replaceAll("\\", "/")}:${issue.line} ${issue.message}`,
    ),
  );

  if (failures.length > 0) {
    throw new Error(`Workflow hardening check failed:\n- ${failures.join("\n- ")}`);
  }
  console.log(`Workflow hardening check passed for ${files.length} workflow files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
