import { expect, it } from "vitest";
import { workerVersionIdentity } from "./check-workflow-hardening";

const sha = "a".repeat(40);
const version = "12345678-1234-1234-1234-123456789abc";

it("retains the staging Router environment without retaining secret bindings", () => {
  expect(
    workerVersionIdentity(
      {
        id: version,
        annotations: { "workers/tag": `${sha}-staging` },
        resources: {
          bindings: [
            { name: "DEPLOY_SHA", type: "plain_text", text: sha },
            { name: "FORECAST_ENVIRONMENT", type: "plain_text", text: "staging" },
            { name: "PRODUCTION_MUTATIONS_ENABLED", type: "plain_text", text: "false" },
            { name: "DISCORD_BOT_TOKEN", type: "secret_text", text: "never-retain" },
          ],
        },
      },
      version,
    ),
  ).toEqual({
    versionId: version,
    deploymentSha: sha,
    tag: `${sha}-staging`,
    vars: {
      DEPLOY_SHA: sha,
      FORECAST_ENVIRONMENT: "staging",
      PRODUCTION_MUTATIONS_ENABLED: "false",
    },
  });
});
