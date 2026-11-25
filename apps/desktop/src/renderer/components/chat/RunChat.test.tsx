// @vitest-environment happy-dom
/**
 * Live runs in chat (ADR 0026, slice 3 of #139): a message a run posted shows as from the run with
 * its driver named as the one who answers for it, a run mention opens the run, and the run panel's
 * messages section shows its inbox, how it hears, and who may message it. The session is stood in for.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { MessageRow } from "../../lib/api";

vi.mock("../../lib/session", () => ({
  useSession: () => ({ me: { memberId: "mrosa" }, members: [], teamId: "team", isAdmin: false }),
  useAct: () => async () => null,
  useRoomQuery: () => undefined,
  useToast: () => ({ show: () => {} }),
}));

const { MessageItem } = await import("./MessageItem");
const { RunMessages } = await import("../RunMessages");
type RunInbox = import("../RunMessages").RunInbox;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(ui: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(ui));
  return host;
}

const nav = { go: vi.fn(), openTask: vi.fn(), openTerminal: vi.fn(), openSpace: vi.fn(), openThread: vi.fn(), openRun: vi.fn() };

function message(more: Partial<MessageRow>): MessageRow {
  return {
    messageId: "msg1",
    channelId: "c1",
    seq: 4,
    author: { kind: "person", memberId: "mana", name: "Ana Ruiz" },
    format: "markdown",
    body: "",
    replyCount: 0,
    repliers: [],
    mentionedTasks: [],
    mentionedRuns: [],
    addressedRuns: [],
    a2aRuns: [],
    mentionedAgents: [],
    mentionedMembers: [],
    mentionsEveryone: false,
    mentionsMe: false,
    reactions: [],
    attachments: [],
    previews: [],
    previewsHidden: false,
    postedAt: Date.now() - 60_000,
    ...more,
  } as unknown as MessageRow;
}

test("a message a run posted shows as from the run, its driver named as the one who answers for it, and its task", () => {
  const host = render(
    <MessageItem
      message={message({ body: "Released the model, it's yours.", asRun: { runId: "rcc00000001" as never, label: "Claude Code (Ana)" } })}
      nav={nav}
      members={[{ memberId: "rcc00000001", name: "Claude Code (Ana)", kind: "run", detail: "Takes messages only from Ana Ruiz", task: "Rig the harbor crane" }]}
      everyone
    />,
  );
  const head = host.querySelector(".msg-head")!;
  expect(head.querySelector("b")!.textContent).toBe("Claude Code (Ana)");
  expect(head.querySelector(".tag")!.textContent).toBe("Run, Ana Ruiz answers for it");
  expect(head.textContent).toContain("Rig the harbor crane");
  expect(head.textContent).not.toContain("Takes messages");
  // The run speaks: its face is the harness's mark, not Ana's.
  expect(host.querySelector(".msg > .mark")).not.toBeNull();
  act(() => (head.querySelector("b") as HTMLElement).click());
  expect(nav.openRun).toHaveBeenCalledWith({ runId: "rcc00000001" });
});

test("a run mention in a message names the run it was addressed to and opens it", () => {
  nav.openRun.mockClear();
  const host = render(
    <MessageItem
      message={message({ body: "<@run:rcc00000001> please release the model", addressedRuns: [{ runId: "rcc00000001" as never, label: "Claude Code (Ana)" }] })}
      nav={nav}
      members={[]}
      everyone
    />,
  );
  const mention = host.querySelector<HTMLButtonElement>('[data-mention="run"]')!;
  expect(mention.textContent).toBe("@Claude Code (Ana)");
  act(() => mention.click());
  expect(nav.openRun).toHaveBeenCalledWith({ runId: "rcc00000001" });
});

const julio = { kind: "person" as const, memberId: "mjulio", name: "Julio" };
const ana = { kind: "person" as const, memberId: "mana", name: "Ana Ruiz" };
const live = {
  runId: "rcc00000001",
  label: "Claude Code (Julio)",
  driver: julio,
  accountable: julio,
  hears: "anyone" as const,
  hearing: "unknown" as const,
  hearsYou: true,
  machine: { machineId: "mach1", name: "julio-mbp" },
};
const at = Date.now() - 5 * 60_000;

test("the run's driver reads its inbox, sees how it hears, and chooses who can message it", () => {
  const setHears = vi.fn();
  const message = vi.fn();
  const host = render(
    <RunMessages
      run={live}
      me="mjulio"
      inbox={{
        waiting: 1,
        messages: [
          { messageId: "m2", place: "#harbor", text: "Release the model, I'm taking over.", from: { member: ana }, accountable: ana, fromDriver: false, status: "waiting", at },
          {
            messageId: "m1",
            place: "a direct message",
            text: "Tests pass on my side.",
            from: { member: ana, run: { runId: "rcx", label: "Codex (Ana)" } },
            accountable: ana,
            fromDriver: false,
            status: "delivered",
            how: "mid_task",
            at: at - 60_000,
          },
        ],
      }}
      onSetHears={setHears}
      onMessage={message}
    />,
  );
  expect(host.textContent).toContain("Messages wait here until Uplink Room on julio-mbp can deliver them.");
  const group = host.querySelector('[role="group"][aria-label="Who can message this run"]')!;
  expect([...group.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
    ["Anyone", "true"],
    ["Only me", "false"],
  ]);
  act(() => group.querySelectorAll("button")[1]!.click());
  expect(setHears).toHaveBeenCalledWith("driver");
  const rows = [...host.querySelectorAll(".run-inbox li")];
  expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["Ana Ruiz", "Codex (Ana)"]);
  expect(rows[0]!.textContent).toContain("Release the model, I'm taking over.");
  expect(rows[0]!.textContent).toContain("Waiting");
  expect(rows[1]!.textContent).toContain("Ana Ruiz answers for it");
  expect(rows[1]!.textContent).toContain("Reached it mid-task");
});

test("a message that didn't reach the run says why", () => {
  const failed = (messageId: string, error: NonNullable<NonNullable<RunInbox["messages"]>[number]["error"]>) =>
    ({ messageId, place: "#harbor", text: "status?", from: { member: ana }, accountable: ana, fromDriver: false, status: "failed", error, at }) as const;
  const host = render(
    <RunMessages
      run={live}
      me="mjulio"
      inbox={{
        waiting: 0,
        messages: [
          failed("m1", "run_ended"),
          failed("m2", "driver_changed"),
          failed("m3", "unsure"),
          { ...failed("m4", "visible_outside"), place: "a thread in #launch" },
          { ...failed("m5", "visible_outside"), place: "a direct message" },
        ],
      }}
      onSetHears={vi.fn()}
      onMessage={vi.fn()}
    />,
  );
  const rows = [...host.querySelectorAll(".run-inbox li .hint")].map((hint) => hint.textContent);
  expect(rows).toEqual([
    "Didn't reach it: its terminal ended first.",
    "Didn't reach it: its driver changed to someone who can't see where this was posted.",
    "May not have reached it: its session took it twice without saying it arrived.",
    "Didn't reach it: this run is visible to people outside #launch, so it can't hear messages from there.",
    "Didn't reach it: this run is visible to people outside that direct message, so it can't hear messages from there.",
  ]);
});

test("a teammate sees how many messages wait, not what they say, and who may message the run", () => {
  const host = render(
    <RunMessages
      run={{ ...live, hears: "driver", hearing: "between_turns", hearsYou: false }}
      me="mrosa"
      inbox={{ waiting: 2, messages: undefined }}
      onSetHears={vi.fn()}
      onMessage={vi.fn()}
    />,
  );
  expect(host.textContent).toContain("Hears you between turns: a message reaches it when its turn ends.");
  expect(host.querySelector('[role="group"][aria-label="Who can message this run"]')).toBeNull();
  expect(host.textContent).toContain("Only Julio and their agents can message it.");
  expect(host.textContent).toContain("2 messages waiting. Only Julio reads what it's sent.");
  expect(host.querySelector(".run-inbox")).toBeNull();
  // It wouldn't get a message from you, so there's no button to send one.
  expect(host.textContent).not.toContain("Message this run");
});
