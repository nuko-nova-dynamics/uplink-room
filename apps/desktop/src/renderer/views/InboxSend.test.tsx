// @vitest-environment happy-dom
/**
 * The Inbox's box sends with no dialog. With a Link (ADR 0049) the message goes to the direct
 * message with that agent, which decides whether it is work. Without one, it becomes a task and a
 * Claude Code thread starts on it in T3 Code, which then opens.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import type { MyTeam } from "../lib/api";
import { SessionProvider, ToastProvider } from "../lib/session";
import { FakeConvex } from "../gym/fakeConvex";
import type { Nav } from "../Shell";
import { Inbox } from "./Inbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

const team = {
  teamId: "team1",
  memberId: "m1",
  role: "admin",
  name: "Nuko Nova",
} as unknown as MyTeam;
const julio = { memberId: "m1", name: "Julio", kind: "person" as const, role: "admin" };
const grok = { memberId: "m9", name: "Grok Bot", kind: "agent" as const, role: "member" };
const link: {
  memberId: string;
  agentId: string;
  name: string;
  channelId: string;
  reach: string | null;
} = {
  memberId: "m9",
  agentId: "a9",
  name: "Grok Bot",
  channelId: "dm1",
  reach: "webhook",
};
const hopper = {
  machineId: "hopper",
  name: "hopper",
  belongsTo: { kind: "person", member: julio },
  online: true,
  tools: [],
  mostOpenAccess: "drive",
  slots: 2,
  slotsInUse: 0,
  sharingStopped: false,
  liveTerminals: 0,
  t3: { state: "connected" },
};

function mount(
  withLink: boolean | typeof link,
  more: {
    messages?: unknown[];
    runs?: Record<string, unknown>;
    peers?: unknown[];
    /** Your read point in the Link conversation (channels.list readSeq). */
    readSeq?: number;
    /** How many messages past it the room counts unread, replies in threads too (channels.list). */
    unread?: number;
    /** messages.post waits until the test settles it. */
    holdPosts?: boolean;
    /** members.setLink waits until the test resolves it. */
    holdLinkSaves?: boolean;
  } = {},
) {
  const calls: { path: string; args: Record<string, unknown> }[] = [];
  const reads: Record<string, unknown>[] = [];
  const linkSaves: (() => void)[] = [];
  const posts: { refuse: () => void }[] = [];
  const convex = new FakeConvex(
    (udfPath) =>
      ({
        "teams:members": [julio, grok],
        "inbox:get": { needsYou: [], working: [], done: [] },
        "projects:list": [],
        "machines:list": [hopper],
        "teams:roster": [
          {
            kind: "agent",
            memberId: "m9",
            agentId: "a9",
            name: "Grok Bot",
            reach: "webhook",
            takesYourWork: true,
          },
          {
            kind: "agent",
            memberId: "m8",
            agentId: "a8",
            name: "Duet",
            reach: "checks_in",
            takesYourWork: true,
          },
          // Takes work only from the teammate who added it: offered nowhere.
          {
            kind: "agent",
            memberId: "m7",
            agentId: "a7",
            name: "Icarus",
            reach: "a2a",
            takesYourWork: false,
          },
        ],
        "channels:list": [
          {
            channelId: "dm1",
            kind: "direct",
            readSeq: more.readSeq ?? 0,
            unread: more.unread ?? 0,
          },
        ],
        "members:link": withLink === true ? link : withLink || null,
        "messages:list": more.messages ?? [],
        "runs:get": Object.values(more.runs ?? {})[0],
        "a2a:list": more.peers ?? [],
        "tasks:board": [],
      })[udfPath],
    (udfPath, args) => {
      // Showing the conversation marks it read; that isn't a send.
      if (udfPath === "channels:markRead") {
        reads.push(args);
        return Promise.resolve(0);
      }
      calls.push({ path: udfPath, args });
      if (udfPath === "messages:post" && more.holdPosts)
        return new Promise((_resolve, reject) =>
          posts.push({ refuse: () => reject(new Error("The room refused it.")) }),
        );
      if (udfPath === "members:setLink" && more.holdLinkSaves)
        return new Promise((resolve) => linkSaves.push(() => resolve(null)));
      if (udfPath === "tasks:create") return Promise.resolve("task1");
      if (udfPath === "runs:start")
        return Promise.resolve({ runId: "run1", terminalId: undefined });
      return Promise.resolve("message1");
    },
    () => () => {},
  );
  const nav = { openThread: vi.fn(), openTask: vi.fn() } as unknown as Nav;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <Inbox
              nav={nav}
              groupByProject={false}
              setGroupByProject={() => {}}
              projectFilter="all"
              setProjectFilter={() => {}}
              frozen={false}
            />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  const send = async (text: string) => {
    const input = host.querySelector<HTMLTextAreaElement>(".inbox-ask")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        text,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Enter in the box sends, as a person does.
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
  };
  return { host, calls, nav, send, reads, linkSaves, posts };
}

test("with a Link, Enter sends the message to the direct message with it, and nothing else", async () => {
  const { host, calls, send } = mount(true);
  expect(host.querySelector<HTMLTextAreaElement>(".inbox-ask")!.placeholder).toBe(
    "Message Grok Bot",
  );
  await send("should we drop Safari 16?");
  expect(calls.map((c) => c.path)).toEqual(["messages:post"]);
  expect(calls[0]!.args).toMatchObject({
    channelId: "dm1",
    body: "should we drop Safari 16?",
    format: "markdown",
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("without a Link, Enter makes a task and starts a Claude Code thread on it, then opens it", async () => {
  const { calls, nav, send } = mount(false);
  await send("the checkout page crashes on Safari, can someone look");
  expect(calls.map((c) => c.path)).toEqual(["tasks:create", "runs:start"]);
  expect(calls[0]!.args).toMatchObject({
    title: "the checkout page crashes on Safari, can someone look",
  });
  expect(calls[1]!.args).toMatchObject({
    taskId: "task1",
    harness: "claude-code",
    machineId: "hopper",
    via: "thread",
    prompt: "the checkout page crashes on Safari, can someone look",
  });
  expect(nav.openThread).toHaveBeenCalledWith("run1");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

/** A message in the conversation with Grok Bot, as messages.list returns it. */
function said(n: number, author: typeof julio | typeof grok, body: string, more: object = {}) {
  return {
    messageId: `msg${n}`,
    channelId: "dm1",
    seq: n,
    author,
    format: "markdown",
    body,
    replyCount: 0,
    repliers: [],
    mentionedTasks: [],
    mentionedRuns: [],
    addressedRuns: [],
    a2aRuns: [],
    reactions: [],
    attachments: [],
    deliveries: [],
    postedAt: n,
    ...more,
  };
}

const status = (host: HTMLElement) =>
  [...host.querySelectorAll(".link-status")].map((line) => line.textContent);

test("a failed send to the Link's webhook says why under each message it failed on, even after a reply", () => {
  const failed = {
    to: grok,
    via: "webhook",
    status: "failed",
    reason: "The webhook answered HTTP 502.",
    at: 3,
  };
  const { host } = mount(true, {
    messages: [
      said(1, julio, "is the CSV export done?", { deliveries: [{ ...failed, at: 1 }] }),
      said(2, grok, "Almost."),
      said(3, julio, "and the Bayview feed?", { deliveries: [failed] }),
    ],
  });
  // A later reply doesn't mean the earlier message arrived.
  expect(status(host)).toEqual([
    "Sending to Grok Bot failed. The webhook answered HTTP 502.",
    "Sending to Grok Bot failed. The webhook answered HTTP 502.",
  ]);
  const under = [...host.querySelectorAll(".link-status")].map(
    (line) => line.closest(".link-msg")!.textContent,
  );
  expect(under[0]).toContain("is the CSV export done?");
  expect(under[1]).toContain("and the Bayview feed?");
});

test("a message waiting for a Link that checks in says it sees it when it next checks", () => {
  const { host } = mount(
    { ...link, reach: "checks_in" },
    {
      messages: [
        said(1, julio, "and the Bayview feed?", {
          deliveries: [{ to: grok, via: "check_in", status: "waiting", at: 1 }],
        }),
      ],
    },
  );
  expect(status(host)).toEqual([
    "Grok Bot checks in on its own schedule and sees this when it next checks.",
  ]);
});

test("a message the Link refused over A2A says so, from its run", () => {
  const run = {
    runId: "run7",
    harness: "a2a",
    state: "failed",
    failReason: "Unsupported operation.",
    a2a: {
      agent: { agentId: "a9", memberId: "m9", name: "Grok Bot" },
      delivery: "failed",
      messages: [
        { kind: "start", text: "hi", at: 1, status: "failed", error: "Unsupported operation." },
      ],
    },
  };
  const { host } = mount(
    { ...link, reach: "a2a" },
    {
      messages: [
        said(1, julio, "and the Bayview feed?", { a2aRuns: ["run7"], mentionedRuns: ["run7"] }),
      ],
      runs: { run7: run },
    },
  );
  expect(status(host)).toEqual(["Grok Bot didn't take this message: Unsupported operation."]);
  // The run it was sent to isn't a card under your own message.
  expect(host.querySelector(".link-run")).toBeNull();
});

test("with a Link the room can't reach, the box says so and Enter starts a thread instead", async () => {
  const { host, calls, nav, send } = mount(
    { ...link, reach: null },
    { messages: [said(1, julio, "and the Bayview feed?")] },
  );
  expect(host.querySelector(".composer-note")!.textContent).toBe(
    "The room can't reach Grok Bot, your Link, so messages start a thread until it can.",
  );
  expect(status(host)).toEqual(["The room can't reach Grok Bot, so it didn't get this."]);
  expect(host.querySelector<HTMLTextAreaElement>(".inbox-ask")!.placeholder).toBe(
    "Tell an agent what to do",
  );
  await send("check the Bayview feed");
  expect(calls.map((c) => c.path)).toEqual(["tasks:create", "runs:start"]);
  expect(nav.openThread).toHaveBeenCalledWith("run1");
});

test("a pasted message keeps its line breaks, and its first line is the task's title", async () => {
  const { calls, send } = mount(false);
  await send("Fix the Safari checkout crash\n1. Add ten items\n2. Apply a coupon");
  expect(calls[0]!.args).toMatchObject({
    title: "Fix the Safari checkout crash",
    description: "Fix the Safari checkout crash\n1. Add ten items\n2. Apply a coupon",
  });
  expect(calls[1]!.args).toMatchObject({
    prompt: "Fix the Safari checkout crash\n1. Add ten items\n2. Apply a coupon",
  });
});

test("an A2A answer names its own conversation run: no work card, and it still offers Make it a task", () => {
  const { host } = mount(
    { ...link, reach: "a2a" },
    {
      messages: [
        said(1, julio, "should we drop Safari 16?", { mentionedRuns: ["run7"], a2aRuns: ["run7"] }),
        said(2, grok, "About 3% of checkouts still use it.", {
          mentionedRuns: ["run7"],
          a2a: { runId: "run7" },
        }),
      ],
    },
  );
  expect(host.querySelector(".link-run")).toBeNull();
  expect(host.querySelector(".link-make-task")?.textContent).toBe("Make it a task");
});

test("while two Link changes save, the box stays shut until the last one is saved", async () => {
  const { host, linkSaves } = mount(true, { holdLinkSaves: true });
  // The Send to menu (UI SDK Menu) opens in the body, its choices menu items.
  const pick = async (label: string) => {
    act(() => host.querySelector<HTMLButtonElement>(".send-target-chip")!.click());
    await act(() => settle());
    const items = [...document.querySelectorAll<HTMLElement>('.send-target-menu [role^="menuitem"]')];
    act(() =>
      items
        .filter((b) => b.textContent?.includes(label))
        .at(-1)!
        .click(),
    );
  };
  const box = host.querySelector<HTMLTextAreaElement>(".inbox-ask")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hi");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sendButton = () => host.querySelector<HTMLButtonElement>(".composer-send")!;
  await pick("No Link");
  await pick("Duet");
  expect(sendButton().disabled).toBe(true);
  // The first save (clearing) finishes first: the second is still out, so the box stays shut.
  await act(async () => linkSaves[0]!());
  expect(sendButton().disabled).toBe(true);
  await act(async () => linkSaves[1]!());
  expect(sendButton().disabled).toBe(false);
});

test("Send to offers only agents that take your work", async () => {
  const { host } = mount(true);
  act(() => host.querySelector<HTMLButtonElement>(".send-target-chip")!.click());
  await act(() => settle());
  const menu = document.querySelector(".send-target-menu")!.textContent!;
  expect(menu).toContain("Duet");
  expect(menu).not.toContain("Icarus");
});

describe("reading the Link conversation in the Inbox", () => {
  const six = (from: number) =>
    Array.from({ length: 6 }, (_, i) =>
      said(from + i, i % 2 ? grok : julio, `message ${from + i}`),
    );
  const touch = (host: HTMLElement) =>
    act(() => {
      host
        .querySelector(".link-conversation")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

  test("opening the Inbox marks nothing read: you may not have looked", () => {
    const { reads } = mount(true, { messages: six(10), readSeq: 12, unread: 3 });
    expect(reads).toEqual([]);
  });

  test("a click in the conversation marks it read up to the newest when every unread message is shown", () => {
    const { host, reads } = mount(true, { messages: six(10), readSeq: 12, unread: 3 });
    touch(host);
    expect(reads).toEqual([expect.objectContaining({ channelId: "dm1", upTo: "msg15" })]);
  });

  test("a click leaves it unread when an unread reply in a thread isn't shown here", () => {
    // Three unread messages are listed (13 to 15); the room counts a fourth, a thread reply.
    const { host, reads } = mount(true, { messages: six(10), readSeq: 12, unread: 4 });
    touch(host);
    expect(reads).toEqual([]);
  });

  test("a deleted message still listed for its replies doesn't count toward what's shown", () => {
    // 13 was deleted (the room no longer counts it unread) but stays for its replies; one of them
    // is unread and not shown here. 14 and 15 are listed: two of the room's three unread.
    const messages = six(10).map((m) => (m.seq === 13 ? { ...m, deletedAt: 1 } : m));
    const { host, reads } = mount(true, { messages, readSeq: 12, unread: 3 });
    touch(host);
    expect(reads).toEqual([]);
  });

  test("a click leaves it unread when older unread messages aren't shown", () => {
    const { host, reads } = mount(true, { messages: six(10), readSeq: 2, unread: 13 });
    touch(host);
    expect(reads).toEqual([]);
  });

  test("what's done in a file's viewer over the conversation doesn't mark it read", () => {
    const { host, reads } = mount(true, { messages: six(10), readSeq: 12, unread: 3 });
    // The image and PDF viewers open as dialogs from inside the list.
    const viewer = document.createElement("div");
    viewer.setAttribute("role", "dialog");
    const close = document.createElement("button");
    viewer.append(close);
    host.querySelector(".link-conversation li")!.append(viewer);
    act(() => {
      close.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(reads).toEqual([]);
  });

  test("closing a PDF viewer by its backdrop doesn't mark the conversation read", () => {
    const { host, reads } = mount(true, { messages: six(10), readSeq: 12, unread: 3 });
    // The shared Dialog puts its backdrop (.overlay) outside the element with role="dialog".
    const backdrop = document.createElement("div");
    backdrop.className = "overlay";
    host.querySelector(".link-conversation li")!.append(backdrop);
    act(() => {
      backdrop.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(reads).toEqual([]);
  });

  test("a reply from the box leaves reading to the room, which counts it read when it posts", async () => {
    const { reads, send } = mount(true, { messages: six(10), readSeq: 2, unread: 13 });
    await send("thanks, go ahead");
    expect(reads).toEqual([]);
  });
});

test("a send the room refuses comes back ahead of the next message already being typed", async () => {
  const { host, send, posts } = mount(true, { holdPosts: true });
  await send("should we drop Safari 16?");
  const box = host.querySelector<HTMLTextAreaElement>(".inbox-ask")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "and Safari 15",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => posts[0]!.refuse());
  expect(box.value).toBe("should we drop Safari 16?\nand Safari 15");
});

test("a line the room wrote for the Link's run, such as a message it didn't send, shows in the conversation", () => {
  const { host } = mount(
    { ...link, reach: "a2a" },
    {
      messages: [
        said(1, julio, "and the Bayview feed?"),
        said(2, grok, "", {
          system: {
            kind: "run",
            runId: "run7",
            text: "Grok Bot has 5 messages waiting to go out, so this one wasn't sent. Send it again once it answers.",
            tone: "warn",
          },
        }),
      ],
    },
  );
  expect(host.querySelector(".link-msg.room")?.textContent).toBe(
    "Grok Bot has 5 messages waiting to go out, so this one wasn't sent. Send it again once it answers.",
  );
});
