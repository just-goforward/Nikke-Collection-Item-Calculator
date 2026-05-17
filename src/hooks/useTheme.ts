import { useCallback, useEffect, useState } from "react";

import type { Grade } from "../types";
import type { ThemeMode } from "../ui-types";

const THEME_STORAGE_KEY = "collectionThemeMode";

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

  const setThemeMode = useCallback((mode: ThemeMode) => {
    const nextMode = mode === "dark" || mode === "light" ? mode : "system";
    setThemeModeState(nextMode);
    try {
      if (nextMode === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    } catch {
      // Ignore storage failures.
    }
  }, []);

  useEffect(() => {
    const apply = () => {
      const resolved = resolvedTheme(themeMode);
      document.body.classList.toggle("theme-dark", resolved === "dark");
      document.body.classList.toggle("theme-light", resolved === "light");
    };
    apply();
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media || themeMode !== "system") return undefined;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themeMode]);

  useEffect(() => {
    document.body.classList.toggle("grade-r", grade === "R");
    document.body.classList.toggle("grade-sr", grade === "SR");
  }, [grade]);

  return { themeMode, setThemeMode };
}
