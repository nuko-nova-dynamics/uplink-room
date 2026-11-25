import { isTerminalReplies, isTerminalReply } from "@uplink-room/protocol/terminalReplies";

/** One request to `terminals.input`: typing, or this screen's own replies, never both. */
export type Outgoing = { data: string; reply: boolean };

/**
 * What a terminal screen sends to the terminal, in order, one request at a time. xterm.js hands the
 * app two kinds of data through `onData`: what the driver types, and what the screen answers on its
 * own when the program asks (focus in and out once Claude Code turns on focus reporting, device
 * attributes, cursor position). Both reach the program, and the room records both; a reply is marked
 * so "who typed what" shows it apart.
 *
 * xterm sends each reply as a data event of its own, so a whole event is a reply when it matches one
 * of xterm's reply shapes (`isTerminalReply`). One key has a reply's shape: Shift+F3 is
 * `ESC [ 1 ; 2 R`, a cursor position report. xterm names every key in `onKey` just before its data
 * event, so a data event that `onKey` just named is typing.
 *
 * - Replies to the output a screen replays when it opens are dropped: the program asked those
 *   questions long ago, and bash would read a late `ESC [ ? 1 ; 2 c` as `1;2c` typed. xterm parses
 *   output in order and calls each write's callback once it's parsed (`wrote`), so a reply made while
 *   the oldest unparsed write is history answers history. Every reply but a focus report comes from
 *   parsing; a focus report does when a program turns focus reporting on (`parsedModeSet`), and
 *   otherwise from a click.
 * - Only the screen that answers (the room's `responderScreenId`, `ScreenClaims`) sends replies;
 *   another screen drops its own.
 * - Only the driver's screens type.
 */
export class TerminalInput {
  #queue: Outgoing[] = [];
  #key: string | undefined;
  /** For each write xterm hasn't parsed yet, oldest first: whether it's replayed history. */
  #writes: boolean[] = [];
  #focusFromParse = false;

  /** For `term.write(chunk.data, input.wrote(history))`: the callback xterm calls once it parsed that chunk. */
  wrote(history: boolean): () => void {
    this.#writes.push(history);
    return () => void this.#writes.shift();
  }

  /** xterm parsed DECSET: a focus report right now answers the program turning focus reporting on. */
  parsedModeSet(): void {
    this.#focusFromParse = true;
    queueMicrotask(() => (this.#focusFromParse = false));
  }

  /** xterm's `onKey`: the next data event with this text is that key. */
  key(key: string): void {
    this.#key = key;
    // xterm sends the key's data in the same call; an unsent key (stdin off) mustn't mark later data.
    queueMicrotask(() => {
      if (this.#key === key) this.#key = undefined;
    });
  }

  /** xterm's `onData`, with whether this screen drives and whether it answers the program. */
  data(chunk: string, screen: { driving: boolean; answering: boolean }): void {
    const typed = chunk === this.#key;
    this.#key = undefined;
    if (!chunk) return;
    if (typed || !isTerminalReply(chunk)) {
      if (screen.driving) this.#push({ data: chunk, reply: false });
      return;
    }
    const focus = chunk === "\x1b[I" || chunk === "\x1b[O";
    const replaying = (!focus || this.#focusFromParse) && this.#writes[0] === true;
    if (screen.answering && !replaying) this.#push({ data: chunk, reply: true });
  }

  /**
   * This screen just became the one that answers. A program with focus reporting on hears once
   * whether this screen has focus, since the screen before may have last told it something else.
   */
  claimed({ focusReporting, focused }: { focusReporting: boolean; focused: boolean }): void {
    if (focusReporting) this.#push({ data: focused ? "\x1b[I" : "\x1b[O", reply: true });
  }

  /** The next request to send, oldest first. */
  next(): Outgoing | undefined {
    return this.#queue.shift();
  }

  #push(item: Outgoing): void {
    const last = this.#queue.at(-1);
    // Typing joins typing, and replies join replies up to what the room takes as replies in one request.
    if (last && !last.reply && !item.reply) last.data += item.data;
    else if (last?.reply && item.reply && isTerminalReplies(last.data + item.data)) last.data += item.data;
    else this.#queue.push(item);
  }
}

/**
 * When a screen claims to be the one that answers the program (`terminals.claimReplies`): when it
 * opens the terminal as the driver's, when its member gets the wheel, and when it gets focus while
 * driving. Never because another screen claimed, so two of the driver's windows can't take the claim
 * back and forth. A reply lost while the claim moves is fine: programs ask again at their next prompt.
 */
export class ScreenClaims {
  #driving = false;
  readonly #claim: () => void;

  constructor(claim: () => void) {
    this.#claim = claim;
  }

  /** Whether the screen drives now. Opening as the driver's, or getting the wheel, claims. */
  driving(driving: boolean, answering: boolean): void {
    if (driving && !this.#driving && !answering) this.#claim();
    this.#driving = driving;
  }

  /** The screen, or its window, got focus. */
  focused(answering: boolean): void {
    if (this.#driving && !answering) this.#claim();
  }
}
