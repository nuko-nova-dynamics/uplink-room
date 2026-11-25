/**
 * The soft wood cues (DESIGN.md, Sound). These are the placeholder versions the
 * round 6 page synthesizes (design/rounds/6-thread-call-sound): short sine
 * partials with a fast attack, like a small marimba. Final sound design is
 * still an open item, so only `voice` and `CUES` change when it lands.
 *
 * Which cues exist and when they play:
 *   needs   Needs you: a run starts waiting on you.
 *   wheel   The wheel is yours: you became the driver of a terminal.
 *   join    Someone joins a call (people and agents alike).
 *   leave   Someone leaves a call.
 *   settle  Settled: you settled finished work.
 *   zero    Inbox zero: the last thing that needed you or waited to be settled is gone.
 *   message A message addressed to you, outside the channel you're looking at (spec #63).
 * Allowing an approval plays nothing, on purpose.
 *
 * Calls play `join` and `leave` through `playCue`; the rest are played by the
 * shell (`components/Signals.tsx`) and the Inbox.
 */
import type { RigState } from "../characters/CharacterView";

export type Cue = "needs" | "wheel" | "join" | "leave" | "settle" | "zero" | "message";

export const CUES: Record<Cue, { label: string; notes: [number, number][]; link: RigState }> = {
  needs: { label: "Needs you", notes: [[659, 0], [988, 0.11]], link: "waiting" },
  wheel: { label: "You have control", notes: [[523, 0], [659, 0.07], [784, 0.14]], link: "working" },
  join: { label: "Someone joins a call", notes: [[587, 0], [880, 0.09]], link: "idle" },
  leave: { label: "Someone leaves a call", notes: [[880, 0], [587, 0.09]], link: "idle" },
  settle: { label: "Settled", notes: [[988, 0], [740, 0.06]], link: "done" },
  zero: { label: "Inbox zero", notes: [[523, 0], [659, 0], [784, 0], [1047, 0.12]], link: "done" },
  message: { label: "A message for you", notes: [[698, 0], [880, 0.07]], link: "idle" },
};

/** Each wood note: the fundamental and a quiet fourth harmonic, both decaying fast. */
const PARTIALS: [multiple: number, gain: number, decay: number][] = [
  [1, 0.18, 0.28],
  [4, 0.05, 0.06],
];
const ATTACK = 0.004;
/** How long a cue rings after its last note starts. */
const TAIL = ATTACK + PARTIALS[0]![2] + 0.05;
/** Cues that arrive together play one after the other, this far apart, instead of on top of each other. */
const GAP = 0.08;

let context: AudioContext | null = null;
let nextFree = 0;
let enabled = true;

function voice(ac: AudioContext, frequency: number, at: number) {
  const out = ac.createGain();
  out.connect(ac.destination);
  for (const [multiple, gain, decay] of PARTIALS) {
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency * multiple;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + ATTACK);
    env.gain.exponentialRampToValueAtTime(0.0004, at + ATTACK + decay);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + ATTACK + decay + 0.05);
  }
}

type Listener = (cue: Cue) => void;
const listeners = new Set<Listener>();

/** Link reacts to every cue, sound on or off: `onCue` tells each Link on screen. */
export function onCue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSoundsEnabled(on: boolean) {
  enabled = on;
}

let played = 0;

/**
 * Plays a cue (unless sounds are off) and tells Link. `preview` plays it even
 * with sounds off, for the Play buttons in Settings.
 */
export function playCue(cue: Cue, { preview = false }: { preview?: boolean } = {}) {
  // The screenshot script reads which cue played last, and how many have played, from here.
  document.documentElement.dataset["cue"] = `${cue} ${++played}`;
  for (const listener of listeners) listener(cue);
  if (!enabled && !preview) return;
  try {
    context ??= new AudioContext();
  } catch {
    return;
  }
  const ac = context;
  if (ac.state === "suspended") void ac.resume();
  const start = Math.max(ac.currentTime + 0.02, nextFree);
  const notes = CUES[cue].notes;
  for (const [frequency, delay] of notes) voice(ac, frequency, start + delay);
  nextFree = start + Math.max(...notes.map(([, delay]) => delay)) + TAIL + GAP;
}
