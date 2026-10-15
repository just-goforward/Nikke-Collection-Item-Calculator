import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pagesPublicationPolicy } from "./site-hosting-policy";

describe("Pages publication policy", () => {
  it.each(["pages", "worker", undefined])(
    "evaluates workflow publication and rollback gates for %s",
    (target) => {
      const policy = pagesPublicationPolicy(target);
      const workflow = readFileSync(".github/workflows/pages.yml", "utf8");
      expect(workflow).toContain(`publish_pages: \${{ steps.hosting.outputs.publish_pages }}`);
      const gates = [
        ["Upload Pages artifact", policy.publishPages],
        ["deploy:", policy.publishPages],
        ["post-deploy-smoke:", policy.smokePages],
        ["Retain SHA-identified Pages hosting rollback artifact", policy.retainRollbackArtifact],
      ] as const;
      for (const event of ["push", "pull_request", "workflow_dispatch"]) {
        const values: Record<string, string> = {
          "github.event_name": event,
          "steps.hosting.outputs.publish_pages": String(policy.publishPages),
          "needs.verify.outputs.publish_pages": String(policy.publishPages),
          "steps.hosting.outputs.retain_rollback_artifact": String(policy.retainRollbackArtifact),
        };
        for (const [anchor, enabled] of gates) {
          const expression = workflow.split(anchor)[1]?.match(/\n\s+if: ([^\n]+)/)?.[1];
          expect(expression).toBeDefined();
          const actual = expression?.split(" && ").every((clause) => {
            const match = clause.match(/^([\w.]+) == '([^']+)'$/);
            if (!match?.[1] || match[2] === undefined || !(match[1] in values)) {
              throw new Error(`Unsupported workflow gate ${clause}`);
            }
            return values[match[1]] === match[2];
          });
          expect(actual).toBe(event === "push" && enabled);
        }
      }
    },
  );
  it.each([undefined, "", "pages"])("preserves legacy publication for %s", (target) => {
    expect(pagesPublicationPolicy(target)).toEqual({
      publishPages: true,
      smokePages: true,
      retainRollbackArtifact: true,
    });
  });

  it("retains verification artifacts but never publishes or smokes Pages in Worker mode", () => {
    expect(pagesPublicationPolicy("worker")).toEqual({
      publishPages: false,
      smokePages: false,
      retainRollbackArtifact: true,
    });
  });

  it.each(["Worker", " workers ", "false", "unknown"])("fails closed for %s", (target) => {
    expect(() => pagesPublicationPolicy(target)).toThrow("SITE_HOSTING_TARGET");
  });
});
