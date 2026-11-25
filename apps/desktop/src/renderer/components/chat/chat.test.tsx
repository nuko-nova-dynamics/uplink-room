// @vitest-environment happy-dom
/**
 * Chat's components (spec #63), rendered into happy-dom with React itself: the composer's mention
 * autocomplete, editing a message, reaction chips, the "new" divider and how mentions render.
 */
import { act, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { dividerBefore, type MentionPick } from "../../lib/chat";
import { latchEnter } from "../../lib/enterKey";
import { useFollowNew, useOpenPlace } from "../../lib/positionOnce";
import { fileDrop } from "./Composer";
import { decorate, markMentions, renderMarkdown } from "../MessageBody";
import { InlineEditor, NewDivider } from "./InlineEditor";
import { MentionInput } from "./MentionInput";
import { placeNear } from "./NewDirectMessage";
import {
  EmojiPicker,
  pickerPlace,
  quickReactions,
  ReactionChips,
  rememberEmoji,
} from "./Reactions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  // Let go of any Enter a test pressed (lib/enterKey keeps whether it's down).
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
});

function render(ui: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(ui));
  return host;
}

/** Types into a React-controlled textarea, caret at the end. */
function type(box: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, text);
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(el: Element, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

const members = [
  { memberId: "mjulio00001", name: "Julio", kind: "person" as const },
  { memberId: "mana0000001", name: "Ana", kind: "person" as const },
  { memberId: "manalopez01", name: "Ana Lopez", kind: "person" as const },
  { memberId: "mhermes0001", name: "Hermes", kind: "agent" as const },
];

function Composer({
  everyone = true,
  onSubmit,
  people = members,
  onPicks,
  enterSends = false,
  onArrowUpEmpty,
}: {
  everyone?: boolean;
  onSubmit?: (text: string) => void;
  people?: typeof members;
  onPicks?: (picks: MentionPick[]) => void;
  enterSends?: boolean;
  onArrowUpEmpty?: () => void;
}) {
  const [text, setText] = useState("");
  const [picks, setPicks] = useState<MentionPick[]>([]);
  return (
    <MentionInput
      value={text}
      onChange={setText}
      picks={picks}
      onPicks={(next) => {
        setPicks(next);
        onPicks?.(next);
      }}
      members={people}
      everyone={everyone}
      me="mjulio00001"
      label="Message"
      enterSends={enterSends}
      onArrowUpEmpty={onArrowUpEmpty}
      onSubmit={() => onSubmit?.(text)}
    />
  );
}

test("typing @ lists teammates, agents and @everyone; arrows and Enter pick one", async () => {
  const host = render(<Composer />);
  const box = host.querySelector("textarea")!;
  type(box, "hi @an");
  // Each row is a face, then the name (and Agent, or what @everyone does).
  const options = () =>
    [...host.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent!.replace(o.querySelector(".mention-face")?.textContent ?? "", ""),
    );
  expect(options()).toEqual(["Ana", "Ana Lopez"]);
  expect(box.getAttribute("aria-expanded")).toBe("true");

  key(box, "ArrowDown");
  expect(host.querySelector('[aria-selected="true"] b')!.textContent).toBe("Ana Lopez");
  key(box, "Enter");
  expect(box.value).toBe("hi @Ana Lopez ");
  expect(host.querySelector('[role="listbox"]')).toBeNull();

  type(box, "hi @Ana Lopez and @her");
  expect(options()).toEqual(["HermesAgent"]);
  key(box, "Tab");
  expect(box.value).toBe("hi @Ana Lopez and @Hermes ");

  type(box, "@ev");
  expect(options()).toEqual(["everyoneEveryone in this channel"]);
  key(box, "Escape");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
});

test("@everyone isn't offered where it isn't allowed, and ⌘↵ sends", () => {
  const sent = vi.fn();
  const host = render(<Composer everyone={false} onSubmit={sent} />);
  const box = host.querySelector("textarea")!;
  type(box, "@ev");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  type(box, "ship it");
  key(box, "Enter", { metaKey: true });
  expect(sent).toHaveBeenCalledWith("ship it");
});

test("editing: the box opens with the text, ⌘↵ saves the change and closes, Escape cancels", async () => {
  const onSave = vi.fn(async () => true);
  const onCancel = vi.fn();
  const host = render(
    <InlineEditor
      body="Deploy at 5"
      members={members}
      everyone
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  const box = host.querySelector("textarea")!;
  expect(box.value).toBe("Deploy at 5");
  type(box, "Deploy at 6");
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onSave).toHaveBeenCalledWith("Deploy at 6");
  expect(onCancel).toHaveBeenCalledTimes(1);

  const unchanged = vi.fn(async () => true);
  const closed = vi.fn();
  const again = render(
    <InlineEditor body="Same" members={members} everyone onSave={unchanged} onCancel={closed} />,
  );
  await act(async () => {
    (again.querySelector("button.primary") as HTMLButtonElement).click();
  });
  expect(unchanged).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledTimes(1);
  key(again.querySelector("textarea")!, "Escape");
  expect(closed).toHaveBeenCalledTimes(2);

  // Emptied, it can't be saved: a message is taken back by deleting it.
  const third = render(
    <InlineEditor body="Text" members={members} everyone onSave={unchanged} onCancel={closed} />,
  );
  type(third.querySelector("textarea")!, "   ");
  expect((third.querySelector("button.primary") as HTMLButtonElement).disabled).toBe(true);
});

test("reaction chips show each emoji's count, whether you reacted, and who did; a click toggles yours", () => {
  const onToggle = vi.fn();
  const onAdd = vi.fn();
  const host = render(
    <ReactionChips
      reactions={[
        { emoji: "👍", count: 2, mine: true, names: ["Julio", "Ana"] },
        { emoji: "🎉", count: 5, mine: false, names: ["Ana", "Ben", "Cleo"] },
      ]}
      onToggle={onToggle}
      onAdd={onAdd}
    />,
  );
  const chips = [...host.querySelectorAll<HTMLButtonElement>("button.reaction:not(.add)")];
  // Who reacted is in each chip's name; hovering shows it as a tooltip (Tip), not a title.
  expect(
    chips.map((c) => [c.textContent, c.getAttribute("aria-pressed"), c.getAttribute("aria-label")]),
  ).toEqual([
    ["👍2", "true", "👍 2. Julio and Ana reacted with 👍. Remove yours"],
    ["🎉5", "false", "🎉 5. Ana, Ben, Cleo and 2 others reacted with 🎉. Add yours"],
  ]);
  act(() => chips[0]!.click());
  act(() => chips[1]!.click());
  expect(onToggle.mock.calls).toEqual([
    ["👍", true],
    ["🎉", false],
  ]);
  act(() => host.querySelector<HTMLButtonElement>("button.reaction.add")!.click());
  expect(onAdd).toHaveBeenCalled();
  expect(render(<ReactionChips reactions={[]} onToggle={onToggle} />).innerHTML).toBe("");
});

test("the new divider sits before the first message you hadn't read", () => {
  const messages = [
    { messageId: "a", seq: 1, author: { memberId: "ana" }, body: "old" },
    { messageId: "b", seq: 2, author: { memberId: "ana" }, body: "new one" },
    { messageId: "c", seq: 3, author: { memberId: "ben" }, body: "newer" },
  ];
  const at = dividerBefore(messages, 1, "me");
  const host = render(
    <div>
      {messages.map((m) => (
        <div key={m.messageId}>
          {at === m.messageId ? <NewDivider /> : null}
          <p>{m.body}</p>
        </div>
      ))}
    </div>,
  );
  const divider = host.querySelector('[role="separator"]')!;
  expect(divider.getAttribute("aria-label")).toBe("New messages");
  expect(divider.nextElementSibling!.textContent).toBe("new one");
});

test("mentions render as escaped names, and yours and @everyone are marked", () => {
  const names = new Map([
    ["mana0000001", "Ana"],
    ["mevil000001", '<img src=x onerror="alert(1)">'],
  ]);
  const html = markMentions(
    renderMarkdown("<@mana0000001> and <@mevil000001> and <@mnobody0001>, @everyone"),
    {
      nameOf: (id) => names.get(id),
      me: "mana0000001",
    },
  );
  expect(html).toContain('<mark data-mention="me">@Ana</mark>');
  expect(html).toContain(
    '<mark data-mention="member">@&lt;img src=x onerror="alert(1)"&gt;</mark>'.replace(
      'onerror="alert(1)"',
      "onerror=&quot;alert(1)&quot;",
    ),
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;@mnobody0001&gt;");
  expect(html).toContain('<mark data-mention="everyone">@everyone</mark>');
});

test("a run mention renders as the run's name, escaped, as a button that names the run; an unknown run stays text", () => {
  const runs = new Map([
    ["rcc00000001", "Claude Code (Julio)"],
    ["revil000001", "<b>Codex</b> (Ana)"],
  ]);
  const html = markMentions(
    renderMarkdown("<@run:rcc00000001> release the model, <@run:revil000001>, <@run:rgone000001>"),
    {
      nameOf: () => undefined,
      runName: (id) => runs.get(id),
      me: "mana0000001",
    },
  );
  expect(html).toContain(
    '<button type="button" data-mention="run" data-run="rcc00000001">@Claude Code (Julio)</button>',
  );
  expect(html).toContain(">@&lt;b&gt;Codex&lt;/b&gt; (Ana)</button>");
  expect(html).not.toContain("<b>");
  expect(html).toContain("&lt;@run:rgone000001&gt;");
});

const twins = [
  { memberId: "mjulio00001", name: "Julio", kind: "person" as const },
  { memberId: "manaone0001", name: "Ana", kind: "person" as const },
  { memberId: "manatwo0001", name: "Ana", kind: "person" as const },
];

test("picking the second of two members with the same name keeps that member", () => {
  let picks: MentionPick[] = [];
  const host = render(<Composer people={twins} onPicks={(p) => (picks = p)} />);
  const box = host.querySelector("textarea")!;
  type(box, "@an");
  expect([...host.querySelectorAll('[role="option"] b')].map((o) => o.textContent)).toEqual([
    "Ana",
    "Ana",
  ]);
  key(box, "ArrowDown");
  key(box, "Enter");
  expect(box.value).toBe("@Ana ");
  expect(picks).toEqual([{ start: 0, memberId: "manatwo0001", name: "Ana" }]);
});

test("editing a message that mentions the second Ana saves the same Ana", async () => {
  const onSave = vi.fn(async (_body: string) => true);
  const host = render(
    <InlineEditor
      body="<@manatwo0001> can you check?"
      members={twins}
      everyone
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  const box = host.querySelector("textarea")!;
  expect(box.value).toBe("@Ana can you check?");
  type(box, "@Ana can you check? Thanks");
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onSave).toHaveBeenCalledWith("<@manatwo0001> can you check? Thanks");
});

test("a file dropped on a composer is taken once, and doesn't reach the channel's own drop handler", () => {
  const composer = vi.fn();
  const channel = vi.fn();
  const host = render(
    <div className="channel" {...fileDrop(channel)}>
      <div className="composer" {...fileDrop(composer)} />
    </div>,
  );
  const files = [new File(["x"], "log.txt")];
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files, types: ["Files"] } });
  act(() => {
    host.querySelector(".composer")!.dispatchEvent(drop);
  });
  expect(composer).toHaveBeenCalledTimes(1);
  expect(composer).toHaveBeenCalledWith(files);
  expect(channel).not.toHaveBeenCalled();
  expect(drop.defaultPrevented).toBe(true);
});

test("the new direct message popover opens under the + button, or above it in a short window, and never past the edge", () => {
  const plus = { top: 400, bottom: 420, right: 140 };
  expect(placeNear(plus, 840)).toEqual({ top: 426, left: 8, maxHeight: 406 });
  // 600 high: 166 below, 386 above, so it opens upward and fits.
  expect(placeNear(plus, 600)).toEqual({ bottom: 206, left: 8, maxHeight: 386 });
});

test("a thread opened at a reply from search stays at that reply: consuming the target never sends it to the start (#99 review)", () => {
  // Like the Replies panel: each navigation sets the target, and positioning consumes it.
  function Panel({
    navigation,
    replies,
    place,
  }: {
    navigation: { reply?: string };
    replies: string[] | undefined;
    place: (where: string) => void;
  }) {
    const [target, setTarget] = useState<string | undefined>(undefined);
    useEffect(() => setTarget(navigation.reply), [navigation]);
    useOpenPlace(
      target,
      replies !== undefined,
      (id) => place(`target ${id}`),
      () => setTarget(undefined),
      () => place("start"),
    );
    return (
      <ul>
        {replies?.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    );
  }
  const place = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const opened = { reply: "r1" };
  act(() => root.render(<Panel navigation={opened} replies={undefined} place={place} />));
  expect(place).not.toHaveBeenCalled();
  act(() => root.render(<Panel navigation={opened} replies={["r1", "r2", "r3"]} place={place} />));
  // At the reply, and only there: not at the start once the target is consumed.
  expect(place.mock.calls).toEqual([["target r1"]]);
  // New replies, edits and reactions (a new list): no more scrolling.
  act(() =>
    root.render(<Panel navigation={opened} replies={["r1", "r2", "r3", "r4"]} place={place} />),
  );
  expect(place.mock.calls).toEqual([["target r1"]]);
  // Opening the same reply again from another banner is a new navigation.
  act(() =>
    root.render(
      <Panel navigation={{ reply: "r1" }} replies={["r1", "r2", "r3", "r4"]} place={place} />,
    ),
  );
  expect(place.mock.calls).toEqual([["target r1"], ["target r1"]]);

  // A thread opened without a target goes to its start (the first unread reply, or the newest) once.
  const plain = vi.fn();
  const other = document.createElement("div");
  document.body.append(other);
  const root2 = createRoot(other);
  roots.push(root2);
  act(() => root2.render(<Panel navigation={{}} replies={["a"]} place={plain} />));
  act(() => root2.render(<Panel navigation={{}} replies={["a", "b"]} place={plain} />));
  expect(plain.mock.calls).toEqual([["start"]]);
});

test("editing an HTML message saves it as written: an @ in it stays text, not a mention", async () => {
  const onSave = vi.fn(async (_body: string) => true);
  const page = "<p>Hello @Ana, updated</p>";
  const host = render(
    <InlineEditor
      body="<p>Hello @Ana</p>"
      format="html"
      members={members}
      everyone
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  const box = host.querySelector("textarea")!;
  expect(box.value).toBe("<p>Hello @Ana</p>");
  type(box, page);
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onSave).toHaveBeenCalledWith(page);
});

test("in the composer Enter sends; Shift+Enter, Enter inside a ``` block and Enter while an IME composes make a new line", () => {
  const sent = vi.fn();
  const host = render(<Composer enterSends onSubmit={sent} />);
  const box = host.querySelector("textarea")!;
  type(box, "ship it");
  key(box, "Enter", { shiftKey: true });
  expect(sent).not.toHaveBeenCalled();
  key(box, "Enter", { isComposing: true });
  expect(sent).not.toHaveBeenCalled();
  type(box, "```\nconst a = 1;");
  key(box, "Enter");
  expect(sent).not.toHaveBeenCalled();
  type(box, "ship it");
  key(box, "Enter");
  expect(sent).toHaveBeenCalledWith("ship it");
});

test("↑ in the empty composer asks to edit your last message; with text in the box it moves the caret as usual", () => {
  const editLast = vi.fn();
  const host = render(<Composer enterSends onArrowUpEmpty={editLast} />);
  const box = host.querySelector("textarea")!;
  type(box, "draft");
  key(box, "ArrowUp");
  expect(editLast).not.toHaveBeenCalled();
  type(box, "");
  key(box, "ArrowUp");
  expect(editLast).toHaveBeenCalledTimes(1);
});

test("the emoji picker finds emoji by name, picks the first match with Enter, and offers any emoji pasted in", () => {
  const picked = vi.fn();
  render(<EmojiPicker onPick={picked} onClose={() => {}} />);
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search emoji"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const typeIn = (text: string) =>
    act(() => {
      setter.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  typeIn("tada");
  const shown = () =>
    [...document.querySelectorAll(".emoji-grid button")].map((b) => b.textContent);
  expect(shown()[0]).toBe("🎉");
  key(search, "Enter");
  expect(picked).toHaveBeenCalledWith("🎉", true);
  typeIn("🦄");
  expect(shown()).toEqual(["🦄"]);
  typeIn("zzzz-nothing");
  expect(document.querySelector(".emoji-none")).not.toBeNull();
});

test("a #name of a channel you can open becomes a button, but not inside a link, a URL or code; code blocks get Copy; an edit ends the text", () => {
  const channels = new Map([["design", "chdesign0001"]]);
  const html = decorate(
    renderMarkdown(
      "See #design and #nowhere, [the doc](https://x.dev/page#design), `#design`\n\n```\n#design\n```",
    ),
    {
      channels,
      editedAt: 0,
    },
  );
  const host = document.createElement("div");
  host.innerHTML = html;
  const refs = [...host.querySelectorAll<HTMLElement>(".channel-ref")];
  expect(refs.map((r) => [r.textContent, r.dataset["channel"]])).toEqual([
    ["#design", "chdesign0001"],
  ]);
  expect(host.textContent).toContain("#nowhere");
  expect(host.querySelector("a")!.getAttribute("href")).toBe("https://x.dev/page#design");
  expect(host.querySelector("code")!.textContent).toBe("#design");
  expect(host.querySelector(".code-block .code-copy")!.textContent).toBe("Copy");
  // The edited mark ends the last paragraph, or follows a last block that isn't one.
  expect(host.lastElementChild!.classList.contains("edited-mark")).toBe(true);
  const plain = document.createElement("div");
  plain.innerHTML = decorate("<p>Deploy at 6</p>", { editedAt: 0 });
  expect(plain.querySelector("p")!.lastElementChild!.textContent).toBe("(edited)");
});

test("the action bar's one-click reactions keep 👍 and ❤️ in place; only the third follows your latest", () => {
  localStorage.removeItem("uplink.recentEmoji");
  rememberEmoji("👍");
  expect(quickReactions()).toEqual(["👍", "❤️", "😂"]);
  rememberEmoji("🚀");
  expect(quickReactions()).toEqual(["👍", "❤️", "🚀"]);
  rememberEmoji("❤️");
  expect(quickReactions()).toEqual(["👍", "❤️", "🚀"]);
  localStorage.removeItem("uplink.recentEmoji");
});

test("holding Enter after it picks a mention doesn't send the unfinished draft (#99 review)", () => {
  const sent = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Composer enterSends onSubmit={sent} />));
  const box = host.querySelector("textarea")!;
  type(box, "hi @an");
  key(box, "Enter");
  expect(box.value).toBe("hi @Ana ");
  // The key held down: its repeats don't send, and neither does another press before it's let go.
  key(box, "Enter", { repeat: true });
  key(box, "Enter", { repeat: true });
  key(box, "Enter");
  expect(sent).not.toHaveBeenCalled();
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
  key(box, "Enter");
  expect(sent).toHaveBeenCalledWith("hi @Ana ");
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
});

test("an emoji picked with Enter holds Enter back until it's let go; one picked with Space doesn't swallow the next Enter (#99 review)", () => {
  const sent = vi.fn();
  // The composer's box and its emoji picker, which latches Enter for a pick made with a key.
  const host = render(
    <>
      <Composer enterSends onSubmit={sent} />
      <EmojiPicker onPick={(_emoji, byKey) => byKey && latchEnter()} onClose={() => {}} />
    </>,
  );
  const box = host.querySelector("textarea")!;
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search emoji"]')!;
  const up = (el: Element, name: string) =>
    act(() => void el.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true })));
  type(box, "ship it");
  // Enter in the picker's search picks the first match; still held, it doesn't send from the box.
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "tada");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  key(search, "Enter");
  key(box, "Enter");
  expect(sent).not.toHaveBeenCalled();
  up(box, "Enter");
  key(box, "Enter");
  expect(sent).toHaveBeenCalledTimes(1);
  up(box, "Enter");
  // Picked with Space (a key press on the emoji's button): Enter isn't down, so nothing is held back.
  sent.mockClear();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const emoji = document.querySelector<HTMLButtonElement>(".emoji-grid button")!;
  key(emoji, " ");
  act(() => void emoji.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
  up(emoji, " ");
  key(box, "Enter");
  expect(sent).toHaveBeenCalledTimes(1);
  up(box, "Enter");
});

test("a message's reaction picker fits the 300 px Replies column at 960 px: narrower, shifted in, and above when below is short (#99 review)", () => {
  const view = { width: 960, height: 800 };
  // The Replies panel at a 960 px window: x 660 to 960.
  const column = { left: 660, right: 960 };
  // The action bar at the panel's right edge, low in the window.
  const low = pickerPlace({ left: 800, right: 952, top: 500, bottom: 526 }, column, view);
  expect(low.width).toBe(284);
  expect(low.up).toBe(true);
  expect(low.left).toBeGreaterThanOrEqual(column.left + 8);
  expect(low.left + low.width).toBeLessThanOrEqual(column.right - 8);
  expect(low.bottom).toBe(800 - 500 + 4);
  // A bar ending short of the edge: the picker shifts right to stay inside, not off the column's left.
  const inset = pickerPlace({ left: 780, right: 900, top: 80, bottom: 106 }, column, view);
  expect(inset.left).toBe(column.left + 8);
  expect(inset).toMatchObject({ up: false, top: 110, maxHeight: 380 });
  // A wide list leaves it at full width, right-aligned to the bar.
  expect(
    pickerPlace(
      { left: 1100, right: 1290, top: 300, bottom: 326 },
      { left: 248, right: 1320 },
      { width: 1440, height: 900 },
    ),
  ).toMatchObject({ width: 304, left: 1290 - 304 });
  // Opening upward over a list under a header, it stops 8 px below the list's top, never over the header.
  const under = pickerPlace(
    { left: 800, right: 952, top: 400, bottom: 426 },
    { left: 248, right: 960, top: 52 },
    { width: 960, height: 600 },
  );
  expect(under).toMatchObject({ up: true, maxHeight: 400 - 4 - 60 });
});

test("in a short pane at 960 × 600 the whole picker stays in the window, its emoji list scrolling, and it's out of the list that would clip it (#99 review)", () => {
  const view = { width: 960, height: 600 };
  const column = { left: 660, right: 960 };
  // A bar in the middle of the Replies panel: neither side has the picker's full 380 px.
  for (const bar of [
    { left: 800, right: 952, top: 250, bottom: 276 },
    { left: 800, right: 952, top: 330, bottom: 356 },
    { left: 800, right: 952, top: 60, bottom: 86 },
  ]) {
    const place = pickerPlace(bar, column, view);
    const top = place.up ? view.height - place.bottom! - place.maxHeight : place.top!;
    const bottom = place.up ? view.height - place.bottom! : place.top! + place.maxHeight;
    expect(top).toBeGreaterThanOrEqual(8);
    expect(bottom).toBeLessThanOrEqual(view.height - 8);
    // It never covers the bar it opened from.
    expect(place.up ? bottom <= bar.top : top >= bar.bottom).toBe(true);
    expect(place.maxHeight).toBeGreaterThan(200);
  }
  // Rendered with that place, it's a popover in the top layer (so the message list can't clip it)
  // with that height cap, and closes when the list behind it scrolls.
  const closed = vi.fn();
  const host = render(
    <div className="messages">
      <EmojiPicker
        place={pickerPlace({ left: 800, right: 952, top: 250, bottom: 276 }, column, view)}
        onPick={() => {}}
        onClose={closed}
      />
    </div>,
  );
  const picker = document.querySelector<HTMLElement>(".emoji-picker")!;
  expect(picker.getAttribute("data-slot")).toBe("popover-content");
  expect(picker.hasAttribute("popover")).toBe(true);
  expect(picker.classList.contains("placed")).toBe(true);
  expect(picker.style.maxHeight).toBe(
    `${pickerPlace({ left: 800, right: 952, top: 250, bottom: 276 }, column, view).maxHeight}px`,
  );
  // Scrolling inside the picker keeps it; scrolling the list closes it.
  act(() => void picker.querySelector(".emoji-scroll")!.dispatchEvent(new Event("scroll")));
  expect(closed).not.toHaveBeenCalled();
  act(() => void host.querySelector(".messages")!.dispatchEvent(new Event("scroll")));
  expect(closed).toHaveBeenCalled();
});

test("a thread opened at a reply stays there when its replies load, and follows new ones only once you're at its end (Codex review)", () => {
  // A scrolling list happy-dom can measure: 2000 px of replies in a 400 px panel.
  function scrollable(el: HTMLElement | null) {
    if (!el || "measured" in el.dataset) return;
    el.dataset["measured"] = "";
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, 1600));
      },
    });
  }
  function Panel({
    replies,
    target,
    measureOnOpen = true,
  }: {
    replies: string[] | undefined;
    target: string | undefined;
    measureOnOpen?: boolean;
  }) {
    const list = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(target);
    // As the Replies panel: open at the target (here 300 px down), then follow new replies at the end.
    useOpenPlace(
      open,
      replies !== undefined,
      () => {
        list.current!.scrollTop = 300;
        if (measureOnOpen) measure(list.current!);
      },
      () => setOpen(undefined),
      () => {
        list.current!.scrollTop = list.current!.scrollHeight;
        measure(list.current!);
      },
    );
    const measure = useFollowNew(list, replies?.length);
    return (
      <div
        ref={(el) => {
          scrollable(el);
          list.current = el;
        }}
        onScroll={(e) => measure(e.currentTarget)}
      >
        {replies?.map((r) => (
          <p key={r}>{r}</p>
        ))}
      </div>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const panel = () => host.firstElementChild as HTMLElement;
  // The first load is never "new replies", even before anything measured where the list is.
  act(() => root.render(<Panel replies={undefined} target="r3" measureOnOpen={false} />));
  act(() =>
    root.render(<Panel replies={["r1", "r2", "r3", "r4"]} target="r3" measureOnOpen={false} />),
  );
  expect(panel().scrollTop).toBe(300);
  act(() => root.unmount());
  roots.pop();
  const root2 = createRoot(host);
  roots.push(root2);
  const rerender = (ui: ReactNode) => act(() => root2.render(ui));
  // Not cached: the replies arrive after the panel opened at a reply from a link.
  rerender(<Panel replies={undefined} target="r3" />);
  rerender(<Panel replies={["r1", "r2", "r3", "r4"]} target="r3" />);
  expect(panel().scrollTop).toBe(300);
  // A new reply while you read further up doesn't move you.
  rerender(<Panel replies={["r1", "r2", "r3", "r4", "r5"]} target="r3" />);
  expect(panel().scrollTop).toBe(300);
  // Within 80 px of the end, the next one comes into view.
  act(() => {
    panel().scrollTop = 1530;
    panel().dispatchEvent(new Event("scroll"));
  });
  rerender(<Panel replies={["r1", "r2", "r3", "r4", "r5", "r6"]} target="r3" />);
  expect(panel().scrollTop).toBe(1600);
  // 100 px up, it doesn't.
  act(() => {
    panel().scrollTop = 1500;
    panel().dispatchEvent(new Event("scroll"));
  });
  rerender(<Panel replies={["r1", "r2", "r3", "r4", "r5", "r6", "r7"]} target="r3" />);
  expect(panel().scrollTop).toBe(1500);
});

test("a thread at its end stays there when a reply grows after it came, as an image loading does (Codex review)", () => {
  const fire: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        fire.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  try {
    let height = 1000;
    let top = 0;
    function List({ count }: { count: number | undefined }) {
      const list = useRef<HTMLDivElement>(null);
      const measure = useFollowNew(list, count);
      useEffect(() => {
        const el = list.current!;
        if ("measured" in el.dataset) return;
        el.dataset["measured"] = "";
        Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
        Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
        Object.defineProperty(el, "scrollTop", {
          configurable: true,
          get: () => top,
          set: (v: number) => {
            top = Math.max(0, Math.min(v, height - 400));
          },
        });
      }, []);
      return <div ref={list} onScroll={(e) => measure(e.currentTarget)} />;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<List count={3} />));
    const el = host.firstElementChild as HTMLElement;
    // Opened at its end, then the newest reply's image loads and the list grows 240 px.
    act(() => {
      el.scrollTop = 600;
      el.dispatchEvent(new Event("scroll"));
    });
    height = 1240;
    act(() => fire.forEach((f) => f()));
    expect(el.scrollTop).toBe(840);
    // Reading further up, growth doesn't move you.
    act(() => {
      el.scrollTop = 300;
      el.dispatchEvent(new Event("scroll"));
    });
    height = 1500;
    act(() => fire.forEach((f) => f()));
    expect(el.scrollTop).toBe(300);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a run that ends while its message is being edited stays the run the message is for", async () => {
  const onSave = vi.fn(async (_body: string) => true);
  const julioRun = { memberId: "rcc00000001", name: "Claude Code (Julio)", kind: "run" as const };
  const props = {
    body: "<@run:rcc00000001> stop",
    everyone: true,
    addressedRuns: ["rcc00000001"],
    onSave,
    onCancel: () => {},
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<InlineEditor {...props} members={[...members, julioRun]} />));
  const box = host.querySelector("textarea")!;
  expect(box.value).toBe("@Claude Code (Julio) stop");
  // The run ends; Julio's other run takes its name.
  act(() =>
    root.render(
      <InlineEditor {...props} members={[...members, { ...julioRun, memberId: "rcc00000002" }]} />,
    ),
  );
  type(box, "@Claude Code (Julio) stop now");
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onSave).toHaveBeenCalledWith("<@run:rcc00000001> stop now");
});

test("arrowing through a long @ list keeps the selected row in view", () => {
  const many = [
    ...Array.from({ length: 8 }, (_, i) => ({
      memberId: `mclaude000${i}`,
      name: `Claude ${i}`,
      kind: "person" as const,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      memberId: `rcc0000000${i}`,
      name: `Claude Code ${i + 1} (Ana)`,
      kind: "run" as const,
    })),
  ];
  const shown = vi
    .spyOn(Element.prototype, "scrollIntoView")
    .mockImplementation(function (this: Element) {});
  try {
    const host = render(<Composer people={many as unknown as typeof members} />);
    const box = host.querySelector("textarea")!;
    type(box, "@cl");
    shown.mockClear();
    for (let i = 0; i < 9; i++) key(box, "ArrowDown");
    const selected = host.querySelector('[aria-selected="true"]')!;
    expect(selected.textContent).toContain("Claude Code 2 (Ana)");
    // The last call is for the row now selected (with its group title, if it has one).
    const last = shown.mock.contexts.at(-1) as Element;
    expect(last.contains(selected)).toBe(true);
    expect(shown.mock.calls.at(-1)).toEqual([{ block: "nearest" }]);
  } finally {
    shown.mockRestore();
  }
});

test("wrapping long comment identifiers preserves text, links and code", () => {
  const id = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const source = `<p>Read ${id} <a href="https://example.test/${id}">${id}</a> <code>${id}</code></p>`;
  const plain = document.createElement("div");
  plain.innerHTML = source;
  const wrapped = document.createElement("div");
  wrapped.innerHTML = decorate(source, { wrapLongWords: true });
  expect(wrapped.textContent).toBe(plain.textContent);
  expect(wrapped.querySelectorAll(".breakable-word")).toHaveLength(1);
  expect(wrapped.querySelector("a")?.outerHTML).toBe(plain.querySelector("a")?.outerHTML);
  expect(wrapped.querySelector("code")?.outerHTML).toBe(plain.querySelector("code")?.outerHTML);
});
