import { expect, test } from "vitest";
import { checkpointLine, diffLines, threadBlocks, workLine, type ThreadItem } from "./thread";

const at = Date.UTC(2026, 10, 4, 12);
const item = (order: number, extra: Partial<ThreadItem>): ThreadItem => ({ itemId: `i${order}`, order, kind: "message", ...extra }) as ThreadItem;

test("a turn's work between two messages folds into one block, and plans, checkpoints and notices stand alone", () => {
  const blocks = threadBlocks([
    item(5, { kind: "message", role: "assistant" }),
    item(1, { kind: "message", role: "user" }),
    item(2, { kind: "reasoning" }),
    item(3, { kind: "tool", tool: "command" }),
    item(4, { kind: "file_change" }),
    item(6, { kind: "checkpoint" }),
    item(7, { kind: "plan" }),
    item(8, { kind: "tool", tool: "command" }),
  ]);
  expect(blocks.map((b) => (b.kind === "work" ? `work:${b.items.length}` : b.kind))).toEqual([
    "message",
    "work:3",
    "message",
    "checkpoint",
    "plan",
    "work:1",
  ]);
});

test("a work line says how long it took and what it did, and names the step still running", () => {
  expect(
    workLine([
      item(1, { kind: "tool", tool: "command", at, status: "completed" }),
      item(2, { kind: "file_change", title: "a.ts", at: at + 60_000 }),
      item(3, { kind: "file_change", title: "a.ts", at: at + 90_000 }),
      item(4, { kind: "tool", tool: "command", failed: true, at: at + 120_000 }),
      item(5, { kind: "tool", tool: "search", at: at + 125_000 }),
    ]),
  ).toBe("Worked 2m, ran 2 commands, edited 1 file, searched 1 time, 1 failed");
  expect(workLine([item(1, { kind: "tool", tool: "command", title: "pnpm test", status: "running" })])).toBe("Working: running pnpm test");
  expect(workLine([item(1, { kind: "reasoning" })])).toBe("Worked, thought it through");
});

test("a checkpoint line counts its files and lines, and a diff's lines are marked for showing", () => {
  expect(
    checkpointLine(item(1, { kind: "checkpoint", turn: 2, files: [{ path: "a", additions: 6, deletions: 2 }, { path: "b", additions: 18, deletions: 0 }] })),
  ).toBe("Changed 2 files (+24 −2)");
  expect(diffLines("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n same").map((l) => l.kind)).toEqual(["file", "hunk", "del", "add", "same"]);
});
