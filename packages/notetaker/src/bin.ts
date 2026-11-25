#!/usr/bin/env node
/**
 * uplink-notetaker: runs the Notetaker on this machine (ADR 0008).
 *
 *   UPLINK_URL=https://<deployment>.convex.site \
 *   UPLINK_AGENT_KEY=urk_... \
 *   uplink-notetaker --model ~/.local/share/uplink-room/whisper/ggml-base.bin
 *
 * The agent key needs the room.read, messages.post, calls.join and calls.notes
 * scopes. The key is read from the environment only, so it never shows in `ps`.
 */
import { parseArgs } from "node:util";
import { onClosedOutput, RoomClient } from "@uplink-room/room-client";
import { joinLiveKit } from "./media.ts";
import { Notetaker } from "./notetaker.ts";
import { commandSummarizer, DEFAULT_SUMMARIZER } from "./summarize.ts";
import { whisperTranscriber } from "./whisper.ts";

// Whoever read its output is gone, so stop rather than crash on the next line (closedOutput.ts).
onClosedOutput(() => process.exit());

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env["UPLINK_URL"] },
    model: { type: "string", default: process.env["WHISPER_MODEL"] },
    whisper: { type: "string", default: process.env["WHISPER_CLI"] ?? "whisper-cli" },
    language: { type: "string", default: "auto" },
    "summarize-with": { type: "string", default: DEFAULT_SUMMARIZER },
    "vad-threshold": { type: "string", default: "400" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`uplink-notetaker [--url URL] [--model PATH] [--whisper whisper-cli] [--language auto]
                 [--summarize-with '${DEFAULT_SUMMARIZER}'] [--vad-threshold 400]

Joins the Uplink Room calls it's asked to join, transcribes each participant with
whisper.cpp, and posts call notes and proposed tasks when the call ends.

Environment: UPLINK_URL (the deployment's site URL), UPLINK_AGENT_KEY (required),
WHISPER_MODEL (a ggml model file), WHISPER_CLI.`);
  process.exit(0);
}

const key = process.env["UPLINK_AGENT_KEY"];
if (!values.url || !key || !values.model) {
  console.error("Set UPLINK_URL, UPLINK_AGENT_KEY and WHISPER_MODEL (or --url and --model). See --help.");
  process.exit(2);
}

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const client = new RoomClient({ url: values.url, key });
const notetaker = new Notetaker({
  api: client,
  joinMedia: joinLiveKit,
  transcribe: whisperTranscriber({ model: values.model, binary: values.whisper, language: values.language, log }),
  summarize: commandSummarizer(values["summarize-with"]),
  segmenter: { threshold: Number(values["vad-threshold"]) },
  log,
});

notetaker.start();
log("Watching for calls to join.");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("Leaving calls.");
  await notetaker.stop();
  await client.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
