import { expect, it } from "vitest";
import { decisionIdentity } from "./decisions";

it("bounds decision identities independently of source identifier lengths", async () => {
  const version = "v".repeat(300);
  const id = await decisionIdentity("6225681", version, "solo_review");
  expect(id).toMatch(/^d_[0-9a-f]{24}$/);
  expect(await decisionIdentity("6225681", version, "solo_review")).toBe(id);
  expect(await decisionIdentity("6225681", `${version}2`, "solo_review")).not.toBe(id);
  expect(await decisionIdentity("maintenance_grant", version, 100, version)).toHaveLength(26);
  expect(await decisionIdentity("retry", version, 100)).toHaveLength(26);
});
