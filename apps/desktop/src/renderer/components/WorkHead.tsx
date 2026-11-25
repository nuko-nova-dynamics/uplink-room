import { useEffect, useId, useState } from "react";
import { PickOne, PickOneItem } from "./PickOne";
import type { Access, MemberRow } from "../lib/api";
import { ACCESS_LEVELS, ACCESS_META, accessRank } from "../lib/format";
import { MemberFace } from "./Faces";
import { Icon } from "./Icon";
import { Tip } from "./Tip";

const ACCESS_ICON = { watch: "eye", suggest: "suggest", drive: "wheel", open: "open" } as const;

type Who = { memberId: string; name: string; kind: "person" | "agent" };

/** How a screen that's no longer live ended: its run's own state when it has one. */
export type Ended = "didnt_start" | "failed" | "done" | "stopped" | "ended";
const ENDED: Record<Ended, { icon: "x" | "check" | "stop"; label: string; tone: string }> = {
  didnt_start: { icon: "x", label: "Didn't start", tone: "failed" },
  failed: { icon: "x", label: "Failed", tone: "failed" },
  done: { icon: "check", label: "Done", tone: "done" },
  stopped: { icon: "stop", label: "Stopped", tone: "stopped" },
  ended: { icon: "stop", label: "Ended", tone: "stopped" },
};

/**
 * The driver pill of a terminal or Space header (DESIGN.md, "The wheel"): who drives it now, or
 * how it ended, in its run's own words, so an ended screen never claims someone is still driving.
 */
export function DriverPill({
  driver,
  me,
  members,
  ended,
}: {
  driver: Who | undefined;
  me: string;
  members: MemberRow[];
  ended?: Ended | undefined;
}) {
  if (ended) {
    const how = ENDED[ended];
    return (
      <div className={`driver-pill ended ${how.tone}`} aria-label="In control">
        <Icon name={how.icon} />
        <span>{how.label}</span>
      </div>
    );
  }
  const isMe = driver?.memberId === me;
  return (
    <div className={`driver-pill ${isMe ? "me" : ""}`} aria-label="In control">
      <Icon name="wheel" />
      {driver ? (
        <>
          <MemberFace member={driver} members={members} size={24} />
          <span>{isMe ? "You're in control" : `${driver.name} is in control`}</span>
        </>
      ) : (
        <span>Nobody is in control</span>
      )}
    </div>
  );
}

/** The faces the header shows at most; the sentence beside them counts the rest. */
const WATCHING_FACES = 3;

/**
 * Who else has the screen open, as a sentence: "Axel is watching", "Axel and 2 others are watching",
 * or, for someone who isn't driving, "You and Axel are watching". It names people, so it can't read
 * as the viewer's own mode beside the access control. The driver is named in the header's pill.
 */
export function watchingText(others: { name: string }[], meDriving: boolean): string {
  const [first, second] = others;
  if (!first) return meDriving ? "No one else is watching" : "You're watching";
  const rest = others.length - 1;
  const names =
    rest === 0
      ? first.name
      : rest === 1
        ? `${first.name} and ${second!.name}`
        : `${first.name} and ${rest} others`;
  if (meDriving) return `${names} ${rest === 0 ? "is" : "are"} watching`;
  return rest === 0 ? `You and ${names} are watching` : `You, ${names} are watching`;
}

/** Everyone watching but you and the driver, each once. */
export function otherWatchers<W extends Who>(
  watching: W[],
  me: string,
  driverId: string | undefined,
): W[] {
  const seen = new Set([me, ...(driverId ? [driverId] : [])]);
  const others: W[] = [];
  for (const w of watching) {
    if (seen.has(w.memberId)) continue;
    seen.add(w.memberId);
    others.push(w);
  }
  return others;
}

export function Watching({
  watching,
  me,
  driverId,
  members,
}: {
  watching: Who[];
  me: string;
  driverId: string | undefined;
  members: MemberRow[];
}) {
  const others = otherWatchers(watching, me, driverId);
  // Nobody else watching while you're in control says nothing, so it isn't said.
  if (others.length === 0 && driverId === me) return null;
  return (
    <span className="watching" title={others.map((w) => w.name).join(", ") || undefined}>
      {others.slice(0, WATCHING_FACES).map((who) => (
        <MemberFace key={who.memberId} member={who} members={members} size={20} />
      ))}
      <span className="muted">{watchingText(others, driverId === me)}</span>
    </span>
  );
}

/** Where an access level applies: a terminal, a Space or a shared browser. */
export type AccessSurface = "terminal" | "space" | "browser" | "thread";
/** Who reads an access level's words: its driver, or a teammate, who is told the driver's name. */
export type AccessReader = { me: true } | { me: false; name: string | undefined };

const SURFACE: Record<
  AccessSurface,
  {
    thing: string;
    touch: string;
    input: string;
    keeps: string;
    suggest: string;
    youPick: string;
    theyPick: string;
  }
> = {
  terminal: {
    thing: "the terminal",
    touch: "type",
    input: "keyboard",
    keeps: "Your keyboard stays on at every level.",
    suggest: "propose commands",
    youPick: "you choose which to send",
    theyPick: "chooses which to send",
  },
  space: {
    thing: "the screen",
    touch: "click or type",
    input: "mouse and keyboard",
    keeps: "Your mouse and keyboard stay on at every level.",
    suggest: "suggest what to do",
    youPick: "you decide",
    theyPick: "decides",
  },
  // A T3 Code thread (ADR 0021, ADR 0023): only its driver sends it messages.
  thread: {
    thing: "the thread",
    touch: "send it messages",
    input: "person",
    keeps: "Your message box stays on at every level.",
    suggest: "suggest messages",
    youPick: "you choose which to send",
    theyPick: "chooses which to send",
  },
  browser: {
    thing: "the page",
    touch: "click or type",
    input: "mouse and keyboard",
    keeps: "Your mouse and keyboard stay on at every level.",
    suggest: "suggest URLs",
    youPick: "you choose which to open",
    theyPick: "chooses which to open",
  },
};

/**
 * What an access level lets teammates do, said to whoever reads it: to the driver ("They can propose
 * commands, and you choose which to send.") or to a teammate ("You can ask Ana for the wheel.").
 */
export function accessSentence(
  access: Access,
  surface: AccessSurface,
  driver: AccessReader,
): string {
  const s = SURFACE[surface];
  if (driver.me) {
    if (access === "watch") return `They can see ${s.thing} and can't ${s.touch}.`;
    if (access === "suggest") return `They can ${s.suggest}, and ${s.youPick}.`;
    if (access === "drive") return "They can ask you for control.";
    return `Any of them can take control, one ${s.input} at a time.`;
  }
  const driverName = driver.name ?? "whoever is in control";
  if (access === "watch") return `You can see ${s.thing} and can't ${s.touch}.`;
  if (access === "suggest") return `You can ${s.suggest}, and ${driverName} ${s.theyPick}.`;
  if (access === "drive") return `You can ask ${driverName} for control.`;
  return `You can take control, one ${s.input} at a time.`;
}

/**
 * The line under an access control: what the level lets teammates do and, for the driver, that no
 * level turns their own keyboard off. Access limits teammates, never the driver (the bridge's rule).
 */
export function accessLine(access: Access, surface: AccessSurface, driver: AccessReader): string {
  const sentence = accessSentence(access, surface, driver);
  return driver.me ? `${sentence} ${SURFACE[surface].keeps}` : sentence;
}

/**
 * A terminal's or Space's access level (GLOSSARY.md, "Access"): what teammates may do in it, labeled
 * "Teammates can" with a line under it, so it never reads as the viewer's own mode. Whoever started
 * it picks the level up to the machine's limit, and whoever the machine belongs to can lower it;
 * everyone else sees the level as text, not as a control they can't use. Nothing shows once the
 * screen has ended.
 */
export function AccessControl({
  access,
  loweredFrom,
  mostOpen,
  machineName,
  canOpenUp,
  canLower,
  live,
  onSet,
  starterLabel,
  surface,
  driver,
  oneRow = false,
}: {
  access: Access;
  loweredFrom: Access | undefined;
  mostOpen: Access | undefined;
  machineName: string | undefined;
  canOpenUp: boolean;
  canLower: boolean;
  live: boolean;
  onSet: (access: Access) => void;
  /** Who may open it up: "whoever started this terminal" or "whoever shared this Space". */
  starterLabel: string;
  surface: AccessSurface;
  /** Who reads it: the driver, or a teammate (with the driver's name). */
  driver: AccessReader;
  /** One row: the line under it moves into the control's tooltip (a thread's bar). */
  oneRow?: boolean;
}) {
  const labelId = useId();
  if (!live) return null;
  const lowered = loweredFrom ? (
    <span className="chip amber">
      {ACCESS_META[access].label}, was {ACCESS_META[loweredFrom].label}
    </span>
  ) : null;
  const line = oneRow ? null : (
    <span className="hint access-line">{accessLine(access, surface, driver)}</span>
  );
  if (!canOpenUp && !canLower) {
    return (
      <>
        <span
          className="access-read"
          title={oneRow ? accessLine(access, surface, driver) : undefined}
        >
          <span className="label">Teammates can</span>
          <Icon name={ACCESS_ICON[access]} />
          <b>{ACCESS_META[access].label}</b>
        </span>
        {lowered}
        {line}
      </>
    );
  }
  return (
    <>
      <span className="label" id={labelId} style={{ margin: 0 }}>
        Teammates can
      </span>
      <PickOne<Access> className="seg" aria-labelledby={labelId} value={access} onPick={onSet}>
        {ACCESS_LEVELS.map((level) => {
          const blocked = mostOpen ? accessRank(level) > accessRank(mostOpen) : false;
          const allowed = canOpenUp || (canLower && accessRank(level) <= accessRank(access));
          return (
            <Tip
              key={level}
              label={
                blocked
                  ? `${machineName ?? "This machine"} allows at most ${ACCESS_META[mostOpen!].label}.`
                  : !allowed
                    ? `Only ${starterLabel} can open it up; whoever the machine belongs to can lower it.`
                    : accessSentence(level, surface, driver)
              }
            >
              <PickOneItem value={level} disabled={blocked || !allowed}>
                <span className="segment-content">
                  <Icon name={ACCESS_ICON[level]} />
                  <span>{ACCESS_META[level].label}</span>
                </span>
              </PickOneItem>
            </Tip>
          );
        })}
      </PickOne>
      {lowered}
      {canOpenUp && mostOpen && mostOpen !== "open" ? (
        <span className="hint access-cap">
          {machineName ?? "This machine"} allows up to {ACCESS_META[mostOpen].label}.
        </span>
      ) : null}
      {line}
    </>
  );
}

/**
 * The side panel of a terminal or Space: open by default on a wide window, folded behind a header
 * button below 1100 px so the screen keeps its width. The button says how many things wait there.
 */
export function useRail(defaultOpen = true) {
  const query = "(max-width: 1099px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  const [choice, setChoice] = useState<boolean | null>(null);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const open = choice ?? (!narrow && defaultOpen);
  return { open, toggle: () => setChoice(!open) };
}

/** Opens the folded side panel. While it's open, the panel's own close button folds it again. */
export function RailToggle({
  open,
  onToggle,
  waiting,
  urgent,
  label = "Suggestions",
}: {
  open: boolean;
  onToggle: () => void;
  /** "Activity" once the screen has ended: only its log is left in the panel. */
  label?: string;
  /** Suggestions and wheel requests in the panel. */
  waiting: number;
  /** A wheel request waits on you: the count turns amber. */
  urgent: boolean;
}) {
  if (open) return null;
  return (
    <Tip label="Show suggestions and activity">
      <button
        className="btn rail-toggle"
        aria-expanded={open}
        type="button"
        aria-label={`Show suggestions and activity${waiting ? `, ${waiting} waiting` : ""}`}
        onClick={onToggle}
      >
        <Icon name="suggest" /> {label}
        {waiting > 0 ? <span className={`badge ${urgent ? "amber" : ""}`}>{waiting}</span> : null}
      </button>
    </Tip>
  );
}

/** The side panel's own close button, at its top right. */
export function RailClose({ onClose }: { onClose: () => void }) {
  return (
    <Tip label="Hide suggestions and activity">
      <button
        className="btn icon rail-close"
        type="button"
        aria-label="Hide suggestions and activity"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </Tip>
  );
}
