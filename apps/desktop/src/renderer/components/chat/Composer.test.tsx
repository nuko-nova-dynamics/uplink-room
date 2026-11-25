// @vitest-environment happy-dom
/**
 * The composer against a stand-in Convex client (gym/fakeConvex.ts): what a send carries, and what
 * it tells the channel once the room took it (Codex review of #111).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Id, MyTeam } from "../../lib/api";
import { SessionProvider, ToastProvider } from "../../lib/session";
import { FakeConvex } from "../../gym/fakeConvex";
import type { MentionMember } from "../../lib/chat";
import { Composer } from "./Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
});

const team = { teamId: "team1", memberId: "m1", role: "member", name: "Harbor Labs" } as unknown as MyTeam;
const members = [{ memberId: "m1", name: "Rosa", kind: "person" as const, role: "member" }];

/** A post the test answers by hand: resolve it (the room took it) or reject it (refused). */
type Pending = { args: Record<string, unknown>; resolve: (id: string) => void; reject: (error: Error) => void };

function mount(props: { replyTo?: string; onSent?: () => void; mentionable?: MentionMember[]; notes?: string[]; waiting?: boolean }) {
  const posts: Pending[] = [];
  const convex = new FakeConvex(
    (udfPath) => (udfPath === "teams:members" ? members : undefined),
    (udfPath, args) => {
      if (udfPath !== "messages:post") return Promise.resolve(null);
      return new Promise((resolve, reject) => posts.push({ args, resolve, reject }));
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
            <Composer
              channelId={"c1" as Id<"channels">}
              {...(props.replyTo ? { replyTo: props.replyTo as Id<"messages">, compact: true, alsoSendTo: "#general" } : {})}
              members={props.mentionable ?? members}
              everyone
              {...(props.onSent ? { onSent: props.onSent } : {})}
              {...(props.notes ? { notes: props.notes } : {})}
              {...(props.waiting !== undefined ? { waiting: props.waiting } : {})}
            />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  const box = host.querySelector("textarea")!;
  const send = async (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(box, text);
      box.setSelectionRange(text.length, text.length);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    // Sends go out in order, each after the one before it settled.
    await act(async () => {
      await Promise.resolve();
    });
  };
  const flush = () => act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return { host, posts, send, flush };
}

test("Also send to #channel goes with the reply it was ticked for, and resets as soon as that reply is sent", async () => {
  const { host, posts, send, flush } = mount({ replyTo: "parent1" });
  const box = () => host.querySelector<HTMLInputElement>(".also-send input")!;
  act(() => box().click());
  expect(box().checked).toBe(true);
  await send("Shipping it with the export");
  // Reset at once, before the room answered the first reply.
  expect(box().checked).toBe(false);
  await send("And one more thing");
  // The first post is still out; the second waits behind it.
  expect(posts).toHaveLength(1);
  expect(posts[0]!.args).toMatchObject({ replyTo: "parent1", alsoInChannel: true });
  posts[0]!.resolve("m1");
  await flush();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.args["alsoInChannel"]).toBeUndefined();
  posts[1]!.resolve("m2");
  await flush();
  expect(box().checked).toBe(false);
});

test("a refused reply puts Also send back with its text", async () => {
  const { host, posts, send, flush } = mount({ replyTo: "parent1" });
  const box = () => host.querySelector<HTMLInputElement>(".also-send input")!;
  act(() => box().click());
  await send("Shipping it");
  posts[0]!.reject(new Error("This channel is archived."));
  await flush();
  expect(host.querySelector("textarea")!.value).toBe("Shipping it");
  expect(box().checked).toBe(true);
});

test("onSent fires once the room took a message, from the channel's composer and a thread's, never for a refused one", async () => {
  for (const replyTo of [undefined, "parent1"]) {
    const sent = vi.fn();
    const { posts, send, flush } = mount({ ...(replyTo ? { replyTo } : {}), onSent: sent });
    await send("Checked, Bayview is in the note");
    expect(sent).not.toHaveBeenCalled();
    posts[0]!.resolve("m1");
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    await send("Refused one");
    posts[1]!.reject(new Error("This channel is archived."));
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    act(() => roots.pop()!.unmount());
  }
});

test("typing @ lists live runs with their task under the members, and a picked run is sent as <@run:id> in addressedRuns", async () => {
  const mentionable: MentionMember[] = [
    { memberId: "m1", name: "Rosa", kind: "person" },
    { memberId: "m2", name: "Claire Ruiz", kind: "person" },
    { memberId: "run0000001", name: "Claude Code (Ana)", kind: "run", detail: "Export tide tables" },
  ];
  const { host, posts, flush } = mount({ mentionable });
  const box = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, "@cl");
    box.setSelectionRange(3, 3);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const list = host.querySelector(".mention-list")!;
  expect([...list.querySelectorAll(".pop-title")].map((t) => t.textContent)).toEqual(["Members", "Live runs"]);
  const run = [...list.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.includes("Claude Code (Ana)"))!;
  expect(run.textContent).toContain("Export tide tables");
  act(() => {
    run.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  expect(box.value).toBe("@Claude Code (Ana) ");
  act(() => {
    setter.call(box, `${box.value}please release the model`);
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flush();
  expect(posts[0]!.args).toMatchObject({ body: "<@run:run0000001> please release the model", addressedRuns: ["run0000001"] });
  expect(posts[0]!.args["mentionedMembers"]).toBeUndefined();
});

test("a direct message with a team run keeps a standing note above the box, not a question on each send (ADR 0039)", () => {
  const warning = "Claude Code (Ana)'s output is visible to the whole team, so what you send here won't stay private.";
  const { host } = mount({ notes: [warning] });
  const note = host.querySelector(".composer-note")!;
  expect(note.textContent).toBe(warning);
  // It sits outside the box, so it stays while you write and after you send.
  expect(host.querySelector(".composer-box")!.contains(note)).toBe(false);
  expect(mount({}).host.querySelector(".composer-note")).toBeNull();
});

test("a reply composer opened before its place has loaded holds the send, so a direct message's warning shows first (ADR 0039)", async () => {
  // A reply deep link can load its thread before channels.list says whose output the place's runs are.
  const held = mount({ replyTo: "parent1", waiting: true });
  await held.send("the staging password is hunter2");
  expect(held.posts).toHaveLength(0);
  expect(held.host.querySelector("textarea")!.value).toBe("the staging password is hunter2");
  expect(held.host.querySelector<HTMLButtonElement>(".composer-send")!.disabled).toBe(true);
});

test("a send under a direct message's warning acknowledges it, so the room doesn't refuse it with warning_required (ADR 0039)", async () => {
  const warning = "Claude Code (Ana)'s output is visible to the whole team, so what you send here won't stay private.";
  const warned = mount({ replyTo: "parent1", notes: [warning] });
  await warned.send("the export is done");
  expect(warned.posts[0]!.args).toMatchObject({ replyTo: "parent1", acknowledgeWarning: true });
  const plain = mount({});
  await plain.send("the export is done");
  expect(plain.posts[0]!.args["acknowledgeWarning"]).toBeUndefined();
});
