import type { CSSProperties } from "react";

import type { ThemeMode } from "../ui-types";

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

const classes = {
  root: "mb-[18px] flex items-end justify-between gap-[18px] max-mobile:mb-[10px] max-mobile:items-center max-mobile:gap-[10px]",
  titleWrap: "max-mobile:min-w-0 max-mobile:flex-1",
  title:
    "m-0 text-[clamp(27px,3vw,42px)] font-semibold leading-[1.05] max-mobile:max-w-none max-mobile:text-[clamp(20px,5vw,24px)] max-mobile:leading-[1.15] max-mobile:tracking-[-0.01em] max-phone-xs:text-[18.5px]",
  titleButton:
    "block border-0 bg-transparent p-0 text-left font-semibold text-inherit transition-opacity duration-150 hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-2 focus-visible:ring-offset-page",
  control:
    "inline-grid grid-cols-[auto] items-center gap-1 rounded-card border border-border bg-surface p-0.5 [--theme-index:0] max-mobile:self-center max-mobile:gap-0",
  options:
    "relative grid min-w-0 grid-cols-[repeat(3,minmax(40px,1fr))] gap-0.5 before:absolute before:inset-y-0 before:left-0 before:z-0 before:w-[calc((100%_-_4px)/3)] before:rounded-control before:bg-theme-active before:shadow-[0_8px_18px_rgba(21,43,58,0.16)] before:[transform:translateX(calc(var(--theme-index)*(100%+2px)))] before:[transition:transform_220ms_cubic-bezier(0.2,0.8,0.2,1),background-color_180ms_ease,box-shadow_180ms_ease] max-mobile:grid-cols-[repeat(3,minmax(36px,1fr))] max-mobile:gap-0.5 max-mobile:p-0",
  button:
    "relative z-[1] min-h-[26px] whitespace-nowrap bg-transparent px-[6px] text-[11px] text-muted transition-colors duration-[160ms] max-mobile:text-[10.5px]",
  activeButton: "text-page",
} as const;

type TopBarProps = {
  onReset: () => void;
  themeMode: ThemeMode;
  onThemeModeChange: (themeMode: ThemeMode) => void;
};

export default function TopBar({ onReset, themeMode, onThemeModeChange }: TopBarProps) {
  const themeIndex = Math.max(0, THEME_MODES.indexOf(themeMode));
  const controlStyle = { "--theme-index": themeIndex } as CSSProperties;

  return (
    <header className={classes.root}>
      <div className={classes.titleWrap}>
        <h1 className={classes.title}>
          <button
            className={classes.titleButton}
            onClick={onReset}
            title="입력값 초기화"
            type="button"
          >
            소장품 레벨업 계산기
          </button>
        </h1>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and tests use this grouped control contract. */}
      <div className={classes.control} role="group" aria-label="테마 선택" style={controlStyle}>
        <div className={classes.options}>
          <button
            className={`${classes.button} ${themeMode === "system" ? classes.activeButton : ""}`}
            type="button"
            data-theme-mode="system"
            aria-pressed={themeMode === "system"}
            onClick={() => onThemeModeChange("system")}
          >
            자동
          </button>
          <button
            className={`${classes.button} ${themeMode === "light" ? classes.activeButton : ""}`}
            type="button"
            data-theme-mode="light"
            aria-pressed={themeMode === "light"}
            onClick={() => onThemeModeChange("light")}
          >
            라이트
          </button>
          <button
            className={`${classes.button} ${themeMode === "dark" ? classes.activeButton : ""}`}
            type="button"
            data-theme-mode="dark"
            aria-pressed={themeMode === "dark"}
            onClick={() => onThemeModeChange("dark")}
          >
            다크
          </button>
        </div>
      </div>
    </header>
  );
}
