import type { Access } from "./api";

export { profileRefusal, STARTABLE_HARNESSES, takesFirstPrompt, terminalModes, threadRefusal } from "@uplink-room/backend/harnesses";

export const ACCESS_LEVELS: Access[] = ["watch", "suggest", "drive", "open"];

export function accessRank(access: Access): number {
  return ACCESS_LEVELS.indexOf(access);
}

export const ACCESS_META: Record<Access, { label: string; description: string }> = {
  watch: { label: "View", description: "Teammates can see the terminal, and can't type." },
  suggest: {
    label: "Suggest",
    description: "Teammates can propose commands. Whoever is in control decides whether to send them.",
  },
  drive: {
    label: "Ask for control",
    description: "One person is in control. Teammates ask them for control.",
  },
  open: {
    label: "Take control",
    description: "Anyone can take control. Only one keyboard is on at a time.",
  },
};

export const HARNESS_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok Build",
  opencode: "OpenCode",
  cursor: "Cursor",
  "hermes-agent": "Hermes Agent",
  shell: "Shell",
  t3code: "T3 Code",
  space: "Space",
  rex: "Rex",
  a2a: "A2A agent",
};

export function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness] ?? harness;
}

/** What to call a run: the agent's name for a run sent over A2A (ADR 0012) or given to it (ADR 0044), else its harness. */
export function runLabel(run: {
  harness: string;
  a2a?: { agent: { name: string } } | undefined;
  given?: { agent: { name: string } } | undefined;
}): string {
  return run.a2a?.agent.name ?? run.given?.agent.name ?? harnessLabel(run.harness);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "now", "3m", "2h", "5d". */
export function ago(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 45_000) return "now";
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))}m`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h`;
  return `${Math.round(diff / DAY)}d`;
}

/** "just now", "3m ago", "2h ago". */
export function agoText(timestamp: number, now = Date.now()): string {
  const short = ago(timestamp, now);
  return short === "now" ? "just now" : `${short} ago`;
}

/** A timer that ticks: "04:12", or "1:04:12" past an hour. */
export function clock(since: number, now = Date.now()): string {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** "in 6 days", "in 3 hours", "in 12 minutes". */
/** A length as a person reads it, exactly: the largest unit it's a whole number of, down to seconds. */
export function span(ms: number): string {
  const units = [
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
  ] as const;
  const [size, unit] = units.find(([size]) => ms > 0 && ms % size === 0) ?? [1000, "second"];
  const n = Math.max(1, Math.round(ms / size));
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function timeLeft(until: number, now = Date.now()): string {
  const diff = until - now;
  if (diff <= 0) return "expired";
  if (diff >= DAY)
    return `${Math.round(diff / DAY)} day${Math.round(diff / DAY) === 1 ? "" : "s"} left`;
  if (diff >= HOUR)
    return `${Math.round(diff / HOUR)} hour${Math.round(diff / HOUR) === 1 ? "" : "s"} left`;
  return `${Math.max(1, Math.round(diff / MINUTE))} min left`;
}

export function days(ms: number): string {
  if (ms <= 0) return "not allowed";
  const d = ms / DAY;
  if (d >= 1) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
  return `${Math.round(ms / HOUR)} hours`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const FACE_COLORS = [
  "#7FA6E8",
  "#E8A27F",
  "#8FCB9B",
  "#C79BE0",
  "#E8C86F",
  "#7FCBC4",
  "#E88FA6",
  "#A3B1C6",
];
export function faceColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FACE_COLORS[hash % FACE_COLORS.length]!;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
