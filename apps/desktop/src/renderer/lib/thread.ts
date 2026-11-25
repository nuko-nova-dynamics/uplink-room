/**
 * A T3 Code thread's conversation as the thread view shows it (ADR 0022): the room's items, oldest
 * first, put in blocks. A turn's work (tool calls, reasoning, file changes) between two messages
 * folds into one line (DESIGN.md, "Conversations"); plans, requests, checkpoints and notices stand
 * on their own.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "./api";

export type ThreadItem = FunctionReturnType<typeof api.threads.items>["page"][number];

export type ThreadBlock =
  | { kind: "message"; item: ThreadItem }
  | { kind: "work"; key: string; items: ThreadItem[] }
  | { kind: "plan" | "request" | "checkpoint" | "notice"; item: ThreadItem };

const WORK = new Set(["tool", "reasoning", "file_change"]);

/** Sorts items as T3 Code does: by order, then by id. */
export function byOrder(a: ThreadItem, b: ThreadItem) {
  return a.order - b.order || a.itemId.localeCompare(b.itemId);
}

/** The thread's items in blocks, oldest first. */
export function threadBlocks(items: ThreadItem[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  for (const item of [...items].sort(byOrder)) {
    if (WORK.has(item.kind)) {
      const last = blocks.at(-1);
      if (last?.kind === "work") last.items.push(item);
      else blocks.push({ kind: "work", key: item.itemId, items: [item] });
    } else {
      blocks.push({ kind: item.kind as Exclude<ThreadBlock["kind"], "work">, item });
    }
  }
  return blocks;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A short duration: "40s", "2m", "1h 5m". */
export function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * A work block's one line: "Worked 2m, ran 3 commands, edited 2 files", or while a step still runs,
 * "Working: running pnpm test".
 */
export function workLine(items: ThreadItem[]): string {
  const running = items.findLast((i) => i.status === "running" || i.status === "inProgress" || i.streaming);
  if (running) {
    const what = running.kind === "reasoning" ? "thinking" : running.kind === "file_change" ? `editing ${running.title ?? "a file"}` : `running ${running.title ?? "a tool"}`;
    return `Working: ${what}`;
  }
  const commands = items.filter((i) => i.kind === "tool" && i.tool === "command").length;
  const searches = items.filter((i) => i.kind === "tool" && (i.tool === "search" || i.tool === "web")).length;
  const tools = items.filter((i) => i.kind === "tool" && i.tool !== "command" && i.tool !== "search" && i.tool !== "web").length;
  const files = new Set(items.filter((i) => i.kind === "file_change").map((i) => i.title)).size;
  const thought = items.some((i) => i.kind === "reasoning");
  const failed = items.filter((i) => i.failed).length;
  const times = items.map((i) => i.at).filter((t): t is number => t !== undefined);
  const elapsed = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const parts = [
    ...(commands ? [`ran ${plural(commands, "command", "commands")}`] : []),
    ...(files ? [`edited ${plural(files, "file", "files")}`] : []),
    ...(searches ? [`searched ${plural(searches, "time", "times")}`] : []),
    ...(tools ? [`used ${plural(tools, "tool", "tools")}`] : []),
    ...(!commands && !files && !searches && !tools && thought ? ["thought it through"] : []),
  ];
  const head = elapsed >= 1000 ? `Worked ${took(elapsed)}` : "Worked";
  return `${[head, ...parts].join(", ")}${failed ? `, ${failed} failed` : ""}`;
}

/** A checkpoint's line: "Changed 3 files (+12 −4)". It sits under the turn it belongs to, so it doesn't number it. */
export function checkpointLine(item: ThreadItem): string {
  const files = item.files ?? [];
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  if (!files.length) return "Changed no files";
  return `Changed ${plural(files.length, "file", "files")} (+${add} −${del})`;
}

/** How a request ended, in words. */
export function requestOutcome(item: ThreadItem): string | undefined {
  switch (item.outcome) {
    case undefined:
      return undefined;
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return "Allowed";
    case "decline":
      return "Denied";
    case "answered":
      return "Answered";
    case "saved":
      return "Entered in T3 Code";
    case "linked":
      return "Linked";
    case "declined":
      return "Declined";
    case "cancelled":
    case "expired":
      return "Cancelled";
    case "resolved":
      return "Answered";
    default:
      return item.outcome.charAt(0).toUpperCase() + item.outcome.slice(1);
  }
}

/** A unified diff's lines, each with how to show it. */
export function diffLines(diff: string): { text: string; kind: "add" | "del" | "hunk" | "file" | "same" }[] {
  return diff.split("\n").map((text) => ({
    text,
    kind: text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff --git")
      ? "file"
      : text.startsWith("@@")
        ? "hunk"
        : text.startsWith("+")
          ? "add"
          : text.startsWith("-")
            ? "del"
            : "same",
  }));
}
