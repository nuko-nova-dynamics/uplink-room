/**
 * Cuts one participant's audio into utterances on silence, so each can be
 * transcribed on its own (ADR 0008). Each participant's microphone is its own
 * LiveKit track, so speech is attributed per participant.
 */

export type Utterance = {
  /** The participant's LiveKit identity, which is their member id. */
  speakerId: string;
  /** Wall-clock ms when the utterance started. */
  startedAt: number;
  sampleRate: number;
  samples: Int16Array;
};

export type SegmenterOptions = {
  sampleRate: number;
  /** Root-mean-square level (of 32767) that counts as speech. */
  threshold?: number;
  /** Quiet this long ends an utterance. */
  silenceMs?: number;
  /** Shorter utterances (coughs, clicks) are dropped. */
  minSpeechMs?: number;
  /** Longer speech is cut here, so lines keep coming during a monologue. */
  maxMs?: number;
  /** Audio kept from before speech starts, so the first syllable isn't clipped. */
  preRollMs?: number;
};

export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

export class Segmenter {
  readonly #speakerId: string;
  readonly #onUtterance: (utterance: Utterance) => void;
  readonly #sampleRate: number;
  readonly #threshold: number;
  readonly #silenceMs: number;
  readonly #minSpeechMs: number;
  readonly #maxMs: number;
  readonly #preRollMs: number;

  #preRoll: { frame: Int16Array; at: number }[] = [];
  #frames: Int16Array[] = [];
  #startedAt = 0;
  #durationMs = 0;
  #voicedMs = 0;
  #quietMs = 0;
  #inSpeech = false;

  constructor(speakerId: string, options: SegmenterOptions, onUtterance: (utterance: Utterance) => void) {
    this.#speakerId = speakerId;
    this.#onUtterance = onUtterance;
    this.#sampleRate = options.sampleRate;
    this.#threshold = options.threshold ?? 400;
    this.#silenceMs = options.silenceMs ?? 700;
    this.#minSpeechMs = options.minSpeechMs ?? 300;
    this.#maxMs = options.maxMs ?? 20_000;
    this.#preRollMs = options.preRollMs ?? 200;
  }

  /** Adds one frame of mono 16-bit audio that started at `at` (wall-clock ms). */
  push(frame: Int16Array, at: number): void {
    const frameMs = (frame.length / this.#sampleRate) * 1000;
    const loud = rms(frame) >= this.#threshold;
    if (!this.#inSpeech) {
      this.#preRoll.push({ frame, at });
      let kept = this.#preRoll.reduce((ms, f) => ms + (f.frame.length / this.#sampleRate) * 1000, 0);
      while (kept > this.#preRollMs + frameMs && this.#preRoll.length > 1) {
        kept -= (this.#preRoll.shift()!.frame.length / this.#sampleRate) * 1000;
      }
      if (!loud) return;
      this.#inSpeech = true;
      this.#frames = this.#preRoll.map((f) => f.frame);
      this.#startedAt = this.#preRoll[0]!.at;
      this.#durationMs = kept;
      this.#voicedMs = frameMs;
      this.#quietMs = 0;
      this.#preRoll = [];
      return;
    }
    this.#frames.push(frame);
    this.#durationMs += frameMs;
    if (loud) {
      this.#voicedMs += frameMs;
      this.#quietMs = 0;
    } else {
      this.#quietMs += frameMs;
    }
    if (this.#quietMs >= this.#silenceMs || this.#durationMs >= this.#maxMs) this.#end();
  }

  /** Ends any utterance in progress, such as when the participant leaves. */
  flush(): void {
    if (this.#inSpeech) this.#end();
    this.#preRoll = [];
  }

  #end(): void {
    const frames = this.#frames;
    const voicedMs = this.#voicedMs;
    this.#inSpeech = false;
    this.#frames = [];
    this.#durationMs = 0;
    this.#voicedMs = 0;
    this.#quietMs = 0;
    if (voicedMs < this.#minSpeechMs) return;
    const samples = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      samples.set(f, offset);
      offset += f.length;
    }
    this.#onUtterance({ speakerId: this.#speakerId, startedAt: this.#startedAt, sampleRate: this.#sampleRate, samples });
  }
}
