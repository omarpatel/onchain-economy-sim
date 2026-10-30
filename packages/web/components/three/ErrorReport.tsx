"use client";
import { Component, type ReactNode } from "react";

export class ErrorReport extends Component<{ children: ReactNode }, { err: string | null }> {
  state: { err: string | null } = { err: null };
  static getDerivedStateFromError(e: unknown): { err: string } {
    const any = e as { stack?: string; message?: string };
    return { err: (any?.stack || any?.message || String(e)).slice(0, 2000) };
  }
  render(): ReactNode {
    if (this.state.err) {
      return (
        <pre data-errbox style={{ color: "#ff6b6b", padding: 16, whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "monospace" }}>
          {this.state.err}
        </pre>
      );
    }
    return this.props.children;
  }
}
