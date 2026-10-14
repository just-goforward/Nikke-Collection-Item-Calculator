import { describe, expect, it } from "vitest";
import { minimumWaitBase } from "../certifiedRuntime/minimumWait";
import { certifiedMessages } from "./messages";
import { minimumWaitText } from "./minimumWaitPresentation";

describe("localized minimum-wait label, independent of H56", () => {
  for (const [locale, words] of Object.entries(certifiedMessages)) {
    it(`${locale}: distinguishes proof, unknown and partial interval`, () => {
      const unknown = minimumWaitBase(null, "unknown", "exact_support_limit");
      expect(minimumWaitText(unknown, words)).toBe(words.minimumWaitUnknown);
      expect(minimumWaitText(undefined, words)).toBe(words.minimumWaitUnknown);
      expect(minimumWaitText({ ...unknown, status: "beyond_horizon" }, words)).toBe(
        words.minimumWaitBeyond,
      );
      for (let day = 1; day <= 7; day++)
        expect(minimumWaitText({ ...unknown, status: "certified", minimumDays: day }, words)).toBe(
          words.minimumWaitDays.replace("{n}", String(day)),
        );
      expect(minimumWaitText({ ...unknown, earliestPossibleDay: 3 }, words)).toBe(
        words.minimumWaitLower.replace("{n}", "3"),
      );
      expect(
        minimumWaitText({ ...unknown, earliestPossibleDay: 3, latestPossibleDay: 6 }, words),
      ).toBe(words.minimumWaitInterval.replace("{from}", "3").replace("{to}", "6"));
    });
  }
});
