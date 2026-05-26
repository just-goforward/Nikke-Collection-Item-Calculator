type SolvePanelProps = {
  description: string;
  calculateDisabled: boolean;
  onCalculate: () => void;
  onReset: () => void;
};

const classes = {
  panel:
    "min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] [transform:translateZ(0)] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  note: "mx-[18px] mb-3.5 mt-4 rounded-card border border-border bg-surface-strong px-3.5 py-[13px] text-text-soft text-[13px] font-normal leading-[1.45] [overflow-wrap:break-word] [word-break:keep-all] max-mobile:mx-3 max-mobile:mb-2 max-mobile:mt-3 max-mobile:px-3 max-mobile:py-[11px] max-mobile:text-[12.5px] max-mobile:leading-4",
  buttonRow: "grid grid-cols-[minmax(0,1fr)_86px] gap-2.5 px-[18px] pb-3.5 max-mobile:hidden",
  primaryButton:
    "min-h-[42px] bg-action text-ice tracking-[0.02em] shadow-[inset_0_0_0_1px_rgba(248,252,254,0.10),0_10px_22px_rgba(21,43,58,0.18)] transition-[filter,box-shadow,transform,background-color] duration-[140ms] enabled:hover:brightness-[1.08] enabled:hover:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.16),0_12px_26px_rgba(21,43,58,0.24)] enabled:active:translate-y-px enabled:active:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.12),0_4px_10px_rgba(21,43,58,0.18)] min-[661px]:max-desktop:min-h-[38px] min-[661px]:max-desktop:text-[13px] [body.theme-dark_&]:bg-[#ee7a87] [body.theme-dark_&]:text-[#2a0c12] [body.theme-dark_&]:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_10px_22px_rgba(0,0,0,0.45)] [body.theme-dark_&]:enabled:hover:bg-[#f48f99] [body.theme-dark_&]:enabled:hover:brightness-100 [body.theme-dark_&]:enabled:hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28),0_12px_26px_rgba(0,0,0,0.55)] [body.theme-dark_&]:enabled:active:bg-[#d6646f] [body.theme-dark_&]:enabled:active:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_4px_10px_rgba(0,0,0,0.4)]",
  secondaryButton:
    "min-h-[42px] border border-border bg-button text-text-soft min-[661px]:max-desktop:min-h-[38px] min-[661px]:max-desktop:text-[13px] enabled:hover:border-grade-active enabled:hover:text-grade-active-strong",
} as const;

export default function SolvePanel({
  description,
  calculateDisabled,
  onCalculate,
  onReset,
}: SolvePanelProps) {
  return (
    <section className={classes.panel}>
      <div className={classes.heading}>
        <h2>계산</h2>
      </div>

      <div id="strategyDescription" className={classes.note}>
        {description}
      </div>

      <div className={classes.buttonRow}>
        <button
          id="calculateButton"
          className={classes.primaryButton}
          type="button"
          disabled={calculateDisabled}
          onClick={onCalculate}
        >
          계산
        </button>
        <button
          id="resetButton"
          className={classes.secondaryButton}
          type="button"
          onClick={onReset}
        >
          초기화
        </button>
      </div>
    </section>
  );
}
