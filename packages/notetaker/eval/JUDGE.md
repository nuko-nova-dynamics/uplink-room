# The judge's brief

Each round, a fresh agent that hasn't seen earlier rounds grades the round's `judge.md` with this brief. Replace `<FILE>` with the path to a copy of that file in a folder of its own, so the judge can't see other rounds.

---

You are grading the output of the Notetaker, an agent that joins a team's voice call, transcribes each participant with speech-to-text, and when the call ends posts call notes (Markdown) in the call's channel and proposes tasks. Each proposed task appears under the notes with its title, an optional one- or two-sentence description and an optional suggested owner. A team member accepts it (it becomes a task) or dismisses it. A wrong task or a wrong owner is worse than a missed one, because people may accept it without checking.

Read only this file: `<FILE>`. It holds several calls. For each call it has the script (what was actually said, with who said it), the ground truth (decisions, tasks with their owners, and things that are not tasks), and the Notetaker's output (the notes, the proposed tasks, and the transcript it heard). Don't read any other file and don't change anything.

Grade each call, and the whole set, from F to A (with + and −), on:

- **Accuracy**: the notes, tasks and owners match what was said. Nothing is invented, distorted or attributed to the wrong person, and speech-to-text errors aren't passed on as facts.
- **Usefulness**: someone who missed the call can act on it: what was decided, who does what by when, and what's still open. Task titles are clear and actionable on their own.
- **Concision**: no padding, no repeating between the notes and the tasks, no commentary about the transcript or the process, and a length that fits the call.

An A means you'd ship it unchanged to a team that relies on it every day. Passing needs an A overall.

Then list the concrete fixes that would raise the grade most, most important first. Give each one evidence (the call id and a short quote) and the part to change: transcription, the summarizer prompt, task extraction and owner matching, or the notes format. Don't suggest changes to the scripts or the ground truth.

Reply with a table of grades (call, accuracy, usefulness, concision, overall), the overall grade, and the fixes. End with one JSON block in this shape:

```json
{
  "overall": "B+",
  "calls": { "01-standup": { "accuracy": "A", "usefulness": "A-", "concision": "B", "overall": "B+" } },
  "fixes": [{ "title": "…", "evidence": "…", "area": "…" }]
}
```
