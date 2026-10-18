import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const proposal = readFileSync(".github/workflows/forecast-proposal.yml", "utf8");
const xProbe = readFileSync(".github/workflows/forecast-x-probe.yml", "utf8");
const stagingDeploy = readFileSync(".github/workflows/forecast-collector-deploy.yml", "utf8");
const productionPromote = readFileSync(".github/workflows/forecast-collector-promote.yml", "utf8");
const d1BudgetWatch = readFileSync(".github/workflows/forecast-d1-budget-watch.yml", "utf8");
const d1IndexRemediation = readFileSync(
  ".github/workflows/forecast-d1-index-remediation.yml",
  "utf8",
);
const dispatcherConfig = readFileSync("forecast-dispatcher/wrangler.toml", "utf8");
const interactionConfig = readFileSync("forecast-interactions/wrangler.toml", "utf8");
const manualReview = readFileSync(".github/workflows/resolve-forecast-manual-review.yml", "utf8");
const stagingAdoption = readFileSync(
  ".github/workflows/process-staging-forecast-adoption.yml",
  "utf8",
);
const pages = readFileSync(".github/workflows/pages.yml", "utf8");
const githubApp = readFileSync("forecast-dispatcher/src/github-app.ts", "utf8");
const naverAction = readFileSync("scripts/forecast-naver-action.ts", "utf8");
const ROUTER_DEPLOY_PATTERN =
  /wrangler deploy (?:--env="" )?--config forecast-interactions\/wrangler.toml(?!.*--dry-run)/;

function workflowStep(source: string, name: string) {
  const step = source.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0];
  if (!step) throw new Error(`missing_workflow_step:${name}`);
  return step;
}

function recoveryDecision(step: string, verified: string, attempted: string, cancelled = false) {
  const condition = step.match(/^ {8}if: (.+)$/m)?.[1];
  if (!condition) throw new Error("missing_recovery_condition");
  const attempt = { outputs: { attempted } };
  return runInNewContext(condition, {
    always: () => true,
    failure: () => !cancelled,
    cancelled: () => cancelled,
    steps: {
      operational_verification: { outputs: { verified } },
      router_deploy: attempt,
      collector_deploy: attempt,
      dispatcher_deploy: attempt,
      collector_activation: attempt,
      dispatcher_activation: attempt,
      router_restore: { outcome: "failure" },
    },
  }) as boolean;
}

function artifactPaths(source: string) {
  return [...source.matchAll(/^ {10}path: (?:\|\n((?: {12}.+\n)+)|(.+)\n)/gm)].flatMap((match) =>
    (match[1] ?? match[2] ?? "")
      .trim()
      .split("\n")
      .map((path) => path.trim()),
  );
}

describe("Paid X token isolation from advisory producer subprocesses", () => {
  it("does not expose the bearer token through proposal or probe step, job or workflow wiring", () => {
    for (const [source, name, command] of [
      [proposal, "Fetch, verify, and apply one candidate", "npm run propose:supply-forecast"],
      [xProbe, "Probe exact X status URLs", "node scripts/probe-forecast-x-sources.ts"],
    ] as const) {
      const step = workflowStep(source, name);
      expect(step).toContain(command);
      expect(step).not.toContain("X_API_BEARER_TOKEN");
      expect(source).not.toContain("X_API_BEARER_TOKEN");
    }
  });
});

describe("Staging boundary recovery workflow contract", () => {
  it("makes proven-boundary recovery a validated staging dispatch opt-in before smoke", () => {
    const inputs = stagingDeploy.slice(
      stagingDeploy.indexOf("      recovery_source:"),
      stagingDeploy.indexOf("\npermissions:"),
    );
    expect(inputs).toContain("default: none");
    expect(inputs).toContain('          - "48"');
    expect(inputs).toContain('          - "56"');
    expect(inputs).toContain("expected_committed_item_id:");
    const validation = stagingDeploy.indexOf(
      "- name: Validate boundary recovery inputs before mutations",
    );
    expect(validation).toBeGreaterThan(stagingDeploy.indexOf("- name: Setup Node"));
    expect(validation).toBeLessThan(
      stagingDeploy.indexOf("- name: Apply staging Forecast D1 migrations"),
    );
    const recovery = stagingDeploy.indexOf("- name: Recover explicitly selected staging boundary");
    expect(recovery).toBeGreaterThan(stagingDeploy.indexOf("- name: Deploy staging collector"));
    expect(recovery).toBeLessThan(
      stagingDeploy.indexOf("- name: Live staging queue round-trip smoke"),
    );
    const step = stagingDeploy.slice(
      recovery,
      stagingDeploy.indexOf("- name: Live staging queue round-trip smoke"),
    );
    expect(step).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.recovery_source != 'none' && inputs.recovery_source != ''",
    );
    expect(step).toContain(
      `FORECAST_COLLECTOR_STAGING_URL: \${{ vars.FORECAST_COLLECTOR_STAGING_URL }}`,
    );
    expect(step).toContain(
      `FORECAST_COLLECTOR_ADMIN_TOKEN: \${{ secrets.FORECAST_COLLECTOR_ADMIN_TOKEN }}`,
    );
    expect(step).toContain("run: node scripts/recover-forecast-boundary.ts --apply");
    expect(step).not.toMatch(/run:.*(?:\$\{\{|TOKEN)/);
    expect(productionPromote).not.toContain("recover-forecast-boundary");
  });
});

describe("Forecast dispatcher workflow contract", () => {
  it("keeps the proposal schedule as a thirty-minute watchdog", () => {
    expect(proposal).toContain('cron: "17,47 * * * *"');
    expect(proposal).not.toContain('cron: "*/5 * * * *"');
    expect(proposal).toContain("dispatch_id:");
    expect(proposal).toContain("dispatch_mode:");
    expect(proposal).toContain("/admin/workflow-dispatches/$FORECAST_DISPATCH_ID/status");
    expect(proposal).toContain("/admin/ops-alerts/watchdog-fallback");
    expect(proposal).toContain("/admin/ops-alerts/watchdog-notification-failed");
    expect(proposal).toContain("/admin/ops-alerts/source-processor-internal");
    expect(proposal).toContain("enforce_nonce:true");
    expect(proposal).toContain("vars.DISCORD_FORECAST_ALERT_CHANNEL_ID");
    expect(proposal).toContain(
      'const tracked=dispatcher !== undefined && dispatcher.status !== "missing";',
    );
    expect(proposal).toContain('stale && unsentCritical ? "both"');
    expect(proposal).toContain('reason === "dispatcher_stale"');
    expect(proposal).not.toContain(
      "const stale=!Number.isFinite(observed) || Date.now()-observed>10*60*1000;",
    );
    expect(proposal).toContain(
      '"$FORECAST_DISPATCH_MODE" == "smoke" && -z "$FORECAST_DISPATCH_ID"',
    );
  });

  it("dispatches full verification for GitHub-token-authored pull requests", () => {
    for (const workflow of [proposal, stagingAdoption]) {
      expect(workflow).toContain("actions: write");
      expect(workflow).toContain("npm run dispatch:pages-verification");
    }
    expect(pages).toContain("workflow_dispatch:");
    expect(pages).toContain("deploy:\n    if: github.event_name == 'push'");
    expect(pages).toContain("Upload Pages artifact\n        if: github.event_name == 'push'");
  });

  it("uses an offset private Worker Cron and a two-phase deployment", () => {
    expect(dispatcherConfig).toContain('crons = ["1-59/3 * * * *"]');
    expect(dispatcherConfig).toContain("workers_dev = false");
    expect(dispatcherConfig).not.toContain("GITHUB_APP_PRIVATE_KEY =");
    for (const workflow of [stagingDeploy, productionPromote]) {
      expect(workflow).toContain("--var DISPATCH_ENABLED:false");
      expect(workflow).toContain("--var DISPATCH_ENABLED:true");
      expect(workflow).toContain(
        "--var DISCORD_ACTIVITY_CHANNEL_ID:$DISCORD_FORECAST_ACTIVITY_CHANNEL_ID",
      );
      expect(workflow).toContain(
        "--var DISCORD_ALERT_CHANNEL_ID:$DISCORD_FORECAST_ALERT_CHANNEL_ID",
      );
      expect(workflow).toContain(
        "--var DISCORD_FALLBACK_CHANNEL_ID:$DISCORD_FORECAST_FALLBACK_CHANNEL_ID",
      );
      expect(workflow).toContain("node scripts/apply-forecast-d1-migrations.ts --env");
      expect(workflow).toContain("forecast-interactions/wrangler.toml");
    }
    expect(interactionConfig).not.toContain("[triggers]");
    expect(stagingDeploy).toContain("router_endpoint_ready:");
    expect(stagingDeploy).toContain("Start fixed eight-hour Paid canary v10");
    expect(productionPromote).toContain("Read authenticated Paid canary v10 certificate");
    expect(productionPromote).toContain("environment: cloudflare-production");
    expect(productionPromote).toContain("Determine coupled production rollout");
    expect(stagingDeploy).toContain("Probe GitHub App installation and fixed workflow");
    expect(stagingDeploy).toContain("Fail-closed rollback when staging validation fails");
    expect(stagingDeploy).toContain("Verify live Workers Observability contract before burn-in");
    expect(stagingDeploy).toContain("FORECAST_COLLECTOR_SCRIPT_VERSION_ID");
    expect(stagingDeploy).toContain("FORECAST_DISPATCHER_SCRIPT_VERSION_ID");
    expect(stagingDeploy).toContain("Observe 30-minute account-wide D1 burn-in");
    expect(stagingDeploy).toContain("npm run check:d1-budget -- preflight");
    expect(stagingDeploy.indexOf("Apply staging Forecast D1 migrations")).toBeGreaterThan(-1);
    expect(stagingDeploy.indexOf("Apply staging Forecast D1 migrations")).toBeLessThan(
      stagingDeploy.indexOf("npm run check:d1-budget -- preflight"),
    );
    expect(stagingDeploy).toContain("Verify production and staging Forecast covering indexes");
    expect(stagingDeploy).toContain("--var COLLECT_ENABLED:false");
    expect(stagingDeploy).toContain("--var COLLECT_ENABLED:true");
    expect(stagingDeploy).toContain("Record dispatcher smoke inside the canary window");
    expect(stagingDeploy).toContain("npm run check:d1-budget -- evaluate");
    const alignment = stagingDeploy.indexOf("Align canary start after a completed Cron pair");
    const canaryStart = stagingDeploy.indexOf("Start fixed eight-hour Paid canary v10");
    expect(alignment).toBeGreaterThan(-1);
    expect(canaryStart).toBeGreaterThan(alignment);
    expect(stagingDeploy).toContain("10#$minute % 3 == 2");
    expect(stagingDeploy).toContain("(.collector.deploymentSha == $sha)");
    expect(stagingDeploy).toContain("now - collector_epoch < 180");
    expect(stagingDeploy).toContain("now - dispatcher_epoch < 180");
    expect(productionPromote).toContain("npm run check:d1-budget -- preflight");
    expect(productionPromote).toContain("/admin/canary-window");
    expect(productionPromote).toContain(
      `--runtime-start "\${{ steps.window.outputs.started_at }}"`,
    );
    expect(productionPromote).toContain(`--runtime-end "\${{ steps.window.outputs.ends_at }}"`);
    expect(productionPromote).toContain("Reject only a proven failed or malformed canary");
    const observability = productionPromote.indexOf(
      "Collect exact scheduled-only Workers Observability evidence",
    );
    const freshQuota = productionPromote.indexOf(
      "Measure fresh account quota evidence for the exact canary window",
    );
    const certificate = productionPromote.indexOf("Read authenticated Paid canary v10 certificate");
    expect(observability).toBeGreaterThan(-1);
    expect(freshQuota).toBeGreaterThan(observability);
    expect(certificate).toBeGreaterThan(freshQuota);
    expect(d1BudgetWatch).toContain('cron: "7,37 * * * *"');
    expect(d1BudgetWatch).toContain("/admin/canary-window");
    expect(d1BudgetWatch).toContain("early_check_due");
    expect(d1BudgetWatch).toContain("[2, 4, 6].some");
    expect(d1BudgetWatch).toContain("Disable staging Collector and Dispatcher on budget pressure");
    expect(d1BudgetWatch).toContain("--var COLLECT_ENABLED:false");
    expect(d1IndexRemediation).toContain("environment: cloudflare-production");
    expect(d1IndexRemediation).toContain("Verify statistics production D1 remains readable");
    expect(d1IndexRemediation).toContain('run_sql "Collector covering index"');
    expect(d1IndexRemediation).toContain('run_sql "Dispatcher covering index"');
    expect(d1IndexRemediation).toContain('run_sql "migration ledger"');
    expect(d1IndexRemediation).toContain("EXPLAIN QUERY PLAN");
    expect(d1IndexRemediation).not.toContain("wrangler deploy");
    for (const workflow of [stagingDeploy, productionPromote]) {
      expect(workflow).toContain("DISCORD_FORECAST_APPLICATION_ID");
      expect(workflow).toContain("DISCORD_FORECAST_PUBLIC_KEY");
      expect(workflow).toContain("does not match the repository variable");
    }
  });
});

describe("Forecast production review and migration workflow contract", () => {
  it("keeps manual review resolution read-only and approval-gated in production", () => {
    expect(manualReview).toContain("permissions:\n  contents: read");
    expect(manualReview).toContain("environment: cloudflare-production");
    expect(manualReview).toContain("npm run resolve:forecast-manual-review");
    expect(manualReview).not.toContain("pull-requests: write");
    expect(manualReview).not.toContain("contents: write");
  });

  it("centralizes migrations without moving production writes outside its approval job", () => {
    const promoteJob = productionPromote.slice(productionPromote.indexOf("\n  promote:\n"));
    const canaryJob = productionPromote.slice(0, productionPromote.indexOf("\n  promote:\n"));
    expect(promoteJob).toContain("needs: canary");
    expect(promoteJob).toContain(
      "if: github.ref == 'refs/heads/main' && needs.canary.outputs.canary_promotable == 'true' && !inputs.canary_only",
    );
    expect(promoteJob).toContain("environment: cloudflare-production");
    expect(canaryJob).not.toContain("apply-forecast-d1-migrations.ts");
    for (const [environment, workflow] of [
      ["staging", stagingDeploy],
      ["production", promoteJob],
    ] as const) {
      const command = `run: node scripts/apply-forecast-d1-migrations.ts --env ${environment} --remote${environment === "staging" ? " --allow-forecast-v2" : ""}\n`;
      expect(workflow).toContain(command);
      expect(workflow.split(command)).toHaveLength(2);
      const verification = workflowStep(workflow, "Verify Forecast migration runner");
      for (const spec of [
        "apply-forecast-d1-migrations.spec.ts",
        "apply-forecast-d1-migrations-json.spec.ts",
        "forecast-dispatcher-workflow.spec.ts",
      ]) {
        expect(verification).toContain(`scripts/${spec}`);
      }
      expect(workflow).not.toMatch(/--file forecast-collector\/migrations\//);
      expect(workflow).not.toContain(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version =",
      );
    }
    expect(promoteJob.indexOf("Apply production Forecast D1 migrations")).toBeGreaterThan(
      promoteJob.indexOf("Recheck D1 budget before production migrations"),
    );
    expect(promoteJob.indexOf("Apply production Forecast D1 migrations")).toBeLessThan(
      promoteJob.indexOf("Verify production Cron trigger capacity"),
    );
    expect(stagingDeploy).toContain('"scripts/apply-forecast-d1-migrations.ts"');
    expect(stagingDeploy).toContain('"scripts/apply-forecast-d1-migrations.spec.ts"');
    expect(stagingDeploy).toContain('"scripts/apply-forecast-d1-migrations-json.spec.ts"');
    expect(promoteJob).not.toContain("--allow-forecast-v2");
    for (const spec of [
      "apply-forecast-d1-migrations.v2-gate.spec.ts",
      "apply-forecast-d1-migrations.fail-closed.spec.ts",
      "forecast-migration-0030.spec.ts",
    ]) {
      expect(stagingDeploy).toContain(`"scripts/${spec}"`);
      expect(workflowStep(stagingDeploy, "Verify Forecast migration runner")).toContain(
        `scripts/${spec}`,
      );
    }
  });

  it("keeps directly executed Node imports resolvable on Linux", () => {
    expect(githubApp).toContain('from "../../shared/boundedHttp.ts"');
    expect(naverAction).toContain('from "../shared/boundedHttp.ts"');
    expect(readFileSync("scripts/cloudflare-d1-budget.ts", "utf8")).toContain(
      'from "../shared/cloudflarePaidUsage.ts"',
    );
    expect(readFileSync("scripts/check-forecast-canary.ts", "utf8")).toContain(
      'from "../shared/d1QuotaEvidence.ts"',
    );
  });
});

describe("Forecast deployment identity and restore workflow contract", () => {
  it("isolates staging Discord deployments and keeps automatic rollout disabled", () => {
    const job = stagingDeploy.split("\n  deploy-staging:")[1]?.split("\n  deploy-usage-guard:")[0];
    expect(job).toBeDefined();
    expect(job).not.toMatch(/\$\{\{ (?:vars|secrets)\.DISCORD_FORECAST_(?!STAGING_)/);
    const validation = workflowStep(stagingDeploy, "Validate configuration");
    for (const suffix of [
      "BOT_TOKEN",
      "APPLICATION_ID",
      "PUBLIC_KEY",
      "GUILD_ID",
      "APPROVER_USER_ID",
      "APPROVAL_CHANNEL_ID",
      "ACTIVITY_CHANNEL_ID",
      "ALERT_CHANNEL_ID",
    ]) {
      expect(validation).toContain(`DISCORD_FORECAST_STAGING_${suffix}`);
    }
    expect(validation).toContain("Missing or invalid FORECAST_INTERACTIONS_STAGING_URL");
    const dispatcher = workflowStep(stagingDeploy, "Deploy staging dispatcher");
    expect(dispatcher).toContain("--var DISPATCH_ENABLED:false");
    expect(dispatcher).toContain("--var FORECAST_V2_NOTIFICATIONS_ENABLED:false");
    const collector = workflowStep(stagingDeploy, "Deploy staging collector");
    expect(collector).toContain("--var COLLECT_ENABLED:false");
    expect(collector).toContain("--var FORECAST_V2_MODE:off");
    const interactions = workflowStep(stagingDeploy, "Deploy staging interactions");
    expect(interactions).toContain(
      "wrangler deploy --env staging --config forecast-interactions/wrangler.toml",
    );
    // Staging publication stays enabled with the operator-managed signing key
    // (secret preserved across deploys); production publication stays off.
    expect(interactions).toContain("--var STAGING_PUBLICATION_MODE:enabled");
    expect(interactions).toContain("--var FORECAST_PUBLICATION_KEY_ID:staging-v1");
    expect(interactions).toContain("--var PRODUCTION_PUBLICATION_MODE:off");
    expect(interactions).toContain("--var PRODUCTION_MUTATIONS_ENABLED:false");
    expect(workflowStep(stagingDeploy, "Verify staging interactions readiness")).toContain(
      'npm run smoke:forecast-interactions -- "$FORECAST_INTERACTIONS_STAGING_URL"',
    );
  });

  it("rejects privileged manual refs and deploys the exact certified snapshot", () => {
    for (const workflow of [stagingDeploy, proposal, productionPromote]) {
      expect(workflow).toContain("github.ref == 'refs/heads/main'");
      expect(workflow).not.toContain("ref: refs/heads/main");
    }
    expect(stagingDeploy).toContain(`ref: \${{ github.sha }}`);
    expect(proposal).toContain(`ref: \${{ github.sha }}`);
    expect(productionPromote).toContain(`ref: \${{ needs.canary.outputs.deployment_sha }}`);
    expect(productionPromote).toContain(
      'git merge-base --is-ancestor "$CANARY_SHA" "$TRUSTED_SHA"',
    );
    expect(productionPromote.indexOf("Select the exact trusted canary snapshot")).toBeLessThan(
      productionPromote.indexOf("Install exact canary dependencies"),
    );
    expect(productionPromote).not.toContain("git diff --quiet");
    expect(productionPromote).not.toContain(":(exclude)forecast-collector/src/candidate");
    expect(productionPromote).toContain("Bind the certificate to the selected snapshot and window");
  });

  it("keeps shared Router writes production-owned and rejects missing Router staging setup", () => {
    const routerGuard = stagingDeploy.indexOf(
      "Require the production-owned Router before staging mutations",
    );
    expect(routerGuard).toBeGreaterThan(stagingDeploy.indexOf("Install dependencies"));
    expect(routerGuard).toBeLessThan(stagingDeploy.indexOf("Apply staging Forecast D1 migrations"));
    expect(stagingDeploy).not.toMatch(ROUTER_DEPLOY_PATTERN);
    expect(workflowStep(stagingDeploy, "Deploy staging interactions")).toContain(
      "--var PRODUCTION_MUTATIONS_ENABLED:false",
    );
    expect(stagingDeploy).not.toContain("--var PRODUCTION_MUTATIONS_ENABLED:true");
    expect(stagingDeploy).toContain(
      `FORECAST_EXPECTED_DEPLOY_SHA: \${{ steps.router.outputs.deployment_sha }}`,
    );
    const protectedJob = productionPromote.slice(productionPromote.indexOf("\n  promote:\n"));
    expect(protectedJob).toContain("environment: cloudflare-production");
    expect(protectedJob).toContain("--var PRODUCTION_MUTATIONS_ENABLED:false");
    expect(protectedJob).toContain("--var PRODUCTION_MUTATIONS_ENABLED:true");
  });

  it("captures all restorepoints before production mutation and restores each attempted Worker independently", () => {
    const protectedJob = productionPromote.slice(productionPromote.indexOf("\n  promote:\n"));
    expect(protectedJob.indexOf("Capture validated production restorepoints")).toBeLessThan(
      protectedJob.indexOf("Refresh Paid usage guard before production changes"),
    );
    expect(protectedJob.indexOf("Capture validated production restorepoints")).toBeLessThan(
      protectedJob.indexOf("Apply production Forecast D1 migrations"),
    );
    expect(protectedJob).toContain("for component in collector dispatcher router;");
    expect(protectedJob).not.toContain("wrangler versions list");
    expect(protectedJob).not.toContain("worker_exists");
    for (const component of ["collector", "dispatcher", "router"]) {
      const step = protectedJob.match(
        new RegExp(
          `      - name: Restore production ${component[0]?.toUpperCase()}${component.slice(1)} after any rollout failure[\\s\\S]*?(?=\\n      - name:)`,
        ),
      )?.[0];
      expect(step).toBeDefined();
      expect(step).toContain("if: always() && (failure() || cancelled())");
      expect(step).toContain(`steps.${component}_deploy.outputs.attempted == 'true'`);
      expect(step).toContain(`steps.prior.outputs.${component}_version`);
      expect(step).toContain('versions deploy "$PREVIOUS_VERSION@100%"');
      expect(step).toContain("--active-version");
      expect(step).not.toContain("continue-on-error");
    }
    expect(protectedJob).toContain("Retain production rollout and independent restore evidence");
    expect(protectedJob).toContain("Verify final production deployment identities");
    const artifact = protectedJob.slice(
      protectedJob.indexOf(
        "      - name: Retain production rollout and independent restore evidence",
      ),
    );
    expect(artifact).toContain("production-rollout-dispositions.json");
    expect(artifact).not.toContain("/production-*-before.json");
    expect(artifact).not.toContain("/production-*-after.json");
    expect(artifact).not.toContain("-version-before.json");
    expect(artifact).not.toContain("-version-after.json");
    expect(protectedJob).not.toContain("continue-on-error");
    expect(
      protectedJob.indexOf("Verify proposal workflow targets production collector"),
    ).toBeLessThan(protectedJob.indexOf("Restore production Dispatcher"));
    expect(protectedJob.indexOf("Retain successful rollout evidence")).toBeLessThan(
      protectedJob.indexOf("Restore production Dispatcher"),
    );
    expect(stagingDeploy.indexOf("Retain successful staging identity")).toBeLessThan(
      stagingDeploy.indexOf("Fail-closed rollback when staging validation fails - Dispatcher"),
    );
  });

  it("uses structured staging versions and includes every known shared runtime input", () => {
    expect(stagingDeploy).not.toContain("version_id=$(grep");
    expect(stagingDeploy).toContain("WRANGLER_OUTPUT_FILE_PATH:");
    expect(stagingDeploy).toContain("--deployment-version");
    for (const path of [
      "shared/soloRaidCadence.ts",
      "shared/discordInteraction.ts",
      "shared/runtimeEnvironment.ts",
      "shared/cloudflareWorkerRuntimeWindow.ts",
      "shared/certifiedRational.ts",
      "shared/certifiedDispatchExpectations.ts",
      "shared/certifiedSupply.ts",
      "shared/certifiedSupplyBuild.ts",
      "shared/certifiedSupplyLaws.ts",
      "shared/certifiedSupplyModel.ts",
      "shared/certifiedSupplyValidation.ts",
      "scripts/check-workflow-hardening.ts",
      "scripts/lib/cloudflare-workers-observability.ts",
      ".github/workflows/forecast-collector-promote.yml",
    ])
      expect(stagingDeploy).toContain(`- "${path}"`);
  });

  it("generates, checks and commits the complete certified registry identity", () => {
    const generate = proposal.indexOf("npm run generate:certified-engine-build");
    expect(generate).toBeGreaterThan(proposal.indexOf("npm run generate:supply-forecast"));
    expect(proposal.indexOf("npm run check:certified-engine-build")).toBeGreaterThan(generate);
    const add = proposal.match(/^\s*git add .+$/m)?.[0];
    for (const path of [
      "shared/supplyForecasts.json",
      "shared/generated/supplyForecast.ts",
      "shared/generated/supplyForecastRuntime.ts",
      "shared/generated/certifiedForecastAuthority.ts",
      "shared/generated/certifiedEngineBuild.ts",
    ])
      expect(add).toContain(path);
  });
});

describe("Verified rollout recovery and artifact boundaries", () => {
  it("does not roll back verified Workers on upload-only failure, but still recovers failed or cancelled operations", () => {
    const steps = [
      ...["Router", "Collector", "Dispatcher"].map((component) =>
        workflowStep(
          productionPromote,
          `Restore production ${component} after any rollout failure`,
        ),
      ),
      ...["Collector", "Dispatcher"].map((component) =>
        workflowStep(
          stagingDeploy,
          `Fail-closed rollback when staging validation fails - ${component}`,
        ),
      ),
    ];
    for (const step of steps) {
      expect(recoveryDecision(step, "true", "true")).toBe(false);
      expect(recoveryDecision(step, "", "true")).toBe(true);
      expect(recoveryDecision(step, "", "true", true)).toBe(true);
      expect(recoveryDecision(step, "", "")).toBe(false);
    }
    expect(workflowStep(productionPromote, "Fail after independent restore attempts")).toContain(
      "if: always() && (failure() || cancelled())",
    );
    for (const source of [stagingDeploy, productionPromote]) {
      expect(source.indexOf("id: operational_verification")).toBeLessThan(
        source.indexOf(
          source === stagingDeploy
            ? "      - name: Retain successful staging identity"
            : "      - name: Retain successful rollout evidence",
        ),
      );
    }
  });
  it("restores Router first and keeps Collector and Dispatcher independent of Router recovery success", () => {
    const router = productionPromote.indexOf("      - name: Restore production Router");
    const collector = productionPromote.indexOf("      - name: Restore production Collector");
    const dispatcher = productionPromote.indexOf("      - name: Restore production Dispatcher");
    expect(router).toBeLessThan(collector);
    expect(collector).toBeLessThan(dispatcher);
    for (const component of ["Collector", "Dispatcher"]) {
      const step = workflowStep(
        productionPromote,
        `Restore production ${component} after any rollout failure`,
      );
      expect(recoveryDecision(step, "", "true")).toBe(true);
      expect(step).not.toContain("steps.router_restore");
    }
  });
  it("uploads only the explicit sanitized identity, certification, CPU and quota allowlist", () => {
    const allowlist = new Set([
      "router-identity-before-staging.evidence.json",
      "router-health-before-staging.evidence.json",
      "*-active-identity.evidence.json",
      "*-validation-stop-identity.evidence.json",
      "canary-start-identity.evidence.json",
      "forecast-canary-identity.evidence.json",
      "forecast-canary-summary.ko.md",
      "forecast-canary-report.evidence.json",
      "forecast-canary-runtime.evidence.json",
      "canary-final-quota.evidence.json",
      "forecast-canary-baseline-bootstrap.evidence.json",
      "forecast-observability-live-probe.evidence.json",
      "forecast-observability-preflight.evidence.json",
      "d1-budget-preflight.evidence.json",
      "d1-budget-baseline.evidence.json",
      "d1-budget-evaluation.evidence.json",
      "d1-budget-production-preflight.evidence.json",
      "collector-active-identity.evidence.json",
      "dispatcher-active-identity.evidence.json",
      "production-*-identity-before.evidence.json",
      "production-*-identity-after.evidence.json",
      "production-dispatcher-disabled-identity.evidence.json",
      "production-*-restored.evidence.json",
      "production-*-readiness.evidence.json",
      "production-router-restored-health.evidence.json",
      "production-certified-canary-identity.evidence.json",
      "production-rollout-dispositions.json",
    ]);
    const paths = artifactPaths(stagingDeploy + "\n" + productionPromote);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths)
      expect(allowlist.has(path.replace(/\$\{\{ runner\.temp \}\}\//, "")), path).toBe(true);
    const projections = workflowStep(
      productionPromote,
      "Project privacy-safe certification CPU and quota evidence",
    );
    expect(projections).toContain('peer=("$RUNNER_TEMP/forecast-canary-report.json")');
    expect(projections).toContain(`--retain-evidence "$source" "$kind" "\${peer[@]}"`);
    expect(projections).toContain("candidate forecast-canary-baseline-bootstrap");
    const staging = workflowStep(
      stagingDeploy,
      "Project privacy-safe staging burn-in and quota evidence",
    );
    expect(staging).toContain("baseline d1-budget-baseline");
    expect(staging).toContain("runtime forecast-observability-preflight");
  });
});

describe("Router configuration and identity summaries", () => {
  it("validates the required Router URL unconditionally before mutations in both workflows", () => {
    for (const [source, name] of [
      [stagingDeploy, "Validate required Router origin after dependency installation"],
      [productionPromote, "Validate production configuration"],
    ]) {
      const step = workflowStep(source ?? "", name ?? "");
      expect(step).toContain('--router-origin "$FORECAST_INTERACTIONS_URL"');
      expect(step).not.toContain("inputs.router_endpoint_ready");
    }
  });
  it("publishes certified rather than triggering-main identities through the tested summary renderer", () => {
    const step = workflowStep(
      productionPromote,
      "Write exact certified promotion identities to step summary",
    );
    expect(step).toContain(`CERTIFIED_SHA: \${{ needs.canary.outputs.deployment_sha }}`);
    expect(step).not.toContain("github.sha");
    expect(step).toContain("--identity-summary");
    expect(step).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(workflowStep(stagingDeploy, "Record shadow start")).toContain("--identity-summary");
    expect(workflowStep(productionPromote, "Write Korean v10 certification summary")).toContain(
      '>> "$GITHUB_STEP_SUMMARY"',
    );
  });
  it("recognizes shared Router writes with either absent or explicit empty production environment", () => {
    for (const command of [
      "npx wrangler deploy --config forecast-interactions/wrangler.toml",
      'npx wrangler deploy --env="" --config forecast-interactions/wrangler.toml',
    ])
      expect(command).toMatch(ROUTER_DEPLOY_PATTERN);
    expect(
      "npx wrangler deploy --dry-run --config forecast-interactions/wrangler.toml",
    ).not.toMatch(ROUTER_DEPLOY_PATTERN);
  });
});

describe("Clean-checkout staging validation ordering", () => {
  it("keeps dependency-bearing Router validation after npm ci and before Router reads or mutations", () => {
    const install = stagingDeploy.indexOf("      - name: Install dependencies");
    const validate = stagingDeploy.indexOf(
      "      - name: Validate required Router origin after dependency installation",
    );
    const early = workflowStep(stagingDeploy, "Validate configuration");
    expect(early).not.toContain("node scripts/check-workflow-hardening.ts");
    expect(early).toContain("Missing CLOUDFLARE_API_TOKEN secret.");
    expect(early).toContain("Missing or invalid FORECAST_GITHUB_APP_INSTALLATION_ID variable.");
    expect(stagingDeploy.indexOf("      - name: Verify trusted checkout identity")).toBeLessThan(
      install,
    );
    expect(stagingDeploy).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflowStep(stagingDeploy, "Install dependencies").trim()).toBe("run: npm ci");
    expect(validate).toBeGreaterThan(install);
    expect(validate).toBeLessThan(
      stagingDeploy.indexOf(
        "      - name: Require the production-owned Router before staging mutations",
      ),
    );
    expect(validate).toBeLessThan(
      stagingDeploy.indexOf("      - name: Apply staging Forecast D1 migrations"),
    );
    const production = productionPromote.slice(productionPromote.indexOf("\n  promote:"));
    expect(production.indexOf("      - name: Install dependencies")).toBeLessThan(
      production.indexOf("      - name: Validate production configuration"),
    );
  });

  it("executes the complete preinstall project dependency closure in a sparse checkout without node_modules", () => {
    const beforeInstall = stagingDeploy.slice(
      0,
      stagingDeploy.indexOf("      - name: Install dependencies"),
    );
    const commands = [
      ...beforeInstall.matchAll(/^\s*(?:run: )?node (scripts\/\S+\.ts)([^\n]*)$/gm),
    ];
    expect(commands.map((command) => command.slice(1))).toEqual([
      ["scripts/recover-forecast-boundary.ts", " --validate"],
    ]);
    const files = ["scripts/recover-forecast-boundary.ts", "shared/boundedHttp.ts"];
    const closure = new Set(files.map((file) => resolve(file)));
    const root = mkdtempSync(join(tmpdir(), "forecast-preinstall-"));
    try {
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
          const specifier = match[1] ?? "";
          if (!isBuiltin(specifier))
            expect(closure.has(resolve(dirname(file), specifier)), specifier).toBe(true);
        }
        const target = join(root, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(file, target);
      }
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      const output = execFileSync(
        process.execPath,
        ["scripts/recover-forecast-boundary.ts", "--validate"],
        {
          cwd: root,
          timeout: 10_000,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_PATH: "",
            NODE_OPTIONS: "",
            RECOVERY_SOURCE: "none",
            EXPECTED_COMMITTED_ITEM_ID: "",
          },
        },
      );
      expect(output).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
