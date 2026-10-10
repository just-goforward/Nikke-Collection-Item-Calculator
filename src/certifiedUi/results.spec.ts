import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { solveCertified } from "../certified/solver";
import type { CertifiedOutput } from "../certified/types";
import { I18nProvider } from "../i18n/locale";
import { ResultPanels } from "./CertifiedResultPanels";
import { certifiedMessages } from "./messages";

const snapshot = buildCertifiedSupplySnapshot({
  asOf: "2026-09-30T03:00:00Z",
  revision: "ui-capacity-regression",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
});
const input = {
  grade: "R" as const,
  level: 0,
  exp: 0,
  stock: [300, 50, 20] as const,
  asOf: snapshot.asOf,
  snapshot,
  computeWaiting: false,
};
function render(output: CertifiedOutput) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(ResultPanels, {
        output,
        busy: false,
        words: certifiedMessages.en,
        conversionRequired: false,
        actionsDisabled: false,
        onOutcome: () => {},
        onConvert: () => {},
      }),
    ),
  );
}

describe("certified result refusal and partial presentation", () => {
  it("shows only the capacity refusal without a recommendation or fallback result", () => {
    const output = solveCertified(input, { maxMemoEntries: 1 });
    expect(output.status).toBe("refused");
    expect(output.current).toBeNull();
    expect(output.refusal?.reason).toBe("exact_memo_limit");
    const html = render(output);
    expect(html).toContain(certifiedMessages.en.limit);
    expect(html).not.toContain("cert-probability");
    expect(html).not.toContain(certifiedMessages.en.recommend);
    expect(html).not.toContain(certifiedMessages.en.unresolved);
  });

  it("keeps a completed current result when only future work exceeds the request deadline", () => {
    let currentSent = false;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (currentSent ? 16000 : 0));
    let output: CertifiedOutput;
    try {
      output = solveCertified(
        {
          ...input,
          grade: "SR",
          level: 14,
          exp: 0,
          stock: [10, 0, 0],
          computeWaiting: true,
          receivedEventIds: snapshot.events
            .filter((event) => event.gameDate === snapshot.coverage.currentDay)
            .map((event) => event.id),
        },
        {
          deadlineAt: 15000,
          onCurrent: () => {
            currentSent = true;
          },
        },
      );
    } finally {
      clock.mockRestore();
    }
    expect(output.status).toBe("partial");
    expect(output.current).not.toBeNull();
    expect(output.refusal?.phase).toBe("waiting");
    const html = render(output);
    expect(html).toContain("cert-probability");
    expect(html).toContain(certifiedMessages.en.unresolved);
    expect(html).not.toContain(certifiedMessages.en.limit);
  });
});
