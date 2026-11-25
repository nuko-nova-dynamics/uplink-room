import type { RunState } from "./api";

export type AnyState = RunState | "not_started";

/** Each state has its own icon and label, so color is never the only signal (DESIGN.md). */
export const STATE_META: Record<AnyState, { label: string; icon: IconName }> = {
  waiting: { label: "Waiting", icon: "alert" },
  working: { label: "Working", icon: "working" },
  done: { label: "Done", icon: "check" },
  failed: { label: "Failed", icon: "x" },
  stopped: { label: "Stopped", icon: "stop" },
  unknown: { label: "Status unknown", icon: "dots" },
  not_started: { label: "Not started", icon: "circle" },
};

export type IconName =
  | "chevron-left"
  | "more"
  | "alert"
  | "working"
  | "check"
  | "x"
  | "stop"
  | "dots"
  | "circle"
  | "inbox"
  | "unfiled"
  | "folder"
  | "hash"
  | "gear"
  | "terminal"
  | "wheel"
  | "eye"
  | "suggest"
  | "open"
  | "machine"
  | "live"
  | "offline"
  | "plus"
  | "copy"
  | "chevron"
  | "chevron-down"
  | "layers"
  | "board"
  | "file"
  | "user"
  | "people"
  | "close"
  | "send"
  | "arrow-up"
  | "reply"
  | "trash"
  | "sun"
  | "moon"
  | "link"
  | "clock"
  | "browser"
  | "expand"
  | "shrink"
  | "doc"
  | "canvas"
  | "pdf"
  | "image"
  | "pin"
  | "upload"
  | "download"
  | "comment"
  | "bell"
  | "play"
  | "mic"
  | "mic-off"
  | "camera"
  | "camera-off"
  | "screen"
  | "leave"
  | "volume"
  | "transcript"
  | "smile"
  | "edit"
  | "search"
  | "at"
  | "lock"
  | "exit"
  | "pushpin"
  | "tick"
  | "sliders"
  | "paperclip"
  | "repo";

/** Run states in the order the Roster and rows treat as most urgent first (GLOSSARY.md). */
export const URGENCY: AnyState[] = [
  "waiting",
  "failed",
  "working",
  "unknown",
  "done",
  "stopped",
  "not_started",
];

export function mostUrgent(states: AnyState[]): AnyState {
  return [...states].sort((a, b) => URGENCY.indexOf(a) - URGENCY.indexOf(b))[0] ?? "not_started";
}
