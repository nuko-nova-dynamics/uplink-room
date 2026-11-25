/**
 * Remote connectors (ADR 0028, ADR 0031, GLOSSARY "Connector"). A person adds the room's MCP URL
 * in a hosted assistant (Grok Bot, ChatGPT dots, Meta Muse, Claude Duet) or any remote MCP client,
 * and signs in with Clerk there. The room's `/mcp` endpoint (lib/remoteMcp.ts) checks Clerk's
 * access token on every call and records the connection here, one per person and OAuth client.
 * The person approves it in the app, choosing its team, name and scopes (decision D15 of ADR
 * 0029); approving adds it as an agent with an agent key whose secret nobody sees, so the agent's
 * role, scopes, record of actions and revoking work as for any agent (ADR 0003, ADR 0005). It
 * starts with `room.read` and `messages.post` (D14).
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { checkScopes, insertAgent, insertAgentKey, revokeAgentKey } from "./agents";
import { accountDeleted, teamActorForPerson } from "./lib/actor";
import { roomError } from "./lib/errors";
import { audit } from "./lib/members";
import { accountMutation, accountQuery, roomMutation } from "./lib/room";
import { DEFAULT_AGENT_SCOPES } from "./lib/scopes";
import { hasWaiting, markRunSeen, markSeenMessages } from "./lib/deliveries";
import { vCharacter } from "./schema";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** `lastSeenAt` is written at most this often. */
export const SEEN_GRANULARITY_MS = HOUR;
/** How many connections one person can have waiting at once; past that a new client is told so. */
export const MAX_PENDING_PER_PERSON = 10;
/** A connection nobody approved and that hasn't called for this long is deleted. */
export const PENDING_KEPT_MS = 30 * DAY;

/** What the room calls a connection when it has nothing better: its client's name, else its client ID's host. */
export function connectorLabel(connector: Pick<Doc<"connectors">, "clientName" | "clientId">): string {
  if (connector.clientName) return connector.clientName;
  try {
    return new URL(connector.clientId).host || connector.clientId;
  } catch {
    return connector.clientId;
  }
}

/**
 * Where a connection stands. `pending` until the person approves it; `approved` while its key
 * works; `ended` once its key was revoked, its agent removed, or the person who approved it left
 * the team. An ended connection stays ended until the person removes it (connectors.remove),
 * after which the client's next call asks again.
 */
type Standing =
  | { status: "pending" }
  | {
      status: "approved";
      teamId: Id<"teams">;
      key: Doc<"agentKeys">;
      agent: Doc<"agents">;
      member: Doc<"members">;
      accountable: Doc<"members">;
    }
  | { status: "ended"; why: string; teamId?: Id<"teams">; agent?: Doc<"agents"> };

async function standing(ctx: QueryCtx, connector: Doc<"connectors">): Promise<Standing> {
  if (!connector.agentKeyId) return { status: "pending" };
  const key = await ctx.db.get(connector.agentKeyId);
  const agent = connector.agentId ? await ctx.db.get(connector.agentId) : null;
  const teamId = connector.teamId;
  const ended = (why: string): Standing => ({ status: "ended", why, ...(teamId ? { teamId } : {}), ...(agent ? { agent } : {}) });
  if (!key || key.revokedAt !== undefined) return ended("its agent key was revoked");
  if (!agent || !teamId) return ended("its agent no longer exists");
  const member = await ctx.db
    .query("members")
    .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
    .unique();
  if (!member || member.removedAt !== undefined) return ended("its agent was removed from the team");
  const accountable = await ctx.db.get(agent.addedBy);
  if (!accountable || accountable.removedAt !== undefined) return ended("the person who approved it left the team");
  if (await accountDeleted(ctx, accountable._id)) return ended("the person who approved it deleted their account");
  return { status: "approved", teamId, key, agent, member, accountable };
}

export const { person: list, signIn: listBySignIn } = accountQuery({
  name: "connectors.list",
  description:
    "Your remote connectors: each hosted assistant or MCP client you signed in to this room's MCP endpoint (/mcp), newest first, with its connectorId, clientId (the OAuth client: a URL for a client that publishes its metadata), clientName (what it calls itself; untrusted), when it first and last called, and status: pending (waiting for you to approve it with connectors.approve, choosing its team, name and scopes), approved (an agent in team, acting through its own agent key), or ended (its key was revoked, its agent removed, or you left the team; why says which). Remove one with connectors.remove.",
  args: {},
  handler: async (ctx, actor) => {
    const rows = await ctx.db
      .query("connectors")
      .withIndex("by_subject", (q) => q.eq("subject", actor.person.subject))
      .collect();
    const out = [];
    for (const row of rows.sort((a, b) => b.createdAt - a.createdAt)) {
      const now = await standing(ctx, row);
      const team = row.teamId ? await ctx.db.get(row.teamId) : null;
      const agent = now.status === "approved" ? now.agent : now.status === "ended" ? now.agent : undefined;
      out.push({
        connectorId: row._id,
        clientId: row.clientId,
        ...(row.clientName ? { clientName: row.clientName } : {}),
        label: connectorLabel(row),
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        status: now.status,
        ...(now.status === "ended" ? { why: now.why } : {}),
        ...(team ? { team: { teamId: team._id, name: team.name } } : {}),
        ...(agent ? { agent: { agentId: agent._id, name: agent.name } } : {}),
        ...(row.approvedAt !== undefined ? { approvedAt: row.approvedAt } : {}),
      });
    }
    return out;
  },
});

export const { person: approve, agent: approveAgent } = roomMutation({
  name: "connectors.approve",
  description:
    "Approve one of your remote connectors that is waiting (connectors.list, status pending) as an agent in this team: it joins with this name, you are accountable for it, and it acts through its own agent key, which nobody sees, with these scopes (default room.read and messages.post). Change its scopes later with agents.setKeyScopes, or stop it with agents.revokeKey. People only: an agent can't approve one.",
  scope: "people.invite",
  args: {
    connectorId: v.id("connectors"),
    name: v.string(),
    scopes: v.optional(v.array(v.string())),
    character: v.optional(vCharacter),
  },
  argDocs: {
    connectorId: "Which connection, from connectors.list",
    name: "The agent's name in the team, such as Grok Bot",
    scopes: "What its key may do. Default: room.read and messages.post",
  },
  handler: async (ctx, actor, args) => {
    if (actor.kind !== "person") {
      throw roomError("forbidden", "Only a person approves a connector: every agent is added by a person, who is accountable for it.");
    }
    const person = actor.member.personId ? await ctx.db.get(actor.member.personId) : null;
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || !person || connector.subject !== person.subject) {
      throw roomError("not_found", "No such connection is waiting for your approval.");
    }
    if (connector.agentKeyId) throw roomError("conflict", "This connection was already approved. connectors.list shows where.");
    const scopes = args.scopes ? checkScopes(args.scopes) : DEFAULT_AGENT_SCOPES;
    if (scopes.length === 0) throw roomError("invalid", "Pick at least one scope, such as room.read.");

    const { agentId, memberId } = await insertAgent(ctx, actor, {
      name: args.name,
      connection: "mcp",
      ...(args.character ? { character: args.character } : {}),
    });
    const agent = (await ctx.db.get(agentId))!;
    const { keyId } = await insertAgentKey(ctx, actor, agent, `Connector: ${connectorLabel(connector)}`, scopes);
    await ctx.db.patch(connector._id, { teamId: actor.teamId, agentId, agentKeyId: keyId, approvedAt: Date.now() });
    await audit(ctx, actor, "connector.approved", agentId, { clientId: connector.clientId, scopes });
    return { agentId, memberId, keyId, scopes };
  },
});

export const { person: remove, signIn: removeBySignIn } = accountMutation({
  name: "connectors.remove",
  description:
    "Remove one of your remote connectors: decline one that is waiting, or disconnect an approved one, whose agent key is revoked at once (its agent stays in the team, as any agent with a revoked key does). The client's next call asks for approval again. Pass a connectorId from connectors.list; only your own.",
  args: { connectorId: v.id("connectors") },
  argDocs: { connectorId: "Which connection, from connectors.list" },
  handler: async (ctx, actor, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || connector.subject !== actor.person.subject) throw roomError("not_found", "No such connection.");
    const key = connector.agentKeyId ? await ctx.db.get(connector.agentKeyId) : null;
    if (key && key.revokedAt === undefined) {
      // Revoked as the person, in the team, so the team's record of actions shows it.
      const teamActor = await teamActorForPerson(ctx, actor.person, key.teamId).catch(() => null);
      if (teamActor) await revokeAgentKey(ctx, teamActor, key);
      else await ctx.db.patch(key._id, { revokedAt: Date.now() });
    }
    await ctx.db.delete(connector._id);
    return null;
  },
});

/** What `/mcp` acts on for one call: the connection's standing, and for an approved one its key. */
export type ConnectorCall =
  | { status: "new" }
  | { status: "too_many" }
  | { status: "pending"; connectorId: Id<"connectors">; lastSeenAt: number; clientName?: string }
  | { status: "ended"; connectorId: Id<"connectors">; lastSeenAt: number; why: string }
  | {
      status: "approved";
      connectorId: Id<"connectors">;
      lastSeenAt: number;
      teamId: Id<"teams">;
      /** The key's hash: the HTTP action calls the agent functions with it, as /api/v1/call does with an agent key. */
      agentKeyHash: string;
      scopes: string[];
      agentName: string;
      addedBy: string;
      /** Messages wait for its agent to check in: reading a place marks them seen (noteRead). */
      waiting: boolean;
    };

async function callState(ctx: QueryCtx, connector: Doc<"connectors"> | null): Promise<ConnectorCall> {
  if (!connector) return { status: "new" };
  const base = { connectorId: connector._id, lastSeenAt: connector.lastSeenAt };
  const now = await standing(ctx, connector);
  if (now.status === "pending") return { status: "pending", ...base, ...(connector.clientName ? { clientName: connector.clientName } : {}) };
  if (now.status === "ended") return { status: "ended", ...base, why: now.why };
  return {
    status: "approved",
    ...base,
    teamId: now.teamId,
    agentKeyHash: now.key.hash,
    scopes: now.key.scopes,
    agentName: now.member.name,
    addedBy: now.accountable.name,
    waiting: await hasWaiting(ctx, now.member._id),
  };
}

async function find(ctx: QueryCtx, subject: string, clientId: string) {
  return await ctx.db
    .query("connectors")
    .withIndex("by_subject_client", (q) => q.eq("subject", subject).eq("clientId", clientId))
    .unique();
}

/** The connection a checked access token names (its `sub` and `client_id`), as `/mcp` needs it for one call. */
export const forCall = internalQuery({
  args: { subject: v.string(), clientId: v.string() },
  handler: async (ctx, { subject, clientId }): Promise<ConnectorCall> => callState(ctx, await find(ctx, subject, clientId)),
});

/**
 * Records a call from a connection: a new one is waiting for approval (unless the person has
 * MAX_PENDING_PER_PERSON waiting already), a known one is seen now. `clientName` is kept when the
 * connection has none.
 */
export const arrive = internalMutation({
  args: { subject: v.string(), clientId: v.string(), clientName: v.optional(v.string()) },
  handler: async (ctx, { subject, clientId, clientName }): Promise<ConnectorCall> => {
    const now = Date.now();
    const name = clientName?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
    const existing = await find(ctx, subject, clientId);
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now, ...(name && !existing.clientName ? { clientName: name } : {}) });
      return callState(ctx, await ctx.db.get(existing._id));
    }
    const mine = await ctx.db
      .query("connectors")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .collect();
    if (mine.filter((c) => !c.agentKeyId).length >= MAX_PENDING_PER_PERSON) return { status: "too_many" };
    const connectorId = await ctx.db.insert("connectors", {
      subject,
      clientId,
      ...(name ? { clientName: name } : {}),
      createdAt: now,
      lastSeenAt: now,
    });
    return callState(ctx, await ctx.db.get(connectorId));
  },
});

/** Deletes connections nobody approved that haven't called for 30 days. Hourly, up to 500. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("connectors")
      .withIndex("by_key_last_seen", (q) => q.eq("agentKeyId", undefined).lt("lastSeenAt", Date.now() - PENDING_KEPT_MS))
      .take(500);
    for (const connector of old) await ctx.db.delete(connector._id);
    return { deleted: old.length };
  },
});

/** The Room API reads that count as an agent reading the messages they return. */
export const READS = ["messages.list", "messages.replies", "messages.get", "messages.addressed"] as const;

/** The ids of the messages a read returned: a list, a page of one, or one message (null when none). */
export function returnedIds(result: unknown): string[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { page?: unknown }).page)
      ? (result as { page: unknown[] }).page
      : result && typeof result === "object"
        ? [result]
        : [];
  return rows.flatMap((row) =>
    row && typeof row === "object" && typeof (row as { messageId?: unknown }).messageId === "string"
      ? [(row as { messageId: string }).messageId]
      : [],
  );
}

/** The agent member a live agent key belongs to. */
async function keyMember(ctx: QueryCtx, agentKeyHash: string): Promise<Doc<"members"> | null> {
  const key = await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("hash", agentKeyHash))
    .unique();
  if (!key || key.revokedAt !== undefined) return null;
  return ctx.db
    .query("members")
    .withIndex("by_agent", (q) => q.eq("agentId", key.agentId))
    .unique();
}

/**
 * Whether a runs.get answer is a run given to an agent whose send still waits for it to check in
 * (ADR 0044): then the HTTP endpoint and the connector note the read (noteRunRead).
 */
export function waitingGivenRun(fn: string, result: unknown): string | undefined {
  if (fn !== "runs.get" || !result || typeof result !== "object") return undefined;
  const run = result as { runId?: unknown; given?: { delivery?: { status?: unknown } } };
  return run.given?.delivery?.status === "waiting" && typeof run.runId === "string" ? run.runId : undefined;
}

/**
 * An agent read a run given to it (runs.get, ADR 0044): what waited there for it to check in is
 * seen. Only the key's own agent's rows on that run; a teammate reading the run marks nothing.
 */
export const noteRunRead = internalMutation({
  args: { agentKeyHash: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const member = await keyMember(ctx, args.agentKeyHash);
    const runId = ctx.db.normalizeId("runs", args.runId);
    if (!member || !runId) return 0;
    return markRunSeen(ctx, member._id, runId);
  },
});

/**
 * A connector's agent read messages through the Room API (lib/remoteMcp.ts calls this after a read
 * succeeded, with the ids the read returned): what waited on them for it to check in is seen (slice
 * 14 of #139). Only what it was given: not the rest of a page, nor other places. The read itself
 * already checked the agent may see them; this only marks the agent's own deliveries.
 */
export const noteRead = internalMutation({
  args: { agentKeyHash: v.string(), messageIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const member = await keyMember(ctx, args.agentKeyHash);
    if (!member) return 0;
    const ids = args.messageIds.flatMap((id) => {
      const messageId = ctx.db.normalizeId("messages", id);
      return messageId ? [messageId] : [];
    });
    return markSeenMessages(ctx, member._id, ids);
  },
});
