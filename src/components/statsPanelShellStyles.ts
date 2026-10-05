export const classes = {
  panel:
    "panel stats-panel col-span-full min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "section-heading flex cursor-pointer list-none items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] [&::-webkit-details-marker]:hidden max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  headingStatic: "cursor-default",
  errorMessage: "grid justify-items-center gap-3 text-center [&_p]:m-0",
  retryButton:
    "inline-flex min-h-9 items-center justify-center rounded-control border border-border bg-button px-3.5 text-[12.5px] font-bold text-text-soft transition-[border-color,color,background-color] duration-160 hover:border-grade-active hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grade-active focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
  panelLoading:
    "stats-loading-state grid min-h-[128px] place-items-center px-[18px] py-[22px] text-muted max-mobile:min-h-[112px]",
  panelLoadingInner: "grid justify-items-center gap-3 text-center",
  panelLoadingSpinner:
    "stats-loading-spinner size-7 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary",
  panelLoadingText: "m-0 text-[13px] font-semibold leading-[1.4] text-text-soft",
} as const;
