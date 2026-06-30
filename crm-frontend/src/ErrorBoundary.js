// File: src/ErrorBoundary.js
// Catches render-time errors in the subtree so one component crash shows a
// message instead of blanking the whole app (black screen).
import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught render error:", error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ maxWidth: 640, margin: "60px auto", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <h2 style={{ color: "#b91c1c", margin: "8px 0" }}>Something went wrong on this page</h2>
          <p style={{ color: "#444" }}>
            The page hit an error and couldn't finish loading. The rest of the app still works — try going back, or reload.
          </p>
          {this.state.error?.message ? (
            <pre style={{ textAlign: "left", background: "#f6f6f6", border: "1px solid #e2e2e2", borderRadius: 8, padding: 12, fontSize: 12, color: "#555", overflowX: "auto", whiteSpace: "pre-wrap" }}>
              {String(this.state.error.message)}
            </pre>
          ) : null}
          <div style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center" }}>
            <button type="button" onClick={() => window.history.back()} style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid #ccc", background: "#f1f1f1", cursor: "pointer" }}>Go Back</button>
            <button type="button" onClick={this.handleReload} style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: "#1b5e20", color: "#fff", cursor: "pointer" }}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
