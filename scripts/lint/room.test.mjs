import { expect, test } from "vitest";
import { parseSync } from "oxc-parser";
import { checkRoom } from "./room.mjs";

const rules = (source, file) => checkRoom(parseSync(file, source).program, file, source).map((h) => h.rule);

test("a Node entry point under src calls onClosedOutput; tests, scripts and libraries don't have to", () => {
  const entry = "packages/bridge/src/bin.ts";
  expect(rules('#!/usr/bin/env node\nimport { main } from "./cli.ts";\nawait main();', entry)).toEqual(["entry-handles-closed-output"]);
  expect(rules("#!/usr/bin/env node\nonClosedOutput();\nawait main();", entry)).toEqual([]);
  expect(rules("#!/usr/bin/env node\nif (isEntryPoint()) { onClosedOutput(() => process.exit()); }", entry)).toEqual([]);
  expect(rules("#!/usr/bin/env node\nawait main();", "packages/bridge/test/tools/acp.mjs")).toEqual([]);
  expect(rules("export const main = () => {};", entry)).toEqual([]);
});

test("a backend function is public only through publicQuery or publicMutation", () => {
  const file = "packages/backend/convex/tasks.ts";
  expect(rules('import { query, internalQuery } from "./_generated/server";', file)).toEqual(["public-functions-answer-refusals"]);
  expect(rules('import { mutation } from "../_generated/server";', "packages/backend/convex/lib/x.ts")).toEqual(["public-functions-answer-refusals"]);
  expect(rules('import { internalMutation, type QueryCtx } from "./_generated/server";', file)).toEqual([]);
  expect(rules('import { mutation, query } from "../_generated/server";', "packages/backend/convex/lib/refusals.ts")).toEqual([]);
});

test("shipped code calls the room through a client that takes refusals answered", () => {
  const file = "packages/bridge/src/link.ts";
  expect(rules("const client = new ConvexClient(url);\nawait client.mutation(ref, args);", file)).toEqual(["convex-calls-accept-refusals"]);
  expect(rules("class L { constructor() { this.client = new ConvexClient(url); } go() { return this.client.onUpdate(ref, {}, f); } }", file)).toEqual([
    "convex-calls-accept-refusals",
  ]);
  expect(rules("class L { #live; go() { this.#live ??= new ConvexClient(u); return this.#live.query(ref, {}); } }", file)).toEqual([
    "convex-calls-accept-refusals",
  ]);
  expect(rules("const client = new ConvexClient(url);\nawait acceptingRefusals(client).mutation(ref, args);\nawait client.close();", file)).toEqual([]);
  expect(rules("const c = new ConvexReactClient(url);", "apps/desktop/src/renderer/main.tsx")).toEqual(["convex-calls-accept-refusals"]);
  expect(rules("const c = new ConvexHttpClient(url);", "apps/desktop/scripts/seed.ts")).toEqual([]);
});

test("the backend runs a function by name only at a catalog path, whose functions check ids", () => {
  const file = "packages/backend/convex/http.ts";
  expect(rules('ctx.runQuery(makeFunctionReference("messages:getAgent"), args);', file)).toEqual(["run-by-name-through-catalog"]);
  expect(rules("ctx.runQuery(makeFunctionReference(name), args);", file)).toEqual(["run-by-name-through-catalog"]);
  expect(rules("ctx.runQuery(makeFunctionReference(agentFunctionPath(entry.name)), args);", file)).toEqual([]);
  expect(rules("const path = a ? accountFunctionPath(n) : agentFunctionPath(n);\nctx.runQuery(makeFunctionReference(path), args);", file)).toEqual([]);
  const viaHelper = (arg) => `async function run(ctx, path, args) { return ctx.runQuery(makeFunctionReference(path), args); }\nrun(ctx, runFunctionPath(n), a);\nrun(ctx, ${arg}, a);`;
  expect(rules(viaHelper("agentFunctionPath(n)"), file)).toEqual([]);
  expect(rules(viaHelper('"tasks:create"'), file)).toEqual(["run-by-name-through-catalog"]);
});

test("code that reads a spawnSync result's status also reads its error", () => {
  const file = "apps/desktop/scripts/release-mac.ts";
  expect(rules('const r = spawnSync("pnpm", ["build"]);\nif (r.status !== 0) fail(r.status);', file)).toEqual([
    "child-process-reports-start-failure",
  ]);
  expect(rules('if (spawnSync("pnpm", []).status !== 0) fail();', file)).toEqual(["child-process-reports-start-failure"]);
  expect(rules('const r = cp.spawnSync("pnpm", []);\nif (r.status) fail();', file)).toEqual(["child-process-reports-start-failure"]);
  expect(rules('const r = spawnSync("pnpm", []);\nif (r.error) fail(r.error.message);\nif (r.status !== 0) fail();', file)).toEqual([]);
  // Each function's own result: an error read in one doesn't excuse another.
  expect(
    rules('function a() { const r = spawnSync("x", []); if (r.error) throw r.error; }\nfunction b() { const r = spawnSync("y", []); return r.status; }', file),
  ).toEqual(["child-process-reports-start-failure"]);
  expect(rules('const r = spawnSync("pnpm", []);\nexpect(r.status).toBe(0);', "packages/bridge/test/cli.test.ts")).toEqual([]);
});

test("a Room API handler that reads runs or tasks itself checks who may see them", () => {
  const file = "packages/backend/convex/a2a.ts";
  // a2a.runs before the first review of the Board lessons: every run of the agent, to anyone.
  const before = `export const { person: runs } = roomQuery({ name: "a2a.runs", handler: async (ctx, actor, args) => {
    const all = await ctx.db.query("runs").withIndex("by_agent", (q) => q.eq("agentId", args.agentId)).take(50);
    return all.map((r) => r._id);
  } });`;
  expect(rules(before, file)).toEqual(["room-api-reads-runs-through-access"]);
  // Checking the agent's id (inTeam) isn't checking the runs the query lists.
  expect(rules(before.replace("const all", "await inTeam(ctx, actor, args.agentId);\n    const all"), file)).toEqual(["room-api-reads-runs-through-access"]);
  const after = before.replace("return all.map", "const shown = []; for (const r of all) if (await seesRun(ctx, r, actor)) shown.push(r); return shown.map");
  expect(rules(after, file)).toEqual([]);
  // Internal functions (crons, the bridge) and lib helpers read runs without a viewer.
  expect(rules(`export const sweep = internalMutation({ handler: async (ctx) => ctx.db.query("runs").collect() });`, file)).toEqual([]);
  expect(rules(before, "packages/backend/convex/lib/runs.ts")).toEqual([]);
});
