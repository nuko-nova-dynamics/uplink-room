import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type MutationCtx } from "./_generated/server";
import { activeAgentKeys, MAX_ACTIVE_KEYS, requireAdmin, type Actor } from "./lib/actor";
import { randomSecret, sha256 } from "./lib/crypto";
import { roomError } from "./lib/errors";
import { audit, inTeam } from "./lib/members";
import { channelAccess } from "./lib/channels";
import { roomMutation, roomQuery } from "./lib/room";
import { startTeamMember } from "./lib/reads";
import { DEFAULT_AGENT_SCOPES, isScope, type Scope } from "./lib/scopes";
import { revokeBrowserAccess } from "./browsers";
import { removeFromCalls } from "./calls";
import { vCharacter } from "./schema";

export const vConnection = v.union(v.literal("mcp"), v.literal("http"), v.literal("a2a"), v.literal("cli"), v.literal("webhook"));

export function checkScopes(scopes: string[]): Scope[] {
  const bad = scopes.filter((s) => !isScope(s));
  if (bad.length) throw roomError("invalid", `Unknown scopes: ${bad.join(", ")}`);
  return [...new Set(scopes)] as Scope[];
}

/**
 * Adds an agent to the actor's team, as agents.add does: the person adding it is accountable for
 * it, and it starts as a member with no admin role. Also used when a person approves a remote
 * connector (connectors.approve).
 */
export async function insertAgent(
  ctx: MutationCtx,
  actor: Actor,
  args: { name: string; connection: Infer<typeof vConnection>; character?: Infer<typeof vCharacter> },
): Promise<{ agentId: Id<"agents">; memberId: Id<"members"> }> {
  if (actor.kind !== "person") {
    throw roomError("forbidden", "Every agent is added by a person, who is accountable for it.");
  }
  const name = args.name.trim();
  if (!name) throw roomError("invalid", "An agent needs a name.");
  const agentId = await ctx.db.insert("agents", {
    teamId: actor.teamId,
    name,
    addedBy: actor.member._id,
    connection: args.connection,
    ...(args.character ? { character: args.character } : {}),
  });
  const memberId = await ctx.db.insert("members", {
    teamId: actor.teamId,
    kind: "agent",
    agentId,
    name,
    role: "member",
  });
  // Read state starts now: what the team's channels hold so far counts as read (lib/reads.ts).
  await startTeamMember(ctx, actor.teamId, memberId);
  await audit(ctx, actor, "agent.added", agentId, { name });
  return { agentId, memberId };
}

/** Only the person who added an agent makes its keys. */
function requireOwnAgent(actor: Actor, agent: Doc<"agents">): void {
  if (actor.kind !== "person" || agent.addedBy !== actor.member._id) {
    throw roomError("forbidden", "Only the person who added this agent can create its keys.");
  }
}

/**
 * Makes an agent key for `agent`, which the actor must have added, as agents.createKey does. The
 * room keeps only the secret's hash; the caller decides whether anyone ever sees the secret.
 */
export async function insertAgentKey(
  ctx: MutationCtx,
  actor: Actor,
  agent: Doc<"agents">,
  name: string,
  scopes: Scope[],
  channelIds?: Id<"channels">[],
): Promise<{ keyId: Id<"agentKeys">; secret: string }> {
  requireOwnAgent(actor, agent);
  // Bounded, so reading all of an agent's unrevoked keys (activeAgentKeys) never misses one.
  if ((await activeAgentKeys(ctx, agent._id)).length >= MAX_ACTIVE_KEYS) {
    throw roomError("conflict", `${agent.name} already has ${MAX_ACTIVE_KEYS} keys. Revoke an old key before creating another.`);
  }
  const secret = randomSecret("urk");
  const keyId = await ctx.db.insert("agentKeys", {
    teamId: actor.teamId,
    agentId: agent._id,
    name,
    hash: await sha256(secret),
    prefix: secret.slice(0, 8),
    scopes,
    ...(channelIds ? { channelIds } : {}),
    createdBy: actor.member._id,
    createdAt: Date.now(),
  });
  await audit(ctx, actor, "agent_key.created", keyId, { agentId: agent._id, scopes, ...(channelIds ? { channelIds } : {}) });
  return { keyId, secret };
}

/** The most channels one key can be limited to (ADR 0049). */
export const MAX_KEY_CHANNELS = 50;

/**
 * The channels a key is to be limited to, checked: each one the person setting the limit can see,
 * at most MAX_KEY_CHANNELS, without repeats. An empty list leaves the key no channel at all.
 */
async function checkKeyChannels(ctx: MutationCtx, actor: Actor, ids: Id<"channels">[]): Promise<Id<"channels">[]> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_KEY_CHANNELS) throw roomError("invalid", `A key can be limited to at most ${MAX_KEY_CHANNELS} channels.`);
  for (const id of unique) await channelAccess(ctx, actor, id);
  return unique;
}

/** Only the person who added an agent changes its keys. */
async function ownKey(ctx: MutationCtx, actor: Actor, keyId: Id<"agentKeys">): Promise<Doc<"agentKeys">> {
  const key = await ctx.db.get(keyId);
  if (!key || key.teamId !== actor.teamId) throw roomError("not_found", "No such key.");
  const agent = await ctx.db.get(key.agentId);
  if (actor.kind !== "person" || agent?.addedBy !== actor.member._id) {
    throw roomError("forbidden", "Only the person who added this agent can change its keys.");
  }
  return key;
}

export const { person: add, agent: addAgent } = roomMutation({
  name: "agents.add",
  description:
    "Add an agent to the team. The person adding it is accountable for it, and it can do at most what that person can.",
  scope: "people.invite",
  args: { name: v.string(), connection: vConnection, character: v.optional(vCharacter) },
  handler: async (ctx, actor, args) => (await insertAgent(ctx, actor, args)).agentId,
});

export const { person: createKey, agent: createKeyAgent } = roomMutation({
  name: "agents.createKey",
  description:
    "Create an agent key for an agent you added, narrowed to these scopes, and optionally to some channels (channelIds): then it can read and post only there, and see only the tasks of those channels' projects and the tasks it created in no project. The secret is returned once. An agent holds at most 50 unrevoked keys: revoke an old one to make room.",
  scope: "people.invite",
  args: {
    agentId: v.id("agents"),
    name: v.string(),
    scopes: v.optional(v.array(v.string())),
    channelIds: v.optional(v.array(v.id("channels"))),
  },
  argDocs: {
    channelIds: `The only channels this key may read and post in, at most ${MAX_KEY_CHANNELS}, each one you can see. Left out: every channel you can see. Runs, machines and the team's roster aren't channels, so the scopes alone decide those`,
  },
  handler: async (ctx, actor, args) => {
    const agent = await inTeam(ctx, actor, args.agentId);
    requireOwnAgent(actor, agent);
    const scopes = args.scopes ? checkScopes(args.scopes) : DEFAULT_AGENT_SCOPES;
    const channelIds = args.channelIds ? await checkKeyChannels(ctx, actor, args.channelIds) : undefined;
    const { keyId, secret } = await insertAgentKey(ctx, actor, agent, args.name, scopes, channelIds);
    return { keyId, secret, scopes, ...(channelIds ? { channelIds } : {}) };
  },
});

export const { person: setKeyScopes, agent: setKeyScopesAgent } = roomMutation({
  name: "agents.setKeyScopes",
  description: "Change the scopes of one of your agent's keys.",
  scope: "people.invite",
  args: { keyId: v.id("agentKeys"), scopes: v.array(v.string()) },
  handler: async (ctx, actor, args) => {
    const key = await ownKey(ctx, actor, args.keyId);
    const scopes = checkScopes(args.scopes);
    await ctx.db.patch(key._id, { scopes });
    // What the key already holds goes with a scope it loses, as with a narrowing (setKeyChannels):
    // its shared browser connections with browsers.use, its calls with calls.join. Its file links
    // check the key's scopes when used.
    const lost = (scope: Scope) => key.scopes.includes(scope) && !scopes.includes(scope);
    if (lost("browsers.use")) await revokeBrowserAccess(ctx, actor, { agentKeyId: key._id });
    if (lost("calls.join")) await removeAgentFromCalls(ctx, key.agentId);
    await audit(ctx, actor, "agent_key.scopes_changed", key._id, { scopes });
    return null;
  },
});

export const { person: setKeyChannels, agent: setKeyChannelsAgent } = roomMutation({
  name: "agents.setKeyChannels",
  description:
    "Limit one of your agent's keys to some channels, or lift the limit with channelIds null. A limited key reads and posts only in those channels, and sees only the tasks of their projects and the tasks it created in no project; anywhere else answers not_found, as for a channel that doesn't exist. It applies from the key's next call.",
  scope: "people.invite",
  args: { keyId: v.id("agentKeys"), channelIds: v.union(v.array(v.id("channels")), v.null()) },
  handler: async (ctx, actor, args) => {
    const key = await ownKey(ctx, actor, args.keyId);
    const channelIds = args.channelIds ? await checkKeyChannels(ctx, actor, args.channelIds) : undefined;
    await ctx.db.patch(key._id, { channelIds });
    // Its calls and shared browser connections go with the narrowing (it can join again where it
    // still may); its file links and browser tickets check the key's channels when used.
    if (channelIds) {
      await revokeBrowserAccess(ctx, actor, { agentKeyId: key._id });
      await removeAgentFromCalls(ctx, key.agentId);
    }
    await audit(ctx, actor, "agent_key.channels_changed", key._id, { channelIds: channelIds ?? null });
    return null;
  },
});

/**
 * Drops an agent from the calls it's in and revokes its LiveKit joins (calls.removeFromCalls). It
 * can join again where a key of its still may.
 */
async function removeAgentFromCalls(ctx: MutationCtx, agentId: Id<"agents">): Promise<void> {
  const agentMember = await ctx.db
    .query("members")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .unique();
  if (agentMember) await removeFromCalls(ctx, [agentMember._id]);
}

/**
 * Revokes a key, and what it holds in shared browsers and calls, as agents.revokeKey does; the
 * caller checks who may.
 */
export async function revokeAgentKey(ctx: MutationCtx, actor: Actor, key: Doc<"agentKeys">): Promise<void> {
  if (key.revokedAt === undefined) await ctx.db.patch(key._id, { revokedAt: Date.now() });
  await revokeBrowserAccess(ctx, actor, { agentKeyId: key._id });
  await removeAgentFromCalls(ctx, key.agentId);
  await audit(ctx, actor, "agent_key.revoked", key._id);
}

export const { person: revokeKey, agent: revokeKeyAgent } = roomMutation({
  name: "agents.revokeKey",
  description: "Revoke an agent key. It stops working at once.",
  scope: "people.invite",
  args: { keyId: v.id("agentKeys") },
  handler: async (ctx, actor, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key || key.teamId !== actor.teamId) throw roomError("not_found", "No such key.");
    const agent = await ctx.db.get(key.agentId);
    const isAccountable = actor.kind === "person" && agent?.addedBy === actor.member._id;
    if (!isAccountable) requireAdmin(actor);
    await revokeAgentKey(ctx, actor, key);
    return null;
  },
});

/** How many of an agent's revoked keys agents.keys lists: the most recently revoked. */
export const LISTED_REVOKED_KEYS = 20;

export const { person: keys, agent: keysAgent } = roomQuery({
  name: "agents.keys",
  description: `List an agent's keys (never their secrets): those in use, and the ${LISTED_REVOKED_KEYS} it revoked most recently.`,
  scope: "room.read",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    await inTeam(ctx, actor, args.agentId);
    // Both bounded: at most MAX_ACTIVE_KEYS in use, however many an agent revoked over the years.
    const revoked = await ctx.db
      .query("agentKeys")
      .withIndex("by_agent_revoked", (q) => q.eq("agentId", args.agentId).gte("revokedAt", 0))
      .order("desc")
      .take(LISTED_REVOKED_KEYS);
    const keys = [...(await activeAgentKeys(ctx, args.agentId)), ...revoked].sort((a, b) => a._creationTime - b._creationTime);
    return keys.map((k) => ({
      keyId: k._id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      /** The only channels it reads and posts in; absent when it isn't limited (ADR 0049). */
      ...(k.channelIds ? { channelIds: k.channelIds } : {}),
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    }));
  },
});

/** The team an agent key belongs to, so HTTP callers needn't pass `teamId`. */
export const teamForKey = internalQuery({
  args: { agentKeyHash: v.string() },
  handler: async (ctx, { agentKeyHash }) => {
    const key = await ctx.db
      .query("agentKeys")
      .withIndex("by_hash", (q) => q.eq("hash", agentKeyHash))
      .unique();
    return key && key.revokedAt === undefined ? key.teamId : null;
  },
});
