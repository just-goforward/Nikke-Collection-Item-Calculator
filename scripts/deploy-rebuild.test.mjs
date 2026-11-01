import { test } from "node:test";
import assert from "node:assert/strict";
import { deploy } from "./deploy-site.ts";

const sha = "a".repeat(40);
const productionWorkers = {
  site: "collection-kit-site-production",
  stats: "collection-kit-stats",
};
for (const kind of ["site", "stats"]) for (const target of ["production", "staging"]) {
  test(`${kind} replacement ${target} uses explicit config without credentialled checks`, () => {
    const prefix = kind.toUpperCase();
    const account = "b".repeat(32);
    const parent = {
      CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "synthetic",
      [`${prefix}_DEPLOY_ACCOUNT_ID`]: account,
      [`${prefix}_DEPLOY_WORKER`]: target === "production"
        ? productionWorkers[kind] : `collection-kit-${kind}-v2-${target}`,
      [`${prefix}_DEPLOY_HOSTNAME`]: target === "production" ? "nikkecollection.com" : "staging.nikkecollection.com",
    };
    const calls = [];
    const execute = (command, args, options) => {
      calls.push({command, args, options});
      if (command === "git") return args[0] === "rev-parse" ? sha : "";
      if (!args.includes("deploy")) assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      return "";
    };
    deploy(kind, [`rebuild-${target}`, sha], parent, execute);
    const last = calls.at(-1);
    assert.equal(last.args[last.args.indexOf("--config") + 1],
      `${kind === "site" ? "site-worker" : "cloudflare"}/rebuild.${target}.wrangler.toml`);
    assert.equal(last.options.env.CLOUDFLARE_API_TOKEN, "synthetic");
    assert.equal(last.args[last.args.indexOf("--env") + 1], "");
    assert.equal(last.args[last.args.indexOf("--tag") + 1], sha);
    assert.equal(last.options.env.CLOUDFLARE_ACCOUNT_ID, account);
    if (kind === "stats") {
      assert.equal(last.args[last.args.indexOf("--var") + 1], `DEPLOYMENT_SHA:${sha}`);
    } else {
      const artifactCheck = calls.find(call => call.args.includes("--input-type=module"));
      assert.deepEqual(artifactCheck.args.slice(-2), [target, sha]);
      assert.equal(artifactCheck.options.env.GITHUB_SHA, sha);
    }
    assert.throws(() => deploy(kind, [`rebuild-${target}`, sha], {...parent, [`${prefix}_DEPLOY_ACCOUNT_ID`]: "wrong"}, execute));
    assert.throws(() => deploy(kind, [`rebuild-${target}`, sha], parent,
      (command, args) => command === "git" ? args[0] === "rev-parse" ? sha : " M dirty" : ""));
  });
}
for (const kind of ["site", "stats"]) {
  test(`${kind} rejects invalid invocation and authority without uploading`, () => {
    const prefix = kind.toUpperCase();
    const account = "b".repeat(32);
    const parent = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "synthetic",
      [`${prefix}_DEPLOY_ACCOUNT_ID`]: account,
      [`${prefix}_DEPLOY_WORKER`]: productionWorkers[kind],
      [`${prefix}_DEPLOY_HOSTNAME`]: "nikkecollection.com" };
    const cases = [
      [["unknown", sha], parent],
      [["rebuild-production", "bad-sha"], parent],
      [["rebuild-production", sha, "extra"], parent],
      [["rebuild-production", sha], {...parent, [`${prefix}_DEPLOY_WORKER`]: "wrong"}],
      [["rebuild-production", sha], {...parent, [`${prefix}_DEPLOY_HOSTNAME`]: "wrong.example"}],
      [["rebuild-production", sha], {...parent, CLOUDFLARE_API_TOKEN: ""}],
      [["rebuild-production", sha], {...parent, CLOUDFLARE_API_TOKEN: undefined}],
    ];
    for (const [args, env] of cases) {
      let executions = 0;
      assert.throws(() => deploy(kind, args, env, () => { executions++; return ""; }));
      assert.equal(executions, 0);
    }
    let uploads = 0;
    assert.throws(() => deploy(kind, ["rebuild-production", sha], parent, (command, args) => {
      if (args.includes("deploy")) uploads++;
      return command === "git" && args[0] === "rev-parse" ? "c".repeat(40) : "";
    }), /approved SHA/);
    assert.equal(uploads, 0);
  });
}
for (const target of ["production", "staging"]) {
  test(`existing site ${target} preserves artifact gate and config`, () => {
    const account = "b".repeat(32);
    const parent = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "synthetic",
      SITE_DEPLOY_ACCOUNT_ID: account, SITE_DEPLOY_WORKER: `collection-kit-site-${target}`,
      SITE_DEPLOY_HOSTNAME: target === "production" ? "nikkecollection.com" : "staging.nikkecollection.com" };
    const calls = [];
    deploy("site", [target, sha], parent, (command, args) => {
      calls.push(args);
      return command === "git" && args[0] === "rev-parse" ? sha : "";
    });
    assert.equal(calls.at(-1)[3], target === "production" ? "site-worker/production.wrangler.toml" : "site-worker/wrangler.toml");
    let uploaded = false;
    assert.throws(() => deploy("site", [target, sha], parent, (command, args) => {
      if (args.includes("deploy")) uploaded = true;
      if (command !== "git") throw new Error("artifact mismatch");
      return args[0] === "rev-parse" ? sha : "";
    }), /artifact mismatch/);
    assert.equal(uploaded, false);
  });
}
