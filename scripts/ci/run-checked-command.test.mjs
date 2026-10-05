import assert from "node:assert/strict";
import test from "node:test";
import { childEnvironment, commandFor, validateCheckout } from "./run-checked-command.mjs";

const commit = "1".repeat(40);
test("manual workflow definition and checkout must both be the approved candidate", () => {
  assert.doesNotThrow(() => validateCheckout(commit, commit, "workflow_dispatch", commit));
  assert.throws(
    () => validateCheckout(commit, commit, "workflow_dispatch", "2".repeat(40)),
    /Dispatched/,
  );
  assert.throws(
    () => validateCheckout(commit, "2".repeat(40), "workflow_dispatch", commit),
    /Checkout/,
  );
  assert.doesNotThrow(() => validateCheckout(commit, commit, "pull_request", "2".repeat(40)));
});
test("test children receive a strict environment, not Actions or service credentials", () => {
  const env = childEnvironment(
    {
      PATH: "/tools",
      HOME: "/runner",
      GITHUB_SHA: "2".repeat(40),
      GITHUB_TOKEN: "must-not-propagate",
      GH_TOKEN: "must-not-propagate",
      ACTIONS_RUNTIME_TOKEN: "must-not-propagate",
      CLOUDFLARE_API_TOKEN: "must-not-propagate",
      DISCORD_BOT_TOKEN: "must-not-propagate",
      NODE_OPTIONS: "--unsafe-inherited-option",
      npm_config_userconfig: "/secret/npmrc",
      ALIGNMENT_DIAGNOSTIC: "1",
      FULL_ALIGNMENT_MATRIX: "1",
      CERTIFIED_EXPECTED_MANIFEST: "ci-evidence/expected.json",
    },
    commit,
  );
  assert.equal(env.GITHUB_SHA, commit);
  assert.equal(env.PATH, "/tools");
  assert.equal(env.FULL_ALIGNMENT_MATRIX, "1");
  assert.equal(env.CERTIFIED_EXPECTED_MANIFEST, "ci-evidence/expected.json");
  for (const key of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "DISCORD_BOT_TOKEN",
    "NODE_OPTIONS",
    "npm_config_userconfig",
    "ALIGNMENT_DIAGNOSTIC",
  ])
    assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(env.CLOUDFLARE_CF_FETCH_ENABLED, "false");
});

test("rejects incomplete SHA and unknown/shell command modes", () => {
  assert.throws(() => childEnvironment({}, "main"), /full candidate commit/);
  assert.throws(() => childEnvironment({}, "a".repeat(39)), /full candidate commit/);
  const config = {
    node: "/tools/node",
    npmCli: "/tools/npm-cli.js",
    root: "/repo",
    platform: "linux",
  };
  assert.deepEqual(commandFor("npm", ["test"], config), [
    "/tools/node",
    ["/tools/npm-cli.js", "test"],
  ]);
  assert.throws(() => commandFor("npm", [], { ...config, npmCli: undefined }), /pinned/);
  assert.throws(() => commandFor("shell", [], config), /Unsupported/);
  assert.throws(
    () => commandFor("xvfb-playwright", [], { ...config, platform: "win32" }),
    /Unsupported/,
  );
});
