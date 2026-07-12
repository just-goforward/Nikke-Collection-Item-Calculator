import type { CSSProperties, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import type { ThemeMode } from "../ui-types";

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
const THEME_LABELS: Record<ThemeMode, string> = {
  system: "자동",
  light: "라이트",
  dark: "다크",
};
const LANG_OPTIONS = [
  { value: "ko", label: "한국어", enabled: true },
  { value: "en", label: "English", enabled: false },
  { value: "ja", label: "日本語", enabled: false },
] as const;
const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";

const classes = {
  root: "mb-[18px] flex items-center justify-between gap-[18px] max-mobile:mb-[10px] max-mobile:gap-[10px]",
  titleWrap: "flex min-w-0 flex-1 items-center gap-4 max-mobile:block",
  title:
    "m-0 truncate text-[clamp(30px,4vw,42px)] font-semibold leading-[1.05] max-mobile:max-w-none max-mobile:text-[clamp(20px,5vw,24px)] max-mobile:leading-[1.15] max-mobile:tracking-[-0.01em] max-phone-xs:text-[18.5px]",
  titleText: "-mx-1 -my-0.5 block px-1 py-0.5 font-semibold text-inherit",
  viewTabs:
    "relative grid shrink-0 grid-cols-2 gap-0.5 self-center rounded-card border border-border bg-button p-0.5 [--seg-index:0] before:pointer-events-none before:absolute before:inset-y-0.5 before:left-0.5 before:z-0 before:w-[calc((100%_-_6px)/2)] before:rounded-control before:bg-[var(--seg-thumb)] before:shadow-[var(--seg-shadow)] before:[transform:translateX(calc(var(--seg-index)*(100%+2px)))] before:[transition:transform_220ms_cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:before:transition-none max-mobile:hidden",
  viewTab:
    "relative z-[1] grid min-h-[30px] place-items-center whitespace-nowrap rounded-control border-0 bg-transparent px-3.5 text-[12.5px] font-bold text-muted transition-colors duration-[220ms] ease-[ease] motion-reduce:transition-none [&[aria-selected=true]]:text-text-strong [&:not([aria-selected=true])]:hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-1 focus-visible:ring-offset-page",
  viewTabActive: "text-text-strong",
  utilities: "flex shrink-0 items-center gap-2 self-center",
  lang: "relative",
  langButton:
    "inline-flex min-h-[34px] min-w-[42px] items-center justify-center gap-1 rounded-card border border-border bg-button px-2.5 text-[10.5px] font-semibold text-muted transition-[border-color,color,background-color] duration-[160ms] hover:border-grade-active hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-2 focus-visible:ring-offset-page",
  langText: "sr-only",
  langMenu:
    "topbar-menu-rollout absolute right-0 top-[calc(100%+6px)] z-30 grid min-w-[132px] gap-0.5 rounded-card border border-border bg-surface p-1 shadow-panel",
  langOption:
    "flex min-h-8 items-center gap-2 rounded-control border-0 bg-transparent px-2.5 text-left text-[12.5px] font-bold text-text-soft hover:bg-surface-strong",
  langOptionDisabled:
    "cursor-not-allowed text-muted opacity-45 hover:bg-transparent hover:text-muted",
  langCheck: "inline-block w-4 shrink-0 text-center text-[12px] leading-none",
  control:
    "inline-grid grid-cols-[auto] items-center gap-1 rounded-card border border-border bg-button p-0.5 [--seg-index:0] transition-[border-color,background-color] duration-[160ms] max-[684px]:hidden",
  options:
    "relative grid min-w-0 grid-cols-[repeat(3,minmax(42px,1fr))] gap-0.5 before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-0 before:w-[calc((100%_-_4px)/3)] before:rounded-control before:bg-[var(--seg-thumb)] before:shadow-[var(--seg-shadow)] before:[transform:translateX(calc(var(--seg-index)*(100%+2px)))] before:[transition:transform_220ms_cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:before:transition-none",
  button:
    "relative z-[1] min-h-[28px] whitespace-nowrap bg-transparent px-2 text-[11px] font-semibold text-muted transition-colors duration-[220ms] ease-[ease] motion-reduce:transition-none [&[aria-pressed=true]]:text-text-strong [&:not([aria-pressed=true])]:hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
  activeButton: "theme-option-active",
  mobileTheme: "relative hidden max-[684px]:block",
  themeButton:
    "inline-flex min-h-[34px] min-w-[58px] items-center justify-center gap-1 rounded-card border border-border bg-button px-2 text-[10.5px] font-bold text-muted transition-[border-color,color,background-color] duration-[160ms] hover:border-grade-active hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-2 focus-visible:ring-offset-page",
} as const;

type TopBarProps = {
  themeMode: ThemeMode;
  viewTab: TopViewTab;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  onViewTabChange: (viewTab: TopViewTab) => void;
};

export type TopViewTab = "calc" | "stats";

type LanguageSelectorProps = {
  lang: (typeof LANG_OPTIONS)[number]["value"];
  langOpen: boolean;
  langRef: RefObject<HTMLDivElement | null>;
  onLangChange: (lang: (typeof LANG_OPTIONS)[number]["value"]) => void;
  onToggle: () => void;
};

function detectInitialLanguage(): (typeof LANG_OPTIONS)[number]["value"] {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "ko") return saved;
    const browserLanguages = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    const supported = browserLanguages.find((language) => language.toLowerCase().startsWith("ko"));
    if (supported) return "ko";
  } catch {
    return "ko";
  }
  return "ko";
}

function useDismissableMenu(
  open: boolean,
  ref: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", closeOnPointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open, ref]);
}

function LanguageSelector({
  lang,
  langOpen,
  langRef,
  onLangChange,
  onToggle,
}: LanguageSelectorProps) {
  return (
    <div className={classes.lang} ref={langRef}>
      <button
        className={classes.langButton}
        type="button"
        aria-expanded={langOpen}
        aria-haspopup="listbox"
        onClick={onToggle}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.4" />
          <ellipse cx="8" cy="8" rx="2.9" ry="6.4" />
          <path d="M1.9 8h12.2" />
        </svg>
        <span aria-hidden="true">▾</span>
        <span className={classes.langText}>언어 선택</span>
      </button>
      {langOpen ? (
        <div className={classes.langMenu} role="listbox" aria-label="언어 선택">
          {LANG_OPTIONS.map((option) => (
            <button
              className={`${classes.langOption} ${option.enabled ? "" : classes.langOptionDisabled}`}
              type="button"
              role="option"
              aria-selected={lang === option.value}
              aria-disabled={!option.enabled}
              disabled={!option.enabled}
              key={option.value}
              onClick={() => onLangChange(option.value)}
            >
              <span className={classes.langCheck} aria-hidden="true">
                {lang === option.value ? "✓" : ""}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThemeControl({
  controlStyle,
  themeOpen,
  themeRef,
  themeMode,
  onThemeModeChange,
  onToggle,
}: {
  controlStyle: CSSProperties;
  themeOpen: boolean;
  themeRef: RefObject<HTMLDivElement | null>;
  themeMode: ThemeMode;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  onToggle: () => void;
}) {
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and tests use this grouped control contract. */}
      <div className={classes.control} role="group" aria-label="테마 선택" style={controlStyle}>
        <div className={classes.options}>
          {THEME_MODES.map((mode) => (
            <button
              className={`${classes.button} ${themeMode === mode ? classes.activeButton : ""}`}
              type="button"
              data-theme-mode={mode}
              aria-pressed={themeMode === mode}
              key={mode}
              onClick={() => onThemeModeChange(mode)}
            >
              {THEME_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>
      <div className={classes.mobileTheme} ref={themeRef}>
        <button
          className={classes.themeButton}
          type="button"
          aria-label={`테마 선택: ${THEME_LABELS[themeMode]}`}
          aria-expanded={themeOpen}
          aria-haspopup="listbox"
          onClick={onToggle}
        >
          <span>{THEME_LABELS[themeMode]}</span>
          <span aria-hidden="true">▾</span>
        </button>
        {themeOpen ? (
          <div className={classes.langMenu} role="listbox" aria-label="테마 선택">
            {THEME_MODES.map((mode) => (
              <button
                className={classes.langOption}
                type="button"
                role="option"
                aria-selected={themeMode === mode}
                key={mode}
                onClick={() => onThemeModeChange(mode)}
              >
                <span className={classes.langCheck} aria-hidden="true">
                  {themeMode === mode ? "✓" : ""}
                </span>
                <span>{THEME_LABELS[mode]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

function ViewTabs({
  active,
  onChange,
}: {
  active: TopViewTab;
  onChange: (viewTab: TopViewTab) => void;
}) {
  const viewIndex = active === "stats" ? 1 : 0;
  const viewTabStyle = { "--seg-index": viewIndex } as CSSProperties;
  return (
    <div className={classes.viewTabs} role="tablist" aria-label="화면 전환" style={viewTabStyle}>
      <button
        className={`${classes.viewTab} ${active === "calc" ? classes.viewTabActive : ""}`}
        type="button"
        role="tab"
        aria-controls="calculatorWorkspace"
        aria-selected={active === "calc"}
        onClick={() => onChange("calc")}
      >
        계산기
      </button>
      <button
        className={`${classes.viewTab} ${active === "stats" ? classes.viewTabActive : ""}`}
        type="button"
        role="tab"
        aria-controls="globalStatsPanel"
        aria-selected={active === "stats"}
        onClick={() => onChange("stats")}
      >
        통계
      </button>
    </div>
  );
}

export default function TopBar({
  themeMode,
  viewTab,
  onThemeModeChange,
  onViewTabChange,
}: TopBarProps) {
  const [lang, setLang] = useState<(typeof LANG_OPTIONS)[number]["value"]>(detectInitialLanguage);
  const [langOpen, setLangOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const themeIndex = Math.max(0, THEME_MODES.indexOf(themeMode));
  const controlStyle = { "--seg-index": themeIndex } as CSSProperties;

  useDismissableMenu(langOpen, langRef, () => setLangOpen(false));
  useDismissableMenu(themeOpen, themeRef, () => setThemeOpen(false));
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const handleLangChange = (nextLang: (typeof LANG_OPTIONS)[number]["value"]) => {
    const option = LANG_OPTIONS.find((item) => item.value === nextLang);
    if (!option?.enabled) return;
    setLang(nextLang);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
      document.documentElement.lang = nextLang;
    } catch {
      document.documentElement.lang = nextLang;
    }
    setLangOpen(false);
  };
  const handleThemeChange = (nextThemeMode: ThemeMode) => {
    onThemeModeChange(nextThemeMode);
    setThemeOpen(false);
  };

  return (
    <header className={classes.root}>
      <div className={classes.titleWrap}>
        <h1 className={classes.title}>
          <span className={classes.titleText}>소장품 레벨업 계산기</span>
        </h1>
        <ViewTabs active={viewTab} onChange={onViewTabChange} />
      </div>
      <div className={classes.utilities}>
        <LanguageSelector
          lang={lang}
          langOpen={langOpen}
          langRef={langRef}
          onLangChange={handleLangChange}
          onToggle={() => setLangOpen((current) => !current)}
        />
        <ThemeControl
          controlStyle={controlStyle}
          themeOpen={themeOpen}
          themeRef={themeRef}
          themeMode={themeMode}
          onThemeModeChange={handleThemeChange}
          onToggle={() => setThemeOpen((current) => !current)}
        />
      </div>
    </header>
  );
}
