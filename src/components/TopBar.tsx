import type { CSSProperties, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { type AppLocale, useI18n } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages.ko";
import type { ThemeMode } from "../ui-types";

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
const THEME_MESSAGE_KEYS: Record<ThemeMode, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};
const LANG_OPTIONS = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
] as const;

const classes = {
  root: "mb-[18px] flex items-center justify-between gap-[18px] max-mobile:mb-[10px] max-mobile:gap-[10px]",
  titleWrap: "flex min-w-0 flex-1 items-center gap-4 max-mobile:block",
  title:
    "m-0 min-w-0 text-[42px] font-semibold leading-[1.08] [overflow-wrap:break-word] max-tablet:text-[30px] max-mobile:max-w-none max-mobile:text-[20px] max-mobile:leading-[1.18] max-mobile:tracking-[-0.01em] max-phone-xs:text-[18.5px]",
  titleText: "-mx-1 -my-0.5 block px-1 py-0.5 font-semibold text-inherit",
  viewTabs:
    "relative grid shrink-0 grid-cols-2 gap-0.5 self-center rounded-card border border-border bg-button p-0.5 [--seg-index:0] before:pointer-events-none before:absolute before:inset-y-0.5 before:left-0.5 before:z-0 before:w-[calc((100%_-_6px)/2)] before:rounded-control before:bg-[var(--seg-thumb)] before:shadow-[var(--seg-shadow)] before:[transform:translateX(calc(var(--seg-index)*(100%+2px)))] before:[transition:transform_220ms_cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:before:transition-none max-mobile:hidden",
  viewTab:
    "relative z-[1] grid min-h-[30px] place-items-center whitespace-nowrap rounded-control border-0 bg-transparent px-3.5 text-[12.5px] font-bold leading-none text-muted transition-colors duration-[220ms] ease-[ease] motion-reduce:transition-none [&[aria-selected=true]]:text-text-strong [&:not([aria-selected=true])]:hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-1 focus-visible:ring-offset-page",
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
  langCheck: "inline-block w-4 shrink-0 text-center text-[12px] leading-none",
  control:
    "inline-grid grid-cols-[auto] items-center gap-1 rounded-card border border-border bg-button p-0.5 [--seg-index:0] transition-[border-color,background-color] duration-[160ms] max-[684px]:hidden",
  options:
    "relative grid min-w-0 grid-cols-[repeat(3,minmax(42px,1fr))] gap-0.5 before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-0 before:w-[calc((100%_-_4px)/3)] before:rounded-control before:bg-[var(--seg-thumb)] before:shadow-[var(--seg-shadow)] before:[transform:translateX(calc(var(--seg-index)*(100%+2px)))] before:[transition:transform_220ms_cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:before:transition-none",
  button:
    "relative z-[1] grid min-h-[28px] place-items-center whitespace-nowrap bg-transparent px-2 text-[11px] font-semibold leading-none text-muted transition-colors duration-[220ms] ease-[ease] motion-reduce:transition-none [&[aria-pressed=true]]:text-text-strong [&:not([aria-pressed=true])]:hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
  opticalLabel: "topbar-optical-label relative top-px block leading-none",
  activeButton: "theme-option-active",
  mobileTheme: "relative hidden max-[684px]:block",
  themeButton:
    "inline-flex min-h-[34px] min-w-[58px] items-center justify-center gap-1 rounded-card border border-border bg-button px-2 text-[10.5px] font-bold text-muted transition-[border-color,color,background-color] duration-[160ms] hover:border-grade-active hover:text-text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-2 focus-visible:ring-offset-page",
  mobileThemeOpticalLabel:
    "mobile-theme-optical-label relative top-px inline-flex items-center gap-1 leading-none",
} as const;

type TopBarProps = {
  themeMode: ThemeMode;
  viewTab: TopViewTab;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  onViewTabChange: (viewTab: TopViewTab) => void;
};

export type TopViewTab = "calc" | "stats";

type LanguageSelectorProps = {
  lang: AppLocale;
  langOpen: boolean;
  langRef: RefObject<HTMLDivElement | null>;
  onLangChange: (lang: AppLocale) => void;
  onToggle: () => void;
};

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
  const { t } = useI18n();
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
        <span className={classes.langText}>{t("top.language")}</span>
      </button>
      {langOpen ? (
        <div className={classes.langMenu} role="listbox" aria-label={t("top.language")}>
          {LANG_OPTIONS.map((option) => (
            <button
              className={classes.langOption}
              type="button"
              role="option"
              aria-selected={lang === option.value}
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
  const { t } = useI18n();
  const themeLabel = (mode: ThemeMode) => t(THEME_MESSAGE_KEYS[mode]);
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and tests use this grouped control contract. */}
      <div
        className={classes.control}
        role="group"
        aria-label={t("top.theme")}
        style={controlStyle}
      >
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
              <span className={classes.opticalLabel}>{themeLabel(mode)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={classes.mobileTheme} ref={themeRef}>
        <button
          className={classes.themeButton}
          type="button"
          aria-label={`${t("top.theme")}: ${themeLabel(themeMode)}`}
          aria-expanded={themeOpen}
          aria-haspopup="listbox"
          onClick={onToggle}
        >
          <span className={classes.mobileThemeOpticalLabel}>
            <span>{themeLabel(themeMode)}</span>
            <span aria-hidden="true">▾</span>
          </span>
        </button>
        {themeOpen ? (
          <div className={classes.langMenu} role="listbox" aria-label={t("top.theme")}>
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
                <span>{themeLabel(mode)}</span>
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
  const { t } = useI18n();
  const viewIndex = active === "stats" ? 1 : 0;
  const viewTabStyle = { "--seg-index": viewIndex } as CSSProperties;
  return (
    <div
      className={classes.viewTabs}
      role="tablist"
      aria-label={t("common.viewSwitch")}
      style={viewTabStyle}
    >
      <button
        className={`${classes.viewTab} ${active === "calc" ? classes.viewTabActive : ""}`}
        type="button"
        role="tab"
        aria-controls="calculatorWorkspace"
        aria-selected={active === "calc"}
        onClick={() => onChange("calc")}
      >
        <span className={classes.opticalLabel}>{t("top.calculator")}</span>
      </button>
      <button
        className={`${classes.viewTab} ${active === "stats" ? classes.viewTabActive : ""}`}
        type="button"
        role="tab"
        aria-controls="globalStatsPanel"
        aria-selected={active === "stats"}
        onClick={() => onChange("stats")}
      >
        <span className={classes.opticalLabel}>{t("top.stats")}</span>
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
  const { locale, setLocale, t } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const themeIndex = Math.max(0, THEME_MODES.indexOf(themeMode));
  const controlStyle = { "--seg-index": themeIndex } as CSSProperties;

  useDismissableMenu(langOpen, langRef, () => setLangOpen(false));
  useDismissableMenu(themeOpen, themeRef, () => setThemeOpen(false));
  const handleLangChange = (nextLang: AppLocale) => {
    void setLocale(nextLang);
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
          <span className={classes.titleText}>{t("app.title")}</span>
        </h1>
        <ViewTabs active={viewTab} onChange={onViewTabChange} />
      </div>
      <div className={classes.utilities}>
        <LanguageSelector
          lang={locale}
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
