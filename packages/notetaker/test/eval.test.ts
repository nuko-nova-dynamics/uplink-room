import { join } from "node:path";
import { expect, test } from "vitest";
import { editDistance, loadCalls, scoreRun, wordsOf, type CallScript } from "../eval/lib.ts";
import { summaryPrompt } from "../src/summarize.ts";

test("the summarizer's prompt shares no five-word phrase with the eval's calls, so it can't learn the test's answers", async () => {
  const calls = await loadCalls(join(import.meta.dirname, "../eval/calls"));
  const said = calls.flatMap((c) => c.turns.map((t) => ` ${wordsOf(t.text, c.language).join(" ")} `));
  const words = wordsOf(summaryPrompt({ channel: "c", people: [], lines: [] }), "en");
  const shared = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) {
    const phrase = words.slice(i, i + 5).join(" ");
    if (said.some((s) => s.includes(` ${phrase} `))) shared.add(phrase);
  }
  expect([...shared]).toEqual([]);
});

test("the eval's word error rate ignores case, punctuation, accents and how numbers are written", () => {
  expect(wordsOf("The peak was about 4,000 players, at 40% CPU on 1.4.", "en")).toEqual(
    wordsOf("the peak was about four thousand players at forty percent cpu on one point four", "en"),
  );
  expect(wordsOf("Cincuenta gigas, y los logs ocupan 48.", "es")).toEqual(wordsOf("cincuenta gigas y los logs ocupan cuarenta y ocho", "es"));
  expect(editDistance(wordsOf("Ana takes the save slot bug", "en"), wordsOf("Anna takes the slot bug", "en"))).toBe(2);
});

test("the eval pairs each proposed task with at most one known task, and checks its owner", () => {
  const call: CallScript = {
    id: "x",
    kind: "",
    channel: "c",
    language: "en",
    people: [
      { id: "ana", name: "Ana García", voice: "" },
      { id: "ben", name: "Ben Okafor", voice: "" },
    ],
    turns: [{ speaker: "ana", text: "I'll fix the save slot bug." }],
    truth: {
      decisions: [{ text: "Ship Friday", match: [["friday"]] }],
      tasks: [
        { title: "Fix the save slot bug", owner: "ana", match: [["save slot"]] },
        { title: "Send the build to testers", owner: null, match: [["build"], ["tester"]] },
      ],
      notTasks: [{ text: "Photo mode", match: [["photo mode"]] }],
    },
  };
  const score = scoreRun(call, {
    transcript: [{ speaker: "Ana García", text: "I'll fix the save slot bug.", at: 0 }],
    notes: "We ship on Friday.",
    tasks: [
      { title: "Fix the save-slot bug", owner: "Ben Okafor" },
      { title: "Look at the save slot bug again", owner: "Ana García" },
      { title: "Build photo mode", owner: null },
    ],
  });
  expect(score.wer).toEqual({ edits: 0, words: 6 });
  expect(score.tasks).toMatchObject({ proposed: 3, matched: 1, duplicates: 1, invented: ["Build photo mode"], traps: ["Build photo mode"] });
  expect(score.tasks).toMatchObject({ required: 2, requiredFound: 1, missed: ["Send the build to testers"], ownerRight: 0, ownerChecked: 1 });
  expect(score.decisions.missed).toEqual([]);
});

test("a proposal that matches a known task's keywords but also its exclusions is invented, not a duplicate", async () => {
  const [triage] = await loadCalls(join(import.meta.dirname, "../eval/calls"), ["03-bug-triage"]);
  // Matches the iPad crash fix's keywords, but "release" is one of that task's exclusions; it isn't the hotfix task either.
  const score = scoreRun(triage!, { transcript: [], notes: "", tasks: [{ title: "Release the iPad fix", owner: null }] });
  expect(score.tasks).toMatchObject({ proposed: 1, matched: 0, duplicates: 0, invented: ["Release the iPad fix"] });
});
