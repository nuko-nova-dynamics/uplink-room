// @vitest-environment happy-dom
/**
 * useSoftRoomQuery against a stand-in Convex client. `api.x.y` is a new reference on every render
 * (convex's anyApi), so a request keyed on it resubscribed every render and React stopped with
 * error 301; the task panel's run output crashed that way.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, expect, test } from "vitest";
import { api, type MyTeam } from "./api";
import { SessionProvider, useSoftRoomQuery } from "./session";
import { FakeConvex } from "../gym/fakeConvex";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const team = { teamId: "team1", memberId: "m1", role: "member", name: "Harbor Labs" } as unknown as MyTeam;
const members = [{ memberId: "m1", name: "Rosa", kind: "person", role: "member" }];
const terminal = { terminalId: "t1", title: "npm test" };

test("a soft query renders its result without resubscribing on every render", () => {
  const convex = new FakeConvex((udfPath, args) => {
    if (udfPath === "teams:members") return members;
    if (udfPath === "terminals:get" && args["terminalId"] === "t1") return terminal;
    return undefined;
  });
  let renders = 0;
  function Probe() {
    renders++;
    const value = useSoftRoomQuery(api.terminals.get, { terminalId: "t1" as never });
    return <span id="title">{(value as { title?: string } | undefined)?.title ?? "loading"}</span>;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <SessionProvider team={team}>
          <Probe />
        </SessionProvider>
      </ConvexProvider>,
    ),
  );
  expect(host.querySelector("#title")?.textContent).toBe("npm test");
  expect(renders).toBeLessThan(5);
});

test("a soft query that fails gives the value it was told to, so a bad link counts as gone (Codex review)", () => {
  const convex = new FakeConvex((udfPath) => {
    if (udfPath === "teams:members") return members;
    // As messages.get does for "not-a-message": its id validator refuses it.
    if (udfPath === "messages:get") throw new Error("ArgumentValidationError: Value does not match validator.");
    return undefined;
  });
  const seen: unknown[] = [];
  function Probe({ failed }: { failed: null | undefined }) {
    seen.push(useSoftRoomQuery(api.messages.get, { messageId: "not-a-message" as never }, failed));
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  const render = (failed: null | undefined) =>
    act(() =>
      root.render(
        <ConvexProvider client={convex as unknown as ConvexReactClient}>
          <SessionProvider team={team}>
            <Probe failed={failed} />
          </SessionProvider>
        </ConvexProvider>,
      ),
    );
  render(null);
  expect(seen.at(-1)).toBeNull();
  // Without one, a failure still reads as undefined, as before.
  render(undefined);
  expect(seen.at(-1)).toBeUndefined();
});
