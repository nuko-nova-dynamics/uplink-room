import { expect, test } from "vitest";
import { Segmenter, type Utterance } from "../src/utterances.ts";
import { cleanTranscript, wav } from "../src/whisper.ts";

const RATE = 16_000;
const FRAME = 160; // 10 ms

function frames(ms: number, amplitude: number): Int16Array[] {
  const out: Int16Array[] = [];
  for (let i = 0; i < ms / 10; i++) {
    const frame = new Int16Array(FRAME);
    for (let s = 0; s < FRAME; s++) frame[s] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * (i * FRAME + s)) / RATE));
    out.push(frame);
  }
  return out;
}

function feed(parts: [ms: number, amplitude: number][]): Utterance[] {
  const heard: Utterance[] = [];
  const segmenter = new Segmenter("member_ana", { sampleRate: RATE }, (u) => heard.push(u));
  let at = 1_000_000;
  for (const [ms, amplitude] of parts) {
    for (const frame of frames(ms, amplitude)) {
      segmenter.push(frame, at);
      at += 10;
    }
  }
  segmenter.flush();
  return heard;
}

test("speech between silences becomes one utterance, starting just before the first loud frame", () => {
  const heard = feed([
    [1000, 0],
    [1200, 6000],
    [1000, 0],
  ]);
  expect(heard).toHaveLength(1);
  const [u] = heard;
  expect(u!.speakerId).toBe("member_ana");
  expect(u!.startedAt).toBeGreaterThanOrEqual(1_000_000 + 1000 - 220);
  expect(u!.startedAt).toBeLessThanOrEqual(1_000_000 + 1000);
  const seconds = u!.samples.length / RATE;
  expect(seconds).toBeGreaterThan(1.2);
  expect(seconds).toBeLessThan(2.2);
});

test("a short click isn't an utterance, and a pause shorter than the silence doesn't split one", () => {
  expect(feed([[500, 0], [100, 6000], [1000, 0]])).toEqual([]);
  expect(feed([[800, 6000], [400, 0], [800, 6000], [1000, 0]])).toHaveLength(1);
});

test("a long monologue is cut every 20 seconds so lines keep coming", () => {
  expect(feed([[45_000, 6000]])).toHaveLength(3);
});

test("audio is written as a 16 kHz mono WAV for whisper.cpp", () => {
  const file = wav(new Int16Array([0, 1000, -1000]), RATE);
  const view = new DataView(file.buffer);
  expect(String.fromCharCode(...file.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(RATE);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getInt16(46, true)).toBe(1000);
  expect(file.length).toBe(44 + 6);
});

test("whisper.cpp's noise tags are not speech", () => {
  expect(cleanTranscript(" [BLANK_AUDIO]\n")).toBe("");
  expect(cleanTranscript(" (music) Ana takes the save slot bug.\n [Música]\n")).toBe("Ana takes the save slot bug.");
});
