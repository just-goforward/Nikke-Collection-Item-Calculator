import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { validateWorkflowSource } from "./check-workflow-hardening";

const workflow = readFileSync(".github/workflows/forecast-router-bootstrap.yml", "utf8");
const promotion = readFileSync(".github/workflows/forecast-collector-promote.yml", "utf8");

function step(name: string) {
  const source = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0];
  if (!source) throw new Error(`missing_workflow_step:${name}`);
  return source;
}

describe("Protected disabled production Router bootstrap", () => {
  it("requires explicit confirmation, trusted main ancestry and the production approval boundary", () => {
    const triggers = workflow.split("\non:\n")[1]?.split("\npermissions:")[0];
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/);
    expect(triggers).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_call):/m);
    expect(triggers).toContain("confirm_router_only:");
    expect(triggers).toContain("default: false");
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.confirm_router_only",
    );
    expect(workflow).toContain("environment: cloudflare-production");
    expect(workflow).toContain("group: forecast-collector-production");
    expect(workflow).toContain("cancel-in-progress: false");
    const validation = step("Validate and select the approved main snapshot");
    expect(validation).toContain('"$DEPLOY_SHA" =~ ^[0-9a-f]{40}$');
    expect(validation).toContain('git merge-base --is-ancestor "$DEPLOY_SHA" "$TRUSTED_SHA"');
    expect(validation).toContain('git checkout --detach "$DEPLOY_SHA"');
    expect(validation).toContain(
      'git show "$TRUSTED_SHA:scripts/check-workflow-hardening.ts" > scripts/check-workflow-hardening.ts',
    );
    expect(validateWorkflowSource(workflow)).toEqual([]);
  });

  it("never interpolates Actions expressions into any run block", () => {
    const runs = workflow
      .split("      - name: ")
      .slice(1)
      .flatMap((source) => source.split(/^ {8}run: /m).slice(1));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run).not.toContain(`\${{`);
  });

  it("uses the complete existing disabled Router deploy command and only Router configurations", () => {
    const command = (source: string) =>
      source.match(
        /npx wrangler deploy --env="" --config forecast-interactions\/wrangler.toml \\\n(?:.*\n)*? {12}--message "Forecast interaction Router production disabled \$DEPLOY_SHA"/,
      )?.[0];
    expect(command(workflow)).toBeDefined();
    expect(command(workflow)).toBe(command(promotion));
    expect(workflow.match(/npx wrangler deploy /g)).toHaveLength(1);
    const configs = [...workflow.matchAll(/--config (\S+)/g)].map((match) => match[1]);
    expect(new Set(configs)).toEqual(new Set(["forecast-interactions/wrangler.toml"]));
    expect(workflow).toContain("--var PRODUCTION_MUTATIONS_ENABLED:false");
    expect(workflow).toContain('--tag "$DEPLOY_SHA-production-disabled"');
    expect(workflow).not.toMatch(
      /wrangler d1|apply-forecast.*migrations|COLLECT_ENABLED|DISPATCH_ENABLED|admin\/refresh|smoke:|discord\.com|DISCORD.*BOT_TOKEN/,
    );
  });

  it("captures a disabled or legacy restorepoint before deployment and rejects enabled production", () => {
    const deploy = step("Capture restorepoint and deploy disabled Router");
    expect(deploy).toContain("--router-bootstrap-prior");
    expect(deploy).toContain('git merge-base --is-ancestor "$prior_sha" "$DEPLOY_SHA"');
    expect(deploy.indexOf("--router-bootstrap-prior")).toBeLessThan(
      deploy.indexOf("attempted=true"),
    );
    expect(deploy.indexOf("previous_version=$previous")).toBeLessThan(
      deploy.indexOf("attempted=true"),
    );
    expect(deploy.indexOf("attempted=true")).toBeLessThan(deploy.indexOf("npx wrangler deploy "));
    expect(deploy).toContain("Router restorepoint:");
    expect(deploy).toContain("version=\\(.versionId), tag=\\(.tag)");
  });

  it("checks exact active version, disabled identity and matching read-only health", () => {
    const verify = step("Verify disabled Router identity and health");
    expect(verify).toContain('test "$version" = "$EXPECTED_VERSION"');
    expect(verify).toContain('.deploymentSha == $sha and .tag == ($sha + "-production-disabled")');
    expect(verify).toContain('.vars.PRODUCTION_MUTATIONS_ENABLED == "false"');
    expect(verify).toContain(
      '.status == "ok" and .deploymentSha == $sha and .productionMutationsEnabled == false',
    );
    expect(verify).toContain(
      '.productionMutationsEnabled == ($identity[0].vars.PRODUCTION_MUTATIONS_ENABLED == "true")',
    );
    expect(verify).toContain('"$FORECAST_INTERACTIONS_URL/health"');
    expect(workflow).not.toMatch(/curl .*?(?:-X|--request)|\/admin\//);
  });

  it.each([
    ["true", "failure", true, false, true],
    ["true", "skipped", true, false, true],
    ["true", "cancelled", false, true, true],
    ["", "skipped", true, false, false],
    ["true", "success", true, false, false],
    ["true", "success", false, false, false],
  ])("restores attempted=%s verified=%s failure=%s cancelled=%s", (...values) => {
    const [attempted, outcome, failed, cancelled, expected] = values;
    const restore = step("Restore captured Router after failure");
    const condition = restore.match(/^ {8}if: (.+)$/m)?.[1];
    expect(condition).toBeDefined();
    expect(
      runInNewContext(condition ?? "", {
        always: () => true,
        failure: () => failed,
        cancelled: () => cancelled,
        steps: { deploy: { outputs: { attempted } }, verify: { outcome } },
      }),
    ).toBe(expected);
    expect(restore).toContain('wrangler versions deploy "$PREVIOUS_VERSION@100%" --yes --env=""');
    expect(restore).toContain("'. == $prior[0]'");
    expect(restore).not.toContain("--tag");
    expect(step("Fail after attempted restoration")).toContain("exit 1");
  });

  it("exposes the Cloudflare token only during deployment, verification and restoration", () => {
    const credentialSteps = workflow
      .split("      - name: ")
      .filter((source) => source.includes(`\${{ secrets.CLOUDFLARE_API_TOKEN }}`))
      .map((source) => source.split("\n")[0]);
    expect(credentialSteps).toEqual([
      "Capture restorepoint and deploy disabled Router",
      "Verify disabled Router identity and health",
      "Restore captured Router after failure",
    ]);
    expect(step("Install dependencies without deployment credentials")).not.toContain("secrets.");
    expect(workflow).toContain("persist-credentials: false");
  });
});
