import { useEffect, useState } from "react";

import type { MobileTab } from "../components/MobileChrome";
import type { TopViewTab } from "../components/TopBar";

const RESET_UNDO_SECONDS = 5;

type PendingResetUndo<UndoPayload> = {
  payload: UndoPayload;
  secondsLeft: number;
};

function viewTabFromHash(): TopViewTab {
  if (typeof window === "undefined") return "calc";
  return window.location.hash === "#stats" ? "stats" : "calc";
}

function replaceHashForView(viewTab: TopViewTab) {
  if (typeof window === "undefined") return;
  const nextUrl = `${window.location.pathname}${window.location.search}${
    viewTab === "stats" ? "#stats" : ""
  }`;
  window.history.replaceState(null, "", nextUrl);
}

function mobileTabForView(next: TopViewTab, current: MobileTab): MobileTab {
  if (next === "stats") return "stats";
  if (current === "stats") return "input";
  return current;
}

/**
 * Engine-independent shell state shared by every calculator route: desktop view tabs,
 * mobile input/result/stats tabs, the #stats hash and the reset-undo countdown.
 */
export function useAppShellNavigation<UndoPayload>() {
  const [mobileTab, setMobileTab] = useState<MobileTab>("input");
  const [viewTab, setViewTabState] = useState<TopViewTab>(viewTabFromHash);
  const [resetToast, setResetToast] = useState<PendingResetUndo<UndoPayload> | null>(null);

  useEffect(() => {
    const syncFromHash = () => {
      const next = viewTabFromHash();
      setViewTabState(next);
      setMobileTab((current) => mobileTabForView(next, current));
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  useEffect(() => {
    if (!resetToast) return undefined;
    if (resetToast.secondsLeft <= 0) {
      setResetToast(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setResetToast((current) =>
        current ? { ...current, secondsLeft: current.secondsLeft - 1 } : null,
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [resetToast]);

  const setViewTab = (next: TopViewTab) => {
    setViewTabState(next);
    replaceHashForView(next);
    if (next === "stats") {
      setMobileTab("stats");
      return;
    }
    setMobileTab((current) => (current === "stats" ? "input" : current));
  };

  const setMobileViewTab = (next: MobileTab, focus = false) => {
    setMobileTab(next);
    const nextViewTab = next === "stats" ? "stats" : "calc";
    setViewTabState(nextViewTab);
    replaceHashForView(nextViewTab);
    if (focus && window.matchMedia("(max-width: 660px)").matches) {
      window.requestAnimationFrame(() => document.getElementById(`mobile-tab-${next}`)?.focus());
    }
  };

  return {
    mobileTab,
    viewTab,
    statsVisible: viewTab === "stats" || mobileTab === "stats",
    setViewTab,
    setMobileViewTab,
    resetToast,
    showResetToast: (payload: UndoPayload) =>
      setResetToast({ payload, secondsLeft: RESET_UNDO_SECONDS }),
    clearResetToast: () => setResetToast(null),
  };
}
