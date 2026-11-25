import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { roomError } from "./errors";
import { isScope, SCOPES, type Scope } from "./scopes";

/**
 * Whoever is calling the Room API: a person signed in with Clerk, or an agent
 * using one of its agent keys.
 */
export type Actor = {
  kind: "person" | "agent";
  teamId: Id<"teams">;
  /** The acting member: the person, or the agent. */
  member: Doc<"members">;
  /**
   * Effective role. For an agent it is never higher than the role of the
   * person accountable for it (ADR 0003).
   */
  role: "admin" | "member";
  /** People have every scope. Agents have only their key's. */
  scopes: ReadonlySet<Scope> | "all";
  agentKeyId?: Id<"agentKeys">;
  /** For agents: the key's name, for errors. */
  agentKeyName?: string;
  /** For agents: the person accountable for it. */
  accountable?: Doc<"members">;
  /**
   * For an agent whose key is limited to some channels (ADR 0049): the only channels it can see.
   * Absent: every channel its member can see.
   */
  channelIds?: ReadonlySet<Id<"channels">>;
};

/**
 * The person the app's Clerk session names; null for none, and for a deleted account (ADR 0035),
 * whose session token issued before the deletion may still be presented.
 */
export async function personForIdentity(ctx: QueryCtx): Promise<Doc<"people"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const person = await ctx.db
    .query("people")
    .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
    .unique();
  return person && person.deletedAt === undefined ? person : null;
}

export async function memberForPerson(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  personId: Id<"people">,
): Promise<Doc<"members"> | null> {
  const members = await ctx.db
    .query("members")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .collect();
  return members.find((m) => m.teamId === teamId && m.removedAt === undefined) ?? null;
}

export async function personActor(ctx: QueryCtx, teamId: Id<"teams">): Promise<Actor> {
  const person = await personForIdentity(ctx);
  if (!person) throw roomError("unauthenticated", "Sign in to use Uplink Room.");
  return teamActorForPerson(ctx, person, teamId);
}

/** A person as their member in `teamId`; forbidden when they aren't in it. */
export async function teamActorForPerson(ctx: QueryCtx, person: Doc<"people">, teamId: Id<"teams">): Promise<Actor> {
  const member = await memberForPerson(ctx, teamId, person._id);
  if (!member) throw roomError("forbidden", "You are not a member of this team.");
  return { kind: "person", teamId, member, role: member.role, scopes: "all" };
}

/**
 * A person acting at the account level, in no team (ADR 0030): signed in with Clerk in the app,
 * or with a CLI sign-in over HTTP. People have no scopes; agents have no account level.
 */
export type AccountActor = {
  kind: "person";
  person: Doc<"people">;
  /** The CLI sign-in the call came with. Absent for the app's Clerk session. */
  signIn?: Doc<"cliSignIns">;
};

/**
 * The CLI sign-in whose token hashes to `hash`, while it works: not revoked, not expired, and its
 * account not deleted (which the room marks at once, before a later step revokes the sign-in).
 */
export async function liveCliSignIn(ctx: QueryCtx, hash: string): Promise<Doc<"cliSignIns">> {
  const signIn = await ctx.db
    .query("cliSignIns")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
  // `expired` is what ends a cached result (cliSignIns.expire); the time check covers the moments
  // before the scheduled write lands, for a query that runs fresh.
  if (!signIn || signIn.revokedAt !== undefined || signIn.expired === true || signIn.expiresAt <= Date.now()) {
    throw roomError("unauthenticated", "This sign-in expired or was revoked. Run `uplink login` to sign in again.");
  }
  const person = await ctx.db.get(signIn.personId);
  if (person?.deletedAt !== undefined) throw roomError("unauthenticated", "This sign-in's account was deleted.");
  return signIn;
}

export async function accountActorForIdentity(ctx: QueryCtx): Promise<AccountActor> {
  const person = await personForIdentity(ctx);
  if (!person) throw roomError("unauthenticated", "Sign in to use Uplink Room.");
  return { kind: "person", person };
}

export async function accountActorForCliSignIn(ctx: QueryCtx, hash: string): Promise<AccountActor> {
  const signIn = await liveCliSignIn(ctx, hash);
  const person = await ctx.db.get(signIn.personId);
  if (!person) throw roomError("unauthenticated", "This sign-in's account no longer exists.");
  return { kind: "person", person, signIn };
}

/** A team function called with a CLI sign-in: the person, as their member in `teamId`, as in the app. */
export async function cliSignInActor(ctx: QueryCtx, hash: string, teamId: Id<"teams">): Promise<Actor> {
  const { person } = await accountActorForCliSignIn(ctx, hash);
  return teamActorForPerson(ctx, person, teamId);
}

/**
 * A joined run acting with its own run token (ADR 0029 D8, ADR 0032): the session and its person, and
 * with a team its run and its driver as a person in the run's team, the member every message it posts
 * there is stored under (D2). A session that joined with no team has neither: it acts only in its
 * Pairs (D13, lib/pairs.ts).
 */
export type JoinedRun = {
  kind: "run";
  session: Doc<"joinedSessions">;
  /** The signed-in person the session joined as. */
  person: Doc<"people">;
  run: Doc<"runs"> | null;
  /** The run's driver, the signed-in person, acting as their member in the run's team. */
  actor: Actor | null;
};

/** A joined run in a team: its run and its driver. */
export type TeamJoinedRun = JoinedRun & { run: Doc<"runs">; actor: Actor };

/** The joined run's team run, or the error a session in no team gets: it can only pair (D13). */
export function teamRunOf(joined: JoinedRun): TeamJoinedRun {
  if (!joined.run || !joined.actor) {
    throw roomError(
      "forbidden",
      "This session joined with no team, so it can only pair: it posts in its Pairs (uplink say --in pair, or uplink reply to a Pair message). To post in a team, run uplink join --team <team>.",
    );
  }
  return joined as TeamJoinedRun;
}

/**
 * The joined run whose run token hashes to `hash`, while the token works: the run hasn't ended, the
 * CLI sign-in it was made with still works, and its person is still in the run's team (a session in
 * no team needs only the first two). A revoked sign-in fails here on the token's next call, even
 * before the run's own row says it ended.
 */
export async function joinedRunForToken(ctx: QueryCtx, hash: string): Promise<JoinedRun> {
  const session = await ctx.db
    .query("joinedSessions")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
  if (!session) throw roomError("unauthenticated", "This run token isn't valid. Run `uplink join` again in the session.");
  if (session.endedAt !== undefined) {
    throw roomError("unauthenticated", "This joined run ended, so its run token no longer works. Run `uplink join` again to rejoin.");
  }
  const signIn = await ctx.db.get(session.signInId);
  if (!signIn || signIn.revokedAt !== undefined || signIn.expired === true || signIn.expiresAt <= Date.now()) {
    throw roomError("unauthenticated", "The sign-in this session joined with expired or was revoked. Run `uplink login`, then `uplink join` again.");
  }
  const person = await ctx.db.get(session.personId);
  if (!person) throw roomError("unauthenticated", "This joined run's account no longer exists.");
  // A deleted account's runs end in steps after it is marked deleted (accounts.ts); none acts meanwhile.
  if (person.deletedAt !== undefined) throw roomError("unauthenticated", "This joined run's account was deleted.");
  // With no team it can only pair (D13): it has no run row and no member to act as.
  if (!session.teamId) return { kind: "run", session, person, run: null, actor: null };
  const run = session.runId ? await ctx.db.get(session.runId) : null;
  if (!run) throw roomError("unauthenticated", "This joined run no longer exists. Run `uplink join` again to rejoin.");
  const member = await memberForPerson(ctx, session.teamId, person._id);
  if (!member || member._id !== run.driverId) {
    throw roomError("unauthenticated", "You're no longer in this run's team, so it can't act there.");
  }
  return { kind: "run", session, person, run, actor: { kind: "person", teamId: session.teamId, member, role: member.role, scopes: "all" } };
}

/**
 * An agent acting with its agent key outside its team, in a Pair (D11): the team checks every agent
 * call passes (agentActorForKey), and its key's `pairs.join` scope. `person` is the person
 * accountable for it, one of the pair's people.
 */
export type PairAgent = { kind: "agent"; actor: Actor; agent: Doc<"agents">; person: Doc<"people"> };

/** Whoever calls a Pair function (realm `pair`): a signed-in person, or an agent with its key. */
export type PairActor = (AccountActor & { kind: "person" }) | PairAgent;

export async function pairAgentForKey(ctx: QueryCtx, agentKeyHash: string): Promise<PairAgent> {
  const key = await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("hash", agentKeyHash))
    .unique();
  const actor = await agentActorForKey(ctx, key, key?.teamId as Id<"teams">);
  requireScope(actor, "pairs.join");
  const agent = (await ctx.db.get(key!.agentId))!;
  const person = actor.accountable?.personId ? await ctx.db.get(actor.accountable.personId) : null;
  // agentActorForKey already refuses an agent whose person's account is deleted; no Pair takes one
  // without a person either, so none adds a deleted person back.
  if (!person || person.deletedAt !== undefined) throw roomError("forbidden", "The person accountable for this agent has no account.");
  return { kind: "agent", actor, agent, person };
}

/** Whether `memberId` is a person whose account was deleted (ADR 0035). */
export async function accountDeleted(ctx: QueryCtx, memberId: Id<"members">): Promise<boolean> {
  const member = await ctx.db.get(memberId);
  const person = member?.personId ? await ctx.db.get(member.personId) : null;
  return person?.deletedAt !== undefined;
}

/**
 * Whether the person accountable for an agent still answers for it: in the team, with an account.
 * Every way an agent acts or is reached checks it (agentActorForKey, the remote connector, routine
 * webhooks, A2A, shared browsers), so an agent stops the moment its person's account is deleted,
 * before the steps that take them out of the team run (ADR 0035).
 */
export async function accountableStands(ctx: QueryCtx, accountable: Doc<"members"> | null): Promise<boolean> {
  return accountable !== null && accountable.removedAt === undefined && !(await accountDeleted(ctx, accountable._id));
}

/**
 * Whether a member can still act in its team: still in it, and a person whose account wasn't
 * deleted, or an agent whose accountable person is both.
 */
export async function memberStillActs(ctx: QueryCtx, memberId: Id<"members">): Promise<boolean> {
  const member = await ctx.db.get(memberId);
  if (!member || member.removedAt !== undefined) return false;
  if (member.kind === "person") return !(await accountDeleted(ctx, member._id));
  const agent = member.agentId ? await ctx.db.get(member.agentId) : null;
  return agent !== null && (await memberStillActs(ctx, agent.addedBy));
}

/** The person's memberships, oldest first: one per team they're in. */
export async function teamsOfPerson(ctx: QueryCtx, personId: Id<"people">): Promise<Doc<"members">[]> {
  const members = await ctx.db
    .query("members")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .collect();
  return members.filter((m) => m.removedAt === undefined);
}

/**
 * The team a CLI sign-in's team function acts in when the call names none: the person's only
 * team. With none or several, the error says what to do.
 */
export async function defaultTeamForCliSignIn(ctx: QueryCtx, signIn: Doc<"cliSignIns">): Promise<Id<"teams">> {
  const teams = await teamsOfPerson(ctx, signIn.personId);
  if (teams.length === 1) return teams[0]!.teamId;
  if (teams.length === 0) {
    throw roomError(
      "forbidden",
      "You aren't in a team yet, so only account functions (people.*) work for you. Accept an invite to a team first.",
    );
  }
  throw roomError("invalid", `You're in ${teams.length} teams: pass teamId. people.me lists them.`);
}

/** At most this many unrevoked keys per agent (agents.createKey), so reading all of them stays bounded. */
export const MAX_ACTIVE_KEYS = 50;

/** An agent's unrevoked keys, all of them (at most MAX_ACTIVE_KEYS): revoked ones are never read. */
export async function activeAgentKeys(ctx: QueryCtx, agentId: Id<"agents">): Promise<Doc<"agentKeys">[]> {
  return ctx.db
    .query("agentKeys")
    .withIndex("by_agent_revoked", (q) => q.eq("agentId", agentId).eq("revokedAt", undefined))
    .take(MAX_ACTIVE_KEYS);
}

export async function agentActor(
  ctx: QueryCtx,
  agentKeyHash: string,
  teamId: Id<"teams">,
): Promise<Actor> {
  const key = await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("hash", agentKeyHash))
    .unique();
  return agentActorForKey(ctx, key, teamId);
}

/**
 * The checks every agent call passes, from the key's row: the key isn't revoked and belongs to the
 * team, the agent is still a member, and the person accountable for it is still in the team. The
 * agent's role is never above that person's.
 */
export async function agentActorForKey(ctx: QueryCtx, key: Doc<"agentKeys"> | null, teamId: Id<"teams">): Promise<Actor> {
  if (!key || key.revokedAt !== undefined) {
    throw roomError("unauthenticated", "This agent key is not valid or was revoked.");
  }
  if (key.teamId !== teamId) throw roomError("forbidden", "This agent key belongs to another team.");
  const member = await ctx.db
    .query("members")
    .withIndex("by_agent", (q) => q.eq("agentId", key.agentId))
    .unique();
  if (!member || member.removedAt !== undefined) {
    throw roomError("unauthenticated", "This agent was removed from the team.");
  }
  const agent = await ctx.db.get(key.agentId);
  if (!agent) throw roomError("unauthenticated", "This agent no longer exists.");
  const accountable = await ctx.db.get(agent.addedBy);
  if (!accountable || accountable.removedAt !== undefined) {
    throw roomError("forbidden", "The person accountable for this agent left the team.");
  }
  // A deleted account leaves its teams in steps after it is marked deleted (accounts.ts); its
  // agents stop at once.
  if (await accountDeleted(ctx, accountable._id)) {
    throw roomError("forbidden", "The person accountable for this agent deleted their account.");
  }
  const role = member.role === "admin" && accountable.role === "admin" ? "admin" : "member";
  return {
    kind: "agent",
    teamId,
    member,
    role,
    scopes: new Set(key.scopes.filter(isScope)),
    agentKeyId: key._id,
    agentKeyName: key.name,
    accountable,
    ...(key.channelIds ? { channelIds: new Set(key.channelIds) } : {}),
  };
}

export function hasScope(actor: Actor, scope: Scope): boolean {
  return actor.scopes === "all" || actor.scopes.has(scope);
}

export function requireScope(actor: Actor, scope: Scope): void {
  if (!hasScope(actor, scope)) {
    // Only the person who added the agent can change its keys' scopes (agents.setKeyScopes).
    const who = actor.accountable ? `${actor.accountable.name}, who added ${actor.member.name},` : "The person who added this agent";
    const key = actor.agentKeyName ? ` ("${actor.agentKeyName}")` : "";
    throw roomError(
      "forbidden",
      `This agent key${key} doesn't have the "${scope}" scope (${SCOPES[scope]}). ${who} can add it in the app (Settings, Agents) or with agents.setKeyScopes; members.me lists the scopes this key has.`,
    );
  }
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw roomError("forbidden", "Only admins can do this.");
}

/**
 * True when the actor is this member, or is an agent whose accountable person
 * is this member. An agent can do what its person can, never more.
 */
export function actsFor(actor: Actor, memberId: Id<"members">): boolean {
  return actor.member._id === memberId || actor.accountable?._id === memberId;
}

/** The member who answers for an action: the person, or the agent's accountable person. */
export function accountableId(actor: Actor): Id<"members"> {
  return actor.accountable?._id ?? actor.member._id;
}
