/**
 * Speech to text with whisper.cpp's `whisper-cli`, on the Notetaker's own
 * machine (ADR 0008). Each utterance is written to a WAV file and transcribed
 * with a multilingual model, detecting the language per utterance.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Utterance } from "./utterances.ts";

const run = promisify(execFile);

/** What the Notetaker knows about the call when it asks for an utterance's text. */
export type TranscribeHints = {
  /** Names people in the call may say, the participants first. Speech-to-text spells a name right far more often when it's told it. */
  names?: string[];
  /** The language most of the call has been in so far, for an utterance too short to tell. */
  language?: string;
};

/** An utterance's text, and its language when the transcriber is sure of it. */
export type Transcription = { text: string; language?: string };

/** Speech to text for one utterance. A plain string is fine for a transcriber that doesn't know the language. */
export type Transcriber = (utterance: Utterance, hints?: TranscribeHints) => Promise<string | Transcription>;

/** A mono 16-bit PCM WAV file. */
export function wav(samples: Int16Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}

/**
 * whisper.cpp marks silence and noise with bracketed tags such as
 * `[BLANK_AUDIO]`, `(music)` or `[Música]`. Those aren't speech.
 */
export function cleanTranscript(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most this many names go in whisper's prompt, which holds about 220 tokens. */
const MAX_PROMPT_NAMES = 40;

/**
 * whisper.cpp's initial prompt for a call: the names people may say. Whisper
 * reads the prompt as text that came before the utterance, so names in it are
 * spelled as written ("Priya", not "Kriya"; "Bea", not "B.").
 */
export function namesPrompt(names: string[] | undefined): string | undefined {
  const unique = [...new Set((names ?? []).map((n) => n.trim()).filter(Boolean))].slice(0, MAX_PROMPT_NAMES);
  return unique.length ? `${unique.join(", ")}.` : undefined;
}

/** The language whisper.cpp detected and how sure it was, from what it logs on stderr. */
export function detectedLanguage(stderr: string): { language: string; probability: number } | undefined {
  const match = /auto-detected language: ([a-z]+) \(p = ([\d.]+)\)/.exec(stderr);
  return match ? { language: match[1]!, probability: Number(match[2]) } : undefined;
}

export type WhisperOptions = {
  /** Path to a ggml model, such as ggml-large-v3-turbo-q5_0.bin or ggml-base.bin (multilingual). */
  model: string;
  /** The whisper.cpp command-line binary. */
  binary?: string;
  /** A language code, or `auto` to detect it per utterance. */
  language?: string;
  threads?: number;
  /**
   * Below this detection probability, the utterance is transcribed again in the
   * call's language (TranscribeHints.language). A one-word "Vale." can be heard
   * as English or Russian at p = 0.2–0.3; real detections score above 0.6.
   */
  minLanguageProbability?: number;
  log?: (message: string) => void;
};

export function whisperTranscriber(options: WhisperOptions): Transcriber {
  const binary = options.binary ?? "whisper-cli";
  const language = options.language ?? "auto";
  const minProbability = options.minLanguageProbability ?? 0.5;
  return async (utterance, hints = {}) => {
    if (utterance.sampleRate !== 16_000) throw new Error("whisper.cpp needs 16 kHz audio.");
    const dir = await mkdtemp(join(tmpdir(), "uplink-notetaker-"));
    try {
      const file = join(dir, "utterance.wav");
      await writeFile(file, wav(utterance.samples, utterance.sampleRate));
      const prompt = namesPrompt(hints.names);
      const transcribe = (lang: string, quiet: boolean) => {
        const args = ["-m", options.model, "-f", file, "-l", lang, "-nt"];
        // Without -np whisper.cpp logs the language it detected, on stderr.
        if (quiet) args.push("-np");
        if (prompt) args.push("--prompt", prompt);
        if (options.threads) args.push("-t", String(options.threads));
        return run(binary, args, { maxBuffer: 4 * 1024 * 1024 });
      };
      if (language !== "auto") return { text: cleanTranscript((await transcribe(language, true)).stdout), language };
      const first = await transcribe("auto", false);
      const detected = detectedLanguage(first.stderr);
      if (detected && detected.probability >= minProbability) return { text: cleanTranscript(first.stdout), language: detected.language };
      // Too short or unclear to tell: hear it in the call's language instead of a guess.
      if (hints.language && hints.language !== detected?.language) {
        try {
          return { text: cleanTranscript((await transcribe(hints.language, true)).stdout) };
        } catch (error) {
          // The first pass still heard something: keep it rather than lose the line.
          options.log?.(`Transcribing again in ${hints.language} failed, so the first transcription stands: ${String(error).slice(0, 300)}`);
        }
      }
      return { text: cleanTranscript(first.stdout) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
