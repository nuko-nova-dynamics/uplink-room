# The Notetaker's quality eval

Seven scripted calls with known answers, run through the real Notetaker from the audio onward, then scored. Use it before changing transcription, utterance handling, the summarizer prompt or task extraction, and keep its scorecard in `SCORECARD.md`.

## The calls

Each file in `calls/` is a script (who says what, in order) and its ground truth: the decisions, the tasks with their owners, and things that sound like tasks but aren't.

| Call | What it tests | Length |
|---|---|---|
| `01-standup` | Round-robin updates, a blocker, a moved deadline, a task nobody owns yet | 2.2 min |
| `02-planning` | A scope cut, several owners, a deferred idea, a question for someone not in the call | 2.6 min |
| `03-bug-triage` | Four bugs: fixed by its author, a duplicate, a deferral, an unreproducible report | 2.2 min |
| `04-crosstalk` | People talking over each other, finishing sentences, correcting themselves, backchannels | 2.3 min |
| `05-no-action-items` | A look back with nothing to do: finished work, a dream feature, one decision | 2.1 min |
| `06-handoff` | A task taken and later handed to someone else, a claim given up, an unneeded ticket | 2.1 min |
| `07-bilingual` | Spanish with English technical words, one-word replies, one sentence in English | 2.1 min |

`team.json` lists the team's people who are in no call; with everyone who is in one, they are what the fake `teams.members` returns.

## Run it

You need macOS (the speech comes from `say`), whisper.cpp's `whisper-cli`, a model, and the summarizer command (by default the Notetaker's own, `claude -p` with no tools, logged in). The model is `--model` or `WHISPER_MODEL`; there's no fallback, and the eval checks the file exists before it renders anything.

```sh
pnpm --filter @uplink-room/notetaker eval --round r2 --samples 2 \
  --model ~/.local/share/uplink-room/whisper/ggml-large-v3-turbo-q5_0.bin
```

Each call's script becomes one 16 kHz track per participant, one `say` voice each, with gaps, overlaps and a little noise. The real `Notetaker` joins a fake Room API and hears the tracks in 10 ms frames, as from LiveKit; whisper.cpp transcribes; when the call ends the summarizer writes the notes and tasks. Nothing goes to LiveKit or a deployment.

Options: `--calls 01,07` (a subset), `--samples N` (runs of the summarizer per call, since its answers vary), `--summarize-with "<command>"`, `--model`, `--language`, `--vad-threshold`, `--write-audio` (WAV files of each track, to listen to), `--no-cache` (transcribe every utterance again rather than read cached transcriptions), and `--rescore` (score a round's saved outputs again after changing the scoring or the known answers; it renders no speech and needs no model).

Results go to `out/<round>/` (ignored by git): a JSON file per call with every run's transcript, notes, tasks and scores, `scorecard.md`, and `judge.md`. Speech and transcriptions are cached in `out/cache/`, so a change to the notes alone doesn't run whisper again. A transcription's key holds the audio, the hints, the language setting, a hash of `src/whisper.ts` and `src/utterances.ts`, and the model file's and whisper binary's path, size and last change, so changing any of them transcribes again.

## The scores

- **WER**: word error rate of each speaker's transcript against what they were scripted to say. Case, accents, punctuation and number formatting ("48" and "forty eight") don't count.
- **Names right**: of the times someone said a teammate's first name, how many the transcript got right. Names decide owners, and WER counts them as one word among hundreds.
- **Task precision**: of the proposed tasks, how many match a known task, one to one. A known task matches by keywords in the proposal's title, which is what people read when they accept it.
- **Task recall**: of the known tasks that must be proposed, how many were. Some known tasks are optional: fine either way.
- **Owner accuracy**: of the matched tasks, how many have the right suggested owner, including none when nobody took it.
- **Decisions missed**: known decisions whose keywords are in neither the notes nor the tasks (which show right under the notes).
- **Invented**: proposed tasks that match no known task, such as work the call deferred or found unneeded.
- **Notes words**: the notes' length, averaged per run.

## The judge

The metrics can't tell whether notes are clear or padded. Each round, a fresh agent that hasn't seen earlier rounds grades `judge.md` (the scripts, the ground truth and the outputs) from F to A on accuracy, usefulness and concision, and lists fixes. Its brief is in `JUDGE.md`. A round passes with an A.

## Keep it honest

Don't write the calls' lines, or a judge's suggested wording taken from them, into the summarizer prompt as examples: the prompt then learns the test's answers and the grade means less. `test/eval.test.ts` fails if the prompt shares a five-word phrase with any call. Rounds r1 to r5 had such examples; r6 replaced them and kept the grade (`SCORECARD.md`).
