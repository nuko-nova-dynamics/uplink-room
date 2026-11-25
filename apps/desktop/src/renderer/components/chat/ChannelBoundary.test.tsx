// @vitest-environment happy-dom
/** A channel you lose while it is open (ADR 0016) says so instead of blanking the window. */
import { act, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelBoundary } from "./ChannelBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Throws({ error }: { error: unknown }): never {
  throw error;
}

test("not_found from the channel's queries shows that you aren't in it any more, with a way out", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const leave = vi.fn();
  act(() =>
    root.render(
      <ChannelBoundary onLeave={leave}>
        <Throws error={new ConvexError({ code: "not_found", message: "Not found in this team." })} />
      </ChannelBoundary>,
    ),
  );
  expect(host.textContent).toContain("You aren't in this channel any more.");
  act(() => host.querySelector("button")!.click());
  expect(leave).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

test("any other error is left to the app", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host, { onUncaughtError: () => {} });
  const caught: unknown[] = [];
  act(() =>
    root.render(
      <CatchAll onError={(e) => caught.push(e)}>
        <ChannelBoundary onLeave={() => {}}>
          <Throws error={new Error("boom")} />
        </ChannelBoundary>
      </CatchAll>,
    ),
  );
  expect(caught).toMatchObject([{ message: "boom" }]);
  expect(host.textContent).not.toContain("You aren't in this channel");
  act(() => root.unmount());
});

/** Stands in for whatever handles the app's other errors. */
class CatchAll extends Component<{ children: ReactNode; onError: (error: unknown) => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

test("added back, the channel shows again instead of staying on the note (M4)", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const gone = new ConvexError({ code: "not_found", message: "Not found in this team." });
  act(() =>
    root.render(
      <ChannelBoundary onLeave={() => {}} inChannel={false}>
        <Throws error={gone} />
      </ChannelBoundary>,
    ),
  );
  expect(host.textContent).toContain("You aren't in this channel any more.");
  act(() =>
    root.render(
      <ChannelBoundary onLeave={() => {}} inChannel={true}>
        <p>Back in #launch</p>
      </ChannelBoundary>,
    ),
  );
  expect(host.textContent).toBe("Back in #launch");
  act(() => root.unmount());
});
