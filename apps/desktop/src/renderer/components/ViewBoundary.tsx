import { Component, type ReactNode } from "react";
import { errorFields, log } from "../lib/log";
import { Empty } from "./Empty";

/**
 * Keeps an error in one view (a board, a terminal, Settings) to that view: the sidebar, the call
 * dock and the call itself go on (lib/call.tsx). Without it, React takes the whole window down,
 * and with it the call's controls. The error goes to the diagnostic log.
 */
export class ViewBoundary extends Component<
  { children: ReactNode; onLeave: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    log.error("view", "a view crashed", errorFields(error));
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Empty
        action={
          <button
            className="btn small view-boundary-action"
            type="button"
            onClick={this.props.onLeave}
          >
            Open your Inbox
          </button>
        }
      >
        This view hit an error. Your call and the rest of the app are still running.
      </Empty>
    );
  }
}
