import { describe, expect, it } from "vitest";
import { certifiedMessages } from "./messages";
import { createCertifiedSession, restoreCertifiedSession } from "./session";

const session = createCertifiedSession("cohort-label", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
describe("fixed certified dispatch presentation", () => {
  it.each(["ko", "en", "ja"] as const)(
    "explains the fixed policy without selector copy in %s",
    (locale) => {
      const words = certifiedMessages[locale];
      expect(words.cohort_prior_reset).toContain(
        { ko: "예측 버전", en: "forecast policy", ja: "予測バージョン" }[locale],
      );
      expect(Object.values(words).join(" ")).not.toContain("1:2:3:1");
      expect(words).not.toHaveProperty("cohort");
      expect(words).not.toHaveProperty("learnedMixture");
      expect(words).not.toHaveProperty("reroll3");
    },
  );
  it("drops even equivalent saved weights instead of persisting a session policy", () => {
    const restored = restoreCertifiedSession(
      JSON.stringify({
        ...session,
        cohortWeights: [2, 4, 6].map((numerator) => ({
          numerator: String(numerator),
          denominator: "12",
        })),
      }),
    );
    expect(restored).toEqual({ ...session, migrationNotice: "cohort_prior_reset" });
    expect(restored).not.toHaveProperty("cohortWeights");
  });
  it("creates and restores sessions without any saved weights", () => {
    expect(session).not.toHaveProperty("cohortWeights");
    expect(restoreCertifiedSession(JSON.stringify(session))).toEqual(session);
  });
});
