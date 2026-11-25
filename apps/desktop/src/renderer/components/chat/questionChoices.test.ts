import { expect, test } from "vitest";
import { latestOfRuns, questionChoices } from "../../lib/chat";

test("a question that names its choices gives them, and any other gives none", () => {
  expect(questionChoices("Which release note: the CSV export one, or the DST fix?")).toEqual(["the CSV export one", "the DST fix"]);
  expect(questionChoices("Metric or imperial?")).toEqual(["Metric", "imperial"]);
  expect(questionChoices("What should the column be called?")).toEqual([]);
  expect(questionChoices("Ship it today or tomorrow.")).toEqual([]);
});

test("only the newest message of each agent run shows the run's live state", () => {
  const latest = latestOfRuns([
    { messageId: "m1", a2a: { runId: "r1" } },
    { messageId: "m2" },
    { messageId: "m3", a2a: { runId: "r1" } },
    { messageId: "m4", a2a: { runId: "r2" } },
  ]);
  expect([...latest].sort()).toEqual(["m3", "m4"]);
});
