/**
 * A scripted call participant for smoke runs (apps/desktop/scripts/call-smoke.ts):
 * joins a LiveKit room with a token from `calls.join` and plays a 16 kHz mono
 * WAV as its microphone, in a loop with pauses, until it's stopped. Nothing
 * plays aloud; the audio only goes to the call.
 *
 *   node scripts/participant.ts --url ws://127.0.0.1:7880 --token <jwt> --wav speech.wav
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";

const { values } = parseArgs({
  options: { url: { type: "string" }, token: { type: "string" }, wav: { type: "string" }, pause: { type: "string", default: "2500" } },
});
if (!values.url || !values.token || !values.wav) throw new Error("--url, --token and --wav are needed");

const file = await readFile(values.wav);
const at = file.indexOf("data");
const start = file.byteOffset + at + 8;
const speech = new Int16Array(file.buffer.slice(start, start + file.readUInt32LE(at + 4)));

const room = new Room();
await room.connect(values.url, values.token, { autoSubscribe: false, dynacast: false });
const source = new AudioSource(16_000, 1);
await room.localParticipant!.publishTrack(
  LocalAudioTrack.createAudioTrack("microphone", source),
  new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
);
console.log("participant: connected and speaking");

let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await room.disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

const silence = new Int16Array(160);
while (!stopped) {
  for (let i = 0; i + 160 <= speech.length && !stopped; i += 160) {
    await source.captureFrame(new AudioFrame(speech.slice(i, i + 160), 16_000, 1, 160));
  }
  for (let ms = 0; ms < Number(values.pause) && !stopped; ms += 10) {
    await source.captureFrame(new AudioFrame(silence, 16_000, 1, 160));
  }
}
