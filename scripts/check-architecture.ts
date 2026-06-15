import {
  architectureIssues,
  formatArchitectureResult,
  gitTrackedFiles,
} from "./architecture-rules.ts";

const files = gitTrackedFiles();
const issues = architectureIssues(files);
const message = formatArchitectureResult(files, issues);

if (issues.length > 0) {
  console.error(message);
  process.exit(1);
}

console.log(message);
