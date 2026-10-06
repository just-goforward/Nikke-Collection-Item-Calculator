import type { RegistryKey, RequestedTarget } from "./modal-contrast-types";

export function installSnapshotReader(key: RegistryKey) {
  const registry = window[key];
  if (!registry || registry.document !== document) throw new Error("Diagnostic document changed");
  const { identify, element: readElement, fonts: readFonts } = registry.helpers;
  if (!identify || !readElement || !readFonts) throw new Error("Diagnostic readers missing");
  const requestedTargets = (dialog: Element | null, buttons: Element[]): RequestedTarget[] => {
    const requested = Array.from({ length: 6 }, (_, index) => [
      {
        key: `choice-${index + 1}-label`,
        expected: `${index + 1}회차에 대성공`,
        element: buttons[index]?.querySelector(":scope > strong") ?? null,
      },
      {
        key: `choice-${index + 1}-count`,
        expected: `${90 - index * 10}개`,
        element: buttons[index]?.querySelector(":scope > span") ?? null,
      },
    ]).flat();
    requested.push({
      key: "why-summary",
      expected: "왜 필요한가요?",
      element: dialog?.querySelector("details > summary") ?? null,
    });
    return requested;
  };
  const targetEvidence = (requested: RequestedTarget[], all: Set<Element>) =>
    requested.map(({ key: targetKey, expected, element }) => {
      const ancestors: string[] = [];
      for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) {
        all.add(ancestor);
        ancestors.push(identify(ancestor));
      }
      if (element) all.add(element);
      return {
        key: targetKey,
        expected,
        selector: element ? identify(element) : null,
        text: element?.textContent?.trim() ?? null,
        ancestors,
      };
    });
  registry.helpers.capture = () => {
    if (registry.document !== document) throw new Error("Diagnostic document changed");
    const startedAt = performance.now();
    const dialog = document.querySelector(".attempt-modal-overlay[role=dialog]");
    const buttons = Array.from(dialog?.querySelectorAll(".attempt-choice-button") ?? []);
    const requested = requestedTargets(dialog, buttons);
    const all = new Set<Element>();
    const targets = targetEvidence(requested, all);
    const elements = Array.from(all, readElement);
    const fonts = readFonts(requested);
    const targetsComplete =
      buttons.length === 6 &&
      requested.every(({ element, expected }) => element?.textContent?.trim() === expected) &&
      new Set(requested.map(({ element }) => element)).size === 13 &&
      dialog?.querySelectorAll("details > summary").length === 1;
    const animationIdle = elements.every(({ animations }) =>
      animations.every(
        (animation) => !animation.pending && ["finished", "idle"].includes(animation.playState),
      ),
    );
    const entranceOpaque = [dialog, dialog?.querySelector(".attempt-modal")].every(
      (element) => element && getComputedStyle(element).opacity === "1",
    );
    return {
      timeOrigin: performance.timeOrigin,
      startedAt,
      completedAt: performance.now(),
      url: location.href,
      userAgent: navigator.userAgent,
      devicePixelRatio,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      targetsComplete,
      animationIdle,
      entranceOpaque,
      targets,
      elements,
      fonts,
    };
  };
}
