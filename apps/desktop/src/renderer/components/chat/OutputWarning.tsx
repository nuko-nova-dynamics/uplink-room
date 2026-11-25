import { Icon } from "../Icon";

/** A run in a direct message, as channels.list gives it: a warning when people outside it see the run's output. */
export type WarnedRun = { warning?: string | undefined; seenBy?: "team" | "outside" | undefined };

/**
 * A direct message opened with a run whose output people outside it can see (ADR 0039, amended
 * 2026-11-05): the run hears every message, so the header says who sees its output in a few
 * words, with the whole warning as its tooltip and name. The room's first line and the note above
 * the message box say it in full.
 */
export function OutputHeadNote({ runs }: { runs: readonly WarnedRun[] }) {
  const warned = runs.filter((r): r is Required<WarnedRun> => Boolean(r.warning && r.seenBy));
  if (!warned.length) return null;
  const whole = warned.map((r) => r.warning).join(" ");
  return (
    <span className="head-presence head-output" role="note" title={whole} aria-label={whole}>
      <Icon name="eye" size={14} />
      <span className="truncate">
        {warned.some((r) => r.seenBy === "team") ? "Output visible to the whole team" : "Output visible outside this direct message"}
      </span>
    </span>
  );
}
