import { useCallback, useEffect, useRef, useState } from "react";

import type { Grade } from "../types";
import type { ThemeMode } from "../ui-types";

const THEME_STORAGE_KEY = "collectionThemeMode";
const THEME_TRANSITION_MS = 360;

function initialThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage is optional; system mode is the safe fallback.
  }
  return "system";
}

function systemPrefersDark() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolvedTheme(mode: ThemeMode) {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

export function useTheme(grade: Grade) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(initialThemeMode);
  const didApplyThemeRef = useRef(false);
  const transitionTimerRef = useRef<number | null>(null);

  const startThemeTransition = useCallback(() => {
    if (!didApplyThemeRef.current) return;
    document.body.classList.add("theme-transitioning");
    // Make the transition class observable before theme CSS variables change.
    void document.body.offsetHeight;
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = window.setTimeout(() => {
      document.body.classList.remove("theme-transitioning");
      transitionTimerRef.current = null;
    }, THEME_TRANSITION_MS);
  }, []);

  const setThemeMode = useCallback(
    (mode: ThemeMode) => {
      const nextMode = mode === "dark" || mode === "light" ? mode : "system";
      if (nextMode !== themeMode) startThemeTransition();
      setThemeModeState(nextMode);
      try {
        if (nextMode === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
      } catch {
        // Ignore storage failures.
      }
    },
    [startThemeTransition, themeMode],
  );

  useEffect(() => {
    const apply = () => {
      const resolved = resolvedTheme(themeMode);
      document.body.classList.toggle("theme-dark", resolved === "dark");
      document.body.classList.toggle("theme-light", resolved === "light");
      didApplyThemeRef.current = true;
    };
    apply();
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media || themeMode !== "system") return undefined;
    const handleSystemThemeChange = () => {
      startThemeTransition();
      apply();
    };
    media.addEventListener("change", handleSystemThemeChange);
    return () => media.removeEventListener("change", handleSystemThemeChange);
  }, [startThemeTransition, themeMode]);

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      document.body.classList.remove("theme-transitioning");
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("grade-r", grade === "R");
    document.body.classList.toggle("grade-sr", grade === "SR");
  }, [grade]);

  return { themeMode, setThemeMode };
}
