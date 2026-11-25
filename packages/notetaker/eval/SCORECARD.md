# Scorecard

One row per round of the quality eval (`README.md`). Each round was graded by a fresh judge (GPT-6.1 Sol, xhigh, with `JUDGE.md`) that saw only that round's `judge.md`, which holds the first of each call's samples. The summarizer is `claude -p` with the machine's default model; two samples per call. WER and names are the same across a round's samples, since the audio and whisper settings are.

## Result

The loop stopped after r8: neither r7 nor r8 improved on r6, two rounds in a row. The best grade, A− with accuracy A and four of seven calls at A, is short of the A the loop aimed for. r8 is the code in this branch. Rounds r1 to r5 had examples from the calls themselves in the prompt; from r6 they don't, and `test/eval.test.ts` keeps it that way.

## Metrics

| Round | Setup | Judge | WER | Names right | Task precision | Task recall | Owner accuracy | Decisions missed | Invented | Notes words |
|---|---|---|---|---|---|---|---|---|---|---|
| r0 | The code before this work, `ggml-base` | **B+** (accuracy B+, usefulness B+, concision B−) | 4.9% | 57% | 97% | 100% | 100% | 0/26 | 0 | 185 |
| r1 | Turbo model, names and language hints, new prompt, owner matching | **B+** (accuracy A−, usefulness B+, concision B) | 1.7% | 96% | 100% | 98% | 98% | 0/26 | 0 | 131 |
| r2 | Prompt: owners from "I'll do it", promised outcomes, each fact once, highlights | **B+** (accuracy A−, usefulness B+, concision A−) | 1.7% | 96% | 100% | 98% | 100% | 0/26 | 0 | 79 |
| r3 | Prompt: a task carries its requirements, two-sentence descriptions, outcome first, backlog work is a task | **A−** (accuracy A−, usefulness A−, concision A−) | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 65 |
| r4 | Prompt: deadlines in titles, prerequisites, misheard subjects from context; the eval's dropped word fixed | **A−** (accuracy A−, usefulness A−, concision A−); five calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 59 |
| r5 | Prompt: every committed step in the title, "Backlog:", no history or self-evident reasons | **A−** (accuracy A, usefulness A−, concision A−); five calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 58 |
| r6 | r5 with the prompt's examples replaced by ones from none of the calls | **A−** (accuracy A, usefulness A−, concision A−); four calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 65 |
| r7 | Prompt: titles say what a bug is about, open questions keep unexplained problems, instructions not request history | **A−** (accuracy A−, usefulness A−, concision A−); four calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 69 |
| r8 | Prompt: a deadline as it was said; Decisions leave out the first line's | **A−** (accuracy A, usefulness A−, concision A−); four calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 67 |
| r9 | After review: the call as one JSON block of untrusted data, cited points, notes built by the Notetaker, a tool-free summarizer | **A−** (accuracy A−, usefulness A−, concision A−); three calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 64 |
| r10 | After the second review: citations need only exist (no word-overlap gate), fixed headings in code, notes never fail | **A−** (accuracy A−, usefulness A, concision A−); four calls A | 1.7% | 96% | 100% | 100% | 100% | 0/26 | 0 | 65 |

Ablation, not judged: r1's code with `ggml-base` got WER 5.1%, names 100%, precision 98%, recall 100%, owners 100%, 1 invented task, 126 words. The prompt alone shortens the notes; the model alone cuts the WER; the names prompt alone fixes the names.

Rounds r0 to r3 share the same audio, including one clip in which `say` had dropped the word "sheet" (06-handoff, Priya: "the new screenshots and the fact sheet"). From r4 the eval keeps a clip only once two renders agree, and that clip is whole. So r4's handoff call is not fully comparable with earlier rounds.

## Rounds

### r0: the code before this work

Top findings:
1. "Marta" heard as "Martin", in the notes and in a task title (02-planning).
2. Misheard words published as facts: "the fact sheet" as "the facts she mentioned" (06-handoff; the audio itself was missing "sheet", see above), "help page" as "health page" (05-no-action-items).
3. Added certainty: "It matters for the save file size" became "The limit sets the maximum cloud save file size"; a "probably" dropped.

Also: details repeated across the opener, a status section and the tasks; empty "Open questions: None" sections; "Add backlog item: test …" as a title; "right after this call" lost.

Changed for r1:
- whisper's prompt holds the call's names, then the team's (`teams.members`); a language detected below p = 0.5 is transcribed again in the call's main language; large-v3-turbo recommended where there's a GPU.
- A new summarizer prompt: a first line, Decisions and Open questions only, no tasks in the notes, no transcript commentary, certainty kept, no tasks for work deferred or already done, titles that stand alone with their deadline, the last person to take a task owns it.
- Owners match by full name or a unique first name, ignoring case and accents. The summarizer gets the team's other names, to spell them.

### r1

Top findings:
1. "I'll pull the purchase logs" (Sam) gave a task with no owner, though its description named Sam (03-bug-triage).
2. "the fact sheet" still lost: the press-kit task names only the screenshots (06-handoff). The audio was missing the word.
3. "we'll decide then" became "Ask Marta …" instead of "Decide with Marta …" (02-planning).

Also: the Tuesday release time repeated in the opener, the decisions and a task; "Nobody said who will do the release" next to an empty owner; the look-back call lost its crash-rate and support-ticket numbers; "la pull request de Tomás" though nobody said whose it was.

Changed for r2:
- Whoever says "I'll do it", "I'll take it" or "I can do that", or agrees when asked, owns the task.
- A title keeps the promised outcome ("Decide with Marta …").
- Each fact appears once; a decision that only says someone will do something is a task; descriptions don't explain the owner.
- An optional Highlights section for results a call reports.
- Certainty also covers "probably", who made or owns something, and conclusions of the summarizer's own.
- Work reported as in progress isn't a task, unless its owner promised the call something about it.

### r2

Per call: 05-no-action-items A; 01, 02, 03 and 07 A−; 04-crosstalk and 06-handoff B+.

Top findings:
1. "the fact sheet" still lost (06-handoff).
2. Tasks lost their requirements to the notes: "Sixty, not ninety" and "burn the subtitles in" were only in the notes, and the cloud-saves task dropped the "I'd put it on Convex" suggestion (04-crosstalk, 02-planning). The "each fact once" rule from r2 pushed them out.
3. Descriptions of three sentences (01-standup, 02-planning).

Also: openers that describe the call ("The call triaged all four new bugs") and a release time repeated in the notes and a task. One sample of 03-bug-triage left the restore test out of the tasks ("goes on the backlog" read as put off).

Changed for r3:
- What the person doing a task needs from the call (its deadline, and what was decided about it) goes in that task, not the notes; Decisions holds what isn't one task's business.
- Descriptions: at most two short sentences, including a suggestion made for the work.
- The first line states the main outcome, not what the call did.
- Agreed work with nobody to do it yet ("add it to the backlog") is a task; work put off ("that waits for 1.5") isn't.

### r3

Per call: 03-bug-triage and 05-no-action-items A; 01, 02, 04 and 07 A−; 06-handoff B+.

Top findings:
1. "the fact sheet" still lost (06-handoff). Tracing it found the cause in the eval, not the Notetaker: the cached clip of that line was 7.29 s against 7.55 s for a fresh render, with "sheet" missing. It was the only one of 181 clips that differed.
2. Tasks lost deadlines and prerequisites: Bea's trailer task without "before the 12th", the checklist without "today", the cloud-saves build without "after the design doc" (04, 01, 02).
3. "movemos staging" heard as "movemos también", and the notes said "se pasa a una máquina" without saying what moves (07-bilingual).

Also: a decision in both the first line and Decisions (02); descriptions that repeat the title or add nothing ("Es una pull request pequeña").

Changed for r4:
- The eval renders each clip until two renders agree, and the bad clip was rendered again.
- A deadline or timing said for a task goes in its title, even if the notes say it too; a prerequisite ("Before I start on cloud saves, I'll write a design doc") goes in the dependent task's description.
- Decisions name what they're about, and a misheard subject is read from context ("también" in a call about staging means staging).
- A decision in the first line isn't listed again; a description stays empty rather than repeat the title or add a detail nobody needs; no status updates in the notes.

### r4

Per call: 02-planning, 04-crosstalk, 05-no-action-items, 06-handoff and 07-bilingual A; 01-standup and 03-bug-triage A−. The overall grade matches r3, but five calls got an A against two.

Top findings:
1. The restore test lost its backlog status, so it looked ready to start (03-bug-triage).
2. Titles kept only the last step of a commitment: "Share the updated … checklist … when it's done" for "I'm updating the release checklist for 1.4 today", and "Post"/"Send" for "I'll write it" (01, 02, 04).
3. History and self-evident reasons: "Last time it ended up in a screenshot" in a description; "because a launch crash shouldn't wait for 1.5" after the hotfix decision (01, 03).

Also, lower priority by the judge's account: "movemos staging" and "rotación de logs" still misheard in Spanish, though the notes and tasks recovered both.

Changed for r5:
- A title keeps every step and verb the speaker committed to ("Update … today and share it", "Write …").
- Work put on the backlog starts with "Backlog:".
- Descriptions hold only what someone needs to act: no history, no detail nobody needs; a decision's reason only when the decision doesn't already make it plain.

### r5

Per call: 01, 04, 05, 06 and 07 A; 02-planning A−; 03-bug-triage B+. Accuracy reached A.

Top findings:
1. The bug 220 task titles ("the three bug 220 players") don't say what the problem is (03-bug-triage).
2. The notes lost bug 220's unexplained status ("We can't reproduce it. I tried on four devices") (03-bug-triage).
3. Padding in descriptions: "the doc is for people to weigh in on them" (02-planning).

Found while waiting for this grade: the prompt's examples were taken from the eval's own calls ("I'd put it on Convex", "Decide with Marta on Thursday", staging heard as "también", "three players say they lost coins", "before the Steam page goes live on the 12th", and others), which teaches the summarizer the test's answers. r6 is r5 with only those examples replaced by generic ones that share no five-word phrase with any script, to see what the grade is worth without them.

### r6: r5 without the eval's own examples in the prompt

Per call: 01, 05, 06 and 07 A; 02, 03 and 04 A−. The grade held without the leaked examples (r5's triage call was B+, r6's A−).

Top findings:
1. Bug 220's investigation status lost: "We can't reproduce it. I tried on four devices" isn't in the notes or tasks (03-bug-triage). r5 found the same.
2. "Reply to the three players in bug 220 today that we're looking into it" leans on the bug number (03-bug-triage). r5 found the same.
3. A task's deadline repeated in the notes: "before the Steam page goes live on the 12th" in both (04-crosstalk), which the prompt's "even if the notes say it too" invited.

Also: a description written as request history ("Julio asked for it to be posted in the channel") instead of an instruction (02-planning).

Changed for r7 (all examples generic; the prompt shares no five-word phrase with a script):
- A title says what a bug is about, not only its number.
- Open questions keep problems the call couldn't explain, with what's known so far, even when a task looks into them; a question a task simply answers isn't one.
- A deadline goes in the task's title, and the notes don't repeat it.
- Descriptions are instructions to the owner, without request history or reasons the title makes plain.

### r7

Per call: 01, 03, 05 and 06 A; 02 and 07 A−; 04-crosstalk B+. No better than r6: accuracy fell from A to A−. The first round without improvement.

Top findings:
1. The trailer task said "before launch" instead of "before the 12th", which could mean the game's launch (04-crosstalk). The new "the notes don't repeat it" rule moved the date into the notes and left the title vague.
2. "movemos staging" heard as "movemos también", and the decision didn't say what moves (07-bilingual).
3. Repetition: photo mode in the first line and again under Decisions (02-planning); "send Bea the raw files" in a title and again in its description (04-crosstalk).

Changed for r8:
- A task's deadline goes in its title as it was said: a date stays a date.
- Decisions leaves out what the first line already says.

Tried and dropped: giving whisper the call's last 300 characters with the names, so a word the call already used is heard the same way again. WER went from 1.7% to 1.6%, but names right fell from 96% to 91% (04-crosstalk 50%), 03-bug-triage got worse (2.7% to 3.6%), and "movemos staging" became "movemos a una máquina", losing the word entirely.

### r8

Per call: 01, 02, 05 and 06 A; 03, 04 and 07 A−. The same as r6 on every dimension and in the number of calls at A: the second round in a row without improvement, so the loop stopped here.

Top findings, not acted on:
1. Constraints left in the notes instead of their task: "Sixty, not ninety" missing from the trailer task (04-crosstalk); "a 1.4.1 hotfix on Friday" not tied to the crash fix (03-bug-triage).
2. Explanations around decisions: "It is annoying but harmless" after a deferral (03-bug-triage); the deploy decision retells yesterday's 20 minutes and the cache (07-bilingual).
3. Speech-to-text of technical words and durations: "rotación de logs" as "rotación del", "movemos staging" as "movemos también", "sixty second one" as "62nd one". The judge notes the summaries recovered all three.

### r9: after the review of the PR

Not a hill-climbing round: it checks that the review's prompt-injection fix leaves the notes as good as r8's. The summarizer now gets the channel, the names and the transcript as one JSON block that its instructions call data, never instructions; it answers with points that cite transcript lines, and the Notetaker writes the notes from them, leaving out any point whose cited lines don't exist or share no word with it. The default summarizer is `claude -p --tools "" --strict-mcp-config`. No point was left out in any of the 14 runs.

Per call: 02, 05 and 06 A; 01, 03, 04 and 07 A−. Level with r8 overall, one notch lower on accuracy.

Top findings, not acted on:
1. "Share the 1.4 release checklist … when it's done" without "updating it today" (01-standup).
2. "players who lost coins" in two task titles, where the call said "three players say they lost coins" (03-bug-triage).
3. Notes that retell the context of a decision: the deploy's 20 minutes and the cache (07-bilingual), the crash's symptoms in the opening line (03-bug-triage).

### r10: after the second review

The word-overlap check from r9 is gone: it left out valid points ("Go with B.", "No se hace.", "Postpone release." for "We agreed to defer the launch") and kept invented ones that shared one word with a line. A point now needs only to cite transcript lines that all exist; one citing [1, 999] is left out whole. The headings come from fixed wording in code, English or Spanish by the language speech-to-text heard most, never from the summarizer. When no point of the notes is left, the notes say so in one line and the tasks are still proposed. None of this checks that a point is true: what keeps names and speech from steering the Notetaker is isolation (the data block, a summarizer with no tools, and tasks that need a person's yes). No point was left out in any of the 14 runs.

The eval's duplicate count now applies a known task's exclusions, so a proposal they rule out counts as invented; rescoring r0 to r9 with it changed no number.

Per call: 01, 02, 05 and 06 A; 03, 04 and 07 A−. A little better than r9 (usefulness A, four calls at A).

Top findings, not acted on:
1. "players who lost coins" in a task title, where the call said "three players say they lost coins" (03-bug-triage).
2. "movemos staging" heard as "movemos también", and the decision doesn't name staging (07-bilingual).
3. The trailer deadline in both the notes and its task, and "send Bea the raw files" said twice (04-crosstalk); a long deploy decision (07-bilingual).
