import type { CSSProperties } from "react";

import type { ThemeMode } from "../ui-types";

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

type TopBarProps = {
  themeMode: ThemeMode;
  onThemeModeChange: (themeMode: ThemeMode) => void;
};

export default function TopBar({ themeMode, onThemeModeChange }: TopBarProps) {
  const themeIndex = Math.max(0, THEME_MODES.indexOf(themeMode));
  const controlStyle = { "--theme-index": themeIndex } as CSSProperties;

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Collectibles Leveling up Optimizer</p>
        <h1>소장품 레벨업 계산기</h1>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and tests use this grouped control contract. */}
      <div className="theme-control" role="group" aria-label="테마 선택" style={controlStyle}>
        <span className="theme-label">테마</span>
        <div className="theme-options">
          <button
            className={`theme-button ${themeMode === "system" ? "active" : ""}`}
            type="button"
            data-theme-mode="system"
            aria-pressed={themeMode === "system"}
            onClick={() => onThemeModeChange("system")}
          >
            자동
          </button>
          <button
            className={`theme-button ${themeMode === "light" ? "active" : ""}`}
            type="button"
            data-theme-mode="light"
            aria-pressed={themeMode === "light"}
            onClick={() => onThemeModeChange("light")}
          >
            라이트
          </button>
          <button
            className={`theme-button ${themeMode === "dark" ? "active" : ""}`}
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
