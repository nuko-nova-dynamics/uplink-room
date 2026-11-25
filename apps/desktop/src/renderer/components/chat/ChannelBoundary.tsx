import { Component, type ReactNode } from "react";
import { ConvexError } from "convex/values";
import { Empty } from "../Empty";

/**
 * A channel you lose while it is open (someone removed you from a private channel, ADR 0016)
 * answers not_found to every query in it. This shows that plainly instead of the window going
 * blank, and leaves any other error to the app. Once you're in it again (`inChannel`, from your
 * channel list), the channel comes back.
 */
export class ChannelBoundary extends Component<
  {
    children: ReactNode;
    onLeave: () => void;
    inChannel?: boolean | undefined;
    /** The channel's glyph and name, as last seen, for the title row once it's gone. */
    title?: ReactNode;
  },
  { gone: boolean; error: unknown }
> {
  override state = { gone: false, error: undefined as unknown };

  override componentDidUpdate(previous: { inChannel?: boolean | undefined }) {
    // Added back: someone in the channel put you in it again, so it shows as before.
    if (this.state.gone && this.props.inChannel === true && previous.inChannel !== true) {
      this.setState({ gone: false });
    }
  }

  static getDerivedStateFromError(error: unknown) {
    const code = error instanceof ConvexError && error.data && typeof error.data === "object" ? (error.data as { code?: string }).code : undefined;
    return code === "not_found" || /Not found in this team/.test(String((error as Error)?.message ?? "")) ? { gone: true, error: undefined } : { gone: false, error };
  }

  override render() {
    if (this.state.error !== undefined) throw this.state.error;
    if (this.state.gone) {
      // The title row stays, so the window's top line doesn't break; nothing in it is yours any more.
      return (
        <>
          <header className="main-head">
            <h1 className="truncate">{this.props.title ?? <span className="muted">Not available</span>}</h1>
          </header>
          <Empty
          action={
            <button className="btn" type="button" onClick={this.props.onLeave}>
              Open your Inbox
            </button>
          }
        >
          You aren't in this channel any more.
          </Empty>
        </>
      );
    }
    return this.props.children;
  }
}
