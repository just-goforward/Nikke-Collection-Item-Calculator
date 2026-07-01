import type { LoadingView } from "../ui-types";

type LoadingOverlayProps = {
  loading: LoadingView;
};

export default function LoadingOverlay({ loading }: LoadingOverlayProps) {
  if (!loading.active) return null;

  return (
    <div
      id="loadingOverlay"
      className="fixed inset-0 z-20 grid place-items-center bg-overlay p-6 backdrop-blur-[4px] max-[660px]:z-50"
      aria-busy="true"
      aria-live="polite"
      role="status"
    >
      <div className="grid min-w-[min(320px,100%)] justify-items-center gap-2.5 rounded-card border border-border bg-surface p-[22px] text-center shadow-panel">
        <div
          className="h-[34px] w-[34px] animate-spin rounded-full border-4 border-spinner-track border-t-grade-active"
          aria-hidden="true"
        ></div>
        <strong className="text-text-strong text-lg font-semibold">계산 중</strong>
        <span id="loadingText" className="text-muted text-[13px] font-medium">
          {loading.text}
        </span>
      </div>
    </div>
  );
}
