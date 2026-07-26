import { Component, type ErrorInfo, type ReactNode } from "react";

import { useI18n } from "../i18n/locale";

type BoundaryProps = {
  children: ReactNode;
  detail: string;
  reloadLabel: string;
  title: string;
};

type BoundaryState = {
  failed: boolean;
};

class RenderErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Calculator render failed.", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="boot-error" role="alert">
        <h1>{this.props.title}</h1>
        <p>{this.props.detail}</p>
        <button type="button" onClick={() => window.location.reload()}>
          {this.props.reloadLabel}
        </button>
      </main>
    );
  }
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <RenderErrorBoundary
      detail={t("error.renderDetail")}
      reloadLabel={t("error.reload")}
      title={t("error.renderTitle")}
    >
      {children}
    </RenderErrorBoundary>
  );
}
