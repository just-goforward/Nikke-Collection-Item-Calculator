import { describe, expect, it } from "vitest";
import { minimumWaitBase } from "../certifiedRuntime/minimumWait";
import { certifiedMessages } from "./messages";
import {
  minimumWaitCalculating,
  minimumWaitReason,
  minimumWaitText,
} from "./minimumWaitPresentation";

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
    it(`${locale}: separates computing from unknown and explains refusals`, () => {
      const pending = minimumWaitBase(null, "unknown", "minimum_wait_in_progress");
      expect(minimumWaitCalculating(pending, true)).toBe(true);
      expect(minimumWaitText(pending, words, true)).toBe(words.minimumWaitCalculating);
      expect(minimumWaitText(undefined, words, true)).toBe(words.minimumWaitCalculating);
      expect(minimumWaitReason(pending, words, true)).toBeNull();
      for (const [reason, message] of [
        ["request_budget_exhausted", words.minimumWaitBudget],
        ["exact_support_limit", words.minimumWaitGuard],
        ["current_claimable_unreceived", words.claimRequired],
        ["minimum_wait_future_coverage_incomplete", words.minimumWaitCoverage],
      ] as const) {
        const unknown = minimumWaitBase(null, "unknown", reason);
        expect(minimumWaitCalculating(unknown, true)).toBe(false);
        expect(minimumWaitText(unknown, words, true)).toBe(words.minimumWaitUnknown);
        expect(minimumWaitReason(unknown, words, true)).toBe(message);
      }
      expect(words.minimumWaitMeaning.length).toBeGreaterThan(0);
    });
    it(`${locale}: hides unmapped internal reasons behind the localized fallback`, () => {
      for (const reason of [
        "minimum_wait_batch_not_exact_tie",
        "negative_recurring_rate",
        "minimum_wait_compensation_invalid",
        "new_guard",
        "__proto__",
        null,
      ]) {
        const unknown = minimumWaitBase(null, "unknown", reason);
        for (const busy of [false, true]) {
          const message = minimumWaitReason(unknown, words, busy);
          expect(message).toBe(words.minimumWaitUnconfirmed);
          if (reason !== null) expect(message).not.toContain(reason);
        }
      }
    });
    it(`${locale}: explains idle pending results as interrupted and asks to recalculate`, () => {
      for (const reason of ["minimum_wait_in_progress", "current_not_completed"]) {
        const pending = minimumWaitBase(null, "unknown", reason);
        expect(minimumWaitText(pending, words, true)).toBe(words.minimumWaitCalculating);
        expect(minimumWaitReason(pending, words, true)).toBeNull();
        expect(minimumWaitCalculating(pending, false)).toBe(false);
        expect(minimumWaitReason(pending, words, false)).toBe(words.minimumWaitInterrupted);
        expect(minimumWaitReason(pending, words, false)).not.toContain(reason);
      }
    });
  }
});
