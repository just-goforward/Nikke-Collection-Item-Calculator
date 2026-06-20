import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { ignoreExpectedError } from "../lib/errorHandling";
import type { Grade } from "../types";
import type { ThemeMode } from "../ui-types";

const THEME_STORAGE_KEY = "collectionThemeMode";
const THEME_COMMIT_CLASS = "theme-commit";
const THEME_VIEW_TRANSITION_CLASS = "theme-view-transitioning";
let themeTransitionGeneration = 0;

function initialThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (error) {
    ignoreExpectedError(
      "theme storage read can fail in private or restricted browser contexts",
      error,
    );
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

function applyTheme(mode: ThemeMode) {
  const resolved = resolvedTheme(mode);
  document.body.classList.toggle("theme-dark", resolved === "dark");
  document.body.classList.toggle("theme-light", resolved === "light");
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function releaseThemeCommitClass() {
  document.documentElement.classList.remove(THEME_COMMIT_CLASS);
}

function releaseViewTransitionClass(generation: number) {
  if (generation !== themeTransitionGeneration) return;
  document.documentElement.classList.remove(THEME_VIEW_TRANSITION_CLASS);
}

function commitThemeChange(update: () => void) {
  document.documentElement.classList.add(THEME_COMMIT_CLASS);
  if (
    prefersReducedMotion() ||
    document.visibilityState !== "visible" ||
    typeof document.startViewTransition !== "function"
  ) {
    update();
    window.requestAnimationFrame(releaseThemeCommitClass);
    return;
  }

  const generation = ++themeTransitionGeneration;
  document.documentElement.classList.add(THEME_VIEW_TRANSITION_CLASS);
  const transition = document.startViewTransition(update);
  void transition.ready.then(releaseThemeCommitClass, releaseThemeCommitClass);
  void transition.finished.then(
    () => releaseViewTransitionClass(generation),
    () => releaseViewTransitionClass(generation),
  );
}

export function useTheme(grade: Grade) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(initialThemeMode);

  const setThemeMode = useCallback(
    (mode: ThemeMode) => {
      const nextMode = mode === "dark" || mode === "light" ? mode : "system";
      if (nextMode === themeMode) return;
      commitThemeChange(() => {
        flushSync(() => setThemeModeState(nextMode));
        applyTheme(nextMode);
      });
      try {
        if (nextMode === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
      } catch (error) {
        ignoreExpectedError(
          "theme storage write can fail in private or restricted browser contexts",
          error,
        );
      }
    },
    [themeMode],
  );

  useEffect(() => {
    applyTheme(themeMode);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media || themeMode !== "system") return undefined;
    const handleSystemThemeChange = () => {
      commitThemeChange(() => applyTheme(themeMode));
    };
    media.addEventListener("change", handleSystemThemeChange);
    return () => media.removeEventListener("change", handleSystemThemeChange);
  }, [themeMode]);

  useEffect(() => {
    return () => {
      releaseThemeCommitClass();
      document.documentElement.classList.remove(THEME_VIEW_TRANSITION_CLASS);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("grade-r", grade === "R");
    document.body.classList.toggle("grade-sr", grade === "SR");
  }, [grade]);

  return { themeMode, setThemeMode };
}
