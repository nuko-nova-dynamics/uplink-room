import { describe, expect, test } from "vitest";
import { afterEach, vi } from "vitest";
import { canvasSaver, canvasStash, draftStore, foundInSource, foundReporter, freshRemote, keepsMarkdown, pickOccurrence, saveQueue } from "./sync";

describe("canvas: which shapes from the room to merge", () => {
  const known = new Map([
    ["a", { version: 3, versionNonce: 50 }],
    ["b", { version: 2, versionNonce: 10 }],
  ]);

  test("a newer shape, an unknown shape, and the winner of a tie with another editor are merged", () => {
    const remote = [
      { id: "a", version: 4, versionNonce: 1 }, // newer
      { id: "b", version: 2, versionNonce: 7 }, // same version, another editor's nonce won in the room
      { id: "c", version: 1, versionNonce: 3 }, // new
    ];
    expect(freshRemote(known, remote).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  test("a shape the room has exactly as this viewer does, or older, is left alone", () => {
    expect(freshRemote(known, [{ id: "a", version: 3, versionNonce: 50 }, { id: "b", version: 1, versionNonce: 0 }])).toEqual([]);
  });
});

describe("docs: which occurrence of a repeated passage a comment means", () => {
  const text = "save the slot. load the slot. save the slot again";

  test("the prefix and the suffix together pick the occurrence", () => {
    expect(pickOccurrence(text, "the slot", "load", ".")).toBe(text.indexOf("the slot", 10));
    expect(pickOccurrence(text, "the slot", "save", "again")).toBe(text.lastIndexOf("the slot"));
  });

  test("the suffix alone can tell repeats apart", () => {
    expect(pickOccurrence(text, "save the slot", "", "again")).toBe(text.lastIndexOf("save the slot"));
  });

  test("without context the first occurrence is used, and a missing passage is -1", () => {
    expect(pickOccurrence(text, "the slot", "", "")).toBe(text.indexOf("the slot"));
    expect(pickOccurrence(text, "the shrine", "", "")).toBe(-1);
  });
});

describe("docs: whether the rich editor kept a file's Markdown", () => {
  // A shortened copy of the screenshot doc, and of the Markdown Tiptap 3.32.0 gave back for it (logged from the app).
  const original = [
    "# Level 1: The reef",
    "",
    "The first level teaches jumping and the **save slot** flow before any enemy appears.",
    "",
    "## Beats",
    "",
    "1. Wake up on the beach, with no HUD until the first jump.",
    "2. Cross three rock gaps, each wider than the last.",
    "",
    "## To do",
    "",
    "- [x] Block out the beach",
    "- [ ] Tune the second gap",
    "",
    "| Gap | Width | Goal |",
    "| --- | --- | --- |",
    "| 1 | 2 tiles | Teach the jump |",
    "",
    "Art notes live in the [publisher brief](https://example.com/brief). The shrine saves with `saveSlot.write()`.",
    "",
  ].join("\n");
  const reformatted = [
    "# Level 1: The reef",
    "",
    "The first level teaches jumping and the **save slot** flow before any enemy appears.",
    "",
    "## Beats",
    "",
    "1. Wake up on the beach, with no HUD until the first jump.",
    "2. Cross three rock gaps, each wider than the last.",
    "",
    "## To do",
    "",
    "- [x] Block out the beach",
    "- [ ] Tune the second gap",
    "",
    "",
    "| Gap | Width   | Goal           |",
    "| --- | ------- | -------------- |",
    "| 1   | 2 tiles | Teach the jump |",
    "",
    "",
    "Art notes live in the [publisher brief](https://example.com/brief). The shrine saves with `saveSlot.write()`.",
  ].join("\n");

  test("reformatting that keeps every element counts as kept", () => {
    expect(keepsMarkdown(original, reformatted)).toBe(true);
  });

  test("dropped raw HTML, link titles, images or formatting count as lost", () => {
    expect(keepsMarkdown("Intro\n\n<details><summary>Music</summary>Tide</details>", "Intro\n\nMusicTide")).toBe(false);
    expect(keepsMarkdown('[brief](https://x.test "The brief")', "[brief](https://x.test)")).toBe(false);
    expect(keepsMarkdown("![Title screen](https://x.test/a.png)", "Title screen")).toBe(false);
    expect(keepsMarkdown("Keep **this** bold", "Keep this bold")).toBe(false);
    expect(keepsMarkdown("```ts\nconst a = 1;\n```", "```\nconst a = 1;\n```")).toBe(false);
    // Two lists that come back as one: the next load would show a different structure.
    expect(keepsMarkdown("* One\n* Two\n\n- [x] Done", "- One\n- Two\n\n- [x] Done")).toBe(false);
  });

  test("marker style, escapes and entities don't count as changes", () => {
    expect(keepsMarkdown("* With *no HUD* and 5 * 3 &amp; more", "- With _no HUD_ and 5 \\* 3 & more")).toBe(true);
  });

  test("an out-of-range numeric entity doesn't break the check", () => {
    expect(keepsMarkdown("Written out: &amp;#x110000;", "Written out: &amp;#x110000;")).toBe(true);
  });

  test("text that changed counts as lost", () => {
    expect(keepsMarkdown("One two three", "One three")).toBe(false);
  });
});

describe("docs: which comments are still attached while editing the source", () => {
  test("a quote is attached when its visible text is still in the source", () => {
    const source = "Call `save_slot()` once.\n\nThe **reef** level.";
    const anchors = [
      { id: "a", quote: "save_slot() once" },
      { id: "b", quote: "The reef level" },
      { id: "c", quote: "the shrine" },
    ];
    expect(foundInSource(source, anchors)).toEqual(["a", "b"]);
  });
});

describe("docs: attached comments across nested blocks in the source", () => {
  test("a quote spanning a parent item and its nested item, or two paragraphs, is attached", () => {
    const source = "- Parent\n  - Child\n\n- First paragraph\n\n  Second paragraph\n";
    expect(foundInSource(source, [{ id: "a", quote: "Parent Child" }, { id: "b", quote: "First paragraph Second paragraph" }])).toEqual(["a", "b"]);
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("docs: unsaved drafts kept on this computer", () => {
  test("a save clears the draft only if it is still the one that save sent", () => {
    const drafts = draftStore(memoryStorage());
    const sent = drafts.write("f1", { content: "edit one", base: 3 });
    // The doc is reopened and edited again before that save finishes.
    const newer = drafts.write("f1", { content: "edit one, edit two", base: 3 });

    drafts.settle("f1", sent, "edit one");
    expect(drafts.read("f1")).toMatchObject({ content: "edit one, edit two", rev: newer });
    drafts.settle("f1", newer, "edit one, edit two");
    expect(drafts.read("f1")).toBeNull();
  });

  test("a draft whose text is what the save sent is cleared, whatever its revision", () => {
    const drafts = draftStore(memoryStorage());
    const sent = drafts.write("f1", { content: "A", base: 3 });
    drafts.write("f1", { content: "B", base: 3 }); // edited during the save
    drafts.write("f1", { content: "A", base: 3 }); // and undone back to what was sent
    drafts.settle("f1", sent, "A");
    expect(drafts.read("f1")).toBeNull();
  });

  test("storage that throws doesn't break reading or writing", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } };
    const drafts = draftStore(broken);
    expect(drafts.write("f1", { content: "x", base: 1 })).toEqual(expect.any(String));
    expect(drafts.read("f1")).toBeNull();
    expect(() => drafts.settle("f1", "r", "x")).not.toThrow();
  });
});

describe("docs: which view reports attached comments", () => {
  test("only the visible view reports, and a repeat of the last report is dropped", () => {
    const seen: string[][] = [];
    const report = foundReporter((ids) => seen.push(ids));
    report.setMode("rich");
    report.found("rich", ["a", "b"]);
    report.setMode("source");
    report.found("source", ["b"]); // the passage of "a" was deleted in the source
    report.found("rich", ["a", "b"]); // the hidden rich editor still has the old text: ignored
    report.found("source", ["b"]); // nothing changed: dropped
    report.setMode("rich");
    report.found("rich", ["a", "b"]); // back in rich text with "a" restored: reported again
    expect(seen).toEqual([["a", "b"], ["b"], ["a", "b"]]);
  });
});

describe("docs: one save at a time", () => {
  /** A server that checks the base version the way files.edit does, and answers when told to. */
  function slowServer(version: number) {
    const sent: { content: string; base: number; finish: () => void }[] = [];
    let server = { version, content: "" };
    const send = (content: string, base: number) =>
      new Promise<{ version: number } | { conflict: string }>((resolve) => {
        sent.push({
          content,
          base,
          finish: () => {
            if (base !== server.version) return resolve({ conflict: "version conflict" });
            server = { version: server.version + 1, content };
            resolve({ version: server.version });
          },
        });
      });
    return { send, sent, server: () => server };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("edits made during a slow save are saved after it, against the version it returned", async () => {
    const remote = slowServer(3);
    const results: unknown[] = [];
    let editor = { content: "A", rev: "r1" };
    const queue = saveQueue({ base: 3, send: remote.send, latest: () => editor, onResult: (r) => results.push(r) });

    queue.request("A", "r1");
    editor = { content: "AB", rev: "r2" };
    queue.request("AB", "r2"); // typing while the first save is out
    editor = { content: "ABC", rev: "r3" };
    queue.request("ABC", "r3"); // the close-save joins the same queue
    expect(remote.sent.map((s) => s.content)).toEqual(["A"]);

    remote.sent[0]!.finish();
    await tick();
    expect(remote.sent.map((s) => [s.content, s.base])).toEqual([["A", 3], ["ABC", 4]]);
    remote.sent[1]!.finish();
    await tick();

    expect(remote.server()).toEqual({ version: 5, content: "ABC" });
    expect(results).toEqual([
      { result: { version: 4 }, content: "A", rev: "r1", more: true },
      { result: { version: 5 }, content: "ABC", rev: "r3", more: false },
    ]);
    expect(queue.base()).toBe(5);
    expect(queue.busy()).toBe(false);
  });

  test("an edit undone during a slow save isn't sent afterwards: the queue sends what the doc holds now", async () => {
    const remote = slowServer(3);
    const results: { more: boolean }[] = [];
    let editor = { content: "A", rev: "r1" };
    const queue = saveQueue({ base: 3, send: remote.send, latest: () => editor, onResult: (r) => results.push(r) });

    queue.request("A", "r1");
    editor = { content: "B", rev: "r2" };
    queue.request("B", "r2"); // an edit, queued behind the save of A
    editor = { content: "A", rev: "r3" }; // undone before the save returns
    remote.sent[0]!.finish();
    await tick();

    expect(remote.sent.map((s) => s.content)).toEqual(["A"]);
    expect(remote.server()).toEqual({ version: 4, content: "A" });
    expect(results).toEqual([expect.objectContaining({ content: "A", more: false })]);
  });

  test("text changed again during a slow save goes out as it is now, not as it was queued", async () => {
    const remote = slowServer(3);
    let editor = { content: "A", rev: "r1" };
    const queue = saveQueue({ base: 3, send: remote.send, latest: () => editor, onResult: () => {} });

    queue.request("A", "r1");
    editor = { content: "B", rev: "r2" };
    queue.request("B", "r2");
    editor = { content: "C", rev: "r3" }; // typed again; its autosave hasn't fired yet
    remote.sent[0]!.finish();
    await tick();

    expect(remote.sent.map((s) => [s.content, s.base])).toEqual([["A", 3], ["C", 4]]);
  });

  test("a real conflict stops the queue: queued text isn't sent over someone else's version", async () => {
    const remote = slowServer(3);
    const results: { result: unknown }[] = [];
    const queue = saveQueue({ base: 2, send: remote.send, latest: () => ({ content: "AB", rev: "r2" }), onResult: (r) => results.push(r) });

    queue.request("A", "r1");
    queue.request("AB", "r2");
    remote.sent[0]!.finish();
    await tick();

    expect(results.map((r) => r.result)).toEqual([{ conflict: "version conflict" }]);
    expect(remote.sent).toHaveLength(1);
    expect(queue.busy()).toBe(false);
  });
});

describe("canvas: saving shapes until the room has them", () => {
  afterEach(() => vi.useRealTimers());
  const shape = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, version, versionNonce: version * 10, ...extra });

  test("a failed save keeps its shapes and retries them; versions count as saved only once it succeeds", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    let fail = true;
    const saver = canvasSaver({
      maxBytes: 1000,
      save: async (batch) => {
        calls.push(batch.map((e) => e["id"] as string));
        return fail ? { ok: false, kind: "retry", message: "offline" } : { ok: true };
      },
      onRejected: () => {},
    });

    saver.changed([shape("a", 1), shape("b", 1)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([["a", "b"]]);
    expect(saver.confirmed.get("a")).toBeUndefined();
    // The same shapes reported again don't double up, and they're still pending.
    saver.changed([shape("a", 1), shape("b", 1)]);
    expect(saver.pendingCount()).toBe(2);

    fail = false;
    await vi.advanceTimersByTimeAsync(1100); // the first retry
    expect(calls).toEqual([["a", "b"], ["a", "b"]]);
    expect(saver.confirmed.get("a")).toEqual({ version: 1, versionNonce: 10 });
    expect(saver.pendingCount()).toBe(0);
  });

  test("a shape too large to save is refused before sending, with a message, and the others are saved", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const rejected: string[] = [];
    const saver = canvasSaver({
      maxBytes: 200,
      save: async (batch) => {
        calls.push(batch.map((e) => e["id"] as string));
        return { ok: true };
      },
      onRejected: (message) => rejected.push(message),
    });

    saver.changed([shape("a", 1), shape("huge", 1, { text: "x".repeat(500) }), shape("b", 1)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([["a", "b"]]);
    expect(rejected).toEqual([expect.stringMatching(/too large/)]);
    // The refused version isn't queued again on the next change report.
    saver.changed([shape("huge", 1, { text: "x".repeat(500) })]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(1);
  });

  test("a shape the room refuses as invalid is split out, so it can't hold the others back", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const rejected: string[] = [];
    const saver = canvasSaver({
      maxBytes: 1000,
      save: async (batch) => {
        calls.push(batch.map((e) => e["id"] as string));
        return batch.some((e) => e["id"] === "bad")
          ? { ok: false, kind: "invalid", message: "A canvas can't hold shapes of that type." }
          : { ok: true };
      },
      onRejected: (message) => rejected.push(message),
    });

    saver.changed([shape("a", 1), shape("bad", 1), shape("b", 1), shape("c", 1)]);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saver.pendingCount()).toBe(0);
    expect([...saver.confirmed.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(rejected).toEqual([expect.stringMatching(/can't hold/)]);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  test("an edit made while a save is out is saved after it", async () => {
    vi.useFakeTimers();
    const calls: [string, number][][] = [];
    let release: () => void = () => {};
    const saver = canvasSaver({
      maxBytes: 1000,
      save: (batch) => {
        calls.push(batch.map((e) => [e["id"] as string, e["version"] as number]));
        return calls.length === 1 ? new Promise((r) => (release = () => r({ ok: true }))) : Promise.resolve({ ok: true });
      },
      onRejected: () => {},
    });

    saver.changed([shape("a", 1)]);
    await vi.advanceTimersByTimeAsync(300);
    saver.changed([shape("a", 2)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([[["a", 1]]]);
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([[["a", 1]], [["a", 2]]]);
    expect(saver.confirmed.get("a")?.version).toBe(2);
  });

  test("leaving the canvas sends pending shapes at once", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const saver = canvasSaver({
      maxBytes: 1000,
      save: async (batch) => {
        calls.push(batch.map((e) => e["id"] as string));
        return { ok: true };
      },
      onRejected: () => {},
    });
    saver.changed([shape("a", 1)]);
    saver.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([["a"]]);
  });

  test("a saver set up again after leaving (StrictMode's extra cleanup) saves new edits", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const saver = canvasSaver({
      maxBytes: 1000,
      save: async (batch) => {
        calls.push(batch.map((e) => e["id"] as string));
        return { ok: true };
      },
      onRejected: () => {},
    });
    saver.dispose();
    saver.resume();
    saver.changed([shape("a", 1)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([["a"]]);
  });

  test("shapes no save reached before the canvas closed are saved when it reopens", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const offline = canvasSaver({
      maxBytes: 1000,
      save: async () => ({ ok: false, kind: "retry", message: "offline" }),
      onRejected: () => {},
      stash: canvasStash(storage, "c1"),
    });
    offline.confirm([shape("old", 3)]);
    offline.changed([shape("old", 3), shape("a", 1), shape("b", 2)]);
    offline.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60_000); // every retry fails

    const room = new Map<string, number>([["old", 3], ["b", 2]]); // another viewer saved b since
    const calls: string[][] = [];
    const reopened = canvasSaver({
      maxBytes: 1000,
      save: async (batch) => {
        calls.push(batch.map((e) => e["id"] as string));
        for (const e of batch) room.set(e["id"] as string, e["version"] as number);
        return { ok: true };
      },
      onRejected: () => {},
      stash: canvasStash(storage, "c1"),
    });
    reopened.confirm([...room].map(([id, version]) => shape(id, version)));
    // Only shapes newer than the room's come back, to show and to save.
    expect(reopened.restore().map((e) => e.id)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([["a"]]);
    expect(room.get("a")).toBe(1);
    expect(canvasStash(storage, "c1").shapes()).toEqual([]);
  });

  test("a kept shape at the room's version but a lower nonce wins the tie, as the room's merge decides", () => {
    // The room keeps the lower versionNonce on a tie (isNewer in convex/lib/files.ts), so an
    // offline edit that ties the room's version with a lower nonce must come back and be saved.
    const storage = memoryStorage();
    canvasStash(storage, "c1").keep([{ id: "s", version: 2, versionNonce: 10 }, { id: "t", version: 2, versionNonce: 30 }]);
    const reopened = canvasSaver({ maxBytes: 1000, save: async () => ({ ok: true }), onRejected: () => {}, stash: canvasStash(storage, "c1") });
    reopened.confirm([{ id: "s", version: 2, versionNonce: 20 }, { id: "t", version: 2, versionNonce: 20 }]);
    expect(reopened.restore().map((e) => e.id)).toEqual(["s"]);
    // The losing tie is dropped from this computer; the winning one stays until the room has it.
    expect(canvasStash(storage, "c1").shapes().map((e) => e.id)).toEqual(["s"]);
  });

  test("the stash keeps the copy that wins a version tie, and a losing save doesn't clear it", () => {
    const stash = canvasStash(memoryStorage(), "c1");
    stash.keep([{ id: "s", version: 2, versionNonce: 10 }]);
    // A losing equal-version edit doesn't overwrite the winning copy...
    stash.keep([{ id: "s", version: 2, versionNonce: 20 }]);
    expect(stash.shapes()).toEqual([{ id: "s", version: 2, versionNonce: 10 }]);
    // ...and another viewer's save of the losing edit doesn't clear it.
    stash.drop([{ id: "s", version: 2, versionNonce: 20 }]);
    expect(stash.shapes().map((e) => e.versionNonce)).toEqual([10]);
    // The same edit, or a newer version, saved by the room does clear it.
    stash.drop([{ id: "s", version: 2, versionNonce: 10 }]);
    expect(stash.shapes()).toEqual([]);
    stash.keep([{ id: "s", version: 3, versionNonce: 5 }]);
    stash.drop([{ id: "s", version: 4, versionNonce: 99 }]);
    expect(stash.shapes()).toEqual([]);
  });

  test("a shape Excalidraw changes in place while it's drawn is kept, and saved, at its latest state", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const sent: [number, unknown][] = [];
    let release: () => void = () => {};
    const saver = canvasSaver({
      maxBytes: 1000,
      save: (batch) => {
        sent.push(...batch.map((e): [number, unknown] => [e.version, e["width"]]));
        return new Promise((r) => (release = () => r({ ok: true })));
      },
      onRejected: () => {},
      stash: canvasStash(storage, "c1"),
    });
    const live = shape("a", 1, { width: 0 });
    saver.changed([live]);
    await vi.advanceTimersByTimeAsync(300); // the save of version 1 is out
    Object.assign(live, { version: 2, versionNonce: 20, width: 160 }); // the drag goes on
    saver.changed([live]);
    expect(canvasStash(storage, "c1").shapes()).toEqual([expect.objectContaining({ version: 2, width: 160 })]);
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toEqual([[1, 0], [2, 160]]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(canvasStash(storage, "c1").shapes()).toEqual([]);
  });

  test("the local copy keeps the newest version of each shape, whichever viewer wrote it", () => {
    const storage = memoryStorage();
    canvasStash(storage, "c1").keep([shape("a", 3)]);
    canvasStash(storage, "c1").keep([shape("a", 2), shape("b", 1)]);
    expect(canvasStash(storage, "c1").shapes().map((e) => [e.id, e.version])).toEqual([["a", 3], ["b", 1]]);
    // A save of an older version doesn't clear the newer one.
    canvasStash(storage, "c1").drop([shape("a", 2)]);
    expect(canvasStash(storage, "c1").shapes().map((e) => e.id)).toEqual(["a", "b"]);
  });
});
