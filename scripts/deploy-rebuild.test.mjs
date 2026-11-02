import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { deploy } from "./deploy-site.ts";

const sha = "a".repeat(40);
const productionWorkers = {
  site: "collection-kit-site-production",
  stats: "collection-kit-stats",
};
test("sealed online promotion publishes only the verified fixed entry without rebuilding", () => {
  const sha = "a".repeat(40), account = "15be33fd20ea78eb3d60b719be831148";
  const parent = {
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "synthetic",
    SITE_DEPLOY_ACCOUNT_ID: account, SITE_DEPLOY_WORKER: "collection-kit-site-production",
    SITE_DEPLOY_HOSTNAME: "nikkecollection.com",
    SITE_RELEASE_DIR: resolve(import.meta.dirname, "../../sealed-test-placeholder"),
    SITE_RELEASE_MANIFEST_SHA256: "c".repeat(64), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  };
  function run({ changes = {}, rejectSeal = false, dirtyAfterSeal = false } = {}) {
    const calls = [];
    let verified = false;
    const invoke = () => deploy("site", ["production-online-sealed", sha], { ...parent, ...changes },
      (command, args, options) => {
        calls.push(args);
        if (command === "git") return args[0] === "rev-parse" ? sha :
          dirtyAfterSeal && verified ? " M changed.ts" : "";
        if (!args.includes("deploy")) {
          assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
          assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, undefined);
        }
        if (args[0].endsWith("site-release.mjs")) {
          assert.deepEqual(args.slice(1), ["verify", parent.SITE_RELEASE_DIR, sha,
            parent.SITE_RELEASE_MANIFEST_SHA256, "123", "1"]);
          if (rejectSeal) throw new Error("synthetic sealed payload rejection");
          verified = true;
        }
        if (args.includes("deploy")) {
          assert.equal(verified, true);
          assert.equal(options.env.CLOUDFLARE_API_TOKEN, "synthetic");
        }
        return "";
      });
    return { calls, invoke };
  }
  const accepted = run(); accepted.invoke();
  const upload = accepted.calls.at(-1);
  assert.deepEqual(upload.slice(-3), [resolve(parent.SITE_RELEASE_DIR, "worker/worker.js"),
    "--no-bundle", "--no-experimental-auto-create"]);
  assert.equal(upload[upload.indexOf("--config") + 1], "site-worker/production.wrangler.toml");
  for (const options of [{ rejectSeal: true }, { dirtyAfterSeal: true },
    { changes: { SITE_RELEASE_MANIFEST_SHA256: "" } }, { changes: { GITHUB_RUN_ID: "" } },
    { changes: { SITE_DEPLOY_HOSTNAME: "other.example" } },
    { changes: { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), SITE_DEPLOY_ACCOUNT_ID: "b".repeat(32) } }]) {
    const rejected = run(options);
    assert.throws(rejected.invoke);
    assert.equal(rejected.calls.some(args => args.includes("deploy")), false);
  }
});
test("explicit online Site promotion validates production trust before uploading and retains all authority and snapshot gates", () => {
  const account = "15be33fd20ea78eb3d60b719be831148";
  const parent = {
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "synthetic",
    SITE_DEPLOY_ACCOUNT_ID: account, SITE_DEPLOY_WORKER: "collection-kit-site-production",
    SITE_DEPLOY_HOSTNAME: "nikkecollection.com", UNRELATED_SECRET: "never-forward",
  };
  const root = resolve(import.meta.dirname, "..");
  const run = ({ kind = "site", args = ["production-online", sha], changes = {},
    head = sha, status = () => "", artifactFailure = false } = {}) => {
    const calls = [];
    let snapshots = 0;
    const execute = (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(options.cwd, root);
      assert.equal(options.env.UNRELATED_SECRET, undefined);
      if (args.includes("deploy")) return "";
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, undefined);
      assert.equal(options.env.GITHUB_SHA, sha);
      if (command === "git") {
        if (args[0] === "rev-parse") return head;
        assert.deepEqual(args, ["status", "--porcelain", "--untracked-files=all"]);
        return status(++snapshots);
      }
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-e"]);
      assert.deepEqual(args.slice(-3), [resolve(root, "dist"), "production", sha]);
      // This executable CLI payload is the process boundary: an online dispatch
      // must request the candidate trust check, not the bundled or OFF checker.
      assert.match(args[2], /await assertProductionSiteCandidateProfile\(process\.argv\[1\],process\.argv\[3\]\)/);
      assert.match(args[2], /await buildSiteProduction\(process\.argv\[1\],true,approved,process\.argv\[2\]\)/);
      assert.doesNotMatch(args[2], /assertProductionOffSiteProfile|assertSiteDeploymentArtifact/);
      if (artifactFailure) throw new Error("synthetic online artifact rejection");
      return "";
    };
    return { calls, invoke: () => deploy(kind, args, { ...parent, ...changes }, execute) };
  };
  const accepted = run();
  accepted.invoke();
  const upload = accepted.calls.at(-1);
  assert.deepEqual(accepted.calls.map(call => call.command === "git" ? call.args[0] :
    call.args.includes("deploy") ? "upload" : "artifact"),
  ["rev-parse", "status", "artifact", "rev-parse", "status", "upload"]);
  assert.equal(upload.command, process.execPath);
  assert.deepEqual(upload.args.slice(0, 8), [
    resolve(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy", "--config", "site-worker/production.wrangler.toml", "--env", "", "--tag", sha,
  ]);
  assert.equal(upload.options.env.CLOUDFLARE_ACCOUNT_ID, account);
  assert.equal(upload.options.env.CLOUDFLARE_API_TOKEN, "synthetic");

  for (const options of [
    { args: ["production-online", "bad-sha"] },
    { args: ["production-online", "A".repeat(40)] },
    { args: ["production-online", sha, "extra"] },
    { changes: { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), SITE_DEPLOY_ACCOUNT_ID: "b".repeat(32) } },
    { changes: { SITE_DEPLOY_ACCOUNT_ID: "b".repeat(32) } },
    { changes: { SITE_DEPLOY_WORKER: "collection-kit-site-v2-production" } },
    { changes: { SITE_DEPLOY_HOSTNAME: "staging.nikkecollection.com" } },
    { changes: { CLOUDFLARE_API_TOKEN: "" } },
    { changes: { CLOUDFLARE_API_TOKEN: undefined } },
    { kind: "stats" },
  ]) {
    const rejected = run(options);
    assert.throws(rejected.invoke);
    assert.equal(rejected.calls.length, 0);
  }
  for (const options of [
    { head: "c".repeat(40) },
    { status: () => " M src/application.ts" },
    { status: () => "?? scripts/unsealed-candidate.mjs" },
    { status: count => count === 2 ? " M src/application.ts" : "" },
    { artifactFailure: true },
  ]) {
    const rejected = run(options);
    assert.throws(rejected.invoke, /approved SHA|synthetic online artifact rejection/);
    assert.equal(rejected.calls.some(call => call.args.includes("deploy")), false);
  }
});
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
