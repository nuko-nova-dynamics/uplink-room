/**
 * An agent's call with the wrong kind of id is refused with `invalid`, not thrown as Convex's
 * ArgumentValidationError, which Convex reports to Sentry (lib/idArgs.ts, UPLINK-ROOM-BACKEND-J).
 */
import { expect, test } from "vitest";
import { v } from "convex/values";
import { api } from "../convex/_generated/api";
import { accountFunctionPath, agentFunctionPath, catalog, runFunctionPath } from "../convex/lib/catalog";
import { checkIds, looseIds } from "../convex/lib/idArgs";
import "../convex/roomModules";

/** A validator's JSON form, which Convex keeps on it but leaves out of its types. */
const json = (validator: unknown) => (validator as { json: unknown }).json;
import { addAgent, callAsAgent, newRoom, newTeam } from "./setup";

test("an agent that passes another table's id gets invalid, naming both tables, and the right id still works", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Hermes", ["room.read", "messages.post"]);
  const channelId = (await admin.as.query(api.channels.list, { teamId })).find((c) => c.name === "general")!.channelId;

  const wrong = await callAsAgent(t, key, "messages.get", { messageId: channelId });
  expect(wrong).toMatchObject({ status: 400, ok: false, error: { code: "invalid" } });
  expect(wrong.error?.message).toBe("messageId takes an id from messages; this one is from channels.");
  expect(await callAsAgent(t, key, "messages.get", { messageId: "not-an-id" })).toMatchObject({
    status: 400,
    error: { code: "invalid", message: "messageId takes an id from messages; this isn't one." },
  });

  const posted = await callAsAgent(t, key, "messages.post", { channelId, body: "hello" });
  const read = await callAsAgent(t, key, "messages.get", { messageId: posted.result });
  expect(read).toMatchObject({ ok: true, result: { body: "hello" } });
});

test("ids nested in objects, arrays and nullable unions are checked; other unions keep Convex's check", async () => {
  const args = {
    teamId: v.id("teams"),
    list: v.array(v.id("channels")),
    nested: v.optional(v.object({ projectId: v.union(v.id("projects"), v.null()) })),
    either: v.union(v.id("tasks"), v.string()),
  };
  const loosened = looseIds(args);
  expect(json(loosened.list)).toEqual({ type: "array", value: { type: "string" } });
  expect(loosened.nested.isOptional).toBe("optional");
  // A string here could be either member, so it can't be loosened and stays Convex's to check.
  expect(loosened.either).toBe(args.either);

  const t = newRoom();
  const { teamId } = await newTeam(t);
  const channelId = await t.run(async (ctx) => (await ctx.db.query("channels").first())!._id);
  await t.run(async (ctx) => {
    expect(() => checkIds(ctx, args, { teamId, list: [channelId], nested: { projectId: null } })).not.toThrow();
    expect(() => checkIds(ctx, args, { teamId, list: [channelId, teamId] })).toThrow("list[1] takes an id from channels; this one is from teams.");
    expect(() => checkIds(ctx, args, { teamId, list: [], nested: { projectId: teamId } })).toThrow(
      "nested.projectId takes an id from projects; this one is from teams.",
    );
  });
});

test("every Room API function's loosened arguments differ from its own only where an id became a string", () => {
  // Ids out, the shapes Convex still checks are the same, so the handlers get what they always did.
  const idsAsStrings = (json: unknown): unknown =>
    JSON.parse(JSON.stringify(json), (_key, value) =>
      value && typeof value === "object" && value.type === "id" ? { type: "string" } : value,
    );
  expect(catalog().length).toBeGreaterThan(100);
  for (const entry of catalog()) {
    const loosened = looseIds(entry.args);
    for (const [name, validator] of Object.entries(entry.args)) {
      const before = idsAsStrings(json(validator));
      const after = idsAsStrings(json(loosened[name]));
      expect(normalizeUnions(after), `${entry.name} ${name}`).toEqual(normalizeUnions(before));
    }
  }
});

/** A union's members as a set: loosening puts the string first and merges the ids into it. */
function normalizeUnions(json: unknown): unknown {
  return JSON.parse(JSON.stringify(json), (_key, value) =>
    value && typeof value === "object" && value.type === "union"
      ? { ...value, value: [...new Set((value.value as unknown[]).map((m) => JSON.stringify(m)))].sort() }
      : value,
  );
}

test("every function an agent, a CLI sign-in or a joined run calls by name takes its ids loosened, for checkIds to check", async () => {
  // The paths http.ts, live.ts and the remote MCP connector run (lint rule room/run-by-name-through-catalog).
  const paths = (entry: ReturnType<typeof catalog>[number]) =>
    entry.realm === "run" ? [runFunctionPath(entry.name)] : entry.realm === "team" ? [agentFunctionPath(entry.name)] : [agentFunctionPath(entry.name), accountFunctionPath(entry.name)];
  let checked = 0;
  for (const entry of catalog()) {
    for (const path of paths(entry)) {
      const [file, name] = path.split(":") as [string, string];
      const fn = (await import(`../convex/${file}.ts`))[name] as { exportArgs(): string } | undefined;
      if (!fn) continue; // An account function has no agent path.
      const declared = JSON.parse(fn.exportArgs()) as { value: Record<string, { fieldType: unknown }> };
      for (const [arg, validator] of Object.entries(looseIds(entry.args))) {
        expect(declared.value[arg]?.fieldType, `${path} ${arg}`).toEqual(json(validator));
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(100);
});
