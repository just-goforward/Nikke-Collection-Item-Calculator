import { Component, type ErrorInfo, type ReactNode } from "react";

type LazySectionErrorBoundaryProps = {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
  name: string;
  onRetry: () => void;
};

type LazySectionErrorBoundaryState = {
  failed: boolean;
};

export class LazySectionErrorBoundary extends Component<
  LazySectionErrorBoundaryProps,
  LazySectionErrorBoundaryState
> {
  state: LazySectionErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazySectionErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} lazy section failed.`, error, info.componentStack);
  }

  private retry = () => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
