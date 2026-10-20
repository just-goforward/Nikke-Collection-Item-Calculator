import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupplyModel";
import { CertifiedBanner } from "./CertifiedShellChrome";
import type { CertifiedCalculatorController } from "./calculatorController";
import { certifiedMessages } from "./messages";
import type { CertifiedShellInteractions } from "./useCertifiedShellInteractions";

vi.mock("../i18n/locale", () => ({ useI18n: () => ({ locale: "ko", t: (key: string) => key }) }));

const words = certifiedMessages.ko;

function renderBanner(snapshot: CertifiedSupplySnapshot) {
  const controller = {
    snapshot,
    prepareError: null,
    storageBlocked: false,
    sessionSaveFailed: false,
    session: {} as CertifiedCalculatorController["session"],
  } as CertifiedCalculatorController;
  return renderToStaticMarkup(
    createElement(CertifiedBanner, {
      controller,
      ui: {} as CertifiedShellInteractions,
      words,
    }),
  );
}

function snapshot(
  version: CertifiedSupplySnapshot["cadence"]["version"],
  sourceStatus: CertifiedSupplySnapshot["sourceStatus"] = "uncertain",
) {
  return {
    sourceStatus,
    cadence: { version } as CertifiedSupplySnapshot["cadence"],
  } as CertifiedSupplySnapshot;
}

describe("CertifiedBanner", () => {
  it("hides the no-automatic-delay notice for the median cadence", () => {
    expect(renderBanner(snapshot("observed-median-v2"))).not.toContain(words.uncertain);
  });

  it("keeps the no-automatic-delay notice for the legacy cadence", () => {
    expect(renderBanner(snapshot("observed-mean-thursday-v1"))).toContain(words.uncertain);
  });

  it("omits the notice when sources are healthy", () => {
    expect(renderBanner(snapshot("observed-mean-thursday-v1", "healthy"))).not.toContain(
      words.uncertain,
    );
  });

  it("renders no retired source-review advisory", () => {
    const html = renderBanner(snapshot("observed-mean-thursday-v1"));
    expect(html).not.toContain("data-forecast-review");
    expect(html).not.toContain("정보 검토 상태를 확인하지 못했습니다");
  });
});
