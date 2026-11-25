import "../components/agentWork.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { api, type Access, type Id } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { ACCESS_META, accessRank, formatTime, harnessLabel } from "../lib/format";
import {
  AccessControl,
  DriverPill,
  RailClose,
  RailToggle,
  Watching,
  useRail,
} from "../components/WorkHead";
import "./work.css";
import { useAct, useActOnce, useRoomQuery, useSession, useToast } from "../lib/session";
import { failText, groupInput, showReply, showTyped } from "../lib/work";
import { mayDriveBelowDrive, personDriving } from "../lib/machinePick";
import { ScreenClaims, TerminalInput } from "../lib/terminalInput";
import { MemberFace } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Tip } from "../components/Tip";
import { useMutation } from "convex/react";
import type { Nav } from "../Shell";
import { NO_CAPTURE } from "../lib/analytics";
import { StartRunDialog } from "./TaskPanel";

const WATCH_EVERY_MS = 15_000;
const RESIZE_DEBOUNCE_MS = 200;
const termBg = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--term-bg").trim() || "#0b0c0d";

export function TerminalView({ terminalId, nav }: { terminalId: Id<"terminals">; nav: Nav }) {
  const session = useSession();
  const { teamId } = session;
  const terminal = useRoomQuery(api.terminals.get, { terminalId });
  const machines = useRoomQuery(api.machines.list, {});
  const watch = useAct(api.terminals.watch);
  const setAccess = useAct(api.terminals.setAccess);
  const takeWheel = useAct(api.terminals.takeWheel, { success: "You have control" });
  const requestWheel = useAct(api.terminals.requestWheel, { success: "Asked for control" });
  const passWheel = useAct(api.terminals.passWheel, { success: "Handed off" });
  const [settle] = useActOnce(api.inbox.settle, { success: "Settled" });
  const stopSharingTab = useAct(api.rex.stopSharing, {
    success: "Stopped sharing. The tab keeps running in Rex.",
  });
  const [runAgain, setRunAgain] = useState(false);

  const me = session.me.memberId;
  const isDriver = terminal?.driver?.memberId === me;
  const live = terminal?.status === "live" || terminal?.status === "starting";

  // Say we're watching now, and every ~15 seconds while the screen is open.
  useEffect(() => {
    void watch({ terminalId });
    const id = setInterval(() => void watch({ terminalId }), WATCH_EVERY_MS);
    return () => clearInterval(id);
  }, [terminalId, watch]);

  const machine = machines?.find((m) => m.machineId === terminal?.machine?.machineId);
  // Keys can't reach a machine whose bridge is offline, so the keyboard stays off there.
  const machineOffline = machine?.online === false;
  const keyboardOn = Boolean(isDriver && live && !machineOffline);
  const ownsMachine =
    machine?.belongsTo.kind === "person"
      ? machine.belongsTo.member.memberId === me
      : session.isAdmin;
  const isStarter = terminal?.startedBy.memberId === me;
  // A personal machine at Watch or Suggest: only its person drives there, and a teammate who started
  // a terminal can't take it back (ADR 0025).
  const machinePerson = personDriving(machine);
  const suggestions = useRoomQuery(api.terminals.suggestions, { terminalId });
  const wheelRequests = useRoomQuery(api.terminals.wheelRequests, { terminalId });
  const asksMe = isDriver ? (wheelRequests?.length ?? 0) : 0;
  // The screen comes first, as Grok Bot's computer view: the panel opens on its own only while a
  // suggestion or a request for control waits there, and its header button opens it otherwise.
  const rail = useRail(Boolean(live) && (suggestions?.length ?? 0) + asksMe > 0);
  const title = terminal?.title || (terminal ? harnessLabel(terminal.tool) : "Terminal");
  // How the run ended, for the header once the terminal is no longer live.
  const run = useRoomQuery(
    api.runs.get,
    terminal?.runId && !live ? { runId: terminal.runId } : "skip",
  );

  return (
    <div
      className={`terminal-layout work-ui ${NO_CAPTURE} ${rail.open ? "" : "rail-closed"}`}
      style={{ position: "relative" }}
    >
      <div className="terminal-main">
        <header className="main-head work-head">
          <Tip label="Back">
            <button
              className="btn icon"
              type="button"
              aria-label="Back"
              onClick={() => nav.go({ name: "inbox" })}
            >
              <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
            </button>
          </Tip>
          <h1 title={title}>{title}</h1>
          <span className="grow" />
          {terminal ? (
            <DriverPill
              driver={terminal.driver}
              me={me}
              members={session.members}
              ended={
                live
                  ? undefined
                  : terminal.status === "failed"
                    ? "didnt_start"
                    : run?.state === "failed" || run?.state === "done" || run?.state === "stopped"
                      ? run.state
                      : "ended"
              }
            />
          ) : null}
          {terminal && !isDriver && live && !machineOffline ? (
            terminal.access === "open" ||
            (terminal.access !== "drive" && mayDriveBelowDrive(machine, terminal.startedBy, me)) ? (
              <button className="btn" type="button" onClick={() => void takeWheel({ terminalId })}>
                <Icon name="wheel" />
                <span className="control-label"> Take control</span>
              </button>
            ) : terminal.access === "drive" ? (
              <AskForWheel terminalId={terminalId} requestWheel={requestWheel} />
            ) : null
          ) : null}
          {isDriver && live && !machineOffline ? (
            <PassWheel
              members={session.members.filter(
                (m) =>
                  m.memberId !== me &&
                  (accessRank(terminal!.access) >= accessRank("drive") ||
                    mayDriveBelowDrive(machine, terminal!.startedBy, m.memberId)),
              )}
              onPass={(to) => void passWheel({ terminalId, to })}
            />
          ) : null}
          {terminal?.inRex === "tab" && live && (isStarter || ownsMachine) ? (
            // A Rex tab the person opened: the share ends, and the tab keeps running in Rex.
            <button
              className="btn"
              type="button"
              onClick={() => void stopSharingTab({ terminalId })}
            >
              <span className="control-label">Stop sharing</span>
            </button>
          ) : null}
          {/* An ended terminal's panel starts folded, but its log of who typed what can still open. */}
          <RailToggle
            open={rail.open}
            onToggle={rail.toggle}
            waiting={live ? (suggestions?.length ?? 0) + asksMe : 0}
            urgent={live ? asksMe > 0 : false}
            label={live ? "Suggestions" : "Activity"}
          />
        </header>

        {/* An ended terminal has no access to change or wheel to pass: its bar goes. */}
        <div className="terminal-bar" hidden={Boolean(terminal && !live)}>
          {terminal ? (
            <AccessControl
              access={terminal.access}
              loweredFrom={terminal.loweredFrom}
              mostOpen={terminal.machine?.mostOpenAccess}
              machineName={terminal.machine?.name}
              // Nothing reaches a machine whose bridge is offline, so its access can't change.
              canOpenUp={isStarter && !machineOffline}
              canLower={Boolean(ownsMachine) && !machineOffline}
              live={Boolean(live)}
              onSet={(access) => void setAccess({ terminalId, access })}
              starterLabel="whoever started this terminal"
              surface="terminal"
              // What the level means is the control's tooltip, so the bar stays one row above the screen.
              oneRow
              driver={isDriver ? { me: true } : { me: false, name: terminal.driver?.name }}
            />
          ) : null}
          <span className="grow" />
          {terminal ? (
            <span
              className="muted where"
              title={
                terminal.inRex
                  ? "Rex sets this tab's size. While the tab is open in a Rex app, the app's size is kept."
                  : undefined
              }
            >
              {terminal.inRex === "run"
                ? "In Rex"
                : terminal.inRex === "tab"
                  ? "Rex tab"
                  : harnessLabel(terminal.tool)}
              {terminal.machine ? (
                <>
                  {" on "}
                  <span className="mono terminal-machine-name" title={terminal.machine.name}>
                    {terminal.machine.name}
                  </span>
                </>
              ) : null}
              {terminal.inRex && terminal.size ? (
                <>
                  {", "}
                  <span>{`${terminal.size.cols} × ${terminal.size.rows}`}</span>
                </>
              ) : null}
            </span>
          ) : null}
          {/* The access control's line and who is watching go on the bar's second row. */}
          <span className="bar-break" aria-hidden="true" />
          {terminal && live ? (
            <Watching
              watching={terminal.watching}
              me={me}
              driverId={terminal.driver?.memberId}
              members={session.members}
            />
          ) : null}
        </div>

        {terminal && live && machine && !machine.online ? (
          <div className="note" style={{ margin: "10px 14px 0" }}>
            {machine.name} is offline, so nothing reaches this terminal and the screen shows the
            last output it sent. It comes back when its bridge does.
          </div>
        ) : null}
        {terminal &&
        live &&
        machinePerson &&
        isStarter &&
        !isDriver &&
        machinePerson.memberId !== me ? (
          <div className="note" style={{ margin: "10px 14px 0" }}>
            <span className="mono">{machine!.name}</span> is set to{" "}
            {ACCESS_META[machine!.mostOpenAccess].label}, so {machinePerson.name} is in control of
            every terminal there, yours included. Your run keeps going, and you can{" "}
            {terminal.access === "watch" ? "watch it" : "suggest commands in it"}.
          </div>
        ) : null}
        {terminal && !live ? (
          <div className="note ended-note" style={{ margin: "10px 14px 0" }}>
            <span className="grow">
              {terminal.status === "failed"
                ? `This terminal failed to start${terminal.failReason ? `: ${failText(terminal.failReason)}` : "."}`
                : `This terminal${terminal.machine ? ` (${harnessLabel(terminal.tool)} on ${terminal.machine.name})` : ""} has ended. The screen below is what it showed.`}
              {machineOffline && terminal.machine
                ? ` ${terminal.machine.name} is offline now.`
                : ""}
            </span>
            {run?.taskId && run.machine && (run.state === "failed" || run.state === "stopped") ? (
              <button className="btn" type="button" onClick={() => setRunAgain(true)}>
                <span className="control-label">Run again</span>
              </button>
            ) : null}
            {/* A task's run is settled with its task, from the Inbox; a run with no task settles here. */}
            {run && !run.taskId && run.settled ? (
              <span className="task-settled">
                <Icon name="check" size={14} /> Settled
              </span>
            ) : run &&
              !run.taskId &&
              (run.state === "done" || run.state === "failed" || run.state === "stopped") ? (
              // Busy (and ignoring presses) until the settle comes back.
              <Button className="btn" onClick={() => settle({ runId: run.runId })}>
                <span className="control-label">Settle</span>
              </Button>
            ) : null}
          </div>
        ) : null}
        {runAgain && run?.taskId && run.machine ? (
          <StartRunDialog
            taskId={run.taskId}
            projectId={undefined}
            nav={nav}
            onClose={() => setRunAgain(false)}
            from={{
              harness: run.harness,
              machineId: run.machine.machineId,
              repo: run.repo,
              via: terminal?.inRex === "run" ? "rex" : "terminal",
            }}
          />
        ) : null}

        <XtermPane
          terminalId={terminalId}
          teamId={teamId}
          keyboardOn={keyboardOn}
          responderScreenId={terminal?.responderScreenId}
          driverName={terminal?.driver?.name}
          live={Boolean(live)}
          offline={machineOffline}
          // A Rex tab has the size Rex gives it, so the screen draws at that size instead of fitting.
          fixedSize={terminal?.inRex ? terminal.size : undefined}
        />
      </div>

      {rail.open ? (
        <TerminalSide
          terminalId={terminalId}
          access={terminal?.access ?? "watch"}
          isDriver={Boolean(isDriver)}
          live={Boolean(live)}
          offline={Boolean(machineOffline)}
          onClose={rail.toggle}
        />
      ) : null}
    </div>
  );
}

function AskForWheel({
  terminalId,
  requestWheel,
}: {
  terminalId: Id<"terminals">;
  requestWheel: (a: { terminalId: Id<"terminals"> }) => Promise<unknown>;
}) {
  const session = useSession();
  const requests = useRoomQuery(api.terminals.wheelRequests, { terminalId });
  const asked = (requests ?? []).some((r) => r.from.memberId === session.me.memberId);
  return (
    <button
      className="btn ask-for-wheel work-ui"
      type="button"
      disabled={asked}
      onClick={() => void requestWheel({ terminalId })}
    >
      <Icon name="wheel" />{" "}
      <span className="control-label">{asked ? "Asked for control" : "Ask for control"}</span>
    </button>
  );
}

function PassWheel({
  members,
  onPass,
}: {
  members: { memberId: Id<"members">; name: string; kind: "person" | "agent" }[];
  onPass: (to: Id<"members">) => void;
}) {
  const session = useSession();
  return (
    <Menu onAction={(memberId) => onPass(memberId as Id<"members">)}>
      <MenuTrigger className="btn">
        <Icon name="wheel" />
        <span className="control-label"> Hand off</span>
      </MenuTrigger>
      <MenuContent
        className="pop pass-wheel-menu"
        aria-label="Hand off to"
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={8}
      >
        <MenuGroup>
          <MenuGroupLabel className="pop-title">Hand off to</MenuGroupLabel>
          {members.length === 0 ? (
            <div className="muted" style={{ padding: "6px 9px" }}>
              Nobody can take it at this access level.
            </div>
          ) : null}
          {members.map((m) => (
            <MenuItem key={m.memberId} value={m.memberId} label={m.name}>
              <MemberFace member={m} members={session.members} size={18} /> {m.name}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * The xterm screen. It subscribes to `terminals.output` after the last chunk
 * it wrote and writes chunks in order. Typing goes to `terminals.input` only
 * while the keyboard is on (you are the driver); otherwise stdin is off and a
 * badge says so.
 */
export function XtermPane({
  terminalId,
  teamId,
  keyboardOn,
  responderScreenId,
  driverName,
  live,
  offline,
  fixedSize,
}: {
  terminalId: Id<"terminals">;
  teamId: Id<"teams">;
  keyboardOn: boolean;
  /** The screen whose own replies reach the program (`terminals.claimReplies`). */
  responderScreenId: string | undefined;
  driverName: string | undefined;
  live: boolean;
  offline: boolean;
  fixedSize?: { cols: number; rows: number } | undefined;
}) {
  /** The screen's own box: xterm opens in it, and its fit measures it. */
  const frame = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const written = useRef(0);
  /** The newest output in the room when this screen opened: what's replayed, not answered. */
  const replayThrough = useRef<number | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const toast = useToast();
  const sendInput = useMutation(api.terminals.input);
  const keyboard = useRef(keyboardOn);
  keyboard.current = keyboardOn;
  // This screen, apart from the driver's other windows: one screen answers the program's questions.
  const [screenId] = useState(() => crypto.randomUUID());
  const answering = responderScreenId === screenId;
  const answeringRef = useRef(answering);
  answeringRef.current = answering;
  const claimReplies = useMutation(api.terminals.claimReplies);
  // The driver's screen that most recently opened the terminal, got the wheel or got focus answers
  // the program; losing that never claims it back (lib/terminalInput.ts, ScreenClaims).
  const claims = useRef<ScreenClaims | null>(null);
  const claimFor = useRef({ teamId, terminalId, claimReplies });
  claimFor.current = { teamId, terminalId, claimReplies };
  const onFocus = useCallback(() => claims.current?.focused(answeringRef.current), []);

  // The terminal has one size for everyone, so only the driver sets it (`terminals.resize`). The
  // fitted size goes out when the screen opens, when you become the driver, and (debounced)
  // when the window changes size.
  const sendResize = useMutation(api.terminals.resize);
  const sizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSize = useRef("");
  // A Rex tab draws at the size Rex reports. The driver still asks for the size that fits this
  // screen; Rex applies it only while no Rex app has the tab open (ADR 0019).
  const fixed = useRef(fixedSize);
  fixed.current = fixedSize;
  const fitAddon = useRef<FitAddon | null>(null);
  const syncSize = useCallback(
    (term: Terminal, now = false) => {
      clearTimeout(sizeTimer.current);
      const send = () => {
        const wanted = fixed.current
          ? fitAddon.current?.proposeDimensions()
          : { cols: term.cols, rows: term.rows };
        if (!keyboard.current || !wanted || wanted.cols < 1 || wanted.rows < 1) return;
        const key = `${wanted.cols}x${wanted.rows}`;
        if (key === lastSize.current) return;
        lastSize.current = key;
        // A failure here (the wheel moved on, the terminal ended) needs no message: the next
        // size change tries again, and the screen still works at the old size.
        sendResize({ teamId, terminalId, cols: wanted.cols, rows: wanted.rows }).catch(() => {
          lastSize.current = "";
        });
      };
      if (now) send();
      else sizeTimer.current = setTimeout(send, RESIZE_DEBOUNCE_MS);
    },
    [sendResize, teamId, terminalId],
  );

  // Keystrokes and the screen's own replies are queued apart and sent one request at a time, in
  // order; a reply names the output it answers, and the log shows it apart (lib/terminalInput.ts).
  const pending = useRef<TerminalInput>(new TerminalInput());
  const inFlight = useRef(false);
  const flush = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      for (let next = pending.current.next(); next; next = pending.current.next()) {
        try {
          await sendInput(
            next.reply
              ? { teamId, terminalId, data: next.data, reply: true, screenId }
              : { teamId, terminalId, data: next.data },
          );
        } catch (error) {
          // A reply that fails needs no message: nobody typed it, and the program asks again or goes on without it.
          if (!next.reply) toast.show(errorMessage(error));
        }
      }
    } finally {
      inFlight.current = false;
    }
  }, [sendInput, teamId, terminalId, screenId, toast]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: '"Atkinson Hyperlegible Mono", ui-monospace, Menlo, monospace',
      // DESIGN.md, Scales: Mono is 13 px in terminals; 1.35 puts xterm's rows near the 18 px line of 13 px text.
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: false,
      theme: {
        // The host's own background (`--term-bg`), so the screen and its margin match.
        background: termBg(),
        foreground: "#ebecee",
        // The caret is the text color: amber is for what needs you (DESIGN.md).
        cursor: "#ebecee",
        selectionBackground: "#3a3f47",
        black: "#26282c",
        red: "#ef6f6c",
        green: "#5fc38f",
        yellow: "#f0a73a",
        blue: "#9db0d8",
        magenta: "#c79be0",
        cyan: "#7fcbc4",
        white: "#ebecee",
      },
    });
    // `--term-bg` differs a little between the themes; follow a theme change.
    const themeWatch = new MutationObserver(() => {
      term.options.theme = { ...term.options.theme, background: termBg() };
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitAddon.current = fit;
    const place = () => {
      if (fixed.current) term.resize(fixed.current.cols, fixed.current.rows);
      else fit.fit();
    };
    termRef.current = term;
    // A new terminal starts with nothing queued for the last one.
    pending.current = new TerminalInput();
    written.current = 0;
    replayThrough.current = undefined;
    setCursor(0);

    const open = async () => {
      // Measure with the real font, not the fallback.
      try {
        await Promise.race([
          document.fonts.load('12.5px "Atkinson Hyperlegible Mono"'),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      } catch {
        // Fall back to the system monospace.
      }
      if (disposed) return;
      term.open(el);
      term.textarea?.setAttribute(
        "aria-description",
        "Control+Tab moves to the next control. Control+Shift+Tab moves back. Tab completes a command.",
      );
      place();
      syncSize(term, true);
      // Focusing the screen makes it the one that answers, as opening it did.
      term.textarea?.addEventListener("focus", onFocus);
    };
    void open();
    const sized = term.onResize(() => syncSize(term));

    const key = term.onKey(({ key }) => pending.current.key(key));
    // Turning focus reporting on (DECSET 1004) makes xterm report focus while parsing that output.
    const modeSet = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, () => {
      pending.current.parsedModeSet();
      return false;
    });
    const data = term.onData((chunk) => {
      // Only the driver's screens type, and only the screen that answers sends replies; a watcher's
      // screen makes the same replies and holds them in case the wheel comes its way.
      pending.current.data(chunk, { driving: keyboard.current, answering: answeringRef.current });
      void flush();
    });
    window.addEventListener("focus", onFocus);
    const resize = new ResizeObserver(() => {
      try {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          place();
          // At a fixed size the screen doesn't change, but the size the driver asks for does.
          if (fixed.current) syncSize(term);
        }
      } catch {
        // Not open yet.
      }
    });
    resize.observe(el);
    return () => {
      disposed = true;
      themeWatch.disconnect();
      window.removeEventListener("focus", onFocus);
      term.textarea?.removeEventListener("focus", onFocus);
      key.dispose();
      modeSet.dispose();
      data.dispose();
      sized.dispose();
      clearTimeout(sizeTimer.current);
      lastSize.current = "";
      resize.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddon.current = null;
    };
  }, [terminalId, flush, syncSize, onFocus]);

  // A Rex tab's size changed in Rex: draw at the new size.
  useEffect(() => {
    const term = termRef.current;
    if (term && fixedSize && (term.cols !== fixedSize.cols || term.rows !== fixedSize.rows)) {
      try {
        term.resize(fixedSize.cols, fixedSize.rows);
      } catch {
        // Not open yet; `place` sizes it on open.
      }
    }
  }, [fixedSize?.cols, fixedSize?.rows]);

  useEffect(() => {
    const term = termRef.current;
    // Becoming the driver sends the size this screen has now; losing the wheel forgets it, so the
    // next time we drive, the size goes out again. xterm's own input stays on for every screen, so a
    // watcher's still makes its replies; lib/terminalInput.ts keeps a watcher's typing off.
    if (term && keyboardOn) syncSize(term, true);
    else lastSize.current = "";
  }, [keyboardOn, cursor, syncSize]);

  // Each terminal this screen shows starts over, so opening it as the driver claims.
  useEffect(() => {
    claims.current = new ScreenClaims(() => {
      const { teamId, terminalId, claimReplies } = claimFor.current;
      // A failure needs no message: the wheel moved on, and another screen answers.
      claimReplies({ teamId, terminalId, screenId }).catch(() => {});
    });
  }, [terminalId, screenId]);
  // Opening the terminal as the driver, or getting the wheel, makes this screen the one that answers.
  // Only these run it: losing the claim to another screen never claims it back.
  useEffect(() => {
    claims.current?.driving(keyboardOn, answeringRef.current);
  }, [keyboardOn, terminalId]);
  // Just became the one that answers: a program with focus reporting on hears this screen's focus.
  useEffect(() => {
    const term = termRef.current;
    if (!answering || !term) return;
    const focused = document.hasFocus() && document.activeElement === term.textarea;
    pending.current.claimed({ focusReporting: term.modes.sendFocusMode, focused });
    void flush();
  }, [answering, flush]);

  const output = useQuery(api.terminals.output, { teamId, terminalId, afterSeq: cursor });
  useEffect(() => {
    const term = termRef.current;
    if (!term || !output) return;
    // What the room had when this screen opened is replayed: its questions were asked long ago, so
    // nothing answers them now. Output that comes after is live.
    replayThrough.current ??= output.outputSeq;
    let last = written.current;
    for (const chunk of output.chunks) {
      if (chunk.seq <= last) continue;
      term.write(chunk.data, pending.current.wrote(chunk.seq <= replayThrough.current));
      last = chunk.seq;
    }
    if (last !== written.current) {
      written.current = last;
      // Ask for what comes after the last chunk we wrote; the query stays live.
      setCursor(last);
    }
  }, [output]);

  return (
    <div
      // A fixed size (a Rex tab's) larger than the pane scrolls, so the whole screen can be seen.
      className={`xterm-host work-ui ${keyboardOn ? "" : "kb-off"} ${fixedSize ? "fixed-size" : ""}`}
      data-testid="terminal-screen"
      onKeyDownCapture={(event) => {
        // Plain Tab belongs to the shell. Modified Tab leaves it without sending input.
        if (event.key !== "Tab" || !event.ctrlKey) return;
        const layout = event.currentTarget.closest(".terminal-layout");
        if (!layout) return;
        const controls = Array.from(
          layout.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next =
          controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        next.focus();
      }}
    >
      <div className="xterm-frame" ref={frame} />
      <span className={`kb-badge ${keyboardOn ? "on" : ""}`} role="status">
        <Icon name={keyboardOn ? "wheel" : "eye"} size={14} />
        <span className="control-label">
          {keyboardOn
            ? "Keyboard on"
            : !live
              ? "Keyboard off: ended"
              : offline
                ? "Keyboard off: machine offline"
                : `Keyboard off${driverName ? `: ${driverName} is in control` : ""}`}
        </span>
      </span>
    </div>
  );
}

function TerminalSide({
  terminalId,
  access,
  isDriver,
  live,
  offline,
  onClose,
}: {
  terminalId: Id<"terminals">;
  access: Access;
  isDriver: boolean;
  live: boolean;
  /** The machine's bridge is offline: nothing sent to the terminal can reach it. */
  offline: boolean;
  onClose: () => void;
}) {
  const session = useSession();
  const suggestions = useRoomQuery(api.terminals.suggestions, { terminalId });
  const wheelRequests = useRoomQuery(api.terminals.wheelRequests, { terminalId });
  // Newest first, a page at a time: the log grows with every keystroke, so it is paged, not read whole.
  // A page holds keystrokes, which group into far fewer lines.
  const log = usePaginatedQuery(
    api.terminals.inputLog,
    { teamId: session.teamId, terminalId },
    { initialNumItems: 60 },
  );
  const suggest = useAct(api.terminals.suggest, { success: "Suggested" });
  const send = useAct(api.terminals.sendSuggestion);
  const dismiss = useAct(api.terminals.dismissSuggestion);
  const answerWheel = useAct(api.terminals.answerWheelRequest);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: Id<"suggestions">; command: string } | null>(null);

  const canSuggest = live && !isDriver && accessRank(access) >= accessRank("suggest");
  // One line per burst of typing, not one per keystroke, and the screen's own replies on lines of
  // their own. A burst from before replies were marked that shows nothing once its replies are taken
  // out (it was only replies) gets no line.
  const recent = groupInput(log.results).filter(
    (entry) => entry.kind !== undefined || showTyped(entry.data, { legacy: true }) !== "",
  );

  return (
    <aside className="terminal-side" aria-label="Terminal controls">
      <RailClose onClose={onClose} />
      {isDriver && (wheelRequests?.length ?? 0) > 0 ? (
        <div className="side-block">
          <h2>Asking for control</h2>
          {wheelRequests!.map((request) => (
            <div key={request.requestId} className="sugg">
              <div className="row-flex">
                <MemberFace member={request.from} members={session.members} size={20} />
                <span className="grow">{request.from.name} wants control</span>
              </div>
              <div className="row-flex">
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => void answerWheel({ requestId: request.requestId, grant: true })}
                >
                  <span className="control-label">Hand it over</span>
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void answerWheel({ requestId: request.requestId, grant: false })}
                >
                  <span className="control-label">Not now</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="side-block">
        <h2>Suggested commands</h2>
        {(suggestions?.length ?? 0) === 0 ? <span className="muted">None waiting.</span> : null}
        {(suggestions ?? []).map((s) => (
          <div key={s.suggestionId} className="sugg">
            <div className="muted" style={{ fontSize: "var(--font-13)" }}>
              {s.from.name} suggests
            </div>
            {editing?.id === s.suggestionId ? (
              <Input
                className="input mono"
                aria-label="Command to send"
                value={editing.command}
                autoFocus
                onValueChange={(command) => setEditing({ id: s.suggestionId, command })}
              />
            ) : (
              <code style={{ wordBreak: "break-all" }}>{s.command}</code>
            )}
            {isDriver ? (
              <div className="row-flex" style={{ flexWrap: "wrap" }}>
                {/* Focusable while the machine is offline, so its hint can say why it's off. */}
                <Tip
                  label={
                    offline ? "Its machine is offline, so the command can't reach it." : undefined
                  }
                >
                  <Button
                    className="btn primary"
                    disabled={offline}
                    focusableWhenDisabled
                    onClick={async () => {
                      const edited = editing?.id === s.suggestionId ? editing.command : undefined;
                      setEditing(null);
                      await send({
                        suggestionId: s.suggestionId,
                        ...(edited !== undefined ? { command: edited } : {}),
                      });
                    }}
                  >
                    <span className="control-label">Send</span>
                  </Button>
                </Tip>
                {editing?.id === s.suggestionId ? null : (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setEditing({ id: s.suggestionId, command: s.command })}
                  >
                    <span className="control-label">Edit</span>
                  </button>
                )}
                <button
                  className="btn"
                  type="button"
                  onClick={() => void dismiss({ suggestionId: s.suggestionId })}
                >
                  <span className="control-label">Dismiss</span>
                </button>
              </div>
            ) : (
              <span className="hint">Only whoever is in control can send it.</span>
            )}
            {isDriver && offline ? (
              <span className="hint">The machine is offline: send it once it's back.</span>
            ) : null}
          </div>
        ))}
      </div>

      {live && !isDriver ? (
        <form
          className="side-block"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!text.trim()) return;
            if ((await suggest({ terminalId, command: text })) !== undefined) setText("");
          }}
        >
          <h2>Suggest a command</h2>
          <Input
            className="input mono"
            placeholder={canSuggest ? "pnpm test" : "This terminal is on View"}
            disabled={!canSuggest}
            value={text}
            onValueChange={setText}
            aria-label="Suggest a command"
          />
          <button className="btn" type="submit" disabled={!canSuggest || !text.trim()}>
            <Icon name="suggest" />
            <span className="control-label"> Suggest</span>
          </button>
          {!canSuggest ? (
            <span className="hint">
              Teammates can suggest commands once the access is Suggest or more open.
            </span>
          ) : null}
        </form>
      ) : null}

      <div className="side-block">
        <h2>Who typed what</h2>
        {recent.length === 0 ? <span className="muted">Nothing typed yet.</span> : null}
        {log.status === "CanLoadMore" || log.status === "LoadingMore" ? (
          <button
            className="btn"
            type="button"
            disabled={log.status === "LoadingMore"}
            onClick={() => log.loadMore(60)}
          >
            <span className="control-label">Show earlier</span>
          </button>
        ) : null}
        {/* Oldest first, the order the screen shows them in. */}
        {[...recent].reverse().map((entry, index) => (
          <div key={`${entry.at}-${index}`} className="log-line" title={formatTime(entry.at)}>
            <span className="log-time">{formatTime(entry.at)}</span>
            <b style={{ fontWeight: 500, color: "var(--text)", flex: "none" }}>
              {entry.kind === "reply"
                ? entry.by.memberId === session.me.memberId
                  ? "Your screen"
                  : `${entry.by.name}'s screen`
                : entry.by.memberId === session.me.memberId
                  ? "You"
                  : entry.by.name}
            </b>
            {entry.kind === "reply" ? (
              // The screen answering the program on its own: recorded like typing, since a shell can read it as text.
              <code className="log-reply" title="The screen answered the program on its own">
                {showReply(entry.data).slice(0, 120)}
              </code>
            ) : (
              <code>
                {showTyped(entry.data, { legacy: entry.kind === undefined }).slice(0, 120)}
              </code>
            )}
            {entry.suggestedBy ? (
              <span className="muted" style={{ flex: "none" }}>
                from {entry.suggestedBy.name}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
