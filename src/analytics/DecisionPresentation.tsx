import { createContext, useContext, useEffect, useRef } from "react";
import { observeDecision, type DecisionLifecycle } from "./decisionLifecycle";

type ReceiptContext = {
  lifecycle?: DecisionLifecycle | undefined;
  owner: unknown;
  eligible: boolean;
};
export const DecisionPresentation = createContext<ReceiptContext | null>(null);

/** Called in the loaded leaf, never in a suspense fallback or a computed-result renderer. */
export function useDecisionReceipt(leaf: "current" | "wait" | "conversion" | "callout", rendered = true) {
  const context = useContext(DecisionPresentation);
  const committed = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!rendered || !context?.eligible || context.owner === undefined || !context.lifecycle?.presented) return;
    const element = committed.current;
    if (!element) return;
    const { lifecycle, owner } = context;
    const document = element.ownerDocument;
    const view = document.defaultView;
    if (!view) return;
    const ancestors: HTMLElement[] = [];
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement)
      ancestors.push(parent);
    const receipt = () => {
      observeDecision(() => {
        if (committed.current !== element || !element.isConnected || document.visibilityState !== "visible") return;
        const rectangles = Array.from(element.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
        if (!rectangles.length) return;
        let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight;
        for (const ancestor of ancestors) {
          const style = view.getComputedStyle(ancestor);
          if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") ||
              ancestor.getAttribute("aria-hidden") === "true" ||
              style.display === "none" || style.visibility !== "visible" ||
              style.contentVisibility === "hidden" || Number(style.opacity) === 0) return;
          if (ancestor !== element) {
            const bounds = ancestor.getBoundingClientRect();
            if (style.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
            if (style.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
          }
        }
        if (!rectangles.some(rect => Math.min(rect.right, right) > Math.max(rect.left, left) &&
            Math.min(rect.bottom, bottom) > Math.max(rect.top, top))) return;
        lifecycle.presented?.(owner, leaf);
      });
    };
    receipt();
    // Observe only this committed leaf's ancestor attributes, never global content
    // mutations or selectors. Every notification remeasures actual visibility.
    const attributes = new MutationObserver(receipt);
    const geometry = new ResizeObserver(receipt);
    for (const ancestor of ancestors) {
      attributes.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"] });
      geometry.observe(ancestor);
    }
    document.addEventListener("visibilitychange", receipt);
    document.addEventListener("scroll", receipt, true);
    view.addEventListener("resize", receipt);
    element.addEventListener("transitionend", receipt);
    element.addEventListener("animationend", receipt);
    return () => {
      attributes.disconnect(); geometry.disconnect();
      document.removeEventListener("visibilitychange", receipt);
      document.removeEventListener("scroll", receipt, true);
      view.removeEventListener("resize", receipt);
      element.removeEventListener("transitionend", receipt);
      element.removeEventListener("animationend", receipt);
    };
  });
  return committed;
}
