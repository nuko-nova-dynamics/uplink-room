/**
 * Terminal output as plain text, for agents that read a terminal instead of drawing it. Shared by
 * the room (`terminals.read`) and the room client (`run_in_terminal`, `wait_for_terminal`).
 *
 * It keeps what the terminal shows last on each line: a carriage return goes back to the line's
 * start, a backspace moves back one, erase-in-line (`ESC [ K`, `0K`, `1K`, `2K`) clears that part of
 * the line, and every other escape sequence (colors, cursor moves, titles, bracketed paste) prints
 * nothing. It is not a screen emulator: full-screen programs (vim, top) come out garbled. A line
 * holds at most MAX_LINE characters; what a terminal prints past that on one line is dropped.
 *
 * Output arrives in chunks that can split an escape sequence, a surrogate pair or a `\r\n`. A
 * `TerminalText` keeps its state between `push` calls, so feeding chunks one by one gives the same
 * text as feeding them joined. What it holds back for the next push is `pendingLength` characters
 * at the end of its input: a caller that stops reading resumes from `consumed - pendingLength`, so
 * the next read gets the unfinished piece whole.
 */
export class TerminalText {
  #done: string[] = [];
  #doneLength = 0;
  #line: string[] = [];
  #col = 0;
  /** The start of an escape sequence, a surrogate pair or a `\r` the next push finishes. */
  #pending = "";
  #consumed = 0;

  push(raw: string): void {
    this.#consumed += raw.length;
    const s = this.#pending + raw;
    this.#pending = "";
    let i = 0;
    while (i < s.length) {
      const end = unitEnd(s, i);
      if (end === -1) {
        this.#pending = s.slice(i);
        return;
      }
      this.#unit(s, i, end);
      i = end;
    }
  }

  /** Characters of input pushed so far. */
  get consumed(): number {
    return this.#consumed;
  }

  /** Characters at the end of the input held back for the next push (an unfinished sequence). */
  get pendingLength(): number {
    return this.#pending.length;
  }

  /** How many characters `text()` holds now, about: the finished lines and the current one. */
  get length(): number {
    return this.#doneLength + this.#line.length;
  }

  /**
   * The text so far: lines joined with `\n`, each finished line's trailing spaces trimmed. Held-back
   * input is left out. `partial` keeps the unfinished last line's trailing spaces, for text that
   * goes on in a later read: joined, the parts then read exactly as printed.
   */
  text(options: { partial?: boolean } = {}): string {
    const line = this.#line.join("");
    return [...this.#done, options.partial ? line : line.trimEnd()].join("\n");
  }

  #unit(s: string, i: number, end: number) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      // A complete escape sequence, or a lone ESC that started one too long to be real.
      if (end - i > 1) this.#escape(s.slice(i, end));
    } else if (c === 0x0d) {
      this.#col = 0;
      if (end - i === 2) this.#newline();
    } else if (c === 0x0a) {
      this.#newline();
    } else if (c === 0x08) {
      this.#col = Math.max(0, this.#col - 1);
    } else if (c === 0x09 || (c >= 0x20 && c !== 0x7f)) {
      // Tabs and printable characters, a surrogate pair as one; other control characters print nothing.
      this.#put(s.slice(i, end));
    }
  }

  #put(ch: string) {
    if (this.#col >= MAX_LINE) return;
    while (this.#line.length < this.#col) this.#line.push(" ");
    this.#line[this.#col] = ch;
    this.#col++;
  }

  #newline() {
    const line = this.#line.join("").trimEnd();
    this.#done.push(line);
    this.#doneLength += line.length + 1;
    this.#line = [];
    this.#col = 0;
  }

  #escape(sequence: string) {
    // oxlint-disable-next-line no-control-regex -- matching an escape sequence is the point
    const erase = /^\x1b\[([0-9]*)(?:;[0-9]*)*K$/.exec(sequence);
    if (!erase) return;
    const mode = Number(erase[1] || 0);
    if (mode === 0) this.#line.length = Math.min(this.#line.length, this.#col);
    else if (mode === 1) for (let k = 0; k <= this.#col && k < this.#line.length; k++) this.#line[k] = " ";
    else if (mode === 2) this.#line = [];
  }
}

/** The most characters one line holds, so no output can grow a line (or the padding to a column) past it. */
export const MAX_LINE = 50_000;

/** The longest unfinished escape sequence held back for the next chunk (an OSC title can be long). */
export const MAX_PENDING = 4096;

/**
 * Where the escape sequence starting at `s[i]` (an ESC) ends: the index after it, or -1 when `s`
 * ends before it does. CSI is `ESC [` parameters, intermediates and a final byte; OSC is `ESC ]`
 * up to BEL or `ESC \`; charset selection is `ESC ( B` and the like; anything else is two characters.
 */
export function escapeEnd(s: string, i: number): number {
  if (i + 1 >= s.length) return -1;
  const next = s.charCodeAt(i + 1);
  if (next === 0x5b) {
    let j = i + 2;
    while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
    if (j >= s.length) return -1;
    const final = s.charCodeAt(j);
    // A malformed sequence ends before the stray character, which then prints.
    return final >= 0x40 && final <= 0x7e ? j + 1 : j;
  }
  if (next === 0x5d) {
    for (let j = i + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 0x07) return j + 1;
      if (c === 0x1b) {
        if (j + 1 >= s.length) return -1;
        if (s.charCodeAt(j + 1) === 0x5c) return j + 2;
      }
    }
    return -1;
  }
  if (next >= 0x28 && next <= 0x2b) return i + 2 < s.length ? i + 3 : -1;
  return i + 2;
}

/**
 * The end of the unit of output starting at `s[i]`: an escape sequence, a surrogate pair, a `\r\n`
 * or one character. -1 when `s` ends inside it, so it needs more output: an unfinished sequence, a
 * high surrogate, or a `\r` that a `\n` may follow. An unfinished sequence longer than MAX_PENDING
 * isn't one: its ESC is a unit on its own, which prints nothing.
 */
export function unitEnd(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === 0x1b) {
    const end = escapeEnd(s, i);
    if (end !== -1) return end;
    return s.length - i > MAX_PENDING ? i + 1 : -1;
  }
  if (c >= 0xd800 && c <= 0xdbff) return i + 1 < s.length ? i + 2 : -1;
  if (c === 0x0d) {
    if (i + 1 >= s.length) return -1;
    return s.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
  }
  return i + 1;
}

/**
 * How much of `s` to read for a budget of `max` characters: whole units only, never past an
 * unfinished one. It always takes some progress when a unit is complete: at least one unit that
 * isn't an escape sequence (a character, a pair, a line end), or escape sequences up to
 * `max + MAX_PENDING`, so a budget smaller than a sequence or a pair can't stall a reader.
 * `incomplete` says it stopped before an unfinished unit at the end of `s`.
 */
export function takeUnits(s: string, max: number): { end: number; incomplete: boolean } {
  let end = 0;
  let progressed = false;
  while (end < s.length) {
    const next = unitEnd(s, end);
    if (next === -1) return { end, incomplete: true };
    const fits = next <= max || (!progressed && next <= max + MAX_PENDING) || end === 0;
    if (!fits) break;
    if (s.charCodeAt(end) !== 0x1b) progressed = true;
    end = next;
    if (progressed && end >= max) break;
  }
  return { end, incomplete: false };
}

/** One piece of raw output as plain text, read on its own. `partial`: see TerminalText.text. */
export function plainText(raw: string, options: { partial?: boolean } = {}): string {
  const text = new TerminalText();
  text.push(raw);
  return text.text(options);
}
