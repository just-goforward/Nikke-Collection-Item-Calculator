import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CohortPanel } from "./CertifiedSupplyPanels";
import { certifiedMessages } from "./messages";
import { createCertifiedSession } from "./session";

const session = createCertifiedSession("cohort-label", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
describe("default and learned certified mixtures", () => {
  it.each(["ko", "en", "ja"] as const)("distinguishes learned mixtures in %s", (locale) => {
    const words = certifiedMessages[locale];
    const render = (value: typeof session) =>
      renderToStaticMarkup(
        createElement(CohortPanel, {
          disabled: false,
          session: value,
          onUpdate: () => {},
          words,
        }),
      );
    expect(render(session)).not.toContain(words.learnedMixture);
    const learned = {
      ...session,
      cohortWeights: [
        { numerator: "1", denominator: "2" },
        { numerator: "1", denominator: "4" },
        { numerator: "1", denominator: "8" },
        { numerator: "1", denominator: "8" },
      ] as const,
    };
    const html = render(learned);
    expect(html).toContain(words.learnedMixture);
    expect(html).toMatch(/<option[^>]*value="-2"[^>]*selected=""/);
    expect(
      render({
        ...session,
        cohortWeights: [
          { numerator: "2", denominator: "14" },
          { numerator: "4", denominator: "14" },
          { numerator: "6", denominator: "14" },
          { numerator: "2", denominator: "14" },
        ],
      }),
    ).not.toContain(words.learnedMixture);
  });
});
