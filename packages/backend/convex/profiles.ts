import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { actsFor } from "./lib/actor";
import { roomError } from "./lib/errors";
import { audit, inTeam, memberView } from "./lib/members";
import { sendToBridge } from "./lib/outbox";
import { roomMutation, roomQuery } from "./lib/room";
import { actorRef } from "./lib/terminals";
import { wakeForMaintenance, wakeForWork } from "./lib/cloudMachines";

export const { person: create, agent: createAgent } = roomMutation({
  name: "profiles.create",
  description:
    "Make a profile on a machine: your own logins, settings and skills, kept apart from the machine setup for keepForMs (capped at the machine's limit). On someone else's personal machine they can read everything in it, so pass acceptReadableByOwner: true.",
  scope: "runs.start",
  args: {
    machineId: v.id("machines"),
    name: v.string(),
    keepForMs: v.number(),
    acceptReadableByOwner: v.optional(v.boolean()),
  },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    if (machine.unlinkedAt !== undefined) throw roomError("invalid", "This machine was unlinked.");
    if (machine.longestProfileMs <= 0) throw roomError("invalid", "This machine doesn't allow profiles.");
    if (args.keepForMs <= 0) throw roomError("invalid", "Keep the profile for some time.");
    if (machine.belongsTo.kind === "person" && !actsFor(actor, machine.belongsTo.memberId) && !args.acceptReadableByOwner) {
      const owner = await memberView(ctx, machine.belongsTo.memberId);
      throw roomError(
        "invalid",
        `${machine.name} belongs to ${owner.name}. ${owner.name} can read everything in it, including your logins. Pass acceptReadableByOwner: true to go ahead.`,
      );
    }
    const person = actor.accountable ?? actor.member;
    const expiresAt = Date.now() + Math.min(args.keepForMs, machine.longestProfileMs);
    const profileId = await ctx.db.insert("profiles", {
      teamId: actor.teamId,
      machineId: machine._id,
      personId: person._id,
      name: args.name.trim() || "Profile",
      expiresAt,
      status: "creating",
    });
    await ctx.scheduler.runAt(expiresAt, internal.profiles.expire, { profileId });
    await wakeForWork(ctx, machine._id);
    await sendToBridge(ctx, machine._id, {
      v: 1,
      type: "create_profile",
      profileId,
      person: actorRef(person),
      expiresAt,
    });
    await audit(ctx, actor, "profile.created", profileId, { machineId: machine._id, expiresAt });
    return profileId;
  },
});

export const { person: mine, agent: mineAgent } = roomQuery({
  name: "profiles.mine",
  description: "Your profiles on every machine that are being made or ready, with when each expires.",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const person = actor.accountable ?? actor.member;
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .collect();
    const now = Date.now();
    return Promise.all(
      profiles
        .filter((p) => (p.status === "creating" || p.status === "ready") && p.expiresAt > now)
        .map(async (p) => {
          const machine = await ctx.db.get(p.machineId);
          return {
            profileId: p._id,
            name: p.name,
            status: p.status,
            expiresAt: p.expiresAt,
            machine: machine ? { machineId: machine._id, name: machine.name } : undefined,
          };
        }),
    );
  },
});

export const { person: onMachine, agent: onMachineAgent } = roomQuery({
  name: "profiles.onMachine",
  description: "The profiles kept on a machine, and whose they are.",
  scope: "room.read",
  args: { machineId: v.id("machines") },
  handler: async (ctx, actor, args) => {
    const machine = await inTeam(ctx, actor, args.machineId);
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .collect();
    const now = Date.now();
    return Promise.all(
      profiles
        .filter((p) => (p.status === "creating" || p.status === "ready") && p.expiresAt > now)
        .map(async (p) => ({
          profileId: p._id,
          name: p.name,
          person: await memberView(ctx, p.personId),
          status: p.status,
          expiresAt: p.expiresAt,
        })),
    );
  },
});

export const { person: remove, agent: removeAgent } = roomMutation({
  name: "profiles.remove",
  description: "Delete one of your profiles. The bridge removes it from the machine.",
  scope: "runs.start",
  args: { profileId: v.id("profiles") },
  handler: async (ctx, actor, args) => {
    const profile = await inTeam(ctx, actor, args.profileId);
    if (!actsFor(actor, profile.personId)) throw roomError("forbidden", "Only its person can delete a profile.");
    await ctx.db.patch(profile._id, { status: "deleted" });
    await sendToBridge(ctx, profile.machineId, { v: 1, type: "delete_profile", profileId: profile._id });
    await wakeForMaintenance(ctx, profile.machineId);
    await audit(ctx, actor, "profile.deleted", profile._id);
    return null;
  },
});

/**
 * Marks a profile expired in the room at its expiry, so subscribed profile
 * lists drop it even before the bridge reports it: Convex re-runs a query only
 * when data it read changes, never because time passed. Does nothing if the
 * profile was deleted, already expired, or now expires later.
 */
export const expire = internalMutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const profile = await ctx.db.get(profileId);
    if (!profile || (profile.status !== "creating" && profile.status !== "ready")) return null;
    if (profile.expiresAt > Date.now()) return null;
    await ctx.db.patch(profile._id, { status: "expired" });
    await wakeForMaintenance(ctx, profile.machineId);
    return null;
  },
});
