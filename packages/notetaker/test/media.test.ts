/**
 * Seam 2 (spec #5): the Notetaker against a real LiveKit server and real
 * whisper.cpp. A fake participant publishes speech made with macOS `say`; the
 * Notetaker joins with a token, transcribes it, and writes the line to a fake
 * Room API. Runs only when LIVEKIT_SERVER (the livekit-server binary) and
 * WHISPER_MODEL (a ggml model) are set; `say` makes the speech, so macOS only.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { afterAll, beforeAll, expect, test } from "vitest";
import { joinLiveKit } from "../src/media.ts";
import { Notetaker, type RoomApi } from "../src/notetaker.ts";
import { whisperTranscriber } from "../src/whisper.ts";

const SERVER = process.env["LIVEKIT_SERVER"];
const MODEL = process.env["WHISPER_MODEL"];
const enabled = Boolean(SERVER && MODEL && process.platform === "darwin");
const PORT = 17880;
const URL = `ws://127.0.0.1:${PORT}`;

let server: ChildProcess | undefined;
let dir = "";

async function token(identity: string): Promise<string> {
  const at = new AccessToken("devkey", "secret", { identity, ttl: 600 });
  at.addGrant({ room: "call_c1", roomJoin: true, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

beforeAll(async () => {
  if (!enabled) return;
  dir = await mkdtemp(join(tmpdir(), "notetaker-media-"));
  server = spawn(SERVER!, [
    "--dev",
    "--bind",
    "127.0.0.1",
    "--node-ip",
    "127.0.0.1",
    "--config-body",
    // Loopback only: no TCP listener (it would bind every interface) and UDP on 127.0.0.1 alone, so
    // nothing listens on the network and the macOS firewall never asks about this binary.
    `port: ${PORT}\nrtc:\n  tcp_port: 0\n  udp_port: ${PORT + 2}\n  enable_loopback_candidate: true\n  use_external_ip: false\n  ips:\n    includes:\n      - 127.0.0.1/32\n`,
    // Dev mode logs a lot; an unread pipe would fill and stall the server.
  ], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("livekit-server didn't start");
});

afterAll(async () => {
  server?.kill("SIGTERM");
  if (dir) await rm(dir, { recursive: true, force: true });
});

test.skipIf(!enabled)("the Notetaker hears a participant over LiveKit and writes what they said, with who said it", async () => {
  const speech = join(dir, "speech.wav");
  await promisify(execFile)("say", ["-o", speech, "--data-format=LEI16@16000", "Ana, can you take the save slot bug before Friday?"]);
  // `say` writes extra chunks before the samples, so find the "data" chunk.
  const file = await readFile(speech);
  const at = file.indexOf("data");
  const start = file.byteOffset + at + 8;
  const pcm = new Int16Array(file.buffer.slice(start, start + file.readUInt32LE(at + 4)));

  const lines: { speakerId: string; text: string }[] = [];
  const api: RoomApi = {
    async call(fn, args = {}) {
      if (fn === "calls.join") return { callId: "c1", url: URL, token: await token("m_note") };
      if (fn === "calls.addTranscript") lines.push(...(args["lines"] as typeof lines));
      return null;
    },
    watch: () => () => {},
  };
  const notetaker = new Notetaker({
    api,
    joinMedia: joinLiveKit,
    transcribe: whisperTranscriber({ model: MODEL!, language: "auto" }),
    summarize: async () => ({ notes: "", tasks: [] }),
  });

  const julio = new Room();
  await julio.connect(URL, await token("m_julio"), { autoSubscribe: false, dynacast: false });
  const source = new AudioSource(16_000, 1);
  const track = LocalAudioTrack.createAudioTrack("microphone", source);
  await julio.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

  await notetaker.join({ callId: "c1", channelId: "ch1" });
  await new Promise((r) => setTimeout(r, 1500));

  // Speak, then a second and a half of silence so the utterance ends.
  const samples = new Int16Array(pcm.length + 16_000 * 1.5);
  samples.set(pcm);
  for (let i = 0; i + 160 <= samples.length; i += 160) {
    await source.captureFrame(new AudioFrame(samples.slice(i, i + 160), 16_000, 1, 160));
  }
  await source.waitForPlayout();

  for (let i = 0; i < 60 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 500));
  await notetaker.stop();
  await julio.disconnect();

  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0]!.speakerId).toBe("m_julio");
  const said = lines.map((l) => l.text).join(" ").toLowerCase();
  expect(said).toContain("save slot");
  expect(said).toContain("friday");
});

test.skipIf(!enabled)("a second client with the same identity replaces the first, which hears DUPLICATE_IDENTITY", async () => {
  const replaced: string[] = [];
  const first = await joinLiveKit(URL, await token("m_note"), {
    onAudio: () => {},
    onSpeakerGone: () => {},
    onDisconnected: () => replaced.push("disconnected"),
    onReplaced: () => replaced.push("replaced"),
  });
  const second = await joinLiveKit(URL, await token("m_note"), { onAudio: () => {}, onSpeakerGone: () => {} });
  for (let i = 0; i < 40 && replaced.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
  await second.leave();
  await first.leave();
  expect(replaced).toEqual(["replaced"]);
});
