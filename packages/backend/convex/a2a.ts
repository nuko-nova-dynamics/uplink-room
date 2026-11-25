/**
 * Connecting outside agents such as Hermes and OpenClaw over A2A (spec #8, ADR 0012).
 *
 * The room sends an agent work at the agent's own gateway: a mention or a run on
 * a task becomes an A2A message or task (runs.start with via "a2a"). Everything
 * the agent does in the room still goes through the Room API with its agent key.
 * These functions register where that gateway is and the token the room sends
 * it, which is kept apart from agent keys and never returned.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hasScope, type Actor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { audit, inTeam, memberView } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { runView } from "./lib/states";
import { cardUrlFor } from "./lib/a2a/peerUrl";
import { agentMember, detachBinding, peerForAgent } from "./lib/a2a/runs";
import { credentialBinding, hintOf, sealSecret } from "./lib/a2a/secrets";
import { peerDialects } from "./lib/a2a/dialect";
import { vSendWork } from "./schema";
import { webhookFor } from "./lib/deliveries";
import { seesRun } from "./lib/runLabels";

const vCredential = v.union(
  v.object({ kind: v.literal("bearer"), secret: v.string() }),
  /** A token in a header of the agent's choosing, such as X-API-Key. */
  v.object({ kind: v.literal("header"), name: v.string(), secret: v.string() }),
);

/** Headers the room sets itself, which a credential can't take over. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "accept",
  "a2a-version",
  "a2a-extensions",
  "connection",
  "transfer-encoding",
  "cookie",
]);

/** The agent and its member, if `actor` may change where the room sends it work. */
export async function manageable(ctx: QueryCtx, actor: Actor, agentId: Id<"agents">) {
  const agent = await inTeam(ctx, actor, agentId);
  const member = await agentMember(ctx, agent._id);
  if (!member || member.removedAt !== undefined)
    throw roomError("not_found", `${agent.name} isn't in the team any more.`);
  const accountable = actor.kind === "person" && agent.addedBy === actor.member._id;
  // An admin agent also needs team.admin, as for other people's saved logins (ADR 0011).
  const admin =
    actor.role === "admin" && (actor.kind === "person" || hasScope(actor, "team.admin"));
  if (!accountable && !admin) {
    const person = await ctx.db.get(agent.addedBy);
    throw roomError(
      "forbidden",
      `Only ${person?.name ?? "the person accountable for it"}, who is accountable for ${agent.name}, or an admin can change where the room sends it work.`,
    );
  }
  return { agent, member };
}

async function storeCredential(
  ctx: MutationCtx,
  actor: Actor,
  peerId: Id<"a2aPeers">,
  credential: { kind: "bearer"; secret: string } | { kind: "header"; name: string; secret: string },
) {
  const secret = credential.secret.trim();
  if (!secret) throw roomError("invalid", "The token is empty.");
  if (secret.length > 4096 || /[\r\n]/.test(secret))
    throw roomError("invalid", "The token must be one line of at most 4096 characters.");
  let headerName: string | undefined;
  if (credential.kind === "header") {
    headerName = credential.name.trim();
    if (
      !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(headerName) ||
      RESERVED_HEADERS.has(headerName.toLowerCase())
    ) {
      throw roomError(
        "invalid",
        `The room can't send a token in a header named ${JSON.stringify(headerName)}.`,
      );
    }
  }
  const peer = await ctx.db.get(peerId);
  const origin = new URL(peer!.cardUrl).origin;
  const sealed = await sealSecret(secret, credentialBinding(peerId, origin));
  const existing = await ctx.db
    .query("a2aCredentials")
    .withIndex("by_peer", (q) => q.eq("peerId", peerId))
    .unique();
  if (existing) await ctx.db.delete(existing._id);
  await ctx.db.insert("a2aCredentials", {
    teamId: actor.teamId,
    peerId,
    kind: credential.kind,
    ...(headerName ? { headerName } : {}),
    origin,
    ...sealed,
    hint: hintOf(secret),
    setBy: actor.member._id,
    setAt: Date.now(),
  });
}

async function check(ctx: MutationCtx, peer: Doc<"a2aPeers">, cardUrl?: string) {
  const checkGeneration = peer.checkGeneration + 1;
  await ctx.db.patch(peer._id, {
    status: "checking",
    checkGeneration,
    ...(cardUrl ? { cardUrl } : {}),
  });
  await ctx.scheduler.runAfter(0, internal.a2aNode.checkCard, {
    peerId: peer._id,
    generation: checkGeneration,
  });
}

async function peerView(ctx: QueryCtx, peer: Doc<"a2aPeers">) {
  const agent = await ctx.db.get(peer.agentId);
  const member = await agentMember(ctx, peer.agentId);
  const credential = await ctx.db
    .query("a2aCredentials")
    .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
    .unique();
  const versions = peerDialects(peer);
  return {
    peerId: peer._id,
    agentId: peer.agentId,
    agent: { memberId: member?._id, name: agent?.name ?? "Former agent" },
    cardUrl: peer.cardUrl,
    endpointUrl: peer.endpoint?.url,
    status: peer.status,
    error: peer.error,
    checkedAt: peer.checkedAt,
    card: peer.card,
    /** The A2A version the room speaks to it (ADR 0018), and the one its card names. */
    protocol: { speaks: versions.speaks, declared: versions.declared, learned: versions.learned },
    connection: peer.connection
      ? {
          status: peer.connection.status,
          at: peer.connection.at,
          by: await memberView(ctx, peer.connection.by),
          dialect: peer.connection.dialect,
          summary: peer.connection.summary,
        }
      : null,
    cancel: peer.cancel,
    listTasks: peer.listTasks,
    sendWork: peer.sendWork,
    connectedBy: await memberView(ctx, peer.connectedBy),
    credential: credential
      ? {
          kind: credential.kind,
          headerName: credential.headerName,
          hint: credential.hint,
          setAt: credential.setAt,
          setBy: await memberView(ctx, credential.setBy),
        }
      : null,
  };
}

async function existingPeer(ctx: QueryCtx, agent: Doc<"agents">): Promise<Doc<"a2aPeers">> {
  const peer = await peerForAgent(ctx, agent._id);
  if (!peer)
    throw roomError(
      "not_found",
      `${agent.name} has no A2A endpoint. Connect one first (a2a.connect).`,
    );
  return peer;
}

export const { person: connect, agent: connectAgent } = roomMutation({
  name: "a2a.connect",
  description:
    "Connect an agent's A2A endpoint (A2A 1.0, or 0.3, over JSON-RPC), such as a Hermes or OpenClaw gateway, so the room can send it work. Give the agent's address (its Agent Card is read from /.well-known/agent-card.json) and, if its gateway needs one, the token the room sends it (bearer, or a named header). The token is kept sealed, apart from agent keys, and never shown again. sendWork: 'team' (default: anyone in the team can send it work) or 'accountable' (only its person). Only the person accountable for the agent, or an admin, can do this.",
  scope: "people.invite",
  args: {
    agentId: v.id("agents"),
    cardUrl: v.string(),
    credential: v.optional(vCredential),
    sendWork: v.optional(vSendWork),
  },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    if (await webhookFor(ctx, agent._id)) {
      throw roomError(
        "conflict",
        `${agent.name} is reached at a routine webhook. Remove it (webhooks.remove) before connecting an A2A endpoint.`,
      );
    }
    if (await peerForAgent(ctx, agent._id)) {
      throw roomError(
        "conflict",
        `${agent.name} already has an A2A endpoint. Change it with a2a.update.`,
      );
    }
    const cardUrl = cardUrlFor(args.cardUrl);
    const peerId = await ctx.db.insert("a2aPeers", {
      teamId: actor.teamId,
      agentId: agent._id,
      connectedBy: actor.member._id,
      cardUrl,
      status: "checking",
      checkGeneration: 0,
      endpointGeneration: 0,
      cancel: "unknown",
      listTasks: "unknown",
      sendWork: args.sendWork ?? "team",
    });
    if (args.credential) await storeCredential(ctx, actor, peerId, args.credential);
    if (agent.connection !== "a2a") await ctx.db.patch(agent._id, { connection: "a2a" });
    await check(ctx, (await ctx.db.get(peerId))!);
    await audit(ctx, actor, "a2a.connected", agent._id, {
      cardUrl,
      credential: args.credential?.kind ?? "none",
    });
    return peerId;
  },
});

export const { person: update, agent: updateAgent } = roomMutation({
  name: "a2a.update",
  description:
    "Change an agent's A2A endpoint: its address (the card is read again) or who may send it work ('team' or 'accountable').",
  scope: "people.invite",
  args: {
    agentId: v.id("agents"),
    cardUrl: v.optional(v.string()),
    sendWork: v.optional(vSendWork),
  },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    const peer = await existingPeer(ctx, agent);
    const cardUrl = args.cardUrl !== undefined ? cardUrlFor(args.cardUrl) : undefined;
    if (args.sendWork) await ctx.db.patch(peer._id, { sendWork: args.sendWork });
    if (cardUrl && cardUrl !== peer.cardUrl) {
      // A new address: forget what the old one taught, and never send to the old endpoint again.
      // Runs started there stop being followed (the endpoint generation moves on).
      await ctx.db.patch(peer._id, {
        endpoint: undefined,
        card: undefined,
        cancel: "unknown",
        listTasks: "unknown",
        speaks: undefined,
        connection: undefined,
        dialectGeneration: (peer.dialectGeneration ?? 0) + 1,
        error: undefined,
        endpointGeneration: peer.endpointGeneration + 1,
      });
      // A token given for one origin never goes to another.
      if (new URL(cardUrl).origin !== new URL(peer.cardUrl).origin) {
        const stored = await ctx.db
          .query("a2aCredentials")
          .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
          .unique();
        if (stored) await ctx.db.delete(stored._id);
      }
      await check(ctx, (await ctx.db.get(peer._id))!, cardUrl);
    }
    await audit(ctx, actor, "a2a.updated", agent._id, {
      ...(cardUrl ? { cardUrl } : {}),
      ...(args.sendWork ? { sendWork: args.sendWork } : {}),
    });
    return null;
  },
});

export const { person: recheck, agent: recheckAgent } = roomMutation({
  name: "a2a.recheck",
  description: "Read an agent's Agent Card again, for example after its gateway changed.",
  scope: "people.invite",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    await check(ctx, await existingPeer(ctx, agent));
    return null;
  },
});

export const { person: checkConnection, agent: checkConnectionAgent } = roomMutation({
  name: "a2a.checkConnection",
  description:
    "Check that the room can reach an agent's A2A endpoint before sending it work: one harmless call that needs its token (it reads a task that doesn't exist), which shows whether the token works and which A2A version answers, 1.0 or 0.3. The result shows in a2a.get as `connection`. Only the person accountable for the agent, or an admin, can do this.",
  scope: "people.invite",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    const peer = await existingPeer(ctx, agent);
    if (!peer.endpoint) {
      throw roomError(
        "invalid",
        peer.status === "checking"
          ? `${agent.name}'s Agent Card is still being read. Try again in a moment.`
          : `${agent.name}'s Agent Card couldn't be read, so the room has no address to check: ${peer.error ?? "unknown error"}`,
      );
    }
    const now = Date.now();
    if (peer.connection?.status === "checking" && now - peer.connection.at < 60_000) {
      throw roomError("conflict", `A check of ${agent.name}'s connection is already running.`);
    }
    // An id of its own, never reused: a late result of an older check can't land on this one.
    const checkId = crypto.randomUUID();
    await ctx.db.patch(peer._id, {
      connection: { status: "checking", checkId, at: now, by: actor.member._id },
    });
    await ctx.scheduler.runAfter(0, internal.a2aNode.checkConnection, {
      peerId: peer._id,
      checkId,
    });
    await audit(ctx, actor, "a2a.connection_checked", agent._id);
    return null;
  },
});

export const { person: setCredential, agent: setCredentialAgent } = roomMutation({
  name: "a2a.setCredential",
  description:
    "Set or replace the token the room sends an agent's gateway: { kind: 'bearer', secret } or { kind: 'header', name, secret }. It is kept sealed and never shown again.",
  scope: "people.invite",
  args: { agentId: v.id("agents"), credential: vCredential },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    const peer = await existingPeer(ctx, agent);
    await storeCredential(ctx, actor, peer._id, args.credential);
    await audit(ctx, actor, "a2a.credential_set", agent._id, { kind: args.credential.kind });
    return null;
  },
});

export const { person: clearCredential, agent: clearCredentialAgent } = roomMutation({
  name: "a2a.clearCredential",
  description: "Delete the token the room sends an agent's gateway.",
  scope: "people.invite",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    const peer = await existingPeer(ctx, agent);
    const existing = await ctx.db
      .query("a2aCredentials")
      .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await audit(ctx, actor, "a2a.credential_cleared", agent._id);
    return null;
  },
});

export const { person: disconnect, agent: disconnectAgent } = roomMutation({
  name: "a2a.disconnect",
  description:
    "Disconnect an agent's A2A endpoint and delete its token. The room stops following the agent's runs (they show Unknown: the agent may still be running them) and sends it nothing more.",
  scope: "people.invite",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const { agent } = await manageable(ctx, actor, args.agentId);
    const peer = await existingPeer(ctx, agent);
    const bindings = await ctx.db
      .query("a2aBindings")
      .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
      .collect();
    for (const binding of bindings) {
      await detachBinding(
        ctx,
        binding,
        `${agent.name}'s A2A endpoint was disconnected.`,
        actor.member._id,
      );
    }
    const credential = await ctx.db
      .query("a2aCredentials")
      .withIndex("by_peer", (q) => q.eq("peerId", peer._id))
      .unique();
    if (credential) await ctx.db.delete(credential._id);
    await ctx.db.delete(peer._id);
    await audit(ctx, actor, "a2a.disconnected", agent._id);
    return null;
  },
});

export const { person: get, agent: getAgent } = roomQuery({
  name: "a2a.get",
  description:
    "An agent's A2A endpoint, or null: its address, whether its card was read, what the card offers (streaming, skills, what it asks for to sign in), the A2A version the room speaks to it (`protocol`), the last connection check (`connection`), whether cancel works there (learned by trying), and the token's kind and last four characters (never the token).",
  scope: "room.read",
  args: { agentId: v.id("agents") },
  handler: async (ctx, actor, args) => {
    const agent = await inTeam(ctx, actor, args.agentId);
    const peer = await peerForAgent(ctx, agent._id);
    return peer ? peerView(ctx, peer) : null;
  },
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "a2a.list",
  description:
    "The team's agents with an A2A endpoint, so you know who can be sent work or mentioned.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const peers = await ctx.db
      .query("a2aPeers")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    return Promise.all(peers.map((p) => peerView(ctx, p)));
  },
});

export const { person: runs, agent: runsAgent } = roomQuery({
  name: "a2a.runs",
  description:
    "The runs sent to an agent over A2A, newest first, each with its run state, the agent's own task state, when the room last heard, its answer and artifacts.",
  scope: "room.read",
  args: { agentId: v.id("agents"), limit: v.optional(v.number()) },
  handler: async (ctx, actor, args) => {
    const agent = await inTeam(ctx, actor, args.agentId);
    const all = await ctx.db
      .query("runs")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 50, 1), 200));
    const shown: typeof all = [];
    for (const r of all) if (r.teamId === actor.teamId && (await seesRun(ctx, r, actor))) shown.push(r);
    return Promise.all(shown.map((r) => runView(ctx, r, actor)));
  },
});
