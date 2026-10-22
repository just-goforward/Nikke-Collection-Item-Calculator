import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONAL_COHORT_WEIGHTS } from "../../shared/certifiedSupplyModel";
import {
  CERTIFIED_SESSION_READ_KEYS,
  createCertifiedSession,
  readStoredCertifiedSession,
  restoreCertifiedSession,
} from "./session";

describe("certified session namespaces", () => {
  it.each(CERTIFIED_SESSION_READ_KEYS)("reads saved bytes from %s", (key) => {
    const storage = new Map([[key, "saved-bytes"]]);
    expect(
      readStoredCertifiedSession({
        getItem: (name) => storage.get(name) ?? null,
      }),
    ).toBe("saved-bytes");
  });

  it("does not replace malformed current bytes with older stock", () => {
    const storage = new Map<string, string>(
      CERTIFIED_SESSION_READ_KEYS.map((key, index) => [key, index === 0 ? "" : "old"]),
    );
    expect(
      readStoredCertifiedSession({
        getItem: (name) => storage.get(name) ?? null,
      }),
    ).toBe("");
  });

  it("migrates v3 snapshot-era sessions without altering stock or ledger", () => {
    const session = createCertifiedSession("old", { grade: "R", level: 0, exp: 0 }, [1, 2, 3]);
    const old = {
      ...session,
      profileId: "certified-staging-v2",
      cohortWeights: DEFAULT_PERSONAL_COHORT_WEIGHTS,
    };
    const restored = restoreCertifiedSession(JSON.stringify(old));
    expect(restored).toEqual({ ...session, migrationNotice: "cohort_prior_reset" });
    expect(restored?.stock).toEqual(old.stock);
    expect(restored?.receipts).toEqual(old.receipts);
  });
});
