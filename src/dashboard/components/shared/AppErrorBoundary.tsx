import React, { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppErrorBoundary]", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="p-6 text-sm">
        <div className="font-mono text-destructive mb-2">Dashboard crashed</div>
        <div className="mb-3 font-mono text-xs">{this.state.error.message}</div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs"
        >
          Try again
        </button>
      </div>
    );
  }
}
