/**
 * Runs the Notetaker on each eval call, from the audio onward, and scores it.
 *
 *   node eval/run.ts --round r1 --model PATH [--calls 01,04] [--samples 2]
 *                    [--summarize-with "<command>"] [--concurrency 3] [--no-cache]
 *   node eval/run.ts --round r1 --rescore
 *
 * Each call's script becomes one track per participant (macOS `say`), fed to the
 * real Notetaker as LiveKit would: 10 ms frames per participant, then the call
 * ends. Transcription is real whisper.cpp; the notes come from the summarizer
 * command. The Room API is a fake that keeps what the Notetaker writes.
 * Results go to eval/out/<round>/: one JSON per call, scorecard.md, and
 * judge.md (the scripts, the known answers and the outputs, for a judge).
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AudioHandlers, JoinMedia } from "../src/media.ts";
import { SAMPLE_RATE } from "../src/media.ts";
import { Notetaker, type RoomApi } from "../src/notetaker.ts";
import { commandSummarizer, DEFAULT_SUMMARIZER, type Summarizer } from "../src/summarize.ts";
import { whisperTranscriber, type Transcriber } from "../src/whisper.ts";
import { renderCall, writeTracks, type RenderedCall } from "./audio.ts";
import { loadCalls, scoreRun, totals, type CallScore, type CallScript, type RunOutput } from "./lib.ts";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    round: { type: "string" },
    calls: { type: "string" },
    samples: { type: "string", default: "1" },
    model: { type: "string", default: process.env["WHISPER_MODEL"] },
    whisper: { type: "string", default: process.env["WHISPER_CLI"] ?? "whisper-cli" },
    language: { type: "string", default: "auto" },
    "summarize-with": { type: "string", default: DEFAULT_SUMMARIZER },
    "vad-threshold": { type: "string", default: "400" },
    concurrency: { type: "string", default: "3" },
    "write-audio": { type: "boolean", default: false },
    /** Transcribe every utterance again instead of reading cached transcriptions (fresh results still go to the cache). */
    "no-cache": { type: "boolean", default: false },
    /** Score a round's saved outputs again (after a change to the scoring or the known answers), without running anything. */
    rescore: { type: "boolean", default: false },
  },
});
if (!values.round) throw new Error("--round <name> is needed (results go to eval/out/<name>/)");

const RECOMMENDED_MODELS =
  "Use ggml-large-v3-turbo-q5_0.bin on a machine with a GPU, or ggml-base.bin on CPU alone (packages/notetaker/README.md, \"Which model\").";
/** The model file, checked before anything is rendered. Rescoring runs nothing, so it needs none. */
const model = values.model ?? "";
if (!values.rescore) {
  if (!model) throw new Error(`Pass --model or set WHISPER_MODEL to a whisper.cpp model file. ${RECOMMENDED_MODELS}`);
  try {
    if (!statSync(model).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`No whisper.cpp model file at ${model}. ${RECOMMENDED_MODELS}`);
  }
}

const outDir = join(here, "out", values.round);
const cacheDir = join(here, "out", "cache");
const calls = await loadCalls(join(here, "calls"), values.calls?.split(","));
const samples = Number(values.samples);
/** The team (teams.members): everyone in any call, and the people in team.json who are in none. */
const team = new Map<string, string>();
for (const call of await loadCalls(join(here, "calls"))) for (const p of call.people) team.set(p.id, p.name);
for (const p of (JSON.parse(await readFile(join(here, "team.json"), "utf8")) as { people: { id: string; name: string }[] }).people) team.set(p.id, p.name);

/** A file's identity for the cache: its real path, size and last change, so a new model or binary at the same path misses. */
function fileIdentity(path: string): string {
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    return `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${path}:missing`;
  }
}

/** Where a command runs from: itself if it's a path, else the first match on PATH. */
function onPath(command: string): string {
  if (isAbsolute(command) || command.includes("/")) return command;
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return command;
}

/**
 * What a cached transcription depends on besides the audio and the hints: the
 * transcription code (whisper.ts, utterances.ts), the model file, the whisper
 * binary and the language setting. A change to any of them misses the cache.
 */
async function transcriptionIdentity(): Promise<string> {
  const code = createHash("sha256");
  for (const file of ["whisper.ts", "utterances.ts"]) code.update(await readFile(join(here, "..", "src", file)));
  return JSON.stringify([code.digest("hex"), fileIdentity(model), fileIdentity(onPath(values.whisper)), values.language]);
}

/** Caches transcriptions by audio, hints and transcriptionIdentity(), so a rerun that only changes the notes skips whisper. */
function cached(transcribe: Transcriber, label: string, read: boolean): Transcriber {
  return async (utterance, ...rest) => {
    const key = createHash("sha256")
      .update(label)
      .update(JSON.stringify(rest))
      .update(new Uint8Array(utterance.samples.buffer, utterance.samples.byteOffset, utterance.samples.byteLength))
      .digest("hex")
      .slice(0, 32);
    const file = join(cacheDir, "whisper", `${key}.json`);
    if (read) {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Awaited<ReturnType<Transcriber>>;
      } catch {
        // Not cached yet.
      }
    }
    const result = await transcribe(utterance, ...rest);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result));
    return result;
  };
}

const transcribe = cached(
  whisperTranscriber({ model, binary: values.whisper, language: values.language }),
  await transcriptionIdentity(),
  !values["no-cache"],
);
const summarize: Summarizer = commandSummarizer(values["summarize-with"]);

type Member = { memberId: string; name: string; kind: "person" | "agent" };

/** A Room API for one call that keeps the transcript, notes and proposals the Notetaker writes. */
function evalRoom(call: CallScript, members: Member[]) {
  const callId = `call_${call.id}`;
  const channelId = `ch_${call.channel}`;
  const lines = new Map<string, { speakerId: string; text: string; at: number }>();
  let ended: number | undefined;
  let notes = "";
  let proposed: { title: string; description?: string; ownerId?: string }[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const watchers = new Set<(view: unknown) => void>();
  const byId = new Map(members.map((m) => [m.memberId, m]));
  const view = () => ({
    callId,
    channelId,
    ...(ended !== undefined ? { endedAt: ended } : {}),
    participants: ended !== undefined ? [] : members.map((m) => ({ ...m, takesNotes: m.kind === "agent" })),
    everyone: members,
  });
  const api: RoomApi = {
    async call(fn, args = {}) {
      switch (fn) {
        case "calls.join":
          return { callId, participationId: "p_notetaker", url: "ws://eval", token: "eval" };
        case "calls.addTranscript":
          for (const line of args["lines"] as { speakerId: string; text: string; at: number; key: string }[]) lines.set(line.key, line);
          return null;
        case "calls.transcript":
          return { lines: [...lines.values()].sort((a, b) => a.at - b.at).map((l) => ({ speaker: byId.get(l.speakerId), text: l.text, at: l.at })) };
        case "calls.get":
          return view();
        case "channels.list":
          return [{ channelId, name: call.channel }];
        case "teams.members":
          return [
            ...[...team].map(([id, name]) => byId.get(`m_${id}`) ?? { memberId: `m_${id}`, name, kind: "person" }),
            { memberId: "m_notetaker", name: "Notetaker", kind: "agent" },
          ];
        case "calls.postNotes":
          notes = args["body"] as string;
          return "msg_notes";
        case "calls.propose":
          proposed = args["tasks"] as typeof proposed;
          resolveDone();
          return [];
        default:
          return null;
      }
    },
    watch(fn, _args, onUpdate) {
      if (fn !== "calls.get") return () => {};
      watchers.add(onUpdate);
      queueMicrotask(() => watchers.has(onUpdate) && onUpdate(view()));
      return () => watchers.delete(onUpdate);
    },
  };
  return {
    api,
    callId,
    channelId,
    end() {
      ended = Date.now();
      for (const w of watchers) w(view());
    },
    done,
    fail: (error: Error) => rejectDone(error),
    result: (): RunOutput => ({
      transcript: [...lines.values()].sort((a, b) => a.at - b.at).map((l) => ({ speaker: byId.get(l.speakerId)?.name ?? l.speakerId, text: l.text, at: l.at })),
      notes,
      tasks: proposed.map((t) => ({
        title: t.title,
        ...(t.description ? { description: t.description } : {}),
        owner: t.ownerId ? (byId.get(t.ownerId)?.name ?? t.ownerId) : null,
      })),
    }),
  };
}

/** Runs the Notetaker on one rendered call: joins, hears every track, then the call ends and it writes the notes. */
async function runCall(call: CallScript, rendered: RenderedCall, log: string[]): Promise<RunOutput> {
  const members: Member[] = [
    ...call.people.map((p) => ({ memberId: `m_${p.id}`, name: p.name, kind: "person" as const })),
    { memberId: "m_notetaker", name: "Notetaker", kind: "agent" },
  ];
  const room = evalRoom(call, members);
  let answer: Awaited<ReturnType<Summarizer>> | undefined;
  const summarizeAndKeep: Summarizer = async (input) => (answer = await summarize(input));
  let handlers: AudioHandlers | undefined;
  const joinMedia: JoinMedia = async (_url, _token, h) => {
    handlers = h;
    return { leave: async () => {} };
  };
  const notetaker = new Notetaker({
    api: room.api,
    joinMedia,
    transcribe,
    summarize: summarizeAndKeep,
    segmenter: { threshold: Number(values["vad-threshold"]) },
    heartbeatMs: 60_000,
    finishGiveUpMs: 30_000,
    log: (m) => {
      log.push(m);
      if (process.env["EVAL_DEBUG"]) console.error(`${call.id}: ${m}`);
      if (m.startsWith("Couldn't write the call notes")) room.fail(new Error(`${call.id}: ${m}\nLog:\n${log.join("\n")}`));
    },
  });
  await notetaker.join({ callId: room.callId, channelId: room.channelId });
  if (!handlers) throw new Error("The Notetaker didn't join the call's media.");
  // A fixed start time, so the transcript's timestamps are the same on every run.
  const base = Date.UTC(2026, 10, 4, 16, 0, 0);
  const frame = SAMPLE_RATE / 100;
  const length = rendered.tracks.values().next().value!.length;
  for (let s = 0; s + frame <= length; s += frame) {
    for (const person of call.people) handlers.onAudio(`m_${person.id}.p1`, rendered.tracks.get(person.id)!.subarray(s, s + frame), base + (s / SAMPLE_RATE) * 1000);
  }
  for (const person of call.people) handlers.onSpeakerGone(`m_${person.id}.p1`);
  room.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    room.done,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${call.id}: no proposals after 10 minutes. Log:\n${log.join("\n")}`)), 10 * 60_000);
    }),
  ]).finally(() => clearTimeout(timer));
  await notetaker.stop();
  return { ...room.result(), ...(answer ? { summarizerTasks: answer.tasks.map((t) => ({ title: t.title, ...(t.owner ? { owner: t.owner } : {}) })) } : {}) };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

await mkdir(outDir, { recursive: true });
const started = Date.now();
/** When each turn was placed in the call; a round saved before this was kept has the script's order but no times. */
type Placed = { speaker: string; text: string; startMs?: number; overlaps: boolean };
type Run = { output: RunOutput; score: CallScore; log: string[]; seconds: number };
type Saved = { call: string; durationMs?: number; placed?: Placed[]; runs: Run[] };

const results = await pool(calls, Number(values.concurrency), async (call): Promise<{ call: CallScript; placed: Placed[]; runs: Run[] }> => {
  if (values.rescore) {
    // Only the saved outputs and the known answers: no speech is rendered, so no `say` or TTS cache is needed.
    const saved = JSON.parse(await readFile(join(outDir, `${call.id}.json`), "utf8")) as Saved;
    const runs = saved.runs.map((r, i) => ({ ...r, score: scoreRun(call, r.output, i + 1, [...team.values()]) }));
    const placed = saved.placed ?? call.turns.map((t) => ({ speaker: t.speaker, text: t.text, overlaps: t.during !== undefined || t.overlapMs !== undefined }));
    await writeFile(join(outDir, `${call.id}.json`), JSON.stringify({ ...saved, runs }, null, 2));
    return { call, placed, runs };
  }
  const rendered = await renderCall(call, cacheDir);
  if (values["write-audio"]) await writeTracks(call, rendered, join(here, "out", "audio"));
  const runs: Run[] = [];
  for (let sample = 1; sample <= samples; sample++) {
    const log: string[] = [];
    const t0 = Date.now();
    const output = await runCall(call, rendered, log);
    const score = scoreRun(call, output, sample, [...team.values()]);
    runs.push({ output, score, log, seconds: Math.round((Date.now() - t0) / 1000) });
    console.log(`${call.id} #${sample}: ${runs.at(-1)!.seconds}s, ${output.tasks.length} task(s), WER ${(score.wer.edits / score.wer.words).toFixed(3)}`);
  }
  const saved: Saved = { call: call.id, durationMs: rendered.durationMs, placed: rendered.placed, runs };
  await writeFile(join(outDir, `${call.id}.json`), JSON.stringify(saved, null, 2));
  return { call, placed: rendered.placed, runs };
});

// ---------- scorecard ----------

const pct = (n: number) => `${Math.round(n * 100)}%`;
const all = results.flatMap((r) => r.runs.map((x) => x.score));
const t = totals(all);
const md: string[] = [
  `# Notetaker eval: ${values.round}`,
  "",
  values.rescore
    ? `Rescored from the saved outputs: ${Math.max(...results.map((r) => r.runs.length))} sample(s) per call.`
    : `Model: \`${model.replace(homedir(), "~")}\`, language \`${values.language}\`, summarizer \`${values["summarize-with"]}\`, ${samples} sample(s) per call, ${Math.round((Date.now() - started) / 1000)}s.`,
  "",
  "| Call | WER | Names right | Task precision | Task recall | Owner accuracy | Decisions missed | Invented | Notes words |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map(({ call, runs }) => {
    const c = totals(runs.map((r) => r.score));
    return `| ${call.id} | ${c.wer.toFixed(3)} | ${pct(c.namesRight)} | ${pct(c.taskPrecision)} | ${pct(c.taskRecall)} | ${pct(c.ownerAccuracy)} | ${c.decisionsMissed}/${c.decisionsRequired} | ${c.invented} | ${c.notesWords} |`;
  }),
  `| **All** | **${t.wer.toFixed(3)}** | **${pct(t.namesRight)}** | **${pct(t.taskPrecision)}** | **${pct(t.taskRecall)}** | **${pct(t.ownerAccuracy)}** | **${t.decisionsMissed}/${t.decisionsRequired}** | **${t.invented}** | **${t.notesWords}** |`,
  "",
  "## Misses",
  "",
];
for (const { call, runs } of results) {
  for (const { score } of runs) {
    const items = [
      ...score.tasks.missed.map((m) => `missed task: ${m}`),
      ...score.tasks.wrongOwners.map((m) => `wrong owner: ${m}`),
      ...score.tasks.invented.map((m) => `invented task: ${m}${score.tasks.traps.includes(m) ? " (one the call ruled out)" : ""}`),
      ...(score.tasks.duplicates ? [`duplicate task(s): ${score.tasks.duplicates}`] : []),
      ...score.decisions.missed.map((m) => `missed decision: ${m}`),
      ...score.names.missed.map((m) => `name: ${m}`),
    ];
    if (items.length) md.push(`- ${call.id} #${score.sample}: ${items.join("; ")}`);
  }
}
await writeFile(join(outDir, "scorecard.md"), md.join("\n") + "\n");
await writeFile(join(outDir, "scorecard.json"), JSON.stringify({ round: values.round, model, summarizer: values["summarize-with"], totals: t, scores: all }, null, 2));

// ---------- the judge's bundle: scripts, known answers, outputs ----------

const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;
const judge: string[] = ["# Calls to grade", ""];
for (const { call, placed, runs } of results) {
  const name = new Map(call.people.map((p) => [p.id, p.name]));
  const out = runs[0]!.output;
  judge.push(
    `## ${call.id}`,
    "",
    `${call.kind}. Channel #${call.channel}. People: ${call.people.map((p) => p.name).join(", ")}.`,
    "",
    "### Script (what was actually said; [over] marks speech over someone else)",
    "",
    ...placed.map((p) => `- ${p.startMs === undefined ? "--:--" : clock(p.startMs)} ${name.get(p.speaker)}${p.overlaps ? " [over]" : ""}: ${p.text}`),
    "",
    "### Ground truth",
    "",
    "Decisions:",
    ...call.truth.decisions.map((d) => `- ${d.text}${d.optional ? " (optional)" : ""}`),
    ...(call.truth.decisions.length ? [] : ["- (none)"]),
    "",
    "Tasks (owner):",
    ...call.truth.tasks.map(
      (x) =>
        `- ${x.title} (${(Array.isArray(x.owner) ? x.owner : [x.owner]).map((o) => (o ? name.get(o) : "no owner")).join(" or ")})${x.optional ? " (optional: fine either way)" : ""}`,
    ),
    ...(call.truth.tasks.length ? [] : ["- (none)"]),
    "",
    "Not tasks:",
    ...call.truth.notTasks.map((n) => `- ${n.text}`),
    ...(call.truth.notTasks.length ? [] : ["- (none)"]),
    ...(call.truth.notes ? ["", `Note: ${call.truth.notes}`] : []),
    "",
    "### Output: call notes (posted in the channel as Markdown)",
    "",
    "````markdown",
    out.notes,
    "````",
    "",
    "### Output: proposed tasks (shown under the notes; each is accepted or dismissed)",
    "",
    ...out.tasks.map((x) => `- **${x.title}** (suggested owner: ${x.owner ?? "none"})${x.description ? `: ${x.description}` : ""}`),
    ...(out.tasks.length ? [] : ["- (none)"]),
    "",
    "### Output: transcript (speech-to-text, one line per utterance)",
    "",
    ...out.transcript.map((l) => `- ${clock(l.at - Date.UTC(2026, 10, 4, 16, 0, 0))} ${l.speaker}: ${l.text}`),
    "",
  );
}
await writeFile(join(outDir, "judge.md"), judge.join("\n"));
console.log(md.slice(0, 7 + results.length).join("\n"));
console.log(`\nWrote ${join(outDir, "scorecard.md")} and judge.md`);
