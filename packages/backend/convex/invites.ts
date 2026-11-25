/**
 * Invites (ADR 0003: each action is one Room API function). An admin invites someone by email;
 * the room emails them a join link (lib/email.ts) and keeps the token's hash to accept it. A token
 * works once, for 7 days unless the invite says otherwise. Regenerating or resending makes a new
 * token, and the old one stops working at once. An invite nobody accepted after 3 days gets one
 * reminder email, unless it was revoked, regenerated or resent, or the team turned reminders off.
 * Joining sends the person a welcome and, unless they turned it off, tells whoever invited them.
 */
import type { UserIdentity } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { publicMutation, publicQuery } from "./lib/refusals";
import { memberForPerson, personForIdentity, requireAdmin, type Actor } from "./lib/actor";
import { randomSecret, sha256 } from "./lib/crypto";
import { queueEmail } from "./lib/email";
import { roomError } from "./lib/errors";
import { inviteUrl, openInviteToken, sealInviteToken } from "./lib/inviteToken";
import { audit } from "./lib/members";
import { roomMutation, roomQuery } from "./lib/room";
import { startTeamMember } from "./lib/reads";
import { vRole } from "./schema";

const DAY = 24 * 60 * 60 * 1000;
/** How long a token works unless the call says otherwise. */
export const INVITE_DAYS = 7;
/** When an invite nobody accepted gets its one reminder. */
export const REMIND_AFTER_MS = 3 * DAY;

const vDays = v.optional(v.number());

function inviteDays(days: number | undefined): number {
  const value = days ?? INVITE_DAYS;
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw roomError("invalid", "An invite can last from 1 to 30 days.");
  }
  return value;
}

/** Who sent an invite, for its emails: a person, or an agent and the person accountable for it. */
async function sentBy(ctx: QueryCtx, memberId: Id<"members">) {
  const member = await ctx.db.get(memberId);
  if (!member) return null;
  if (member.kind === "person") {
    const person = member.personId ? await ctx.db.get(member.personId) : null;
    return { name: member.name, email: person?.email, agentName: undefined, personMember: member };
  }
  const agent = member.agentId ? await ctx.db.get(member.agentId) : null;
  const accountable = agent ? await ctx.db.get(agent.addedBy) : null;
  const person = accountable?.personId ? await ctx.db.get(accountable.personId) : null;
  return {
    name: accountable ? `${member.name}, an agent ${accountable.name} added` : member.name,
    email: person?.email,
    agentName: member.name,
    personMember: accountable,
  };
}

/** "a…@company.com": enough to recognize an address without handing it to whoever holds a token. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at <= 0 ? "…" : `${email[0]}…${email.slice(at)}`;
}

/**
 * Whether the signed-in account may use an invite: `match` when its email is the invited address
 * (case doesn't matter) and verified, `other` when it's another address, `unverified` when it's
 * the invited address, or no address, without verification (Clerk's `email_verified` session
 * claim). Only `match` may accept. Only people accept invites: an agent joins when a person adds
 * it with agents.add and is accountable for it (ADR 0003), so no agent path goes through here.
 */
function accountFor(identity: UserIdentity, invite: Doc<"invites">): "match" | "other" | "unverified" {
  const email = identity.email?.trim().toLowerCase();
  if (email && email !== invite.email.trim().toLowerCase()) return "other";
  return email && identity.emailVerified === true ? "match" : "unverified";
}

/** A waiting invite of the actor's team: not accepted, not revoked. */
async function waitingInvite(ctx: QueryCtx, actor: Actor, inviteId: Id<"invites">): Promise<Doc<"invites">> {
  const invite = await ctx.db.get(inviteId);
  if (!invite || invite.teamId !== actor.teamId) throw roomError("not_found", "There's no such invite in this team.");
  if (invite.acceptedAt !== undefined) throw roomError("conflict", `${invite.email} already joined with this invite.`);
  if (invite.revokedAt !== undefined) throw roomError("conflict", "This invite was revoked.");
  return invite;
}

async function cancelReminder(ctx: MutationCtx, invite: Doc<"invites">): Promise<void> {
  if (!invite.reminderId) return;
  const job = await ctx.db.system.get("_scheduled_functions", invite.reminderId);
  if (job && job.state.kind === "pending") await ctx.scheduler.cancel(invite.reminderId);
}

/** Gives an invite a new token (generation), sealed for later emails. The old token stops working. */
async function newToken(ctx: MutationCtx, inviteId: Id<"invites">, generation: number, days: number) {
  const token = randomSecret("uri");
  const expiresAt = Date.now() + days * DAY;
  const sealed = await sealInviteToken(token, inviteId, generation);
  await ctx.db.patch(inviteId, {
    tokenHash: await sha256(token),
    generation,
    expiresAt,
    sealedToken: sealed ?? undefined,
  });
  return { token, expiresAt };
}

/**
 * Queues the invite email (or its reminder) for the invite's current token. The email carries the
 * link, so without a sealed token (no INVITE_TOKEN_KEYS) it's recorded as failed at once. Returns
 * whether an email is on its way.
 */
async function queueInviteEmail(ctx: MutationCtx, inviteId: Id<"invites">, kind: "invite" | "reminder") {
  const invite = (await ctx.db.get(inviteId))!;
  const team = await ctx.db.get(invite.teamId);
  const from = await sentBy(ctx, invite.invitedBy);
  const queued = await queueEmail(ctx, {
    teamId: invite.teamId,
    kind,
    to: invite.email,
    inviteId,
    generation: invite.generation ?? 0,
    ...(invite.sealedToken ? {} : { failure: NO_SEALING }),
    data: {
      teamId: invite.teamId,
      teamName: team?.name ?? "your team",
      inviterName: from?.name,
      inviterEmail: from?.email,
      inviteeEmail: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      invitedAt: invite._creationTime,
    },
  });
  return queued?.scheduled ?? false;
}

const NO_SEALING =
  "Invite emails need INVITE_TOKEN_KEYS on this deployment to carry the link. Copy the link and send it yourself.";

export const { person: create, agent: createAgent } = roomMutation({
  name: "invites.create",
  description:
    "Invite a person to the team by email (admins). Emails them a join link unless sendEmail is false, and returns the one-time token, the link to send by hand, and emailed: whether an email is on its way. The token works for expiresInDays (1 to 30, default 7) and only for an account whose verified email is the invited one. An invite nobody accepts gets one reminder email after 3 days, unless the team turned reminders off.",
  scope: "people.invite",
  args: {
    email: v.string(),
    role: v.optional(vRole),
    sendEmail: v.optional(v.boolean()),
    expiresInDays: vDays,
  },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const email = args.email.trim().toLowerCase();
    if (!email.includes("@")) throw roomError("invalid", "That doesn't look like an email address.");
    const days = inviteDays(args.expiresInDays);
    const sendEmail = args.sendEmail !== false;
    const role = args.role ?? "member";
    const inviteId = await ctx.db.insert("invites", {
      teamId: actor.teamId,
      email,
      role,
      invitedBy: actor.member._id,
      tokenHash: "",
      ...(sendEmail ? {} : { sendEmail: false }),
    });
    const { token, expiresAt } = await newToken(ctx, inviteId, 1, days);
    await audit(ctx, actor, "invite.created", inviteId, { email, role });
    const emailed = sendEmail && (await queueInviteEmail(ctx, inviteId, "invite"));
    if (emailed) {
      const reminderId = await ctx.scheduler.runAfter(REMIND_AFTER_MS, internal.invites.remind, { inviteId, generation: 1 });
      await ctx.db.patch(inviteId, { reminderId });
    }
    return { inviteId, token, url: inviteUrl(token), expiresAt, emailed };
  },
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "invites.list",
  description:
    "List the team's invites that haven't been accepted or revoked, with when each expires (expiresAt, null for invites made before invites expired), whether its link can be copied again, and where its latest email stands (emailState: invite or reminder, sending, sent or failed, with the error).",
  scope: "room.read",
  args: {},
  handler: async (ctx, actor) => {
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    return Promise.all(
      invites
        .filter((i) => i.acceptedAt === undefined && i.revokedAt === undefined)
        .map(async (i) => {
          const by = await ctx.db.get(i.invitedBy);
          return {
            inviteId: i._id,
            email: i.email,
            role: i.role,
            invitedAt: i._creationTime,
            invitedBy: by ? { memberId: by._id, name: by.name } : null,
            expiresAt: i.expiresAt ?? null,
            sendEmail: i.sendEmail !== false,
            canCopyLink: i.sealedToken !== undefined,
            remindedAt: i.remindedAt ?? null,
            emailState: i.lastEmail
              ? { kind: i.lastEmail.kind, status: i.lastEmail.status, at: i.lastEmail.at, error: i.lastEmail.error ?? null }
              : null,
          };
        }),
    );
  },
});

export const { person: link, agent: linkAgent } = roomMutation({
  name: "invites.link",
  description:
    "The join link and token of a waiting invite (admins), to send by hand. It's the same token its last email carried. Regenerate the invite for a new one.",
  scope: "people.invite",
  args: { inviteId: v.id("invites") },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const invite = await waitingInvite(ctx, actor, args.inviteId);
    const token = invite.sealedToken
      ? await openInviteToken(invite.sealedToken, invite._id, invite.generation ?? 0)
      : null;
    if (!token) {
      throw roomError(
        "invalid",
        "This invite's link can't be shown again on this deployment. Regenerate the token to get a new one.",
      );
    }
    return { inviteId: invite._id, token, url: inviteUrl(token), expiresAt: invite.expiresAt ?? null };
  },
});

/** Regenerate and resend share this: a new token, the old one invalid, the reminder off. */
async function replaceToken(
  ctx: MutationCtx,
  actor: Actor,
  inviteId: Id<"invites">,
  opts: { days: number; email: boolean; action: string },
) {
  requireAdmin(actor);
  const invite = await waitingInvite(ctx, actor, inviteId);
  await cancelReminder(ctx, invite);
  const generation = (invite.generation ?? 0) + 1;
  const { token, expiresAt } = await newToken(ctx, invite._id, generation, opts.days);
  await ctx.db.patch(invite._id, {
    reminderId: undefined,
    lastEmail: undefined,
    ...(opts.email ? { sendEmail: undefined } : {}),
  });
  await audit(ctx, actor, opts.action, invite._id, { email: invite.email });
  const emailed = opts.email ? await queueInviteEmail(ctx, invite._id, "invite") : false;
  return { inviteId: invite._id, token, url: inviteUrl(token), expiresAt, emailed };
}

export const { person: regenerate, agent: regenerateAgent } = roomMutation({
  name: "invites.regenerate",
  description:
    "Give a waiting invite a new token (admins). The old token stops working at once, the reminder is off, and the invite works for expiresInDays (default 7) from now. Emails the new link unless the invite was made with sendEmail false. Returns the new token and link.",
  scope: "people.invite",
  args: { inviteId: v.id("invites"), expiresInDays: vDays },
  handler: async (ctx, actor, args) => {
    const invite = await ctx.db.get(args.inviteId);
    return replaceToken(ctx, actor, args.inviteId, {
      days: inviteDays(args.expiresInDays),
      email: invite?.sendEmail !== false,
      action: "invite.regenerated",
    });
  },
});

export const { person: resend, agent: resendAgent } = roomMutation({
  name: "invites.resend",
  description:
    "Email a waiting invite again with a fresh token (admins). The old token stops working at once, the reminder is off, and the invite works for expiresInDays (default 7) from now. Returns the new token and link.",
  scope: "people.invite",
  args: { inviteId: v.id("invites"), expiresInDays: vDays },
  handler: async (ctx, actor, args) =>
    replaceToken(ctx, actor, args.inviteId, {
      days: inviteDays(args.expiresInDays),
      email: true,
      action: "invite.resent",
    }),
});

export const { person: revoke, agent: revokeAgent } = roomMutation({
  name: "invites.revoke",
  description: "Revoke a waiting invite (admins). Its token stops working at once and no reminder goes out.",
  scope: "people.invite",
  args: { inviteId: v.id("invites") },
  handler: async (ctx, actor, args) => {
    requireAdmin(actor);
    const invite = await waitingInvite(ctx, actor, args.inviteId);
    await cancelReminder(ctx, invite);
    await ctx.db.patch(invite._id, { revokedAt: Date.now(), sealedToken: undefined, reminderId: undefined });
    await audit(ctx, actor, "invite.revoked", invite._id, { email: invite.email });
    return null;
  },
});

/** The one reminder, 3 days after the invite was made, if it still applies. At most once per invite. */
export const remind = internalMutation({
  args: { inviteId: v.id("invites"), generation: v.number() },
  handler: async (ctx, { inviteId, generation }) => {
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.acceptedAt !== undefined || invite.revokedAt !== undefined) return null;
    if ((invite.generation ?? 0) !== generation || invite.remindedAt !== undefined) return null;
    if (invite.sendEmail === false) return null;
    if (invite.expiresAt !== undefined && Date.now() >= invite.expiresAt) return null;
    await ctx.db.patch(inviteId, { reminderId: undefined });
    const team = await ctx.db.get(invite.teamId);
    if (team?.inviteReminders === "off") return null;
    // Claimed before queueing, in one transaction: no second reminder can follow this one.
    await ctx.db.patch(inviteId, { remindedAt: Date.now() });
    await queueInviteEmail(ctx, inviteId, "reminder");
    return null;
  },
});

/**
 * What a token would join, for "Join <team>?" before accepting. People only, signed in. `state`
 * is `valid`, `expired`, `used`, `revoked` or `invalid` (no such token). `account` says whether
 * this sign-in may use it (accountFor): the invited address is shown in full only to its own
 * account, and masked otherwise.
 */
export const preview = publicQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const person = await personForIdentity(ctx);
    if (!person) throw roomError("unauthenticated", "Sign in to see this invite.");
    const tokenHash = await sha256(token.trim());
    const found = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!found) return { state: "invalid" as const };
    const team = await ctx.db.get(found.teamId);
    const from = await sentBy(ctx, found.invitedBy);
    const state =
      found.acceptedAt !== undefined
        ? ("used" as const)
        : found.revokedAt !== undefined
          ? ("revoked" as const)
          : found.expiresAt !== undefined && Date.now() >= found.expiresAt
            ? ("expired" as const)
            : ("valid" as const);
    const member = await memberForPerson(ctx, found.teamId, person._id);
    const identity = (await ctx.auth.getUserIdentity())!;
    const account = accountFor(identity, found);
    return {
      state,
      account,
      inviteFor: maskEmail(found.email),
      signedInAs: identity.email ? maskEmail(identity.email) : null,
      teamId: found.teamId,
      teamName: team?.name ?? "",
      inviterName: from?.name ?? null,
      email: account === "match" ? found.email : null,
      role: found.role,
      expiresAt: found.expiresAt ?? null,
      alreadyMember: member !== null,
    };
  },
});

/** The team channel "join a call" points to in the welcome email: #general, else the first one. */
async function welcomeChannel(ctx: QueryCtx, teamId: Id<"teams">) {
  const channels = (
    await ctx.db
      .query("channels")
      .withIndex("by_team", (q) => q.eq("teamId", teamId))
      .collect()
  ).filter((c) => (c.kind === undefined || c.kind === "channel") && c.archivedAt === undefined);
  return channels.find((c) => c.name === "general") ?? channels[0] ?? null;
}

/** After someone joins: their welcome, and "<name> joined <team>" for whoever invited them. */
async function queueJoinEmails(
  ctx: MutationCtx,
  invite: Doc<"invites">,
  person: Doc<"people">,
  memberId: Id<"members">,
) {
  const team = await ctx.db.get(invite.teamId);
  const teamName = team?.name ?? "your team";
  const channel = await welcomeChannel(ctx, invite.teamId);
  await queueEmail(ctx, {
    teamId: invite.teamId,
    kind: "welcome",
    to: person.email ?? invite.email,
    inviteId: invite._id,
    data: {
      teamId: invite.teamId,
      teamName,
      role: invite.role,
      inviteeName: person.name,
      ...(channel ? { channelId: channel._id, channelName: channel.name } : {}),
    },
  });
  const from = await sentBy(ctx, invite.invitedBy);
  const inviter = from?.personMember;
  if (!inviter || inviter.removedAt !== undefined || inviter.joinedEmails === "off") return;
  if (inviter._id === memberId || inviter.personId === person._id) return;
  const inviterPerson = inviter.personId ? await ctx.db.get(inviter.personId) : null;
  await queueEmail(ctx, {
    teamId: invite.teamId,
    kind: "joined",
    to: inviterPerson?.email,
    inviteId: invite._id,
    data: {
      teamId: invite.teamId,
      teamName,
      role: invite.role,
      inviteeName: person.name,
      inviteeEmail: person.email ?? invite.email,
      ...(from?.agentName ? { agentName: from.agentName } : {}),
    },
  });
}

/**
 * Joins a team with an invite token. People only, and only the invited one: the account's
 * verified email must be the invite's address. Expired, revoked and used tokens are refused.
 */
export const accept = publicMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const person = await personForIdentity(ctx);
    if (!person) throw roomError("unauthenticated", "Sign in to accept an invite.");
    const tokenHash = await sha256(token.trim());
    const found = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!found || found.acceptedAt !== undefined || found.revokedAt !== undefined) {
      throw roomError("invalid", "This invite isn't valid or was already used.");
    }
    if (found.expiresAt !== undefined && Date.now() >= found.expiresAt) {
      throw roomError("invalid", "This invite expired. Ask whoever invited you for a new one.");
    }
    const identity = (await ctx.auth.getUserIdentity())!;
    const account = accountFor(identity, found);
    if (account === "unverified") {
      throw roomError(
        "forbidden",
        `This invite is for ${maskEmail(found.email)}, and your sign-in doesn't show a verified email address. Verify your email, or sign in with the invited address.`,
      );
    }
    if (account === "other") {
      throw roomError(
        "forbidden",
        `This invite is for ${maskEmail(found.email)}. You're signed in as ${maskEmail(identity.email!)}. Sign in with the invited address to join.`,
      );
    }
    let member = await memberForPerson(ctx, found.teamId, person._id);
    const joined = member === null;
    if (!member) {
      const memberId = await ctx.db.insert("members", {
        teamId: found.teamId,
        kind: "person",
        personId: person._id,
        name: person.name,
        role: found.role,
      });
      // Read state starts now: what the team's channels hold so far counts as read (lib/reads.ts).
      await startTeamMember(ctx, found.teamId, memberId);
      member = (await ctx.db.get(memberId))!;
    }
    await cancelReminder(ctx, found);
    await ctx.db.patch(found._id, {
      acceptedAt: Date.now(),
      acceptedBy: member._id,
      sealedToken: undefined,
      reminderId: undefined,
    });
    if (joined) await queueJoinEmails(ctx, found, person, member._id);
    return found.teamId;
  },
});
