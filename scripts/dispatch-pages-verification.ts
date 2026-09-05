import { pathToFileURL } from "node:url";

const API_VERSION = "2026-03-10";
const WORKFLOW = "pages.yml";
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_BRANCH =
  /^automation\/(?:supply-forecast\/forecast-[0-9a-f]{24}|staging-forecast-adoption\/[A-Za-z0-9._-]+)$/;

type GitHubWorkflowRun = {
  event?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
};

type DispatchDependencies = {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type PagesVerificationInput = {
  repository: string;
  branch: string;
  headSha: string;
  token: string;
  apiUrl?: string;
};

export async function dispatchPagesVerification(
  input: PagesVerificationInput,
  dependencies: DispatchDependencies = {},
) {
  validateInput(input);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const apiUrl = (input.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "User-Agent": "nikke-forecast-pr-verifier",
    "X-GitHub-Api-Version": API_VERSION,
  };

  const refPath = input.branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const refUrl = `${apiUrl}/repos/${input.repository}/git/ref/heads/${refPath}`;
  await waitForHead(refUrl, input.headSha, headers, fetchImpl, sleep);

  const dispatchUrl = `${apiUrl}/repos/${input.repository}/actions/workflows/${WORKFLOW}/dispatches`;
  const dispatch = await fetchImpl(dispatchUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: input.branch }),
    signal: AbortSignal.timeout(10_000),
  });
  if (dispatch.status !== 204) {
    throw new Error(`pages_verification_dispatch_failed:${dispatch.status}`);
  }

  const runsUrl = new URL(`${apiUrl}/repos/${input.repository}/actions/workflows/${WORKFLOW}/runs`);
  runsUrl.searchParams.set("event", "workflow_dispatch");
  runsUrl.searchParams.set("branch", input.branch);
  runsUrl.searchParams.set("per_page", "20");
  return await waitForRun(runsUrl.toString(), input.headSha, headers, fetchImpl, sleep);
}

async function waitForHead(
  url: string,
  expectedSha: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { object?: { sha?: unknown } };
      if (body.object?.sha === expectedSha) return;
    } else if (!retryable(response.status)) {
      throw new Error(`pages_verification_ref_probe_failed:${response.status}`);
    }
    if (attempt < 5) await sleep((attempt + 1) * 1_000);
  }
  throw new Error("pages_verification_ref_not_ready");
}

async function waitForRun(
  url: string,
  expectedSha: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { workflow_runs?: GitHubWorkflowRun[] };
      const run = body.workflow_runs?.find(
        (candidate) =>
          candidate.event === "workflow_dispatch" && candidate.head_sha === expectedSha,
      );
      if (run && typeof run.html_url === "string") return run.html_url;
    } else if (!retryable(response.status)) {
      throw new Error(`pages_verification_run_probe_failed:${response.status}`);
    }
    if (attempt < 11) await sleep(2_000);
  }
  throw new Error("pages_verification_run_not_registered");
}

function validateInput(input: PagesVerificationInput) {
  if (!REPOSITORY.test(input.repository)) throw new Error("invalid_pages_verification_repository");
  if (!ALLOWED_BRANCH.test(input.branch)) throw new Error("invalid_pages_verification_branch");
  if (!SHA.test(input.headSha)) throw new Error("invalid_pages_verification_sha");
  if (input.token.length < 20) throw new Error("missing_pages_verification_token");
}

function retryable(status: number) {
  return status === 404 || status === 409 || status === 422 || status === 429 || status >= 500;
}

async function run() {
  const [branch, headSha] = process.argv.slice(2);
  const apiUrl = process.env["GITHUB_API_URL"];
  const runUrl = await dispatchPagesVerification({
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    branch: branch ?? "",
    headSha: headSha ?? "",
    token: process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "",
    ...(apiUrl === undefined ? {} : { apiUrl }),
  });
  console.log(`Full Pages verification requested for ${headSha}: ${runUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
