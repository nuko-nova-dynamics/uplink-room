/**
 * What the agent in a run may do without asking (GLOSSARY.md, "Permission mode", ADR 0043), in
 * plain words: the four modes T3 Code names approval-required to full-access. Starting a run picks
 * one, a thread's driver changes it in the header's menu, and whoever a machine belongs to caps it
 * in Settings. None of it is amber: a mode doesn't need anyone.
 */
import { useId } from "react";
import { PickOne, PickOneItem } from "./PickOne";
import { RUNTIME_MODES, runtimeModeRank, type RuntimeMode } from "@uplink-room/protocol";
import { formatTime } from "../lib/format";
import { Icon } from "./Icon";
import { Tip } from "./Tip";

export { RUNTIME_MODES, runtimeModeRank, type RuntimeMode };

export const MODE_META: Record<
  RuntimeMode,
  { label: string; line: string; icon: "lock" | "edit" | "sliders" | "alert" }
> = {
  "approval-required": {
    label: "Ask before acting",
    line: "Asks before it runs a command or changes a file. You answer here or in T3 Code.",
    icon: "lock",
  },
  "auto-accept-edits": {
    label: "Edit files without asking",
    line: "Changes files in the project on its own, and asks before it runs a command.",
    icon: "edit",
  },
  auto: {
    label: "Approve safe steps itself",
    line: "A reviewer answers most of its requests, and asks you about the risky ones.",
    icon: "sliders",
  },
  "full-access": {
    label: "Full access",
    line: "Runs commands and changes files anywhere on the machine without asking.",
    icon: "alert",
  },
};

/** A terminal started without flags runs as the machine sets the harness up, which may differ. */
export const TERMINAL_DEFAULT_LABEL = "As the machine sets it up";

/** Why a mode can't be picked here, or undefined when it can. */
export function modeBlock(
  mode: RuntimeMode,
  {
    cap,
    modes,
    machineName,
  }: {
    cap: RuntimeMode | undefined;
    modes?: readonly RuntimeMode[] | undefined;
    machineName?: string | undefined;
  },
): string | undefined {
  if (cap && runtimeModeRank(mode) > runtimeModeRank(cap))
    return `${machineName ?? "This machine"} allows up to ${MODE_META[cap].label}. Whoever it belongs to can allow more in Settings, Machines.`;
  if (modes && !modes.includes(mode))
    return "T3 Code's provider for this harness doesn't offer it.";
  return undefined;
}

/**
 * The modes as a list of choices, each with its line: in Settings for a machine's cap, and in a
 * thread's menu for its driver. Choices a cap or the provider rules out stay visible, off, with why.
 */
export function ModeOptions({
  value,
  modes = RUNTIME_MODES,
  cap,
  offered,
  machineName,
  disabled = false,
  locked = false,
  compact = false,
  label,
  onPick,
}: {
  value: RuntimeMode;
  modes?: readonly RuntimeMode[];
  cap?: RuntimeMode | undefined;
  /** The modes the provider takes, when known. */
  offered?: readonly RuntimeMode[] | undefined;
  machineName?: string | undefined;
  disabled?: boolean;
  /** Someone else's setting: the choices read as text, not as controls that are off. */
  locked?: boolean;
  /** In a popover: no line under each choice, it moves to the tooltip. */
  compact?: boolean;
  label: string;
  onPick: (mode: RuntimeMode) => void;
}) {
  const labelId = useId();
  return (
    <div className="mode-options">
      <span className="label" id={labelId}>
        {label}
      </span>
      <PickOne<RuntimeMode>
        className={`option-list ${compact ? "compact" : ""}`}
        orientation="vertical"
        aria-labelledby={labelId}
        value={value}
        onPick={onPick}
      >
        {modes.map((mode) => {
          const block = modeBlock(mode, { cap, modes: offered, machineName });
          const meta = MODE_META[mode];
          const hint = block ?? (compact ? meta.line : undefined);
          const option = (
            <PickOneItem
              key={mode}
              value={mode}
              className={`option level-option mode-option ${locked ? "locked" : ""}`}
              disabled={disabled || locked || Boolean(block)}
            >
              <Icon name={meta.icon} />
              <span>{meta.label}</span>
              {value === mode ? <Icon name="check" size={14} /> : <span />}
              {compact ? null : <span className="sub">{block ?? meta.line}</span>}
            </PickOneItem>
          );
          return hint ? (
            <Tip key={mode} label={hint}>
              {option}
            </Tip>
          ) : (
            option
          );
        })}
      </PickOne>
    </div>
  );
}

/**
 * The thread header's status for its mode: an icon and the mode's name, never a control (DESIGN.md,
 * "One control"). It names the mode in effect, never one T3 Code hasn't confirmed, so it never shows
 * less than the agent may do. Its tooltip says what it allows, who set it from the room or that it
 * was set in T3 Code itself, and a change still on its way (`pending`).
 */
export function ModeChip({
  mode,
  setBy,
  setAt,
  loweredFrom,
  pending,
  overCap,
}: {
  mode: RuntimeMode;
  setBy?: { name: string } | undefined;
  setAt?: number | undefined;
  loweredFrom?: RuntimeMode | undefined;
  /** A mode asked for that T3 Code hasn't confirmed yet. */
  pending?: RuntimeMode | undefined;
  /** The room stopped the thread: T3 Code didn't take a mode within the machine's limit. */
  overCap?: boolean | undefined;
}) {
  const meta = MODE_META[mode];
  const who = overCap
    ? "Above the machine's limit: T3 Code didn't take a lower mode, so the room stopped this thread."
    : loweredFrom
      ? `Lowered from ${MODE_META[loweredFrom].label} by the machine's limit${setAt ? ` at ${formatTime(setAt)}` : ""}.`
      : setBy
        ? `Set by ${setBy.name}${setAt ? ` at ${formatTime(setAt)}` : ""}.`
        : setAt
          ? `Changed in T3 Code at ${formatTime(setAt)}.`
          : "";
  const waiting =
    pending && pending !== mode
      ? ` Changing to ${MODE_META[pending].label} once T3 Code confirms it.`
      : "";
  const changing = Boolean(pending && pending !== mode);
  return (
    <span
      aria-busy={changing}
      className={`mode-chip ${loweredFrom || overCap ? "amber" : ""}`}
      title={`${meta.line}${who ? ` ${who}` : ""}${waiting}`}
      aria-label={`Agent: ${meta.label}${overCap ? ", stopped: above machine limit" : ""}${changing ? ", changing mode" : ""}`}
    >
      {changing ? (
        <span className="state-icon live mode-changing">
          <Icon name="working" size={14} />
        </span>
      ) : (
        <Icon name={overCap ? "alert" : meta.icon} size={14} />
      )}
      <span className="truncate">{meta.label}</span>
    </span>
  );
}
