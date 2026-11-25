import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_FEATURES, ROOM_FEATURES, type BridgeMessage } from "@uplink-room/protocol";
import { Bridge } from "../src/bridge.ts";
import { cleanups, driver, FakeRoom, setup } from "./tools/bridgeFixture.ts";

/** A room from ADR 0021 on: `bridge.send` names what it takes. */
class FeatureRoom extends FakeRoom {
  override send(message: BridgeMessage) {
    super.send(message);
    return { features: [...ROOM_FEATURES] };
  }
}

test("unpaired T3 polling keeps threads private without an explicit selection", async () => {
  const { T3CodeAdapter } = await import("../src/adapters/t3code.ts");
  const reports: unknown[] = [];
  const adapter = new T3CodeAdapter({ executable: join(import.meta.dirname, "tools/t3"), project: "/fake", pollMs: 10 });
  const handle = adapter.startBridge((...args) => reports.push(args));
  cleanups.push(async () => {
    await handle.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(reports).toEqual([]);
});

test("T3 Code threads become runs, retaining unknown when no waiting prompt is available", async () => {
  const { T3CodeAdapter } = await import("../src/adapters/t3code.ts");
  const { room } = await setup({
    adapters: [
      new T3CodeAdapter({
        executable: join(import.meta.dirname, "tools/t3"),
        project: "/fake",
        sharedThreads: ["working", "done", "waiting"],
        pollMs: 50,
      }),
    ],
  });
  await expect
    .poll(() => room.messages.filter((m) => m.type === "run_state_changed").length)
    .toBe(3);
  expect(room.messages).toContainEqual(
    expect.objectContaining({
      type: "run_state_changed",
      source: { kind: "thread", threadRef: "working" },
      state: "working",
    }),
  );
  expect(room.messages).toContainEqual(
    expect.objectContaining({
      type: "run_state_changed",
      source: { kind: "thread", threadRef: "done" },
      state: "done",
    }),
  );
  expect(room.messages).toContainEqual(
    expect.objectContaining({
      type: "run_state_changed",
      source: { kind: "thread", threadRef: "waiting" },
      state: "unknown",
    }),
  );
  // Without a T3 Code session the bridge can't launch, and says why.
  room.deliver({ v: 1, type: "start_thread", runId: "run-1", harness: "codex", startedBy: driver });
  await expect
    .poll(() => room.messages.find((m) => m.type === "thread_start_failed"))
    .toMatchObject({ runId: "run-1", reason: "t3_not_paired" });
});

/**
 * A bridge paired with a fake T3 Code server, watching its /work/billing project (or `project`).
 * Unless `wait` is false, it returns once the adapter has subscribed to T3's shell.
 */
async function t3Setup(
  script: (fake: import("./tools/fakeT3.ts").FakeT3) => void = () => {},
  options: { project?: string; bridge?: Record<string, unknown>; wait?: boolean; adapter?: Record<string, unknown> } = {},
) {
  const { FakeT3, PAIRING_TOKEN } = await import("./tools/fakeT3.ts");
  const { T3CodeAdapter } = await import("../src/adapters/t3code.ts");
  const { exchangePairingToken } = await import("../src/adapters/t3client.ts");
  const fake = await new FakeT3().start();
  cleanups.push(() => fake.close());
  script(fake);
  const session = await exchangePairingToken(fake.url, PAIRING_TOKEN);
  const adapter = () =>
    new T3CodeAdapter({
      session,
      project: options.project ?? "/work/billing",
      sharedThreads: [...fake.threads.values()]
        .filter((t) => t.projectId === "project-1")
        .map((t) => t.id)
        // And the threads tests open, message or stop without listing them in T3 Code first.
        .concat(["thread-a", "thread-b", "thread-after", "thread-s", "thread-v", "uplink-room-view-1"]),
      retryMs: 50,
      ...options.adapter,
    });
  const context = await setup({ linkedBy: driver.memberId, adapters: [adapter()], ...options.bridge });
  if (options.wait !== false) await expect.poll(() => fake.subscribed).toBe(true);
  return { fake, adapter, session, ...context };
}
const statuses = (room: FakeRoom) =>
  room.messages.filter((m): m is Extract<BridgeMessage, { type: "t3_status" }> => m.type === "t3_status");
const threadReports = (room: FakeRoom, threadRef: string) =>
  room.messages.filter(
    (m): m is Extract<BridgeMessage, { type: "run_state_changed" }> =>
      m.type === "run_state_changed" && m.source.kind === "thread" && m.source.threadRef === threadRef,
  );
/** A running thread waiting on a command approval, as T3 Code's shell and projection show it. */
function approvalPending(fake: import("./tools/fakeT3.ts").FakeT3, requestId: string) {
  fake.projections.set("thread-a", {
    runtimeRequests: [
      { id: requestId, kind: "command", status: "pending", responseCapability: { type: "live" } },
    ],
    turnItems: [
      {
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: `pnpm test --run ${requestId}`,
        reason: "Run the test suite?",
        options: [
          { decision: "accept", label: "Allow" },
          { decision: "acceptForSession", label: "Allow for this session" },
          { decision: "decline", label: "Deny" },
        ],
      },
    ],
  });
  fake.update({
    id: "thread-a",
    projectId: "project-1",
    title: "Run tests",
    status: "running",
    pendingRuntimeRequest: { id: requestId, kind: "command" },
  });
}
const answer = (room: FakeRoom, promptId: string, from = driver, reply: "allow" | "deny" = "allow") =>
  room.deliver({
    v: 1,
    type: "answer_prompt",
    source: { kind: "thread", threadRef: "thread-a" },
    from,
    promptId,
    answer: reply,
  });

test("T3 threads stay private by default, including later updates; room launches are still shared", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("private", { id: "private", projectId: "project-1", title: "Private work", status: "running" });
  }, { adapter: { sharedThreads: undefined } });
  fake.update({ id: "later-private", projectId: "project-1", title: "More private work", status: "running", pendingRuntimeRequest: { id: "secret", kind: "command" } });
  room.deliver({ v: 1, type: "start_thread", runId: "opt-in", harness: "codex", startedBy: driver });
  await expect.poll(() => threadReports(room, "uplink-room-opt-in").length).toBeGreaterThan(0);
  expect(threadReports(room, "private")).toEqual([]);
  expect(threadReports(room, "later-private")).toEqual([]);
  expect(fake.projectionReads).toBeLessThanOrEqual(1);
});

test("only explicitly selected existing T3 threads are reported", async () => {
  const { room, fake } = await t3Setup((fake) => {
    for (const id of ["selected", "private"])
      fake.threads.set(id, { id, projectId: "project-1", title: id, status: "running" });
  }, { adapter: { sharedThreads: ["selected"] } });
  await expect.poll(() => threadReports(room, "selected").length).toBe(1);
  fake.update({ id: "selected", projectId: "project-1", title: "selected", status: "completed" });
  await expect.poll(() => threadReports(room, "selected").at(-1)?.state).toBe("done");
  expect(threadReports(room, "private")).toEqual([]);
});

test("a thread made in T3 Code is reported with the harness its provider runs, not as T3 Code", async () => {
  const { room } = await t3Setup((fake) => {
    fake.providers.push({ instanceId: "my_claude", driver: "claudeAgent", enabled: true, installed: true, status: "ready", models: [{ slug: "opus" }] });
    fake.threads.set("thread-codex", { id: "thread-codex", projectId: "project-1", title: "Fix billing", status: "running" });
    fake.threads.set("thread-claude", { id: "thread-claude", projectId: "project-1", title: "Write docs", status: "running", providerInstanceId: "my_claude" });
    fake.threads.set("thread-gone", { id: "thread-gone", projectId: "project-1", title: "Old", status: "running", providerInstanceId: "removed" });
  });
  await expect.poll(() => threadReports(room, "thread-codex").at(-1)?.harness).toBe("codex");
  await expect.poll(() => threadReports(room, "thread-claude").at(-1)?.harness).toBe("claude-code");
  // A provider T3 Code no longer lists: the bridge can't tell, so it says T3 Code.
  await expect.poll(() => threadReports(room, "thread-gone").at(-1)?.harness).toBe("t3code");
});

test("a snapshot in which T3 Code only resolved other projects' repositories keeps the threads the bridge reports", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("thread-a", { id: "thread-a", projectId: "project-1", title: "Fix billing", status: "running" });
  });
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("working");
  // T3 Code sends these after its first snapshot, with no threads (seen with v0.1.8-nightly.20261105.4234).
  fake.enrich([{ id: "project-2", title: "Site", workspaceRoot: "/work/site", repositoryIdentity: { canonicalKey: "github.com/nuko/site" }, defaultModelSelection: null }], ["/work/site"]);
  fake.update({ id: "thread-a", projectId: "project-1", title: "Fix billing", status: "completed" });
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("done");
});

test("a T3 Code thread with a pending question reports Waiting with the question, while T3 lists it as running", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("thread-q", {
      id: "thread-q",
      projectId: "project-1",
      title: "Pick a marker",
      status: "running",
      pendingRuntimeRequest: { id: "req-q", kind: "user_input" },
    });
    fake.projections.set("thread-q", {
      runtimeRequests: [{ id: "req-q", kind: "user_input", status: "pending", responseCapability: { type: "live" } }],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "req-q",
          questions: [
            {
              id: "research_marker",
              header: "Marker",
              question: "Which research marker?",
              options: [
                { label: "Alpha", description: "First" },
                { label: "Beta", description: "Second" },
              ],
            },
          ],
        },
      ],
    });
    // Another project's thread isn't this bridge's to report.
    fake.threads.set("thread-other", { id: "thread-other", projectId: "project-2", title: "Elsewhere", status: "running" });
  });
  // Pairing asked for only the scopes the bridge needs.
  expect(fake.exchanges[0]!.get("scope")).toBe("orchestration:read orchestration:operate");
  await expect.poll(() => threadReports(room, "thread-q").at(-1)).toMatchObject({
    state: "waiting",
    prompt: { kind: "question", text: "Which research marker? (Alpha / Beta)" },
    title: "Pick a marker",
    repo: "github.com/nuko/billing",
  });
  // Answered in T3 Code: the request goes, and Waiting with it.
  fake.update({ ...fake.threads.get("thread-q")!, pendingRuntimeRequest: null });
  await expect.poll(() => threadReports(room, "thread-q").at(-1)).toMatchObject({ state: "working" });
  expect(threadReports(room, "thread-q").at(-1)?.prompt).toBeUndefined();
  expect(threadReports(room, "thread-other")).toEqual([]);
});

test("a T3 Code approval is answered with accept, only from the driver and only for the current request", async () => {
  const { room, fake } = await t3Setup();
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)).toMatchObject({
    state: "waiting",
    prompt: { kind: "approval", text: "Run the test suite?", action: "pnpm test --run req-1", promptId: expect.any(String) },
  });
  const { promptId } = threadReports(room, "thread-a").at(-1)!.prompt!;

  answer(room, promptId!, { memberId: "teammate", name: "Teammate" });
  await expect
    .poll(() => room.messages.find((m) => m.type === "input_rejected"))
    .toMatchObject({ terminalId: "thread-a", memberId: "teammate", reason: "not_driver" });
  expect(fake.commands).toEqual([]);

  answer(room, promptId!);
  await expect.poll(() => fake.commands).toEqual([
    {
      type: "runtime-request.respond",
      commandId: `uplink-room:answer:${promptId}`,
      threadId: "thread-a",
      requestId: "req-1",
      decision: "accept",
    },
  ]);
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("working");
});

test("a stale or unknown approval id is rejected and never reaches T3 Code", async () => {
  const { room, fake } = await t3Setup();
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.prompt?.promptId).toBeTruthy();
  const first = threadReports(room, "thread-a").at(-1)!.prompt!.promptId!;
  // Answered in T3 Code itself, and the agent asks again.
  fake.projections.get("thread-a")!.runtimeRequests[0]!.status = "resolved";
  approvalPending(fake, "req-2");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.prompt?.action).toBe("pnpm test --run req-2");
  const second = threadReports(room, "thread-a").at(-1)!.prompt!.promptId!;
  expect(second).not.toBe(first);

  answer(room, first);
  answer(room, "made-up-id");
  await expect
    .poll(() => room.messages.filter((m) => m.type === "input_rejected").map((m) => m.reason))
    .toEqual(["stale_prompt", "stale_prompt"]);
  room.deliver({
    v: 1,
    type: "answer_prompt",
    source: { kind: "thread", threadRef: "thread-nothing" },
    from: driver,
    promptId: second,
    answer: "allow",
  });
  await expect
    .poll(() => room.messages.filter((m) => m.type === "input_rejected").at(-1))
    .toMatchObject({ terminalId: "thread-nothing", reason: "no_pending_approval" });
  expect(fake.commands).toEqual([]);

  answer(room, second, driver, "deny");
  await expect.poll(() => fake.commands).toMatchObject([{ requestId: "req-2", decision: "decline" }]);
});

test("start_thread launches a T3 Code thread, binds it to the run before reporting it, and reports why a launch fails", async () => {
  const { room, fake } = await t3Setup();
  const starter = { memberId: "starter", name: "Starter" };
  room.deliver({
    v: 1,
    type: "start_thread",
    runId: "run-9",
    harness: "codex",
    startedBy: starter,
    cwd: "/work/billing",
    prompt: "Fix the invoice totals\nand add a test",
  });
  await expect.poll(() => threadReports(room, "uplink-room-run-9").at(-1)?.state).toBe("working");
  const bound = room.messages.findIndex((m) => m.type === "thread_bound");
  expect(room.messages[bound]).toEqual({ v: 1, type: "thread_bound", runId: "run-9", threadRef: "uplink-room-run-9" });
  expect(bound).toBeLessThan(room.messages.indexOf(threadReports(room, "uplink-room-run-9")[0]!));
  expect(fake.launches).toEqual([
    {
      commandId: "uplink-room:start-thread:run-9",
      threadId: "uplink-room-run-9",
      projectId: "project-1",
      title: "Fix the invoice totals",
      generateTitle: true,
      modelSelection: { instanceId: "codex_px", model: "gpt-6.1-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "Fix the invoice totals\nand add a test", attachments: [] },
    },
  ]);

  room.deliver({ v: 1, type: "start_thread", runId: "run-10", harness: "claude-code", startedBy: starter, repo: "github.com/nuko/billing" });
  room.deliver({ v: 1, type: "start_thread", runId: "run-11", harness: "codex", startedBy: starter, cwd: "/work/elsewhere" });
  await expect
    .poll(() => room.messages.filter((m) => m.type === "thread_start_failed"))
    .toMatchObject([
      { runId: "run-10", reason: "harness_disabled" },
      { runId: "run-11", reason: "project_not_registered", detail: expect.stringContaining("/work/elsewhere") },
    ]);
  expect(fake.launches).toHaveLength(1);
});

test("stop_thread stops the T3 Code thread", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("thread-s", { id: "thread-s", projectId: "project-1", title: "Long job", status: "running", activeRunId: "run-s" });
  });
  await expect.poll(() => threadReports(room, "thread-s").at(-1)?.state).toBe("working");
  room.deliver({ v: 1, type: "stop_thread", threadRef: "thread-s" });
  await expect
    .poll(() => fake.commands)
    .toMatchObject([{ type: "thread.stop", threadId: "thread-s", reason: "Stopped from Uplink Room" }]);
  await expect.poll(() => threadReports(room, "thread-s").at(-1)?.state).toBe("stopped");
});
test("a T3 Code thread deleted while Waiting is reported Stopped with no prompt, so its approval leaves the Inbox", async () => {
  const { room, fake } = await t3Setup((fake) => {
    // Never reported, so its removal says nothing.
    fake.threads.set("thread-other", { id: "thread-other", projectId: "project-2", title: "Elsewhere", status: "running" });
  });
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("waiting");

  fake.remove("thread-a");
  fake.remove("thread-other");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("stopped");
  expect(threadReports(room, "thread-a").at(-1)?.prompt).toBeUndefined();
  expect(threadReports(room, "thread-other")).toEqual([]);

  // The bridge keeps reporting: it doesn't report the deleted thread again, and the next thread comes through.
  fake.update({ id: "thread-b", projectId: "project-1", title: "Next", status: "running" });
  await expect.poll(() => threadReports(room, "thread-b").at(-1)?.state).toBe("working");
  expect(threadReports(room, "thread-a").map((m) => m.state)).toEqual(["waiting", "stopped"]);
});
test("a T3 Code thread archived while Waiting is reported Done with no prompt, though T3 sends the same thread.removed as for a delete", async () => {
  const { room, fake } = await t3Setup();
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("waiting");

  fake.archive("thread-a");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("done");
  expect(threadReports(room, "thread-a").at(-1)?.prompt).toBeUndefined();
  expect(threadReports(room, "thread-a").map((m) => m.state)).toEqual(["waiting", "done"]);
});
test("a T3 Code thread archived or deleted after its run finished says nothing, so settled work stays settled", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("thread-done", { id: "thread-done", projectId: "project-1", title: "Finished", status: "completed" });
    fake.threads.set("thread-failed", { id: "thread-failed", projectId: "project-1", title: "Failed", status: "failed" });
    fake.threads.set("thread-gone", { id: "thread-gone", projectId: "project-1", title: "Finished, then deleted", status: "completed" });
  });
  await expect.poll(() => threadReports(room, "thread-done").at(-1)?.state).toBe("done");
  await expect.poll(() => threadReports(room, "thread-failed").at(-1)?.state).toBe("failed");
  await expect.poll(() => threadReports(room, "thread-gone").at(-1)?.state).toBe("done");

  fake.archive("thread-done");
  fake.archive("thread-failed");
  fake.remove("thread-gone");
  // Events reach the bridge in order, so by the time this thread reports, those three were handled.
  fake.update({ id: "thread-after", projectId: "project-1", title: "After", status: "running" });
  await expect.poll(() => threadReports(room, "thread-after").at(-1)?.state).toBe("working");
  expect(threadReports(room, "thread-done").map((m) => m.state)).toEqual(["done"]);
  expect(threadReports(room, "thread-failed").map((m) => m.state)).toEqual(["failed"]);
  expect(threadReports(room, "thread-gone").map((m) => m.state)).toEqual(["done"]);
  expect(fake.commands).toEqual([]);
});
test("a room that takes it hears when T3 Code archives or deletes a thread it was told about, finished or not", async () => {
  const closed = (room: FakeRoom) => room.messages.filter((m) => m.type === "thread_closed").map((m) => m.threadRef);
  const script = (fake: import("./tools/fakeT3.ts").FakeT3) => {
    fake.threads.set("thread-done", { id: "thread-done", projectId: "project-1", title: "Finished", status: "completed" });
    fake.threads.set("thread-run", { id: "thread-run", projectId: "project-1", title: "Working", status: "running" });
    fake.threads.set("thread-other", { id: "thread-other", projectId: "project-2", title: "Elsewhere", status: "running" });
  };
  for (const link of [new FeatureRoom(), new FakeRoom()]) {
    const { room, fake } = await t3Setup(script, { bridge: { link } });
    await expect.poll(() => threadReports(room, "thread-done").at(-1)?.state).toBe("done");
    await expect.poll(() => threadReports(room, "thread-run").at(-1)?.state).toBe("working");
    fake.archive("thread-done");
    fake.remove("thread-run");
    fake.remove("thread-other");
    fake.update({ id: "thread-after", projectId: "project-1", title: "After", status: "running" });
    await expect.poll(() => threadReports(room, "thread-after").at(-1)?.state).toBe("working");
    // The finished one keeps its state; the running one gets its final state first, as before.
    expect(threadReports(room, "thread-done").map((m) => m.state)).toEqual(["done"]);
    expect(threadReports(room, "thread-run").map((m) => m.state)).toEqual(["working", "stopped"]);
    // A room from before `thread_closed` would refuse it, and never hears it; a never-reported thread says nothing.
    expect(closed(room)).toEqual(link instanceof FeatureRoom ? ["thread-done", "thread-run"] : []);
  }
});
test("a lost T3 Code connection reports unfinished threads Unknown, but not Done, Failed or Stopped ones, and a later update still reports", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("thread-done", { id: "thread-done", projectId: "project-1", title: "Finished", status: "completed" });
    fake.threads.set("thread-failed", { id: "thread-failed", projectId: "project-1", title: "Failed", status: "failed" });
    fake.threads.set("thread-stopped", { id: "thread-stopped", projectId: "project-1", title: "Stopped", status: "interrupted" });
    fake.threads.set("thread-busy", { id: "thread-busy", projectId: "project-1", title: "Busy", status: "running", activeRunId: "run-b" });
  });
  await expect.poll(() => threadReports(room, "thread-done").at(-1)?.state).toBe("done");
  await expect.poll(() => threadReports(room, "thread-failed").at(-1)?.state).toBe("failed");
  await expect.poll(() => threadReports(room, "thread-stopped").at(-1)?.state).toBe("stopped");
  await expect.poll(() => threadReports(room, "thread-busy").at(-1)?.state).toBe("working");

  fake.dropConnections();
  await expect.poll(() => threadReports(room, "thread-busy").at(-1)?.state).toBe("unknown");
  // Reconnected: the snapshot reports the running thread again.
  await expect.poll(() => threadReports(room, "thread-busy").at(-1)?.state).toBe("working");
  expect(threadReports(room, "thread-done").map((m) => m.state)).toEqual(["done"]);
  expect(threadReports(room, "thread-failed").map((m) => m.state)).toEqual(["failed"]);
  expect(threadReports(room, "thread-stopped").map((m) => m.state)).toEqual(["stopped"]);

  // The thread is continued in T3 Code after the reconnect: a real update still reports.
  fake.update({ id: "thread-done", projectId: "project-1", title: "Finished", status: "running", activeRunId: "run-d" });
  await expect.poll(() => threadReports(room, "thread-done").at(-1)?.state).toBe("working");
});
test("a removed T3 Code thread whose state can't be read is reported Unknown, with no prompt", async () => {
  const { room, fake } = await t3Setup();
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("waiting");

  fake.failReads.add("thread-a");
  fake.remove("thread-a");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("unknown");
  expect(threadReports(room, "thread-a").at(-1)?.prompt).toBeUndefined();
});
test("a thread archived and then restored in T3 Code is reported again", async () => {
  const { room, fake } = await t3Setup();
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("waiting");
  fake.archive("thread-a");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("done");

  fake.update({ id: "thread-a", projectId: "project-1", title: "Run tests", status: "running" });
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("working");
});
test("a T3 Code run that was interrupted or cancelled is reported Stopped", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.threads.set("thread-i", { id: "thread-i", projectId: "project-1", title: "Interrupted", status: "running", activeRunId: "run-i" });
    fake.threads.set("thread-c", { id: "thread-c", projectId: "project-1", title: "Cancelled", status: "running", activeRunId: "run-c" });
  });
  await expect.poll(() => threadReports(room, "thread-i").at(-1)?.state).toBe("working");
  fake.update({ ...fake.threads.get("thread-i")!, status: "interrupted" });
  fake.update({ ...fake.threads.get("thread-c")!, status: "cancelled" });
  await expect.poll(() => threadReports(room, "thread-i").at(-1)?.state).toBe("stopped");
  await expect.poll(() => threadReports(room, "thread-c").at(-1)?.state).toBe("stopped");
});
test("a stop_thread T3 Code refuses is reported as stop_failed, and the bridge keeps running", async () => {
  const errors: unknown[] = [];
  const { room, fake } = await t3Setup(
    (fake) => {
      fake.threads.set("thread-s", { id: "thread-s", projectId: "project-1", title: "Long job", status: "running", activeRunId: "run-s" });
      fake.failCommands.add("thread.stop");
    },
    { bridge: { onError: (error: unknown) => errors.push(error) } },
  );
  await expect.poll(() => threadReports(room, "thread-s").at(-1)?.state).toBe("working");
  room.deliver({ v: 1, type: "stop_thread", threadRef: "thread-s" });
  await expect
    .poll(() => room.messages.find((m) => m.type === "input_rejected"))
    .toMatchObject({ terminalId: "thread-s", memberId: driver.memberId, reason: "stop_failed" });
  expect(errors).toEqual([]);
  // Still connected and reporting: the next approval reaches the room.
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("waiting");
  expect(errors).toEqual([]);
});
test("a start_thread that arrives while the bridge is still connecting waits for T3 Code's first snapshot", async () => {
  const { room, fake } = await t3Setup((fake) => (fake.holdSnapshot = true), { wait: false });
  // Queued while the bridge was offline, so it arrives as soon as the bridge starts.
  room.deliver({ v: 1, type: "start_thread", runId: "run-early", harness: "codex", startedBy: driver, cwd: "/work/billing" });
  await expect.poll(() => fake.subscribed).toBe(true);
  fake.releaseSnapshot();
  await expect.poll(() => threadReports(room, "uplink-room-run-early").at(-1)?.state).toBe("working");
  expect(fake.launches).toMatchObject([{ threadId: "uplink-room-run-early", projectId: "project-1" }]);
  expect(room.messages.filter((m) => m.type === "thread_start_failed")).toEqual([]);
});
test("a thread the room launched in another project is still reported after a restart and after sharing resumes", async () => {
  const { Bridge } = await import("../src/bridge.ts");
  const home = await mkdtemp(join(tmpdir(), "uplink-threads-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const threadsFile = join(home, "threads.json");
  const { room, fake, bridge, adapter } = await t3Setup(
    (fake) =>
      fake.projects.push({
        id: "project-2",
        title: "Docs",
        workspaceRoot: "/work/docs",
        repositoryIdentity: { canonicalKey: "github.com/nuko/docs" },
        defaultModelSelection: null,
      }),
    { bridge: { threadsFile } },
  );
  room.deliver({ v: 1, type: "start_thread", runId: "run-docs", harness: "codex", startedBy: driver, cwd: "/work/docs" });
  await expect.poll(() => threadReports(room, "uplink-room-run-docs").at(-1)?.state).toBe("working");
  await bridge.close();
  await expect.poll(() => fake.subscribed).toBe(false);

  const next = new FakeRoom();
  const restarted = new Bridge({
    link: next,
    limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(home, "profiles"),
    linkedBy: driver.memberId,
    threadsFile,
    adapters: [adapter()],
  });
  cleanups.push(() => restarted.close());
  await restarted.start();
  await expect.poll(() => threadReports(next, "uplink-room-run-docs").at(-1)?.state).toBe("working");
  next.deliver({ v: 1, type: "stop_sharing" });
  next.deliver({ v: 1, type: "resume_sharing" });
  await expect.poll(() => threadReports(next, "uplink-room-run-docs").length).toBe(2);
  fake.update({ ...fake.threads.get("uplink-room-run-docs")!, status: "completed" });
  await expect.poll(() => threadReports(next, "uplink-room-run-docs").at(-1)?.state).toBe("done");
});
/**
 * Team A's bridge on a fresh home: it makes a profile and launches a thread in a project the adapter
 * doesn't watch, so only the saved launch makes a restarted bridge report it. Returns what a second
 * bridge on the same home needs.
 */
async function teamAWork() {
  const home = await mkdtemp(join(tmpdir(), "uplink-pairing-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const files = { threadsFile: join(home, "threads.json"), profilesDir: join(home, "profiles") };
  const context = await t3Setup(
    (fake) =>
      fake.projects.push({
        id: "project-2",
        title: "Secret",
        workspaceRoot: "/work/secret",
        repositoryIdentity: { canonicalKey: "github.com/team-a/secret" },
        defaultModelSelection: null,
      }),
    { bridge: { ...files, pairing: { machineId: "machine-a", teamId: "team-a" } } },
  );
  const { room, fake } = context;
  room.deliver({ v: 1, type: "create_profile", profileId: "a-profile", person: driver, expiresAt: Date.now() + 60_000 });
  room.deliver({ v: 1, type: "start_thread", runId: "run-a", harness: "codex", startedBy: driver, cwd: "/work/secret", prompt: "Team A only" });
  await expect.poll(() => threadReports(room, "uplink-room-run-a").at(-1)?.state).toBe("working");
  expect(room.messages).toContainEqual(expect.objectContaining({ type: "profile_created", profileId: "a-profile" }));
  return { ...context, files, home, fake };
}
/** Team B's bridge on the same home, returned once it has reported a thread in the watched project. */
async function teamBBridge(a: Awaited<ReturnType<typeof teamAWork>>) {
  await a.bridge.close();
  await expect.poll(() => a.fake.subscribed).toBe(false);
  const room = new FakeRoom();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 1000 },
    linkedBy: "b-member",
    ...a.files,
    pairing: { machineId: "machine-b", teamId: "team-b" },
    adapters: [a.adapter()],
  });
  cleanups.push(() => bridge.close());
  await bridge.start();
  a.fake.update({ id: "thread-b", projectId: "project-1", title: "Team B work", status: "running" });
  await expect.poll(() => threadReports(room, "thread-b").at(-1)?.state).toBe("working");
  return room;
}
test("after unlinking and pairing with another team, nothing the first team launched reaches the second", async () => {
  const a = await teamAWork();
  a.room.deliver({ v: 1, type: "unlink" });
  const { access } = await import("node:fs/promises");
  await expect.poll(() => access(a.files.threadsFile).then(() => "kept", () => "gone")).toBe("gone");

  const room = await teamBBridge(a);
  expect(threadReports(room, "uplink-room-run-a")).toEqual([]);
  expect(JSON.stringify(room.messages)).not.toMatch(/run-a|a-profile|Team A/);
});
test("a bridge paired again without unlinking ignores the threads and profiles the earlier pairing kept", async () => {
  const a = await teamAWork();
  const room = await teamBBridge(a);
  expect(threadReports(room, "uplink-room-run-a")).toEqual([]);
  expect(JSON.stringify(room.messages)).not.toMatch(/run-a|a-profile|Team A/);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(a.files.profilesDir)).not.toContain("a-profile");
});
test("start_thread with no cwd or repo launches in the watched project, also when it is named by its id", async () => {
  const { room, fake } = await t3Setup(() => {}, { project: "project-1" });
  room.deliver({ v: 1, type: "start_thread", runId: "run-id", harness: "codex", startedBy: driver });
  await expect.poll(() => fake.launches).toMatchObject([{ threadId: "uplink-room-run-id", projectId: "project-1" }]);
  expect(room.messages.filter((m) => m.type === "thread_start_failed")).toEqual([]);
});

test("an approval answer T3 Code fails to take stays answerable, and the retry reaches T3 Code", async () => {
  const { room, fake } = await t3Setup();
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.prompt?.promptId).toBeTruthy();
  const { promptId } = threadReports(room, "thread-a").at(-1)!.prompt!;
  // T3 Code is restarting: the answer doesn't reach it, but the approval still waits.
  fake.failCommands.add("runtime-request.respond");
  answer(room, promptId!);
  await expect
    .poll(() => room.messages.filter((m) => m.type === "input_rejected").map((m) => m.reason))
    .toEqual(["answer_failed"]);
  expect(fake.commands).toEqual([]);

  fake.failCommands.delete("runtime-request.respond");
  answer(room, promptId!);
  await expect
    .poll(() => fake.commands)
    .toEqual([
      {
        type: "runtime-request.respond",
        commandId: `uplink-room:answer:${promptId}`,
        threadId: "thread-a",
        requestId: "req-1",
        decision: "accept",
      },
    ]);
  expect(room.messages.filter((m) => m.type === "input_rejected").map((m) => m.reason)).toEqual(["answer_failed"]);
});

test("a room that names its features hears what the bridge handles and the T3 Code pairing; an older room hears neither", async () => {
  const older = await t3Setup();
  // The adapter is connected by now; give anything it would send time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(older.room.messages.filter((m) => ["bridge_features", "t3_status", "thread_access"].includes(m.type))).toEqual([]);

  const { room, session } = await t3Setup(undefined, { bridge: { link: new FeatureRoom() } });
  await expect.poll(() => room.messages.find((m) => m.type === "bridge_features")).toEqual({
    v: 1,
    type: "bridge_features",
    features: [...BRIDGE_FEATURES],
  });
  // `register_machine` goes first, so the room is known before anything newer is sent.
  expect(room.messages[0]?.type).toBe("register_machine");
  await expect.poll(() => statuses(room).at(-1)).toEqual({
    v: 1,
    type: "t3_status",
    state: "connected",
    expiresAt: session.expiresAt,
    environmentId: "env-fake-1",
  });
});

test("a thread's access is clamped to the machine's limit, and below Drive its wheel goes back only to whoever started it", async () => {
  const { room, fake, bridge } = await t3Setup(undefined, { bridge: { link: new FeatureRoom() } });
  const teammate = { memberId: "teammate", name: "Teammate" };
  room.deliver({ v: 1, type: "change_thread_access", threadRef: "thread-a", access: "drive" });
  await expect.poll(() => room.messages.find((m) => m.type === "thread_access")).toMatchObject({ threadRef: "thread-a", access: "suggest" });
  room.deliver({ v: 1, type: "thread_driver_changed", threadRef: "thread-a", driver: teammate });
  await expect
    .poll(() => room.messages.find((m) => m.type === "input_rejected"))
    .toMatchObject({ terminalId: "thread-a", memberId: "teammate", reason: "driver_change_rejected" });

  await bridge.setLimits({ mostOpenAccess: "drive", slots: 1, longestProfileMs: 1000 });
  room.deliver({ v: 1, type: "change_thread_access", threadRef: "thread-a", access: "drive" });
  room.deliver({ v: 1, type: "thread_driver_changed", threadRef: "thread-a", driver: teammate });
  approvalPending(fake, "req-1");
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.prompt?.promptId).toBeTruthy();
  const { promptId } = threadReports(room, "thread-a").at(-1)!.prompt!;
  // The wheel moved: the first driver's answer is refused, the new driver's reaches T3 Code.
  answer(room, promptId!, driver);
  await expect
    .poll(() => room.messages.filter((m) => m.type === "input_rejected").at(-1))
    .toMatchObject({ memberId: "driver", reason: "not_driver" });
  answer(room, promptId!, teammate);
  await expect.poll(() => fake.commands).toMatchObject([{ type: "runtime-request.respond", requestId: "req-1", decision: "accept" }]);
});

test("a thread saved by a bridge from before ADR 0021 takes its starter from the room, not whoever linked the machine", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "uplink-starters-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const threadsFile = join(home, "threads.json");
  // Version 3 before ADR 0021: drivers and launches, no access or starters.
  await writeFile(threadsFile, JSON.stringify({ v: 3, machineId: "machine-a", teamId: "team-a", drivers: { "thread-a": driver }, launched: {} }));
  const { room } = await t3Setup(undefined, {
    bridge: { link: new FeatureRoom(), threadsFile, pairing: { machineId: "machine-a", teamId: "team-a" } },
  });
  // At Watch the wheel only goes back to whoever started the thread: a teammate, not the linker.
  const starter = { memberId: "teammate", name: "Teammate" };
  room.deliver({ v: 1, type: "thread_driver_changed", threadRef: "thread-a", driver: starter, starterId: "teammate" });
  await expect.poll(async () => JSON.parse(await readFile(threadsFile, "utf8")).drivers["thread-a"]).toEqual(starter);
  expect(JSON.parse(await readFile(threadsFile, "utf8")).starters).toEqual({ "thread-a": "teammate" });
  expect(room.messages.filter((m) => m.type === "input_rejected")).toEqual([]);
});

test("a T3 Code session T3 refuses is reported once as needing pairing again, and a new pairing saved meanwhile is used without a restart", async () => {
  const { exchangePairingToken } = await import("../src/adapters/t3client.ts");
  const { PAIRING_TOKEN } = await import("./tools/fakeT3.ts");
  let saved: import("../src/adapters/t3client.ts").T3Session | undefined;
  const { room, fake, session } = await t3Setup(undefined, {
    bridge: { link: new FeatureRoom() },
    adapter: { loadSession: async () => saved, sessionPollMs: 30, refusedRetryMs: 60_000 },
  });
  saved = session;
  await expect.poll(() => statuses(room).at(-1)?.state).toBe("connected");
  // Revoked in T3 Code's Settings: the open socket closes and new tickets are refused.
  fake.revokeAll();
  await expect.poll(() => statuses(room).at(-1)).toMatchObject({ state: "needs_pairing", reason: "refused", expiresAt: session.expiresAt });
  const asked = fake.tickets.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Not tried again every retryMs (50 ms here) while no new pairing was saved.
  expect(fake.tickets.length).toBe(asked);

  saved = await exchangePairingToken(fake.url, PAIRING_TOKEN);
  await expect.poll(() => statuses(room).at(-1)?.state).toBe("connected");
  expect(fake.tickets.at(-1)).toBe(saved.token);
  expect(statuses(room).filter((s) => s.state === "needs_pairing")).toHaveLength(1);
});

test("a T3 Code session T3 refuses is replaced by the bridge's own pairing, and the room is never told it needs pairing", async () => {
  const { exchangePairingToken } = await import("../src/adapters/t3client.ts");
  const { PAIRING_TOKEN } = await import("./tools/fakeT3.ts");
  let url = "";
  const { room, fake } = await t3Setup(undefined, {
    bridge: { link: new FeatureRoom() },
    adapter: { pairAgain: () => exchangePairingToken(url, PAIRING_TOKEN), sessionPollMs: 30 },
  });
  url = fake.url;
  await expect.poll(() => statuses(room).at(-1)?.state).toBe("connected");
  const before = fake.tickets.at(-1);
  fake.revokeAll();
  await expect.poll(() => fake.tickets.at(-1) !== before && fake.subscribed).toBe(true);
  await expect.poll(() => statuses(room).at(-1)?.state).toBe("connected");
  expect(statuses(room).filter((s) => s.state === "needs_pairing")).toEqual([]);
});

test("a connected bridge renews a T3 Code session ending soon, and renews the new one again when it nears its end", async () => {
  const { exchangePairingToken } = await import("../src/adapters/t3client.ts");
  const { PAIRING_TOKEN } = await import("./tools/fakeT3.ts");
  let url = "";
  let renewals = 0;
  // 25 days on: every 30-day session is within 8 days of its end, so each one is renewed in turn.
  const { room, fake } = await t3Setup(undefined, {
    bridge: { link: new FeatureRoom() },
    adapter: {
      now: () => Date.now() + 25 * 24 * 60 * 60 * 1000,
      refusedRetryMs: 30,
      pairAgain: async () => {
        if (!url) return undefined;
        renewals++;
        return exchangePairingToken(url, PAIRING_TOKEN);
      },
    },
  });
  url = fake.url;
  await expect.poll(() => statuses(room).at(-1)?.state).toBe("connected");
  await expect.poll(() => renewals, { timeout: 3000 }).toBeGreaterThanOrEqual(3);
  expect(statuses(room).filter((s) => s.state === "needs_pairing")).toEqual([]);
});

test("a bridge with no T3 Code session pairs by itself and then launches threads", async () => {
  const { FakeT3, PAIRING_TOKEN } = await import("./tools/fakeT3.ts");
  const { T3CodeAdapter } = await import("../src/adapters/t3code.ts");
  const { exchangePairingToken } = await import("../src/adapters/t3client.ts");
  const fake = await new FakeT3().start();
  cleanups.push(() => fake.close());
  let attempts = 0;
  const { room } = await setup({
    link: new FeatureRoom(),
    linkedBy: driver.memberId,
    adapters: [
      new T3CodeAdapter({
        executable: join(import.meta.dirname, "tools/t3"),
        project: "/work/billing",
        retryMs: 50,
        // T3 Code isn't up the first time, and the next try is minutes away: the room's launch
        // makes the bridge try again at once.
        refusedRetryMs: 60_000,
        pairAgain: async () => (++attempts === 1 ? undefined : exchangePairingToken(fake.url, PAIRING_TOKEN)),
      }),
    ],
  });
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(1);
  room.deliver({ v: 1, type: "start_thread", runId: "run-1", harness: "codex", startedBy: driver });
  await expect.poll(() => fake.subscribed).toBe(true);
  await expect.poll(() => room.messages.find((m) => m.type === "thread_bound")).toMatchObject({ runId: "run-1" });
  expect(room.messages.filter((m) => m.type === "thread_start_failed")).toEqual([]);
});

test("a refused T3 Code session past its end is reported as expired", async () => {
  const { room, fake, session } = await t3Setup(undefined, {
    bridge: { link: new FeatureRoom() },
    adapter: { now: () => Date.now() + 31 * 24 * 60 * 60 * 1000, sessionPollMs: 60_000 },
  });
  fake.revokeAll();
  await expect.poll(() => statuses(room).at(-1)).toMatchObject({ state: "needs_pairing", reason: "expired", expiresAt: session.expiresAt });
});

test("a T3 Code secret request reads Waiting, to be answered in T3 Code, with no buttons", async () => {
  const { room } = await t3Setup((fake) => {
    // T3 reports the card as a pending user_input named by its turn item, not a runtime request.
    fake.threads.set("thread-s", {
      id: "thread-s",
      projectId: "project-1",
      title: "Deploy the preview",
      status: "running",
      pendingRuntimeRequest: { id: "item-secret", kind: "user_input" },
    });
    fake.projections.set("thread-s", {
      runtimeRequests: [],
      turnItems: [{ type: "secret_request", id: "item-secret", label: "Vercel token", reason: "to deploy", secretStatus: "pending" }],
    });
  });
  await expect.poll(() => threadReports(room, "thread-s").at(-1)).toMatchObject({
    state: "waiting",
    prompt: { kind: "question", text: "The agent asks for Vercel token. Enter it in T3 Code; secrets never go through the room." },
  });
  expect(threadReports(room, "thread-s").at(-1)!.prompt!.promptId).toBeUndefined();
});

/** A T3 Code turn item for the thread view tests. */
const turnItem = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `item-${String(n).padStart(4, "0")}`,
  type: "assistant_message",
  threadId: "thread-v",
  runId: "run-1",
  ordinal: n,
  status: "completed",
  title: null,
  startedAt: null,
  updatedAt: "2026-11-04T20:00:00.000Z",
  text: `Answer ${n}`,
  streaming: false,
  ...extra,
});
const items = (room: FakeRoom) =>
  room.messages.filter((m): m is Extract<BridgeMessage, { type: "thread_items" }> => m.type === "thread_items");

test("a watched thread's conversation reaches the room: its newest items first, then each change, until it's unwatched", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.projections.set("thread-v", {
      runtimeRequests: [],
      runs: [{ id: "run-1", status: "completed" }],
      turnItems: [
        turnItem(1, { type: "user_message", text: "Fix the rounding", inputIntent: "turn_start", attachments: [{ type: "image", name: "totals.png", mimeType: "image/png", sizeBytes: 2048 }] }),
        turnItem(2, { type: "command_execution", title: "pnpm test", input: "pnpm test", output: `${"x".repeat(5000)}1 failed`, exitCode: 1 }),
        turnItem(3, { type: "secret_request", label: "Vercel token", reason: "to deploy", secretStatus: "pending" }),
        turnItem(4),
      ],
    });
  }, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-v" });
  await expect.poll(() => items(room)[0]).toMatchObject({ threadRef: "thread-v", reset: true, older: false });
  const first = items(room)[0]!.items;
  expect(first.map((i) => i.kind)).toEqual(["message", "tool", "request", "message"]);
  expect(first[0]).toMatchObject({ role: "user", text: "Fix the rounding", attachments: [{ name: "totals.png", kind: "image", size: 2048 }] });
  // A command's output keeps its end, cut to the limit.
  expect(first[1]).toMatchObject({ tool: "command", title: "pnpm test", exitCode: 1, failed: true, cut: true });
  expect(first[1]!.output).toHaveLength(4000);
  expect(first[1]!.output!.endsWith("1 failed")).toBe(true);
  expect(first[2]).toMatchObject({ request: "secret", text: "Vercel token: to deploy" });

  // A streaming answer: its updates gather into one change.
  fake.pushThread("thread-v", { type: "turn-item.updated", payload: turnItem(5, { text: "Look", streaming: true, runId: "run-2" }) });
  fake.pushThread("thread-v", { type: "turn-item.updated", payload: turnItem(5, { text: "Looking at totals.ts", streaming: true, runId: "run-2" }) });
  await expect.poll(() => items(room)[1]?.items).toEqual([expect.objectContaining({ itemId: "item-0005", text: "Looking at totals.ts", streaming: true })]);
  // Rolled back in T3 Code: that turn's items go.
  fake.pushThread("thread-v", { type: "run.updated", payload: { id: "run-2", status: "rolled_back" } });
  await expect.poll(() => items(room).at(-1)?.removed).toEqual(["item-0005"]);

  room.deliver({ v: 1, type: "unwatch_thread", threadRef: "thread-v" });
  await expect.poll(() => fake.interrupts.length).toBe(1);
  expect(fake.threadSubs).toEqual([]);
});

test("older items come first from what the bridge holds, then from T3 Code's history before the oldest one", async () => {
  const all = Array.from({ length: 260 }, (_, i) => turnItem(i + 1));
  const { room, fake } = await t3Setup((fake) => {
    // T3 Code's bounded snapshot holds the newest 200; its history route has the rest.
    fake.projections.set("thread-v", { runtimeRequests: [], turnItems: all.slice(60) });
    fake.moreHistory.set("thread-v", true);
    fake.history.set("thread-v", all);
  }, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-v" });
  await expect.poll(() => items(room)[0]?.items.length).toBe(150);
  expect(items(room)[0]).toMatchObject({ older: true });
  expect(items(room)[0]!.items[0]!.itemId).toBe("item-0111");

  const pages = () => room.messages.filter((m) => m.type === "thread_history_page");
  room.deliver({ v: 1, type: "thread_history", threadRef: "thread-v", requestId: "h1", beforeItemId: "item-0111" });
  await expect.poll(() => pages()[0]).toMatchObject({ requestId: "h1", older: true });
  const firstPage = (pages()[0] as Extract<BridgeMessage, { type: "thread_history_page" }>).items;
  expect([firstPage[0]!.itemId, firstPage.at(-1)!.itemId]).toEqual(["item-0061", "item-0110"]);
  expect(fake.historyCursors).toEqual([]);

  room.deliver({ v: 1, type: "thread_history", threadRef: "thread-v", requestId: "h2", beforeItemId: "item-0061" });
  await expect.poll(() => pages()[1]).toMatchObject({ requestId: "h2", older: true });
  const second = (pages()[1] as Extract<BridgeMessage, { type: "thread_history_page" }>).items;
  expect([second[0]!.itemId, second.at(-1)!.itemId]).toEqual(["item-0011", "item-0060"]);
  expect(fake.historyCursors).toMatchObject([{ v: 1, st: "thread-v", si: "item-0061" }]);
});

test("a rollback of more than 500 items removes every one of them in the room, 500 to a message", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.projections.set("thread-v", {
      runtimeRequests: [],
      runs: [{ id: "run-2", status: "completed" }],
      turnItems: Array.from({ length: 800 }, (_, i) => turnItem(i + 1, { runId: "run-2" })),
    });
  }, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-v" });
  await expect.poll(() => items(room)[0]?.reset).toBe(true);
  fake.pushThread("thread-v", { type: "run.updated", payload: { id: "run-2", status: "rolled_back" } });
  await expect.poll(() => items(room).flatMap((m) => m.removed ?? []).length).toBe(800);
  expect(items(room).map((m) => m.removed?.length ?? 0).filter(Boolean)).toEqual([500, 300]);
});

test("older items read from T3 Code's history leave the room too when their turn is rolled back", async () => {
  const all = Array.from({ length: 260 }, (_, i) => turnItem(i + 1, { runId: i < 60 ? "run-1" : "run-2" }));
  const { room, fake } = await t3Setup((fake) => {
    fake.projections.set("thread-v", {
      runtimeRequests: [],
      runs: [{ id: "run-1", status: "completed" }, { id: "run-2", status: "completed" }],
      turnItems: all.slice(60),
    });
    fake.moreHistory.set("thread-v", true);
    fake.history.set("thread-v", all);
  }, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-v" });
  await expect.poll(() => items(room)[0]?.reset).toBe(true);
  room.deliver({ v: 1, type: "thread_history", threadRef: "thread-v", requestId: "h1", beforeItemId: "item-0061" });
  await expect.poll(() => room.messages.find((m) => m.type === "thread_history_page")).toMatchObject({ requestId: "h1" });
  fake.pushThread("thread-v", { type: "run.updated", payload: { id: "run-1", status: "rolled_back" } });
  await expect.poll(() => items(room).flatMap((m) => m.removed ?? []).length).toBe(50);
  expect(items(room).flatMap((m) => m.removed ?? [])).toEqual(expect.arrayContaining(["item-0011", "item-0060"]));
});

test("a rollback of every item the room had fills its window again from what the bridge still holds", async () => {
  const { room, fake } = await t3Setup((fake) => {
    fake.projections.set("thread-v", {
      runtimeRequests: [],
      runs: [{ id: "run-1", status: "completed" }, { id: "run-2", status: "completed" }],
      turnItems: Array.from({ length: 200 }, (_, i) => turnItem(i + 1, { runId: i < 50 ? "run-1" : "run-2" })),
    });
  }, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-v" });
  await expect.poll(() => items(room)[0]?.items.length).toBe(150);
  fake.pushThread("thread-v", { type: "run.updated", payload: { id: "run-2", status: "rolled_back" } });
  await expect.poll(() => items(room).flatMap((m) => m.removed ?? []).length).toBe(150);
  const refill = items(room).slice(1).flatMap((m) => m.items.map((i) => i.itemId));
  expect([refill.length, refill[0], refill.at(-1)]).toEqual([50, "item-0001", "item-0050"]);
});

test("a history read that ends after sharing stopped sends none of what it read", async () => {
  const all = Array.from({ length: 260 }, (_, i) => turnItem(i + 1));
  let release!: () => void;
  const { room, fake } = await t3Setup((fake) => {
    fake.projections.set("thread-v", { runtimeRequests: [], turnItems: all.slice(60) });
    fake.moreHistory.set("thread-v", true);
    fake.history.set("thread-v", all);
    fake.historyGate = new Promise<void>((resolve) => (release = resolve));
  }, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "thread-v" });
  await expect.poll(() => items(room).length).toBe(1);
  // Before the oldest the bridge holds: only T3 Code's history route has these.
  room.deliver({ v: 1, type: "thread_history", threadRef: "thread-v", requestId: "h1", beforeItemId: "item-0061" });
  await expect.poll(() => fake.historyCursors.length).toBe(1);
  room.deliver({ v: 1, type: "stop_sharing" });
  await expect.poll(() => fake.subscribed).toBe(false);
  release();
  await expect
    .poll(() => room.messages.find((m) => m.type === "thread_history_page"))
    .toEqual({ v: 1, type: "thread_history_page", threadRef: "thread-v", requestId: "h1", items: [], older: false, error: "sharing_stopped" });
});

test("a view opened before the launch bound its thread is unwatched by T3 Code's id, and not followed again", async () => {
  const { room, fake } = await t3Setup(undefined, { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "start_thread", runId: "run-w", harness: "codex", startedBy: driver, cwd: "/work/billing" });
  await expect.poll(() => threadReports(room, "uplink-room-run-w").at(-1)?.state).toBe("working");
  // Watched by its run id, as a room does before thread_bound reaches it; unwatched by T3 Code's.
  room.deliver({ v: 1, type: "watch_thread", threadRef: "run-w" });
  await expect.poll(() => fake.threadSubs.length).toBe(1);
  room.deliver({ v: 1, type: "unwatch_thread", threadRef: "uplink-room-run-w" });
  await expect.poll(() => fake.threadSubs.length).toBe(0);
  room.deliver({ v: 1, type: "stop_sharing" });
  room.deliver({ v: 1, type: "resume_sharing" });
  await expect.poll(() => threadReports(room, "uplink-room-run-w").length).toBeGreaterThan(1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(fake.threadSubs).toEqual([]);
});

test("a turn's diff is read from T3 Code on request, and one T3 Code can't give says why", async () => {
  const { room } = await t3Setup((fake) => fake.diffs.set("thread-v:1-2", "diff --git a/totals.ts b/totals.ts\n+round half up\n"), {
    bridge: { link: new FeatureRoom() },
  });
  room.deliver({ v: 1, type: "thread_diff_request", threadRef: "thread-v", requestId: "d1", turn: 2 });
  room.deliver({ v: 1, type: "thread_diff_request", threadRef: "thread-v", requestId: "d2", turn: 5 });
  const diffs = () => room.messages.filter((m): m is Extract<BridgeMessage, { type: "thread_diff" }> => m.type === "thread_diff");
  await expect.poll(() => diffs().length).toBe(2);
  expect(diffs().find((d) => d.requestId === "d1")).toMatchObject({ diff: "diff --git a/totals.ts b/totals.ts\n+round half up\n" });
  expect(diffs().find((d) => d.requestId === "d2")).toMatchObject({ error: "No checkpoint for that turn." });
});

test("a thread stream recorded from a real T3 Code server turns into the room's items, in T3 Code's order", async () => {
  // Recorded on 2026-11-04 from T3 Code v0.1.8-nightly.20261104.4179 by `scripts/t3-live-check.ts view`:
  // the scripted ACP agent asked for an approval (allowed), made a plan, ran three tools and wrote a file.
  const { readFile } = await import("node:fs/promises");
  const stream = JSON.parse(await readFile(join(import.meta.dirname, "recordings/t3-thread-stream.json"), "utf8")) as unknown[];
  const { room } = await t3Setup((fake) => fake.threadStreams.set("uplink-room-view-1", stream), { bridge: { link: new FeatureRoom() } });
  room.deliver({ v: 1, type: "watch_thread", threadRef: "uplink-room-view-1" });
  const latest = new Map<string, import("@uplink-room/protocol").ThreadItem>();
  await expect
    .poll(() => {
      for (const batch of items(room)) for (const item of batch.items) latest.set(item.itemId, item);
      return [...latest.values()].some((i) => i.kind === "checkpoint" && i.turn === 1);
    })
    .toBe(true);
  expect(items(room)[0]).toMatchObject({ reset: true });
  const shown = [...latest.values()].sort((a, b) => a.order - b.order);
  expect(shown.map((i) => (i.kind === "tool" ? `tool:${i.tool}` : i.kind === "request" ? `request:${i.request}:${i.outcome}` : i.kind))).toEqual([
    "message",
    "tool:command",
    "plan",
    "tool:tool",
    "tool:command",
    "tool:search",
    "tool:command",
    "request:approval:accept",
    "message",
    "checkpoint",
  ]);
  expect(shown[0]).toMatchObject({ role: "user", text: "APPROVE then PLAN and TOOLS" });
  expect(shown.find((i) => i.kind === "plan")?.steps?.map((s) => s.status)).toEqual(["completed", "running", "pending"]);
  expect(shown.at(-2)).toMatchObject({ role: "assistant" });
  expect(shown.at(-2)!.text).toContain("Approval outcome: allow.");
  expect(shown.at(-1)).toMatchObject({ kind: "checkpoint", turn: 1, files: [{ path: "uplink-probe.txt", additions: 1, deletions: 0 }] });
});

const results = (room: FakeRoom) =>
  room.messages.filter((m): m is Extract<BridgeMessage, { type: "thread_message_result" }> => m.type === "thread_message_result");

test("a driver's message starts a turn in an idle thread and waits behind a busy one's; anyone else's is refused", async () => {
  const { room, fake } = await t3Setup(
    (fake) => fake.threads.set("thread-a", { id: "thread-a", projectId: "project-1", title: "Fix totals", status: "completed", activeRunId: null }),
    { bridge: { link: new FeatureRoom() } },
  );
  const say = (messageId: string, from = driver) =>
    room.deliver({ v: 1, type: "send_thread_message", threadRef: "thread-a", messageId, from, text: `Message ${messageId}` });
  say("m1");
  await expect.poll(() => results(room)[0]).toMatchObject({ messageId: "m1", status: "sent" });
  expect(fake.commands[0]).toEqual({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: "uplink-room:message:m1",
    threadId: "thread-a",
    messageId: "uplink-room:m1",
    text: "Message m1",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });
  fake.update({ ...fake.threads.get("thread-a")!, status: "running", activeRunId: "run-2" });
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("working");
  say("m2");
  await expect.poll(() => results(room)[1]).toMatchObject({ messageId: "m2", status: "queued" });
  expect(fake.commands[1]).toMatchObject({ dispatchMode: { type: "queue_after_active" } });
  say("m3", { memberId: "teammate", name: "Teammate" });
  await expect.poll(() => results(room)[2]).toMatchObject({ messageId: "m3", status: "failed", error: "not_driver" });
  expect(fake.commands).toHaveLength(2);
});

test("only the driver stops a thread's turn in progress, which interrupts its run", async () => {
  const { room, fake } = await t3Setup(
    (fake) => fake.threads.set("thread-a", { id: "thread-a", projectId: "project-1", title: "Fix totals", status: "running", activeRunId: "run-7" }),
    { bridge: { link: new FeatureRoom() } },
  );
  await expect.poll(() => threadReports(room, "thread-a").at(-1)?.state).toBe("working");
  room.deliver({ v: 1, type: "interrupt_thread", threadRef: "thread-a", from: { memberId: "teammate", name: "Teammate" } });
  await expect.poll(() => room.messages.find((m) => m.type === "input_rejected")).toMatchObject({ terminalId: "thread-a", reason: "not_driver" });
  room.deliver({ v: 1, type: "interrupt_thread", threadRef: "thread-a", from: driver });
  await expect.poll(() => fake.commands).toMatchObject([{ type: "run.interrupt", threadId: "thread-a", runId: "run-7" }]);
});

test("a T3 Code question is answered from the room with each question's answer, once, and an older room gets it as text", async () => {
  const question = (fake: import("./tools/fakeT3.ts").FakeT3) => {
    fake.threads.set("thread-q", { id: "thread-q", projectId: "project-1", title: "Pick", status: "running", pendingRuntimeRequest: { id: "req-q", kind: "user_input" } });
    fake.projections.set("thread-q", {
      runtimeRequests: [{ id: "req-q", kind: "user_input", status: "pending", responseCapability: { type: "live" } }],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "req-q",
          questions: [
            { id: "rounding", header: "Rounding", question: "Which rounding?", options: [{ label: "Half up", description: "0.5 goes up" }, { label: "Banker's", description: "0.5 goes to even" }] },
          ],
        },
      ],
    });
  };
  const older = await t3Setup(question);
  await expect.poll(() => threadReports(older.room, "thread-q").at(-1)?.state).toBe("waiting");
  const plain = threadReports(older.room, "thread-q").at(-1)!.prompt!;
  expect(plain).toEqual({ kind: "question", text: "Which rounding? (Half up / Banker's)" });

  const { room, fake } = await t3Setup(question, { bridge: { link: new FeatureRoom() } });
  await expect.poll(() => threadReports(room, "thread-q").at(-1)?.prompt?.promptId).toBeTruthy();
  const prompt = threadReports(room, "thread-q").at(-1)!.prompt!;
  expect(prompt.questions).toEqual([
    {
      id: "rounding",
      header: "Rounding",
      question: "Which rounding?",
      options: [{ label: "Half up", description: "0.5 goes up" }, { label: "Banker's", description: "0.5 goes to even" }],
      allowCustomAnswer: true,
    },
  ]);
  const ask = (promptId: string, answers: Record<string, string>, from = driver) =>
    room.deliver({ v: 1, type: "answer_question", threadRef: "thread-q", from, promptId, answers });
  ask(prompt.promptId!, { rounding: "Half up" }, { memberId: "teammate", name: "Teammate" });
  ask("old-id", { rounding: "Half up" });
  ask(prompt.promptId!, { color: "blue" });
  await expect.poll(() => room.messages.filter((m) => m.type === "input_rejected").map((m) => m.reason)).toEqual(["not_driver", "stale_prompt", "invalid_answer"]);
  ask(prompt.promptId!, { rounding: "Half up" });
  await expect.poll(() => fake.commands).toEqual([
    { type: "runtime-request.respond", commandId: `uplink-room:answer:${prompt.promptId}`, threadId: "thread-q", requestId: "req-q", answers: { rounding: "Half up" } },
  ]);
  await expect.poll(() => threadReports(room, "thread-q").at(-1)?.state).toBe("working");
});
