/**
 * Turns a call script into one 16 kHz mono track per participant, the way the
 * Notetaker hears a call: each person's microphone is its own track (ADR 0008).
 * Speech comes from macOS `say`, one voice per person, placed on a shared
 * timeline with gaps, overlaps and backchannels. A little noise sits under each
 * track, as on a real microphone, below the level that counts as speech.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SAMPLE_RATE } from "../src/media.ts";
import { wav } from "../src/whisper.ts";
import type { CallScript } from "./lib.ts";

const run = promisify(execFile);

export type RenderedCall = {
  /** One track per person id, all the same length. */
  tracks: Map<string, Int16Array>;
  durationMs: number;
  /** When each turn was placed, for the judge's view of the script. */
  placed: { speaker: string; text: string; startMs: number; endMs: number; overlaps: boolean }[];
};

/** PCM samples from a WAV file made by `say` (which writes extra chunks before "data"). */
export function pcmOf(file: Buffer): Int16Array {
  const at = file.indexOf("data");
  if (at < 0) throw new Error("No data chunk in the WAV file.");
  const start = file.byteOffset + at + 8;
  return new Int16Array(file.buffer.slice(start, start + file.readUInt32LE(at + 4)));
}

/**
 * `say` runs one at a time: several at once write clips cut short. Even one at a
 * time it can drop a word (one clip of 181 lost "sheet"), so a clip is kept only
 * once two renders agree on its length.
 */
let saying: Promise<unknown> = Promise.resolve();

/** At most this many seconds per word: a clip shorter than that was cut short. */
const MIN_SECONDS_PER_WORD = 0.15;
/** Two renders of the same text this close in length agree. */
const AGREE_SAMPLES = SAMPLE_RATE / 50;

async function speak(voice: string, text: string, cacheDir: string): Promise<Int16Array> {
  const key = createHash("sha256").update(JSON.stringify([voice, text])).digest("hex").slice(0, 24);
  const file = join(cacheDir, `${key}.wav`);
  const words = text.split(/\s+/).filter(Boolean).length;
  const complete = (pcm: Int16Array) => pcm.length / SAMPLE_RATE >= words * MIN_SECONDS_PER_WORD;
  try {
    const cached = pcmOf(await readFile(file));
    if (complete(cached)) return cached;
  } catch {
    // Not rendered yet.
  }
  const render = saying.then(async () => {
    await mkdir(cacheDir, { recursive: true });
    const partial = (n: number) => `${file}.${process.pid}.${n}.part.wav`;
    let previous: { path: string; pcm: Int16Array } | undefined;
    for (let attempt = 1; ; attempt++) {
      const path = partial(attempt);
      await run("say", ["-v", voice, "-o", path, `--data-format=LEI16@${SAMPLE_RATE}`, text]);
      const pcm = pcmOf(await readFile(path));
      if (complete(pcm) && previous && Math.abs(pcm.length - previous.pcm.length) <= AGREE_SAMPLES) {
        await rename(pcm.length >= previous.pcm.length ? path : previous.path, file);
        break;
      }
      if (attempt === 5) throw new Error(`say -v "${voice}" doesn't render the same clip twice: ${text}`);
      if (!previous || pcm.length > previous.pcm.length) previous = { path, pcm };
    }
    await Promise.all([1, 2, 3, 4, 5].map((n) => rm(partial(n), { force: true })));
    return pcmOf(await readFile(file));
  });
  saying = render.catch(() => {});
  return render;
}

/** A small seeded random number generator (mulberry32), so every render of a call is the same. */
function random(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function renderCall(call: CallScript, cacheDir: string, noiseRms = 40): Promise<RenderedCall> {
  const rand = random(call.id);
  const people = new Map(call.people.map((p) => [p.id, p]));
  const speech = await Promise.all(
    call.turns.map((turn) => {
      const person = people.get(turn.speaker);
      if (!person) throw new Error(`${call.id}: unknown speaker ${turn.speaker}`);
      return speak(turn.voice ?? person.voice, turn.text, join(cacheDir, "tts"));
    }),
  );
  const ms = (samples: number) => (samples / SAMPLE_RATE) * 1000;
  const placed: RenderedCall["placed"] = [];
  let cursor = 800;
  let floor = { startMs: 0, durationMs: 0 };
  call.turns.forEach((turn, i) => {
    const durationMs = ms(speech[i]!.length);
    let startMs: number;
    if (turn.during !== undefined) startMs = floor.startMs + turn.during * floor.durationMs;
    else if (turn.overlapMs !== undefined) startMs = Math.max(0, cursor - turn.overlapMs);
    else startMs = cursor + (turn.gapMs ?? 250 + rand() * 450);
    const endMs = startMs + durationMs;
    placed.push({ speaker: turn.speaker, text: turn.text, startMs, endMs, overlaps: turn.during !== undefined || turn.overlapMs !== undefined });
    if (turn.during === undefined) floor = { startMs, durationMs };
    cursor = Math.max(cursor, endMs);
  });
  const durationMs = cursor + 1500;
  const length = Math.ceil((durationMs / 1000) * SAMPLE_RATE);
  const tracks = new Map<string, Int16Array>();
  for (const person of call.people) {
    const noise = random(`${call.id}:${person.id}`);
    const mix = new Float32Array(length);
    // Roughly Gaussian noise (a sum of uniforms) at the given level.
    for (let s = 0; s < length; s++) mix[s] = (noise() + noise() + noise() + noise() - 2) * noiseRms * 1.73;
    placed.forEach((p, i) => {
      if (p.speaker !== person.id) return;
      const offset = Math.round((p.startMs / 1000) * SAMPLE_RATE);
      const samples = speech[i]!;
      for (let s = 0; s < samples.length && offset + s < length; s++) mix[offset + s]! += samples[s]! * (person.gain ?? 1);
    });
    const track = new Int16Array(length);
    for (let s = 0; s < length; s++) track[s] = Math.max(-32768, Math.min(32767, Math.round(mix[s]!)));
    tracks.set(person.id, track);
  }
  return { tracks, durationMs, placed };
}

/** Writes each track as a WAV file, to listen to what the Notetaker heard. */
export async function writeTracks(call: CallScript, rendered: RenderedCall, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [id, track] of rendered.tracks) await writeFile(join(dir, `${call.id}.${id}.wav`), wav(track, SAMPLE_RATE));
}
