import type { LoadingView } from "../ui-types";

type LoadingOverlayProps = {
  loading: LoadingView;
};

export default function LoadingOverlay({ loading }: LoadingOverlayProps) {
  return (
    <div id="loadingOverlay" className="loading-overlay" hidden={!loading.active}>
      <div className="loading-box">
        <div className="spinner" aria-hidden="true"></div>
        <strong>계산 중</strong>
        <span id="loadingText">{loading.text}</span>
      </div>
    </div>
  );
}
