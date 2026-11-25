// @vitest-environment happy-dom
/**
 * Pairs in the app (slice 12 of #139): a Pair's conversation, making a code, and joining with one.
 * The `pairs.*` functions take no team, so the views call Convex directly; here Convex answers from
 * the samples below and records what was sent.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toasts: [] as string[],
  sent: [] as { name: string; args: Record<string, unknown> }[],
  answers: {} as Record<string, unknown>,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const { useState } = await import("react");
  /** An answer, or what a function of the args gives; an Error is a query that failed. */
  const answerFor = (name: string, args: unknown) => {
    const answer = mocks.answers[name];
    return typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer;
  };
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : answerFor(getFunctionName(ref), args)),
    useQueries: (requests: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(Object.entries(requests).map(([key, { query, args }]) => [key, answerFor(getFunctionName(query), args)])),
    // A paged query's answer is every item, newest first; pages of it load as Convex's would.
    usePaginatedQuery: (ref: never, args: unknown, opts: { initialNumItems: number }) => {
      const [loaded, setLoaded] = useState(opts.initialNumItems);
      const all = args === "skip" ? undefined : (answerFor(getFunctionName(ref), args) as unknown[] | undefined);
      if (!all) return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} };
      return {
        results: all.slice(0, loaded),
        status: loaded >= all.length ? "Exhausted" : "CanLoadMore",
        isLoading: false,
        loadMore: (n: number) => setLoaded((was) => was + n),
      };
    },
    useMutation: (ref: never) => async (args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      mocks.sent.push({ name, args });
      const answer = mocks.answers[name];
      return typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer;
    },
  };
});
vi.mock("../lib/session", () => ({ useToast: () => ({ show: (text: string) => mocks.toasts.push(text) }) }));
vi.mock("../lib/desktop", () => ({ desktop: {} }));

const { PairConversation, PairStart, PairCodePop, PairsNav, usePairs } = await import("./Pairs");
const { Popover } = await import("@ui-sdk/react/popover");
void getFunctionName;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAIR = {
  pairId: "pair1",
  createdAt: Date.UTC(2026, 10, 5, 9),
  seq: 2,
  unread: 0,
  people: [
    { id: "pp-rosa", name: "Rosa Vega", you: true },
    { id: "pp-pepe", name: "Pepe Ortiz" },
  ],
  runs: [
    { id: "pr-1", label: "Claude Code (Pepe Ortiz)", harness: "claude-code", person: "pp-pepe" },
    { id: "pr-2", label: "Codex (Rosa Vega)", harness: "codex", person: "pp-rosa" },
  ],
  agents: [],
};

const MESSAGES = {
  pairId: "pair1",
  seq: 2,
  messages: [
    {
      messageId: "m1",
      seq: 1,
      body: "Which schema are you on?",
      at: Date.UTC(2026, 10, 5, 9, 1),
      from: { kind: "run", id: "pr-1", name: "Claude Code (Pepe Ortiz)", person: { id: "pp-pepe", name: "Pepe Ortiz" } },
    },
    {
      messageId: "m2",
      seq: 2,
      body: "The v2 one, from main.",
      at: Date.UTC(2026, 10, 5, 9, 2),
      from: { kind: "person", id: "pp-rosa", name: "Rosa Vega", person: { id: "pp-rosa", name: "Rosa Vega" } },
    },
  ],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.toasts.length = 0;
  mocks.sent.length = 0;
  mocks.answers = { "pairs:messagesPage": [...MESSAGES.messages].reverse(), "pairs:get": PAIR };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const click = async (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`No button "${label}"`);
  await act(async () => found.click());
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("a live Pair names who it's with, shows its live runs, puts your own messages on the right and sends what you write", async () => {
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  expect(document.querySelector(".main-head h1")?.textContent).toBe("Pair with Pepe Ortiz");
  expect(document.querySelector(".head-presence")?.textContent).toBe("2 runs live");
  expect(document.querySelector(".pair-live-runs")?.textContent).toContain("Claude Code (Pepe Ortiz)");
  expect(document.querySelector(".pair-live-runs")?.textContent).toContain("Codex (Rosa Vega)");

  const [first, second] = [...document.querySelectorAll(".messages-inner .msg")];
  // A run names itself and who answers for it, on the left; your own message is on the right.
  expect(first!.classList.contains("right")).toBe(false);
  expect(first!.querySelector(".msg-head")?.textContent).toContain("Claude Code (Pepe Ortiz)");
  expect(first!.querySelector(".tag")?.textContent).toBe("Run, Pepe Ortiz answers for it");
  expect(second!.classList.contains("right")).toBe(true);

  const box = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message the Pair']")!;
  await type(box, "Sounds good");
  await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(mocks.sent).toContainEqual({ name: "pairs:post", args: { pairId: "pair1", text: "Sounds good" } });
});

test("an image picked in a Pair uploads to an address for that Pair and goes with the message, which may have no text (ADR 0048)", async () => {
  mocks.answers["pairs:attachUrl"] = { uploadUrl: "https://room.example/upload", uploadId: "pu-1", pairId: "pair1" };
  mocks.answers["pairs:post"] = { messageId: "m3", seq: 3, pairId: "pair1" };
  const upload = vi.fn(async () => new Response(JSON.stringify({ storageId: "st-1" }), { status: 200 }));
  vi.stubGlobal("fetch", upload);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:thumb", revokeObjectURL: () => {} }));
  try {
    await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
    const send = document.querySelector<HTMLButtonElement>("button[aria-label='Send']")!;
    expect(send.disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>("input[type='file']")!;
    const image = new File(["png bytes"], "crash.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [image], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => {});

    expect(mocks.sent).toContainEqual({ name: "pairs:attachUrl", args: { pairId: "pair1" } });
    expect(upload).toHaveBeenCalledWith("https://room.example/upload", expect.objectContaining({ method: "POST", headers: { "Content-Type": "image/png" } }));
    expect(document.querySelector(".pending-file.ready")?.textContent).toContain("crash.png");
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(mocks.sent).toContainEqual({
      name: "pairs:post",
      args: { pairId: "pair1", text: "", attachments: [{ uploadId: "pu-1", storageId: "st-1", name: "crash.png" }] },
    });
    expect(document.querySelector(".pending-file")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a Pair message's image shows through a short-lived link the room gives for it", async () => {
  mocks.answers["pairs:messagesPage"] = [
    {
      messageId: "m3",
      seq: 3,
      body: "",
      at: Date.UTC(2026, 10, 5, 9, 3),
      from: { kind: "run", id: "pr-1", name: "Claude Code (Pepe Ortiz)", person: { id: "pp-pepe", name: "Pepe Ortiz" } },
      attachments: [{ index: 0, name: "crash.png", kind: "image", contentType: "image/png", size: 9, restricted: true, url: null, downloadUrl: null }],
    },
    ...[...MESSAGES.messages].reverse(),
  ];
  mocks.answers["pairs:attachmentLink"] = { url: "https://room.example/attachments/pair/t/crash.png", expiresAt: Date.now() + 600_000, pairId: "pair1" };
  // With no IntersectionObserver, an image asks for its link at once instead of once it's on screen.
  vi.stubGlobal("IntersectionObserver", undefined);
  try {
    await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
    await act(async () => {});
    const last = [...document.querySelectorAll(".messages-inner .msg")].at(-1)!;
    // No text, so no empty bubble: just the image.
    expect(last.querySelector(".bubble")).toBeNull();
    expect(mocks.sent).toContainEqual({ name: "pairs:attachmentLink", args: { messageId: "m3", attachmentIndex: 0, download: false } });
    expect(last.querySelector("img")?.getAttribute("src")).toBe("https://room.example/attachments/pair/t/crash.png");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("an ended Pair can still be read, says it ended in place of the message box, and makes no codes", async () => {
  mocks.answers["pairs:get"] = { ...PAIR, runs: [], endedAt: Date.UTC(2026, 10, 5, 10), endReason: "ended" };
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  expect(document.querySelectorAll(".messages-inner .msg")).toHaveLength(2);
  expect(document.querySelector(".pair-ended")?.textContent).toBe("This Pair has ended. You can still read it.");
  expect(document.querySelector("textarea")).toBeNull();
  expect(button("Make a code")).toBeUndefined();
});

test("leaving asks once more, then leaves and says so to the page", async () => {
  const onLeft = vi.fn();
  mocks.answers["pairs:leave"] = null;
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={onLeft} />));
  await act(async () => document.querySelector<HTMLButtonElement>(".members-btn")!.click());
  expect(document.querySelector(".pair-people")?.textContent).toContain("Live runs");
  await click("Leave this Pair");
  expect(document.querySelector(".leave-confirm")?.textContent).toContain("You can't read it after");
  await click("Leave");
  expect(mocks.sent).toContainEqual({ name: "pairs:leave", args: { pairId: "pair1" } });
  expect(onLeft).toHaveBeenCalled();
});

test("a fresh code shows once with its time left and a Copy button", async () => {
  mocks.answers["pairs:code"] = { code: "RIVER-4821-MAPLE-0937", pairId: "pair1", expiresAt: Date.now() + 10 * 60_000 };
  // The code is a popover's content: the conversation holds the popover and its trigger.
  await act(async () => root.render(<Popover defaultOpen><PairCodePop pairId="pair1" /></Popover>));
  expect(mocks.sent.filter((s) => s.name === "pairs:code")).toHaveLength(1);
  expect(document.querySelector(".pair-code")?.textContent).toBe("RIVER-4821-MAPLE-0937");
  expect(document.querySelector(".pair-code-pop")?.textContent).toMatch(/It works once, for the next (10:00|9:5\d)\./);
  expect(document.querySelector(".pair-code-pop")?.textContent).toContain("uplink pair RIVER-4821-MAPLE-0937");
  expect(document.querySelector("button[aria-label=Copy]")).not.toBeNull();
});

test("a refused code reads plainly under the box, and a good one opens its Pair", async () => {
  const opened = vi.fn();
  mocks.answers["pairs:join"] = ({ code }: { code: string }) =>
    code === "RIVER-4821-MAPLE-0937" ? PAIR : { refused: { code: "not_found", message: "That pair code is wrong, was used already, or is more than 10 minutes old." } };
  await act(async () => root.render(<PairStart anchor={new DOMRect(0, 0, 20, 20)} onClose={() => {}} onOpened={opened} />));
  await click("Join with a code");
  const input = document.querySelector<HTMLInputElement>("#pair-code-input")!;
  await type(input, "river 0000 maple 0000");
  await act(async () => input.form!.requestSubmit());
  expect(mocks.sent.at(-1)).toEqual({ name: "pairs:join", args: { code: "RIVER-0000-MAPLE-0000" } });
  // The field's error (UI SDK FieldError) describes the box and is announced.
  const error = () => document.querySelector('[data-slot="field-error"]');
  expect(error()?.textContent).toBe(
    "That code didn't work. It may be mistyped, used already, or more than 10 minutes old. Ask for a new one.",
  );
  expect(input.getAttribute("aria-describedby")).toBe(error()?.id);
  expect(opened).not.toHaveBeenCalled();

  await type(input, "river-4821-maple-0937");
  expect(error()).toBeNull();
  await act(async () => input.form!.requestSubmit());
  expect(opened).toHaveBeenCalledWith("pair1", { code: false });
});

test("New Pair makes one and opens it with its first code showing", async () => {
  const opened = vi.fn();
  mocks.answers["pairs:create"] = { ...PAIR, pairId: "pair2", people: [PAIR.people[0]], runs: [] };
  await act(async () => root.render(<PairStart anchor={new DOMRect(0, 0, 20, 20)} onClose={() => {}} onOpened={opened} />));
  await click("New Pair");
  expect(opened).toHaveBeenCalledWith("pair2", { code: true });
});

test("a run's label names its harness, so a run that left still shows its mark", async () => {
  const { harnessOfLabel } = await import("./Pairs");
  expect(harnessOfLabel("Claude Code (Pepe Ortiz)")).toBe("Claude Code");
  expect(harnessOfLabel("Claude Code 2 (Pepe Ortiz)")).toBe("Claude Code");
  expect(harnessOfLabel("Codex (Rosa Vega)")).toBe("Codex");
});

test("a Pair opens on its own, however far down your Pairs it is, and says so once you aren't in it", async () => {
  // pairs.list has never reached it: it is read with pairs.get.
  mocks.answers["pairs:get"] = ({ pairId }: { pairId: string }) => (pairId === "pair1" ? PAIR : new Error("No such Pair, or you aren't in it."));
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  expect(document.querySelector(".main-head h1")?.textContent).toBe("Pair with Pepe Ortiz");
  await act(async () => root.render(<PairConversation key="gone" pairId="pair-gone" onLeft={() => {}} />));
  expect(document.querySelector(".pair-gone")?.textContent).toBe("You aren't in this Pair any more.");
});

test("the sidebar pages through every Pair, latest activity first", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...PAIR, pairId: `pair-${i}`, createdAt: i, people: [PAIR.people[0], { id: `pp-${i}`, name: `Person ${i}` }] }));
  // Joined last first, as the room pages them; the oldest of them has the latest message.
  mocks.answers["pairs:listPage"] = [...many].reverse().map((p) => (p.pairId === "pair-0" ? { ...p, lastMessageAt: 1000 } : p));
  function Sidebar() {
    const { pairs, more } = usePairs();
    return <PairsNav pairs={pairs} more={more} currentPairId={undefined} onOpen={() => {}} onStart={() => {}} />;
  }
  await act(async () => root.render(<Sidebar />));
  expect(document.querySelectorAll(".pair-item")).toHaveLength(50);
  expect(document.querySelector(".pair-item .label-text")?.textContent).toBe("Person 59");
  await click("More Pairs");
  expect(document.querySelectorAll(".pair-item")).toHaveLength(60);
  expect(document.querySelector(".pair-item .label-text")?.textContent).toBe("Person 0");
  expect(button("More Pairs")).toBeUndefined();
});

/** `count` messages from Pepe's run, newest first, as pairs.messagesPage pages them. */
function manyMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...MESSAGES.messages[0],
    messageId: `m${count - i}`,
    seq: count - i,
    body: `message ${count - i}`,
    at: Date.UTC(2026, 10, 5, 9) + (count - i) * 60_000,
  }));
}
const shownSeqs = () => [...document.querySelectorAll<HTMLElement>(".messages-inner .msg")].map((m) => Number(m.dataset["seq"]));

test("a long Pair loads older messages back to its first, and opens on its newest", async () => {
  mocks.answers["pairs:get"] = { ...PAIR, seq: 120 };
  mocks.answers["pairs:messagesPage"] = manyMessages(120);
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  expect(shownSeqs()).toHaveLength(50);
  expect(shownSeqs().at(-1)).toBe(120);
  // Its start shows only once the first message is loaded.
  expect(document.querySelector(".pair-start-hero")).toBeNull();
  await click("Show older messages");
  await click("Show older messages");
  expect(shownSeqs()).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  expect(document.querySelector(".pair-start-hero")).not.toBeNull();
  expect(button("Show older messages")).toBeUndefined();
});

test("opening a Pair marks read only through the messages it loaded, not older unread ones it didn't", async () => {
  // 30 unread of 120: the first page reaches back past them, so all are read.
  mocks.answers["pairs:get"] = { ...PAIR, seq: 120, unread: 30 };
  mocks.answers["pairs:messagesPage"] = manyMessages(120);
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  expect(mocks.sent.filter((x) => x.name === "pairs:markRead")).toEqual([{ name: "pairs:markRead", args: { pairId: "pair1", seq: 120 } }]);
  act(() => root.unmount());
  root = createRoot(host);
  mocks.sent.length = 0;

  // 500 unread: older pages load to reach them, up to 400 messages; past that nothing is marked
  // read until you load the rest.
  mocks.answers["pairs:get"] = { ...PAIR, seq: 500, unread: 500 };
  mocks.answers["pairs:messagesPage"] = manyMessages(500);
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  expect(shownSeqs()).toHaveLength(400);
  expect(document.querySelector(".unread-above")?.textContent).toContain("Unread messages go on above.");
  expect(mocks.sent.filter((x) => x.name === "pairs:markRead")).toEqual([]);
  await click("Load them");
  await click("Load them");
  expect(shownSeqs()[0]).toBe(1);
  expect(mocks.sent.filter((x) => x.name === "pairs:markRead")).toEqual([{ name: "pairs:markRead", args: { pairId: "pair1", seq: 500 } }]);
});

test("sending clears only what was sent: what you typed while it was on its way stays", async () => {
  let deliver: (value: unknown) => void = () => {};
  mocks.answers["pairs:post"] = () => new Promise((resolve) => (deliver = resolve));
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  const box = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message the Pair']")!;
  await type(box, "Which schema?");
  await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await type(box, "Which schema? Also, which branch");
  await act(async () => deliver({ messageId: "m3", seq: 3, pairId: "pair1" }));
  expect(box.value).toBe("Also, which branch");
});

test("a message a run's full inbox didn't take names that run under the box, until the next one is sent", async () => {
  mocks.answers["pairs:post"] = ({ text }: { text: string }) =>
    text === "first" ? { messageId: "m3", seq: 3, pairId: "pair1", notDelivered: ["Claude Code (Pepe Ortiz)", "Codex (Rosa Vega)"] } : { messageId: "m4", seq: 4, pairId: "pair1" };
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  const box = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message the Pair']")!;
  await type(box, "first");
  await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(document.querySelector(".pair-not-delivered")?.textContent).toBe(
    "Claude Code (Pepe Ortiz) and Codex (Rosa Vega) didn't get it: their inboxes are full. It's still in the Pair.",
  );
  await type(box, "second");
  await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(document.querySelector(".pair-not-delivered")).toBeNull();
});

test("Make a code closes its open popover instead of making another code", async () => {
  mocks.answers["pairs:code"] = { code: "RIVER-4821-MAPLE-0937", pairId: "pair1", expiresAt: Date.now() + 10 * 60_000 };
  await act(async () => root.render(<PairConversation pairId="pair1" onLeft={() => {}} />));
  const make = button("Make a code")!;
  // A real click: the press, then the click.
  const press = async () => {
    await act(async () => make.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await act(async () => make.click());
  };
  await press();
  expect(document.querySelector(".pair-code")?.textContent).toBe("RIVER-4821-MAPLE-0937");
  await press();
  expect(document.querySelector(".pair-code-pop")).toBeNull();
  expect(mocks.sent.filter((s) => s.name === "pairs:code")).toHaveLength(1);
});
