import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { publicMutation } from "./lib/refusals";
import { endJoinedRunsOf } from "./cliSignIns";
import { teamsOfPerson } from "./lib/actor";
import { roomError } from "./lib/errors";
import { recordPerson } from "./lib/people";
import { accountMutation, accountQuery } from "./lib/room";

/** Records the signed-in person. The app calls it after Clerk sign-in. */
export const ensure = publicMutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw roomError("unauthenticated", "Sign in to use Uplink Room.");
    return await recordPerson(ctx, {
      subject: identity.subject,
      name: identity.name,
      email: identity.email,
      avatarUrl: identity.pictureUrl,
    });
  },
});

function signInView(signIn: Doc<"cliSignIns">) {
  return { signInId: signIn._id, name: signIn.name, expiresAt: signIn.expiresAt };
}

export const { person: me, signIn: meBySignIn } = accountQuery({
  name: "people.me",
  description:
    "Who you are as a person, in no team: your personId, name, email and picture, and the teams you're in, each with its teamId, name, your memberId there and your role. With a CLI sign-in (`uplink login`), also that sign-in's signInId, name and when it expires. Account functions like this one work with no team; agent keys can't call them (an agent uses members.me). Every team function takes one of these teamIds; with a CLI sign-in it can be left out when you're in one team.",
  args: {},
  handler: async (ctx, actor) => {
    const teams = [];
    for (const member of await teamsOfPerson(ctx, actor.person._id)) {
      const team = await ctx.db.get(member.teamId);
      if (team) teams.push({ teamId: team._id, name: team.name, memberId: member._id, role: member.role });
    }
    return {
      personId: actor.person._id,
      name: actor.person.name,
      ...(actor.person.email ? { email: actor.person.email } : {}),
      ...(actor.person.avatarUrl ? { avatarUrl: actor.person.avatarUrl } : {}),
      teams,
      ...(actor.signIn ? { signIn: signInView(actor.signIn) } : {}),
    };
  },
});

export const { person: signIns, signIn: signInsBySignIn } = accountQuery({
  name: "people.signIns",
  description:
    "Your CLI sign-ins: each computer where you ran `uplink login` and haven't signed out, newest first, with its signInId, the name it was given (by default the computer's host name), the token's first characters (prefix), when it was made, when it was last used over HTTP (to the hour; absent if never) and when it expires (30 days after it was made). Never the tokens. current is true for the one this call came with. Revoke one with people.revokeSignIn.",
  args: {},
  handler: async (ctx, actor) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("cliSignIns")
      .withIndex("by_person", (q) => q.eq("personId", actor.person._id))
      .order("desc")
      .collect();
    return rows
      .filter((s) => s.revokedAt === undefined && s.expiresAt > now)
      .map((s) => ({
        signInId: s._id,
        name: s.name,
        prefix: s.prefix,
        createdAt: s.createdAt,
        ...(s.lastUsedAt !== undefined ? { lastUsedAt: s.lastUsedAt } : {}),
        expiresAt: s.expiresAt,
        current: actor.signIn?._id === s._id,
      }));
  },
});

export const { person: revokeSignIn, signIn: revokeSignInBySignIn } = accountMutation({
  name: "people.revokeSignIn",
  description:
    "Sign a computer's command line out: its CLI sign-in stops working at once, for the `uplink` tool and `uplink-mcp` there, and the runs its sessions joined with `uplink join` end. Pass a signInId from people.signIns; with a CLI sign-in, leave it out to revoke the one this call came with (what `uplink logout` does). Only your own sign-ins; revoking one twice is fine.",
  args: { signInId: v.optional(v.id("cliSignIns")) },
  argDocs: { signInId: "Which sign-in. Leave it out to revoke the one this call came with (CLI sign-ins only)." },
  handler: async (ctx, actor, args) => {
    const signInId = args.signInId ?? actor.signIn?._id;
    if (!signInId) throw roomError("invalid", "Pass signInId, from people.signIns.");
    const signIn = await ctx.db.get(signInId);
    if (!signIn || signIn.personId !== actor.person._id) throw roomError("not_found", "No such sign-in.");
    if (signIn.revokedAt === undefined) await ctx.db.patch(signIn._id, { revokedAt: Date.now() });
    // Its run tokens stop working now; the runs its sessions joined end with it, in steps (ADR 0032).
    await endJoinedRunsOf(ctx, signIn._id);
    return null;
  },
});
