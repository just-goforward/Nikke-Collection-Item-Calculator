import type { Kit } from "../types";

export const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];

export const kitDotClass: Record<Kit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
};

export const INTERVAL_TOOLTIP_ID = "difficultyIntervalTooltip";

export const classes = {
  panel:
    "panel stats-panel col-span-full min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "section-heading flex cursor-pointer list-none items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] [&::-webkit-details-marker]:hidden max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  headingCollapsed: "!border-b-0",
  headingStatic: "cursor-default",
  panelEmpty: "empty-result px-[18px] py-[22px] font-medium text-muted",
  panelLoading:
    "stats-loading-state grid min-h-[128px] place-items-center px-[18px] py-[22px] text-muted max-mobile:min-h-[112px]",
  panelLoadingInner: "grid justify-items-center gap-3 text-center",
  panelLoadingSpinner:
    "stats-loading-spinner size-7 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary",
  panelLoadingText: "m-0 text-[13px] font-semibold leading-[1.4] text-text-soft",
  resultContent:
    "result-content stats-content grid gap-3.5 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  layout: "stats-layout grid gap-3",
  column: "stats-column grid min-w-0 content-start gap-3",
  section:
    "stats-section grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3.5 rounded-card border border-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-raised)_86%,var(--grade-active-soft)),var(--surface-strong))] p-[15px] max-mobile:gap-2.5 max-mobile:rounded-control max-mobile:p-3",
  sectionTitle:
    "stats-section-title flex min-w-0 flex-wrap items-center justify-between gap-x-2.5 gap-y-1 border-b-2 border-[var(--stats-divider)] pb-2",
  sectionHeading:
    "m-0 max-w-full flex-none text-[16px] font-bold leading-[1.25] text-text-strong [overflow-wrap:anywhere] max-mobile:text-[14px]",
  sectionMeta:
    "max-w-full flex-none whitespace-normal text-right text-[11px] font-medium leading-[1.3] text-muted [overflow-wrap:anywhere] max-mobile:text-[10.5px]",
  overallStack: "overall-stats-stack grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5",
  overallWindow:
    "overall-stats-window grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-card border border-border bg-surface-raised p-[11px] max-mobile:p-2.5",
  overallWindowHead:
    "overall-stats-window-head flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-[3px]",
  overallWindowTitle:
    "max-w-full flex-none text-[13px] font-semibold leading-[1.2] text-text-strong [overflow-wrap:anywhere]",
  overallWindowMeta:
    "max-w-full flex-none text-right text-[11px] font-medium leading-[1.35] text-muted [overflow-wrap:anywhere]",
  overallRateGrid: "overall-rate-grid grid min-w-0 grid-cols-[repeat(2,minmax(0,1fr))] gap-2",
  statsCard:
    "stats-vs-card min-w-0 rounded-card border border-border bg-surface-raised p-3 text-center max-mobile:p-2.5",
  statsCardLabel: "block text-[11px] font-medium leading-[1.2] text-muted",
  statsCardValue:
    "mt-2 block text-[clamp(24px,3.2vw,34px)] font-semibold leading-none max-mobile:mt-1 max-mobile:text-[clamp(20px,6.5vw,24px)]",
  neutralValue: "text-text-strong",
  actualValue: "text-grade-active-strong",
  empty: "stats-empty m-0 text-[12px] font-normal leading-[1.45] text-muted",
  note: "stats-note m-0 min-w-0 text-[11px] font-normal leading-[1.45] text-muted [overflow-wrap:anywhere] [word-break:keep-all]",
  difficultyList: "difficulty-list grid gap-0",
  difficultyRow:
    "difficulty-row flex min-w-0 flex-col gap-[7px] px-0.5 pb-3 pt-[15px] max-mobile:py-2.5 max-mobile:pb-3",
  difficultyRowBorder: "border-t border-border",
  difficultyHead: "difficulty-head flex min-w-0 items-center justify-between gap-2.5",
  difficultySegment:
    "difficulty-segment min-w-0 whitespace-nowrap text-[13px] font-semibold leading-[1.2] text-text-strong max-mobile:text-[12px]",
  difficultyTags: "difficulty-tags flex min-w-0 flex-wrap justify-end gap-[5px]",
  difficultyAttempts:
    "difficulty-attempts m-0 text-[11px] font-medium leading-[1.45] text-muted [overflow-wrap:break-word] [word-break:keep-all]",
  usageTrigger:
    "stats-usage-trigger inline-flex items-center text-[11px] font-medium leading-[1.45] text-muted cursor-help",
  difficultyComparison:
    "difficulty-comparison whitespace-nowrap rounded-pill border border-[color-mix(in_srgb,var(--line)_76%,var(--grade-active))] bg-[color-mix(in_srgb,var(--surface-raised)_82%,var(--grade-active-soft))] px-2 py-[3px] text-[11px] font-medium leading-none text-muted",
  rateBar:
    "difficulty-bar relative block h-[13px] w-full overflow-visible rounded-pill border-0 bg-progress-track p-0 text-left text-inherit [margin-block:14px_19px] [font:inherit] [user-select:none] cursor-default",
  kitRateBar:
    "kit-rate-bar relative block h-[13px] w-full overflow-visible rounded-pill border-0 bg-progress-track p-0 text-left text-inherit [margin-block:14px_19px] [font:inherit] [user-select:none] cursor-default",
  interval:
    "difficulty-interval absolute bottom-[-5px] top-[-5px] z-[3] cursor-help appearance-none rounded-pill border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--grade-active)_24%,transparent)]",
  observed:
    "difficulty-observed absolute top-0 z-[1] block h-full transition-[left,width] duration-[240ms] ease-[ease]",
  observedRight: "rounded-r-pill",
  observedLeft: "rounded-l-pill",
  observedDefault: "bg-[linear-gradient(90deg,var(--blue),var(--purple),var(--yellow))]",
  observedGood: "bg-[linear-gradient(90deg,#2fbf7e,#46d28f)]",
  observedBad: "bg-[linear-gradient(90deg,#ff8a65,#ef5350)]",
  observedNeutral: "bg-blue-kit",
  theoryMarker:
    "difficulty-theory absolute bottom-[-4px] top-[-4px] z-[2] w-0.5 -translate-x-px bg-muted",
  theoryMarkerLabel:
    "absolute bottom-[calc(100%+4px)] left-1/2 whitespace-nowrap text-[10px] font-medium leading-none text-muted -translate-x-1/2",
  theoryMarkerLabelLow: "left-0 translate-x-0",
  theoryMarkerLabelHigh: "left-auto right-0 translate-x-0",
  actualMarker: "difficulty-actual absolute top-[calc(100%+5px)] z-[2] w-0 -translate-x-1/2",
  actualMarkerLow: "translate-x-0",
  actualMarkerHigh: "!left-auto right-0 translate-x-0",
  actualMarkerLabel:
    "absolute left-1/2 whitespace-nowrap text-[12px] font-medium leading-none text-text-strong -translate-x-1/2",
  actualMarkerLabelLow: "left-0 translate-x-0",
  actualMarkerLabelHigh: "left-auto right-0 translate-x-0",
  tooltip:
    "difficulty-tooltip pointer-events-none invisible fixed left-0 top-0 z-[9999] grid w-max max-w-[min(380px,calc(100vw-44px))] gap-[7px] rounded-[10px] border border-[rgba(255,255,255,0.14)] bg-[rgba(22,28,38,0.88)] px-3 py-2.5 text-[#f8fcfe] opacity-0 shadow-[0_14px_32px_rgba(10,18,30,0.22)] transition-opacity duration-[160ms] [--tooltip-motion-y:4px] [--tooltip-offset-x:0px] [--tooltip-offset-y:0px] [transform:translate(var(--tooltip-offset-x),calc(var(--tooltip-offset-y)+var(--tooltip-motion-y)))]",
  tooltipVisible: "is-visible visible opacity-100 [--tooltip-motion-y:0px]",
  tooltipLeft: "side-left [--tooltip-offset-x:-100%]",
  tooltipTop: "side-top [--tooltip-offset-y:-100%]",
  tooltipMessage:
    "difficulty-tooltip-message grid max-w-[calc(100vw-40px)] gap-1.5 text-[12px] font-light leading-[1.65] text-[#f8fcfe] [inline-size:clamp(240px,42vw,360px)] [overflow-wrap:break-word] [text-wrap:pretty] [word-break:keep-all] whitespace-normal",
  tooltipMessageUsage:
    "difficulty-tooltip-message-usage w-max min-w-[170px] max-w-[calc(100vw-44px)] [inline-size:auto]",
  tooltipParagraph: "m-0",
  tooltipUsageList: "grid w-max min-w-full gap-1.5",
  tooltipUsageItem: "grid grid-cols-[1fr_auto] items-center gap-4 text-[12px] leading-none",
  tooltipUsageKit: "inline-flex items-center gap-1.5 text-[#f8fcfe]",
  tooltipUsageDot: "size-[9px] flex-none rounded-pill",
  tooltipUsageValue: "font-semibold text-[#f8fcfe]",
  kitRateList: "kit-rate-list grid gap-3",
  kitRateRow: "kit-rate-row grid min-w-0 gap-[7px]",
  kitRateRowBorder: "border-t border-border pt-3",
  kitRateHead: "kit-rate-head flex min-w-0 items-center justify-between gap-2.5",
  kitRateName:
    "kit-rate-name inline-flex min-w-0 items-center text-[13px] font-semibold leading-[1.2] text-text-strong [word-break:keep-all]",
  kitRateDot: "mr-[7px] size-[9px] flex-none rounded-pill",
  kitRateMeta:
    "kit-rate-meta m-0 text-[11px] font-medium leading-[1.45] text-muted [overflow-wrap:break-word] [word-break:keep-all]",
} as const;

export function joinClasses(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}
