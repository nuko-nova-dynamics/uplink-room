import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { bridgeSays, linkMachine, newRoom, newTeam } from "./setup";

test("a thread started straight in T3 Code shows up Unfiled, suggested for the project that lists its repo", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: ["https://github.com/nuko/billing.git"] });
  const { token } = await linkMachine(t, teamId, admin, "julio-mbp");

  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "thread", threadRef: "t3-thread-42" },
    state: "working",
    harness: "claude-code",
    repo: "git@github.com:nuko/billing.git",
    title: "Refactor invoice export",
  });

  const unfiled = await admin.as.query(api.runs.unfiled, { teamId });
  expect(unfiled).toMatchObject([
    { title: "Refactor invoice export", harness: "claude-code", driver: { name: "Julio" }, suggestedProjects: [{ projectId, name: "Billing" }] },
  ]);
});

test("an unfiled run that is waiting still reaches its driver's inbox", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { token } = await linkMachine(t, teamId, admin, "julio-mbp");

  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "thread", threadRef: "t3-thread-7" },
    state: "waiting",
    prompt: { kind: "question", text: "Which branch should I use?" },
    harness: "codex",
  });

  const inbox = await admin.as.query(api.inbox.get, { teamId });
  expect(inbox.needsYou).toMatchObject([{ unfiled: true, reason: "Which branch should I use?" }]);
});

test("filing an unfiled run under a new task puts it on that project's board", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Billing", repos: ["github.com/nuko/billing"] });
  const { token } = await linkMachine(t, teamId, admin, "julio-mbp");
  await bridgeSays(t, token, { type: "run_state_changed", source: { kind: "thread", threadRef: "t3-thread-9" }, state: "working", harness: "codex", repo: "github.com/nuko/billing", title: "Export CSV" });
  const [run] = await admin.as.query(api.runs.unfiled, { teamId });

  await admin.as.mutation(api.runs.file, { teamId, runId: run!.runId, newTask: { title: "Export invoices as CSV", projectId } });

  expect(await admin.as.query(api.runs.unfiled, { teamId })).toEqual([]);
  const board = await admin.as.query(api.tasks.board, { teamId, projectId });
  expect(board).toMatchObject([{ title: "Export invoices as CSV", runs: [{ runId: run!.runId, harness: "codex" }] }]);
});
