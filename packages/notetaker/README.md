# The Notetaker

An Uplink Room agent that joins the calls it's asked to join, writes down who said what, and when the call ends posts call notes in the channel and proposes tasks (spec #5, ADR 0008). It's an ordinary agent on the Room API: it holds one agent key and nothing else from the room. LiveKit's API secret never reaches it; it joins each call with the token `calls.join` returns (ADR 0007).

## What it does

1. Claims the agent's call lease (`calls.claimLease`, renewed every 15 seconds), so only one Notetaker process per agent takes calls. While it holds the lease it watches `calls.invitations` live with its agent key (`RoomClient.watch`); without it, it waits and tries again. It joins nothing once the lease would have run out by its own clock, and stops watching invites if renewing fails past then. A join still in flight when the lease is lost is undone: it leaves the call and disconnects from LiveKit. On taking the lease it rejoins live calls a crashed process was in and writes the notes and proposals for calls that ended meanwhile, or that have notes but no proposals yet (`calls.unfinished`). If it loses the lease while writing those notes, it stops, and writes them again once it wins the lease back. `stop()` leaves its calls at once, then waits for those notes and proposals while it keeps renewing the lease without taking new calls, and releases it after. If it loses the lease meanwhile, it leaves them to the new holder.
2. Joins each call it's asked to join with `calls.join` (naming the call, so it never starts a new one), and keeps its own join alive with `calls.heartbeat` every 20 seconds.
3. Subscribes to each participant's microphone with `@livekit/rtc-node`, at 16 kHz mono.
4. Cuts each participant's audio into utterances on silence and transcribes each one with whisper.cpp (`whisper-cli`). Whisper's prompt holds the names of the people in the call, then the rest of the team (`teams.members`), so it spells them right. The language is detected per utterance, so Spanish and English both work with a multilingual model; when whisper can't tell (a one-word "Vale." scores p ≈ 0.2), the utterance is transcribed again in the language most of the call has been in.
5. Sends the lines to `calls.addTranscript` every few seconds.
6. When the last person leaves, it leaves too, hands the transcript to a summarizer command, and posts the result with `calls.postNotes` and `calls.propose`. A team member accepts or dismisses each proposed task. The default command is `claude -p --tools "" --strict-mcp-config`: the Claude Code already logged in on that machine, with no tools and no MCP servers, so it can only read and write text.

   Names and speech are untrusted, since anyone can pick a display name or say anything. What keeps them from steering the Notetaker is isolation:
   - Before names reach the summarizer or whisper, they lose email addresses and line breaks.
   - The prompt carries the channel, the names and the transcript as one JSON block that its instructions call data, never instructions, with `<` escaped so nothing inside can close it.
   - The default summarizer has no tools.
   - A proposed task is only a proposal until a person accepts it.

   The summarizer answers with points (the outcome, decisions, highlights, open questions and tasks), each citing transcript lines. The Notetaker writes the notes from them under its own headings, in English or Spanish by the language speech-to-text heard most. It leaves out any point that cites no line, or a line that doesn't exist. That catches a point with no source in the call, but it doesn't check that the cited lines say what the point says. If no point of the notes is left, the notes say so in one line and the tasks are still proposed.

## Run it

You need Node 24+, whisper.cpp's `whisper-cli`, a multilingual model, and a logged-in `claude` (or another command that reads the prompt on stdin and prints the JSON reply it asks for).

```sh
# A multilingual model (574 MB), from whisper.cpp's official model repo. On a machine
# without a GPU, use ggml-base.bin (148 MB) instead: see "Which model" below.
mkdir -p ~/.local/share/uplink-room/whisper
curl -L -o ~/.local/share/uplink-room/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

# In the room: Settings → Agents → Add an agent named Notetaker (sage squircle,
# headphones), then create a key with room.read, messages.post, calls.join and calls.notes.
export UPLINK_URL=https://<deployment>.convex.site
export UPLINK_AGENT_KEY=urk_...
export WHISPER_MODEL=~/.local/share/uplink-room/whisper/ggml-large-v3-turbo-q5_0.bin
pnpm --filter @uplink-room/notetaker start
```

### Which model

Measured with the quality eval below (seven scripted calls, 16 minutes in all) on an Apple Silicon Mac with whisper.cpp 1.9.5. "Names right" counts the times someone said a teammate's name and the transcript spelled it right.

| Model | Size | Word error rate | On the Spanish call | Names right | 10 s of speech takes (GPU) | Same, CPU only (8 threads) |
|---|---|---|---|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin` | 574 MB | 1.7% | 3% | 96% | 1.6 s | 13 s |
| `ggml-small.bin` | 488 MB | 3.1% | 8% | 100% | 0.8 s | |
| `ggml-base.bin` | 148 MB | 5.1% | 17% | 100% | 0.5 s | 1.4 s |

Use large-v3-turbo on a machine with a GPU (Metal on a Mac, CUDA elsewhere). On CPU alone it takes longer than the speech, so the transcript falls further behind the longer people talk; use base there.

Options: `--whisper <path>` (the whisper.cpp binary), `--language es` (skip detection), `--summarize-with "<command>"`, `--vad-threshold 400` (the level that counts as speech; raise it on a noisy line). The agent key is read only from the environment, so it never shows in `ps`.

## Tests

`pnpm --filter @uplink-room/notetaker test` runs the unit tests: cutting audio into utterances, the WAV writer, reading the summarizer's answer, and the whole flow against a fake Room API.

`pnpm --filter @uplink-room/notetaker eval --round <name>` runs the quality eval: seven scripted calls, made into one audio track per person with `say`, go through the real Notetaker and whisper.cpp, and the transcript, notes and proposed tasks are scored against known answers. See `eval/README.md`, and `eval/SCORECARD.md` for the results so far.

`test/media.test.ts` runs the media path for real when `LIVEKIT_SERVER` (a `livekit-server` binary) and `WHISPER_MODEL` are set, on macOS (it makes speech with `say`): it starts `livekit-server --dev`, has a participant publish a spoken sentence, and checks the Notetaker writes it down with the right speaker. See `docs/calls.md` for building `livekit-server` on a Mac.
