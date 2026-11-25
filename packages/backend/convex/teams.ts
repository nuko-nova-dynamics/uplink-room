import { v } from "convex/values";
import { publicMutation, publicQuery } from "./lib/refusals";
import { personForIdentity, requireAdmin } from "./lib/actor";
import { audit } from "./lib/members";
import { roomError } from "./lib/errors";
import { roomMutation, roomQuery } from "./lib/room";
import { runTitleFor, taskIsHidden, taskState, taskTitleFor } from "./lib/states";
import { runIsHidden, takesWorkFrom } from "./lib/a2a/runs";
import type { Doc } from "./_generated/dataModel";
import { limitOf, vCallQualityLimit } from "./lib/callQuality";
import { reachOf } from "./lib/deliveries";
import { seesRun } from "./lib/runLabels";

/**
 * Creates a team. Whoever creates it is its first admin, and it starts with
 * #general. Only people create teams: agent keys belong to one team.
 */
export const create = publicMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const person = await personForIdentity(ctx);
    if (!person) throw roomError("unauthenticated", "Sign in to use Uplink Room.");
    const trimmed = name.trim();
    if (!trimmed) throw roomError("invalid", "A team needs a name.");
    const teamId = await ctx.db.insert("teams", { name: trimmed, createdAt: Date.now() });
    await ctx.db.insert("members", {
      teamId,
      kind: "person",
      personId: person._id,
      name: person.name,
      role: "admin",
    });
    await ctx.db.insert("channels", { teamId, name: "general" });
    return teamId;
  },
});

/** The teams the signed-in person belongs to. */
export const mine = publicQuery({
  args: {},
  handler: async (ctx) => {
    const person = await personForIdentity(ctx);
    if (!person) return [];
    const members = await ctx.db
      .query("members")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .collect();
    const teams = await Promise.all(
      members
        .filter((m) => m.removedAt === undefined)
        .map(async (m) => {
          const team = await ctx.db.get(m.teamId);
          return team && { teamId: team._id, name: team.name, role: m.role, memberId: m._id };
        }),
    );
    return teams.filter((t) => t !== null);
  },
});

export const { person: members, agent: membersAgent } = roomQuery({
  name: "teams.members",
  description: "List the team's members, people and agents, with their roles.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const members = await ctx.db
      .query("members")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    return Promise.all(
      members
        .filter((m) => m.removedAt === undefined)
        .map(async (m) => {
          const agent = m.agentId ? await ctx.db.get(m.agentId) : null;
          const addedBy = agent ? await ctx.db.get(agent.addedBy) : null;
          return {
            memberId: m._id,
            name: m.name,
            kind: m.kind,
            role: m.role,
            addedBy: addedBy ? { memberId: addedBy._id, name: addedBy.name } : undefined,
            // For agent members: the id `agents.keys` and `agents.createKey` take.
            agentId: m.agentId,
            character: agent?.character,
            /**
             * For agents: how the room reaches it. a2a (its endpoint), webhook (a routine webhook, as
             * Grok Bot's), checks_in (it joined through the connector and only reads and posts when it
             * runs, on its own schedule), or absent when the room doesn't reach it at all.
             */
            reach: agent ? await reachOf(ctx, agent._id) : undefined,
            /** The member's custom status (members.setStatus), or absent. */
            status: m.status,
          };
        }),
    );
  },
});

export const { person: roster, agent: rosterAgent } = roomQuery({
  name: "teams.roster",
  description:
    "The roster: the team's agents, each with its agentId (runs.start via 'agent' gives it a task), reach (how the room reaches it), and the most urgent state among the runs it drives or was sent (or idle), and the harnesses running now, each with joined, how many of its runs joined by themselves with uplink join. line is the title of the most urgent live run (or its task), when there is one.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    // A closed run (ADR 0044) counts only for its person and their agents.
    const active: Doc<"runs">[] = [];
    for (const r of runs) {
      if (
        r.state !== "done" &&
        r.state !== "stopped" &&
        r.state !== "failed" &&
        (await seesRun(ctx, r, actor))
      )
        active.push(r);
    }
    const members = await ctx.db
      .query("members")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    // What the roster row says it's on: the title of its most urgent live run (or that run's task),
    // as the viewer may see it, the way Grok Bot's list shows each bot's latest line.
    const LEAD: Doc<"runs">["state"][] = ["waiting", "failed", "working", "unknown"];
    const lineOf = async (rs: Doc<"runs">[]): Promise<string | undefined> => {
      const lead = [...rs].sort((a, b) => LEAD.indexOf(a.state) - LEAD.indexOf(b.state))[0];
      if (!lead) return undefined;
      const title = await runTitleFor(ctx, lead, await runIsHidden(ctx, lead, actor));
      if (title) return title;
      const task = lead.taskId ? await ctx.db.get(lead.taskId) : null;
      return task ? await taskTitleFor(ctx, task, await taskIsHidden(ctx, task, actor)) : undefined;
    };
    const agents = await Promise.all(
      members
        .filter((m) => m.kind === "agent" && m.removedAt === undefined)
        .map(async (m) => {
          // Its runs: the ones it drives, and the ones sent to it over A2A (ADR 0012) or given to it (ADR 0044).
          const own = active.filter(
            (r) => r.driverId === m._id || (m.agentId !== undefined && r.agentId === m.agentId),
          );
          const agent = m.agentId ? await ctx.db.get(m.agentId) : null;
          return {
            kind: "agent" as const,
            memberId: m._id,
            /** The id runs.start takes (via 'agent') to give it a task. */
            agentId: m.agentId,
            name: m.name,
            character: agent?.character,
            state: own.length ? taskState(own) : ("idle" as const),
            runs: own.length,
            line: await lineOf(own),
            /** How the room reaches it, as teams.members gives it: checks_in shows it reads on its own schedule. */
            reach: agent ? await reachOf(ctx, agent._id) : undefined,
            /** Whether you can give it work now: an A2A agent may take work only from its person, or have no endpoint yet. */
            takesYourWork: agent ? await takesWorkFrom(ctx, actor, agent) : false,
          };
        }),
    );
    const byHarness = new Map<string, typeof active>();
    for (const r of active.filter((r) => r.agentId === undefined)) {
      byHarness.set(r.harness, [...(byHarness.get(r.harness) ?? []), r]);
    }
    const harnesses = await Promise.all(
      [...byHarness.entries()].map(async ([harness, rs]) => ({
        kind: "harness" as const,
        name: harness,
        state: taskState(rs),
        runs: rs.length,
        /** How many of them joined by themselves (uplink join, ADR 0032): chat only, no terminal or thread. */
        joined: rs.filter((r) => r.joinedSessionId !== undefined).length,
        line: await lineOf(rs),
      })),
    );
    return [...agents, ...harnesses];
  },
});

export const { person: settings, agent: settingsAgent } = roomQuery({
  name: "teams.settings",
  description:
    "The team's settings: its name, whether link previews are on, callQualityLimit, the highest call quality it allows: 'standard' (voice at standard, screen shares at Sharp, cameras at 720p), 'high' (voice up to high, screen shares up to Balanced and Smooth) or 'none' (everything, the default, with Smooth HD and Source), and inviteReminders, whether an invite nobody accepted after 3 days gets one reminder email.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const team = await ctx.db.get(actor.teamId);
    return {
      name: team?.name ?? "",
      linkPreviews: team?.linkPreviews ?? ("on" as const),
      callQualityLimit: limitOf(team),
      inviteReminders: team?.inviteReminders ?? ("on" as const),
    };
  },
});

export const { person: setInviteReminders, agent: setInviteRemindersAgent } = roomMutation({
  name: "teams.setInviteReminders",
  description:
    "Turn invite reminders on or off for the team (admins). On, an invite nobody accepted after 3 days gets one reminder email; off, none do, including invites already waiting.",
  scope: "team.admin",
  args: { inviteReminders: v.union(v.literal("on"), v.literal("off")) },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    await ctx.db.patch(actor.teamId, { inviteReminders: args.inviteReminders });
    await audit(ctx, actor, "team.invite_reminders", actor.teamId, { inviteReminders: args.inviteReminders });
    return null;
  },
});

export const { person: setCallQualityLimit, agent: setCallQualityLimitAgent } = roomMutation({
  name: "teams.setCallQualityLimit",
  description:
    "Set the highest call quality the team allows (admins), since LiveKit Cloud bills by bandwidth: 'standard' (voice at standard, screen shares at Sharp, 1080p 15 fps, cameras at 720p), 'high' (voice up to high, screen shares up to Balanced, 1080p 30 fps, and Smooth, 720p 60 fps) or 'none' (everything: music voice, and Smooth HD, 1080p 60 fps, and Source screen shares at 30 or 60 fps). A channel chosen above the limit keeps its choice, and its calls use the best the limit allows until the limit goes back up; the apps lower a running share or camera above a new limit.",
  scope: "team.admin",
  args: { limit: vCallQualityLimit },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    await ctx.db.patch(actor.teamId, { callQualityLimit: args.limit });
    await audit(ctx, actor, "team.call_quality_limit", actor.teamId, { limit: args.limit });
    return null;
  },
});

export const { person: setLinkPreviews, agent: setLinkPreviewsAgent } = roomMutation({
  name: "teams.setLinkPreviews",
  description:
    "Turn link previews on or off for the team (admins). Off, the room fetches no page a message links to, and messages show no previews.",
  scope: "team.admin",
  args: { linkPreviews: v.union(v.literal("on"), v.literal("off")) },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    await ctx.db.patch(actor.teamId, { linkPreviews: args.linkPreviews });
    await audit(ctx, actor, "team.link_previews", actor.teamId, { linkPreviews: args.linkPreviews });
    return null;
  },
});
