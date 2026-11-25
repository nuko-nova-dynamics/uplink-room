/**
 * The replies a terminal screen sends to the program on its own, which nobody typed. Shared by the
 * desktop app (which draws terminals with xterm.js 6.0) and the room (`terminals.input` with `reply`).
 * One screen sends them: the driver's screen that most recently opened the terminal, got the wheel or
 * got focus (`terminals.claimReplies`).
 *
 * A reply still reaches the program and is still recorded with everything else sent to the
 * terminal: the mark changes only how "who typed what" shows it. A reply can put text on a shell's
 * line (bash reads `ESC [ ? 1 ; 2 c` as `1;2c`), so nothing sent may go unrecorded.
 *
 * These are the replies xterm.js 6.0 sends (`common/InputHandler.ts`, `browser/CoreBrowserTerminal.ts`),
 * each as one data event of its own, with exact values where xterm has one answer and bounded
 * numbers where it reports a position or size:
 *
 * - focus in and out, `CSI I` and `CSI O`, once a program turns on focus reporting (Claude Code does);
 * - device attributes, `CSI ? 1 ; 2 c` and `CSI > 0 ; 276 ; 0 c` (xterm.js as `xterm`, its default);
 * - a status report, `CSI 0 n`, and cursor position reports, `CSI row ; col R` and `CSI ? row ; col R`;
 * - mode reports, `CSI ? mode ; value $ y` and `CSI mode ; value $ y`;
 * - window and cell size reports, `CSI 8 ; rows ; cols t`, `CSI 4 ; h ; w t` and `CSI 6 ; h ; w t`;
 * - color reports, `OSC 10 ; rgb:rrrr/gggg/bbbb ST` (and 11, 12, `4 ; index`);
 * - status strings, `DCS 1 $ r … ST` for the five settings xterm reports, and `DCS 0 $ r ST`.
 *
 * Anything else marked as a reply, or longer than these, is typing.
 */
const ESC = "\\x1b";
/** A row or column: the room keeps a terminal between 5 and 200 rows and 20 and 500 columns. */
const RC = "[1-9]\\d{0,2}";
/** A mode number, or a size in pixels. */
const N5 = "[1-9]\\d{0,4}";
const HEX4 = "[0-9a-f]{4}";
const COLOR_INDEX = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const SHAPES = [
  `${ESC}\\[[IO]`,
  `${ESC}\\[\\?1;2c`,
  `${ESC}\\[>0;276;0c`,
  `${ESC}\\[0n`,
  `${ESC}\\[\\??${RC};${RC}R`,
  `${ESC}\\[\\??${N5};[0-4]\\$y`,
  `${ESC}\\[8;${RC};${RC}t`,
  `${ESC}\\[[46];${N5};${N5}t`,
  `${ESC}\\](?:1[0-2]|4;${COLOR_INDEX});rgb:${HEX4}\\/${HEX4}\\/${HEX4}${ESC}\\\\`,
  `${ESC}P(?:1\\$r(?:[01]"q|61;1"p|${RC};${RC}r|0m|[0-6] q)|0\\$r)${ESC}\\\\`,
].join("|");

/** The longest one reply can be, in characters: the longest shape above is 28. */
export const MAX_REPLY_LENGTH = 32;
/** How many replies one `terminals.input` may carry, and so how long it can be. */
export const MAX_REPLIES = 8;

const ONE = new RegExp(`^(?:${SHAPES})$`);
const EACH = new RegExp(`(?:${SHAPES})`, "gy");
const ANY = new RegExp(`(?:${SHAPES})`, "g");

/** True when `data` is exactly one of the screen's own replies. */
export function isTerminalReply(data: string): boolean {
  return data.length <= MAX_REPLY_LENGTH && ONE.test(data);
}

/**
 * True when `data` is one to MAX_REPLIES of the screen's own replies, one after another, and nothing
 * else. Anything else marked as a reply is typing.
 */
export function isTerminalReplies(data: string): boolean {
  if (!data || data.length > MAX_REPLIES * MAX_REPLY_LENGTH) return false;
  EACH.lastIndex = 0;
  let count = 0;
  while (EACH.lastIndex < data.length) {
    const start = EACH.lastIndex;
    const match = EACH.exec(data);
    if (!match || match.index !== start || match[0].length > MAX_REPLY_LENGTH || ++count > MAX_REPLIES) return false;
  }
  return count > 0;
}

/**
 * `data` without the screen's replies in it. Only for input recorded before replies were marked
 * apart (`ESC [ O ESC [ ? 1 ; 2 c ESC [ I` sent with Enter): newer typing is shown as typed, Shift+F3
 * (`ESC [ 1 ; 2 R`, shaped like a cursor position report) included.
 */
export function withoutTerminalReplies(data: string): string {
  return data.replace(ANY, "");
}
