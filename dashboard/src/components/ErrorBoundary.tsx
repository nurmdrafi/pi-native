import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  error: Error | null;
}

/** Contains a tab crash so one broken panel never blanks the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          <p className="font-medium text-destructive">
            {this.props.label} failed to render
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {this.state.error.message}
          </p>
          <button
            type="button"
            className="mt-3 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
            onClick={() => this.setState({ error: null })}
          >
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
