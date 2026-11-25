import { useEffect, useRef } from "react";
import "./link-rig.js";
import type { Character } from "../lib/api";
import type { AnyState } from "../lib/states";

/**
 * The rig (`design/link-rig.js`, copied unchanged) is a plain script that
 * registers `window.UplinkCast` and animates every `Char` it makes.
 * This file wraps it for React.
 */
export type RigState = "idle" | "working" | "waiting" | "blocked" | "done";

type Char = {
  svg: SVGSVGElement;
  state: RigState;
  /** The rig's clock, the time the current state began, and the blink still closing. */
  t: number;
  enteredAt: number;
  blink: number;
  vel: Record<string, number>;
  step(dt: number): void;
  draw(): void;
  setState(state: RigState): void;
  setKind(kind: string): void;
  setAcc(acc: string | null): void;
};

/**
 * "Only live things move" (DESIGN.md). Working, Waiting and Blocked are live
 * and keep moving; idle and done are not, so a character in either one plays
 * its entrance (done's one hop) and then holds still, unless the view is
 * `lively` (Link's big moments: sign-in and onboarding).
 */
const STILL: ReadonlySet<RigState> = new Set(["idle", "done"]);
const SETTLE_SECONDS = 1.1;
/** How long Link holds a cue's state before going back (as on the round 6 page). */
const REACTION_MS = 2600;

/** Re-enter the current state, so a character reacts again (a hop) without changing state. */
function nudge(char: Char) {
  char.enteredAt = char.t;
  char.vel["y"] = (char.vel["y"] ?? 0) - 60;
  char.vel["sy"] = (char.vel["sy"] ?? 0) - 2.2;
}

type Body = {
  w: number;
  h: number;
  n: number;
  taper: number;
  c1: string;
  c2: string;
  faceDy: number;
  antenna: number;
};

type Cast = {
  Char: new (host: HTMLElement, opts: Record<string, unknown>) => Char;
  BODIES: Record<string, Body>;
};

function cast(): Cast {
  return (window as unknown as { UplinkCast: Cast }).UplinkCast;
}

/** The six bodies, with the accessory each one carries (DESIGN.md, "Characters"). */
export const BODY_OPTIONS = [
  { id: "notetaker", label: "Squircle" },
  { id: "deploy", label: "Pill" },
  { id: "hermes", label: "Rounded triangle" },
  { id: "scribe", label: "Circle" },
  { id: "chief", label: "Tall" },
  { id: "watch", label: "Blob" },
] as const;

/** Eight colors, each a light and a shaded tone. */
export const COLOR_OPTIONS = [
  { id: "sage", c1: "#B5CBA3", c2: "#93AD81" },
  { id: "blue", c1: "#7E9DEB", c2: "#5878D2" },
  { id: "coral", c1: "#F09A85", c2: "#D9725F" },
  { id: "lilac", c1: "#BDA8EA", c2: "#987FD6" },
  { id: "sand", c1: "#F0DDBC", c2: "#D9BE93" },
  { id: "gold", c1: "#F6CD6E", c2: "#E2AC43" },
  { id: "teal", c1: "#86D0C4", c2: "#5DB0A3" },
  { id: "pink", c1: "#EFA6BC", c2: "#D47F99" },
] as const;

export const TOOL_OPTIONS = [
  { id: "notetaker", label: "Headphones" },
  { id: "deploy", label: "Wrench" },
  { id: "hermes", label: "Glasses" },
  { id: "scribe", label: "Pencil" },
  { id: "chief", label: "Clipboard" },
  { id: "watch", label: "Lantern" },
] as const;

/**
 * An agent's `character` is stored as { body, color, accessory }: `body` is a
 * body id above, `color` a color id (or a "#c1,#c2" pair), `accessory` a tool id.
 */
export function colorPair(color: string): { c1: string; c2: string } {
  const named = COLOR_OPTIONS.find((c) => c.id === color);
  if (named) return named;
  const [c1, c2] = color.split(",");
  if (c1 && c2) return { c1, c2 };
  return COLOR_OPTIONS[0];
}

function bodyKey(character: Character | undefined, link: boolean): string | undefined {
  if (link) return "link";
  if (!character) return undefined;
  const base = cast().BODIES[character.body] ?? cast().BODIES["notetaker"]!;
  const { c1, c2 } = colorPair(character.color);
  const key = `custom-${character.body}-${c1}-${c2}`;
  if (!cast().BODIES[key]) cast().BODIES[key] = { ...base, c1, c2, antenna: 0 };
  return key;
}

/** The rig's state names: Failed shows the blocked look, and idle is the rest. */
export function rigState(state: AnyState | "idle"): RigState {
  switch (state) {
    case "waiting":
      return "waiting";
    case "failed":
      return "blocked";
    case "working":
      return "working";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

export function CharacterView({
  character,
  link = false,
  state = "idle",
  size = 28,
  label,
  lively = false,
  reaction,
  still = false,
}: {
  still?: boolean;
  character?: Character | undefined;
  /** Link, the house mascot. */
  link?: boolean;
  state?: AnyState | "idle";
  size?: number;
  label: string;
  /** Full motion, and idle keeps breathing. Off, motion is smaller and idle and done hold still. */
  lively?: boolean;
  /** A short reaction (Link to a sound cue): this state for a moment, then back. `at` makes each one new. */
  reaction?: { state: RigState; at: number } | null | undefined;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const char = useRef<Char | null>(null);
  const kind = bodyKey(character, link) ?? "notetaker";
  const accessory = link ? null : (character?.accessory ?? null);
  const base = rigState(state);
  const baseRef = useRef(base);
  baseRef.current = base;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const made = new (cast().Char)(el, {
      kind,
      acc: accessory,
      state: rigState(state),
      size,
      label,
      lively,
    });
    if (!lively) {
      const step = made.step.bind(made);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (still) {
        step(0);
        made.t = SETTLE_SECONDS + 1;
        made.enteredAt = 0;
        made.blink = 0;
      }
      made.step = (dt) => {
        const settled = made.t - made.enteredAt > SETTLE_SECONDS && made.blink === 0;
        if (STILL.has(made.state) && settled) return;
        step(dt);
        // The rig stops its springs under reduced motion, but still schedules blinks.
        // Keep the same expression throughout the static reduced-motion sequence.
        if (reducedMotion.matches) {
          made.blink = 0;
          made.draw();
        }
      };
    }
    char.current = made;
    return () => {
      made.svg.remove();
      // The rig keeps every Char it made; drop this one so a long session doesn't pile them up.
      const all = (cast().Char as unknown as { all: Char[] }).all;
      const at = all.indexOf(made);
      if (at >= 0) all.splice(at, 1);
      char.current = null;
    };
    // The character is rebuilt only when its look or size changes; state is set below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, accessory, size, label, lively, still]);

  useEffect(() => {
    char.current?.setState(base);
  }, [base]);

  // A reaction takes over for a moment, then the character goes back to its own state.
  useEffect(() => {
    const made = char.current;
    if (!made || !reaction) return;
    if (reaction.state === made.state) nudge(made);
    else made.setState(reaction.state);
    const back = setTimeout(() => made.setState(baseRef.current), REACTION_MS);
    return () => clearTimeout(back);
    // Only a new reaction starts this; a state change meanwhile is applied by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reaction?.at]);

  return (
    <span
      ref={host}
      className="char-host"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    />
  );
}
