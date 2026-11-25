import { api, type Id } from "../lib/api";
import { useSoftRoomQuery } from "../lib/session";
import { dropTrailingPrompts, outputTail } from "../lib/work";

/** How many of the newest output chunks a preview reads. A chunk is at most 32 KiB. */
const TAIL_CHUNKS = 4;

/**
 * The last lines a terminal printed, as plain text, live. `undefined` while loading or when
 * there's no terminal.
 */
export function useTerminalTail(terminalId: Id<"terminals"> | undefined, lines = 3) {
  // Soft: a preview that can't load (a run hidden from you, a terminal gone) shows nothing.
  const terminal = useSoftRoomQuery(api.terminals.get, terminalId ? { terminalId } : "skip");
  const seq = terminal?.outputSeq ?? 0;
  // Step the window in blocks of chunks, so a busy terminal doesn't resubscribe on every chunk.
  const afterSeq = Math.max(0, Math.floor(Math.max(0, seq - TAIL_CHUNKS) / TAIL_CHUNKS) * TAIL_CHUNKS);
  const output = useSoftRoomQuery(
    api.terminals.output,
    terminal && terminalId ? { terminalId, afterSeq, limit: TAIL_CHUNKS * 2 } : "skip",
  );
  // A window that doesn't start at the first chunk can start mid-line: drop that partial line.
  const text = output ? output.chunks.map((c) => c.data).join("") : undefined;
  const firstBreak = text?.indexOf("\n") ?? -1;
  const whole = text !== undefined && afterSeq > 0 ? (firstBreak >= 0 ? text.slice(firstBreak + 1) : "") : text;
  return {
    terminal,
    tail: whole !== undefined ? outputTail([whole], lines) : undefined,
  };
}

/**
 * The last lines a run's terminal printed, so a run card says what the agent is doing (or why it
 * stopped) without opening the terminal. Clicking it opens the terminal. Like the terminal itself,
 * it stays dark in both themes.
 */
export function RunOutput({
  terminalId,
  onOpen,
  lines = 3,
  finished = false,
  failed: runFailed = false,
}: {
  terminalId: Id<"terminals">;
  onOpen: () => void;
  lines?: number;
  /** The run ended: a bare prompt it was left at says nothing, so it's left out. */
  finished?: boolean;
  /** The run failed: its lines wrap, so the error reads in full. */
  failed?: boolean;
}) {
  const { terminal, tail: raw } = useTerminalTail(terminalId, lines + 2);
  // Nothing shows until the lines have loaded: an empty box reads as broken.
  if (!terminal || raw === undefined) return null;
  const tail = (finished ? dropTrailingPrompts(raw) : raw).slice(-lines);
  const failed = terminal.status === "failed" && terminal.failReason;
  return (
    <button
      type="button"
      className={`run-output ${runFailed ? "wrap" : ""}`}
      onClick={onOpen}
      aria-label={`Open the terminal. Last output: ${tail.join(" ") || "none"}`}
    >
      {failed ? <span className="run-output-fail">Didn't start: {terminal.failReason}</span> : null}
      {tail.length > 0 ? (
        tail.map((line, index) => (
          <span key={index} className="run-output-line">
            {/* A whole line that wraps only between words, so a command never splits inside one;
                only a very long line ends early. */}
            {(line.length > 240 ? `${line.slice(0, 239)}…` : line).split(" ").map((word, i) => (
              <span key={i}>
                {i > 0 ? " " : ""}
                <span className="cmd-word">{word}</span>
              </span>
            ))}
          </span>
        ))
      ) : failed ? null : (
        <span className="run-output-line quiet">No output yet</span>
      )}
    </button>
  );
}
