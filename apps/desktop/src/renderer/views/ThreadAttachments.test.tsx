// @vitest-environment happy-dom
/**
 * A thread's message box with files (ADR 0043), against a stand-in Convex client: a file picked,
 * pasted or dropped uploads at once with the channel composer's flow, Send waits for it, and the
 * message carries the upload. A teammate's suggestion box takes no files.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MyTeam } from "../lib/api";
import { SessionProvider, ToastProvider } from "../lib/session";
import { FakeConvex } from "../gym/fakeConvex";
import { ThreadFoot } from "./ThreadView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const team = { teamId: "team1", memberId: "m1", role: "member", name: "Harbor Labs" } as unknown as MyTeam;
const members = [{ memberId: "m1", name: "Julio", kind: "person" as const, role: "member" }];
const run = { runId: "run-1", state: "done", stateChangedAt: 0, harness: "codex", machine: { machineId: "mac", name: "julio-mbp" } };
const thread = (takesFiles = true) => ({ open: true, takesMessages: true, takesFiles, access: "watch", driver: { memberId: "m1", name: "Julio" } });

function mount({ isDriver = true, takesFiles = true } = {}) {
  const sent: Record<string, unknown>[] = [];
  let uploaded!: () => void;
  const upload = new Promise<void>((resolve) => (uploaded = resolve));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await upload;
      return new Response(JSON.stringify({ storageId: "storage-1" }), { status: 200 });
    }),
  );
  const convex = new FakeConvex(
    (udfPath) => (udfPath === "teams:members" ? members : undefined),
    async (udfPath, args) => {
      if (udfPath === "messages:attachUrl") return { uploadUrl: "https://room.example/upload", uploadId: "upload-1" };
      if (udfPath === "threads:send") {
        sent.push(args);
        return { messageId: "tm-1" };
      }
      return null;
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <ThreadFoot
              run={run as never}
              thread={thread(takesFiles) as never}
              harness="Codex"
              isDriver={isDriver}
              canAnswer={isDriver}
              machineOffline={false}
              now={0}
            />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  return { host, sent, uploaded };
}

const sendButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button[type=submit]")!;

test("a picked image uploads at once, Send waits for it, and the message carries it with or without text", async () => {
  const { host, sent, uploaded } = mount();
  const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
  expect(host.querySelector("button[aria-label='Attach images or files']")).not.toBeNull();
  const file = new File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(host.querySelector(".pending-file")?.textContent).toContain("Uploading");
  expect(sendButton(host).disabled).toBe(true);
  await act(async () => uploaded());
  await act(async () => {});
  expect(host.querySelector(".pending-file")?.textContent).toContain("screen.png");
  expect(sendButton(host).disabled).toBe(false);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(sent).toEqual([
    expect.objectContaining({ runId: "run-1", text: "", attachments: [{ uploadId: "upload-1", storageId: "storage-1", name: "screen.png" }] }),
  ]);
  // What went leaves the box.
  expect(host.querySelector(".pending-file")).toBeNull();
});

test("a pasted file is attached, and one the room would refuse is named with why before anything uploads", async () => {
  const { host } = mount();
  const box = host.querySelector("textarea")!;
  const paste = (files: File[]) => {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { files };
    return event;
  };
  await act(async () => box.dispatchEvent(paste([new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })])));
  expect(host.querySelector(".pending-error")?.textContent).toMatch(/SVG/);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  await act(async () => box.dispatchEvent(paste([new File(["log"], "build.log", { type: "text/plain" })])));
  expect(host.querySelector(".pending-file")?.textContent).toContain("build.log");
});

test("a teammate's suggestion box, and a bridge too old to send files, take none", () => {
  for (const props of [{ isDriver: false }, { takesFiles: false }]) {
    const { host } = mount(props);
    expect(host.querySelector("input[type=file]")).toBeNull();
    expect(host.querySelector("button[aria-label='Attach images or files']")).toBeNull();
  }
});
