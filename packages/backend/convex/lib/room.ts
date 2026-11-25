/**
 * The Room API factory (ADR 0003).
 *
 * Each Room API function is written once with `roomQuery` or `roomMutation`
 * and exported twice:
 *
 *   export const { person: create, agent: createAgent } = roomMutation({...});
 *
 * `person` is the public Convex function the desktop app calls with a Clerk
 * session. `agent` is an internal function the HTTP endpoint calls with an
 * agent key's hash, or with a CLI sign-in's hash (ADR 0030), which acts as the
 * person, as the app does. Both run the same handler with the same rights
 * checks, so no action is app-only. The MCP server and the command-line tool
 * go through the HTTP endpoint.
 *
 * Account functions (`accountQuery`, `accountMutation`) act for a signed-in
 * person in no team, so a person with no team can use them:
 *
 *   export const { person: me, signIn: meBySignIn } = accountQuery({...});
 *
 * `signIn` is the internal function the HTTP endpoint calls with a CLI
 * sign-in's hash. Agent keys can't call them.
 *
 * Pair functions (`pairQuery`, `pairMutation`) act in Pairs (ADR 0034), outside every team, for a
 * signed-in person (the app's Clerk session or a CLI sign-in) or an agent with its key and the
 * `pairs.join` scope (ADR 0029 D11):
 *
 *   export const { person: list, signIn: listBySignIn, agent: listAgent } = pairQuery({...});
 *
 * Run functions (`joinedRunQuery`, `joinedRunMutation`) act as one joined run (ADR 0032),
 * with that run's own token and nothing else, so an agent in a session that
 * joined never needs its person's sign-in:
 *
 *   export const { run: takeByRun } = joinedRunMutation({...});
 */
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { v, type ObjectType, type PropertyValidators } from "convex/values";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import {
  accountActorForCliSignIn,
  accountActorForIdentity,
  agentActor,
  cliSignInActor,
  joinedRunForToken,
  pairAgentForKey,
  personActor,
  requireScope,
  type AccountActor,
  type Actor,
  type JoinedRun,
  type PairActor,
} from "./actor";
import { roomError, type RoomRefusal } from "./errors";
import { answerMutation, answerQuery, publicMutation, publicQuery } from "./refusals";
import { checkIds, looseIds } from "./idArgs";
import { registerFunction, type ArgDoc } from "./catalog";
import { audit, channelOfIds, wasAudited } from "./members";
import type { Scope } from "./scopes";

const teamArg = { teamId: v.id("teams") };

/** How an HTTP or live call proves who it is: exactly one of these. */
const credentialArgs = { agentKeyHash: v.optional(v.string()), signInHash: v.optional(v.string()) };

/** The actor for an internal (HTTP or live) call: an agent within its key's scopes, or a person by their CLI sign-in. */
async function credentialActor(
  ctx: QueryCtx,
  credential: { agentKeyHash?: string; signInHash?: string },
  teamId: Id<"teams">,
  scope: Scope,
): Promise<Actor> {
  if (credential.agentKeyHash !== undefined && credential.signInHash === undefined) {
    const actor = await agentActor(ctx, credential.agentKeyHash, teamId);
    requireScope(actor, scope);
    return actor;
  }
  if (credential.signInHash !== undefined && credential.agentKeyHash === undefined) {
    return cliSignInActor(ctx, credential.signInHash, teamId);
  }
  throw roomError("unauthenticated", "Send an agent key or a CLI sign-in's token.");
}

type Def<Args extends PropertyValidators, Ctx, R> = {
  /** Public name, `module.function`, such as `tasks.create`. Also the HTTP and MCP name. */
  name: string;
  description: string;
  /** The scope an agent key needs. People are limited by their role, not scopes. */
  scope: Scope;
  args: Args;
  /** Per-argument docs for the JSON Schema agents see (MCP tools, `uplink <fn> --help`). */
  argDocs?: { [K in keyof Args & string]?: ArgDoc };
  handler: (ctx: Ctx, actor: Actor, args: ObjectType<Args>) => Promise<R>;
  /**
   * Mutations only. Every successful agent call is logged as `api.<name>`
   * (with the agent, its key and its person) unless the handler logged it
   * itself. Set false only for a presence heartbeat.
   */
  agentAudit?: false;
};

// Each factory's public `person` function answers refusals only to a caller that asks
// (`publicQuery`, `publicMutation`). Its internal functions always answer them (lib/refusals.ts):
// the HTTP endpoint, `live:query` and the remote MCP connector are their only callers.

export function roomQuery<Args extends PropertyValidators, R>(def: Def<Args, QueryCtx, R>) {
  registerFunction({ ...def, kind: "query", realm: "team" });
  const allArgs = { ...teamArg, ...def.args };
  return {
    person: publicQuery({
      args: allArgs,
      handler: async (ctx, args): Promise<R> => {
        const { teamId, ...rest } = args as unknown as { teamId: Id<"teams"> };
        const actor = await personActor(ctx, teamId);
        return def.handler(ctx, actor, rest as ObjectType<Args>);
      },
    }),
    agent: internalQuery({
      args: { ...credentialArgs, ...looseIds(allArgs) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerQuery(async () => {
          checkIds(ctx, allArgs, args);
          const { agentKeyHash, signInHash, teamId, ...rest } = args as {
            agentKeyHash?: string;
            signInHash?: string;
            teamId: (typeof args)["teamId"];
          };
          const actor = await credentialActor(ctx, { agentKeyHash, signInHash }, teamId, def.scope);
          return def.handler(ctx, actor, rest as ObjectType<Args>);
        }),
    }),
  };
}

export function roomMutation<Args extends PropertyValidators, R>(def: Def<Args, MutationCtx, R>) {
  registerFunction({ ...def, kind: "mutation", realm: "team" });
  const allArgs = { ...teamArg, ...def.args };
  return {
    person: publicMutation({
      args: allArgs,
      handler: async (ctx, args): Promise<R> => {
        const { teamId, ...rest } = args as unknown as { teamId: Id<"teams"> };
        const actor = await personActor(ctx, teamId);
        return def.handler(ctx, actor, rest as ObjectType<Args>);
      },
    }),
    agent: internalMutation({
      args: { ...credentialArgs, ...looseIds(allArgs) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerMutation(ctx, async () => {
          checkIds(ctx, allArgs, args);
          const { agentKeyHash, signInHash, teamId, ...rest } = args as {
            agentKeyHash?: string;
            signInHash?: string;
            teamId: (typeof args)["teamId"];
          };
          const actor = await credentialActor(ctx, { agentKeyHash, signInHash }, teamId, def.scope);
          // A person with a CLI sign-in is logged as in the app: by what the handler records.
          const auditCall = actor.kind === "agent" && def.agentAudit !== false;
          // The channel the call is about, found before the handler can delete what names it.
          const channelId = auditCall ? await channelOfIds(ctx, Object.values(idArgs(def, rest))) : undefined;
          const result = await def.handler(ctx, actor, rest as ObjectType<Args>);
          // Spec #3: every action by an agent records the agent, its key and its person.
          if (auditCall && !wasAudited(actor)) {
            await auditAgentCall(ctx, actor, def, rest, result, channelId);
          }
          return result;
        }),
    }),
  };
}

type AccountDef<Args extends PropertyValidators, Ctx, R> = {
  /** Public name, `module.function`, such as `people.me`. Also the HTTP and MCP name. */
  name: string;
  description: string;
  args: Args;
  argDocs?: { [K in keyof Args & string]?: ArgDoc };
  handler: (ctx: Ctx, actor: AccountActor, args: ObjectType<Args>) => Promise<R>;
};

/** An account function that reads (ADR 0030): for a signed-in person, in no team. */
export function accountQuery<Args extends PropertyValidators, R>(def: AccountDef<Args, QueryCtx, R>) {
  registerFunction({ ...def, kind: "query", realm: "account", scope: "account" });
  return {
    person: publicQuery({
      args: def.args,
      handler: async (ctx, args): Promise<R> => def.handler(ctx, await accountActorForIdentity(ctx), args),
    }),
    signIn: internalQuery({
      args: { signInHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerQuery(async () => {
          checkIds(ctx, def.args, args);
          const { signInHash, ...rest } = args as { signInHash: string };
          return def.handler(ctx, await accountActorForCliSignIn(ctx, signInHash), rest as ObjectType<Args>);
        }),
    }),
  };
}

/** An account function that changes things (ADR 0030): for a signed-in person, in no team. */
export function accountMutation<Args extends PropertyValidators, R>(def: AccountDef<Args, MutationCtx, R>) {
  registerFunction({ ...def, kind: "mutation", realm: "account", scope: "account" });
  return {
    person: publicMutation({
      args: def.args,
      handler: async (ctx, args): Promise<R> => def.handler(ctx, await accountActorForIdentity(ctx), args),
    }),
    signIn: internalMutation({
      args: { signInHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerMutation(ctx, async () => {
          checkIds(ctx, def.args, args);
          const { signInHash, ...rest } = args as { signInHash: string };
          return def.handler(ctx, await accountActorForCliSignIn(ctx, signInHash), rest as ObjectType<Args>);
        }),
    }),
  };
}

type PairDef<Args extends PropertyValidators, Ctx, R> = {
  /** Public name, `pairs.function`. Also the HTTP and MCP name. */
  name: string;
  description: string;
  args: Args;
  argDocs?: { [K in keyof Args & string]?: ArgDoc };
  handler: (ctx: Ctx, actor: PairActor, args: ObjectType<Args>) => Promise<R>;
};

/** A Pair function that reads (ADR 0034): for a signed-in person, or an agent with `pairs.join`. */
export function pairQuery<Args extends PropertyValidators, R>(def: PairDef<Args, QueryCtx, R>) {
  registerFunction({ ...def, kind: "query", realm: "pair", scope: "pairs.join" });
  return {
    person: publicQuery({
      args: def.args,
      handler: async (ctx, args): Promise<R> => def.handler(ctx, await accountActorForIdentity(ctx), args),
    }),
    signIn: internalQuery({
      args: { signInHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerQuery(async () => {
          checkIds(ctx, def.args, args);
          const { signInHash, ...rest } = args as { signInHash: string };
          return def.handler(ctx, await accountActorForCliSignIn(ctx, signInHash), rest as ObjectType<Args>);
        }),
    }),
    agent: internalQuery({
      args: { agentKeyHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerQuery(async () => {
          checkIds(ctx, def.args, args);
          const { agentKeyHash, ...rest } = args as { agentKeyHash: string };
          return def.handler(ctx, await pairAgentForKey(ctx, agentKeyHash), rest as ObjectType<Args>);
        }),
    }),
  };
}

/**
 * A Pair function that changes things (ADR 0034). An agent's call is logged in its own team's record,
 * as `api.<name>` with the pair as its target, as every agent action is (spec #3). activity.list
 * shows such an entry only to those in the Pair, so the rest of the team doesn't learn of it.
 */
export function pairMutation<Args extends PropertyValidators, R>(def: PairDef<Args, MutationCtx, R>) {
  registerFunction({ ...def, kind: "mutation", realm: "pair", scope: "pairs.join" });
  return {
    person: publicMutation({
      args: def.args,
      handler: async (ctx, args): Promise<R> => def.handler(ctx, await accountActorForIdentity(ctx), args),
    }),
    signIn: internalMutation({
      args: { signInHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerMutation(ctx, async () => {
          checkIds(ctx, def.args, args);
          const { signInHash, ...rest } = args as { signInHash: string };
          return def.handler(ctx, await accountActorForCliSignIn(ctx, signInHash), rest as ObjectType<Args>);
        }),
    }),
    agent: internalMutation({
      args: { agentKeyHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerMutation(ctx, async () => {
          checkIds(ctx, def.args, args);
          const { agentKeyHash, ...rest } = args as { agentKeyHash: string };
          const agent = await pairAgentForKey(ctx, agentKeyHash);
          const result = await def.handler(ctx, agent, rest as ObjectType<Args>);
          const pairId = (rest as { pairId?: unknown }).pairId ?? (result as { pairId?: unknown } | null)?.pairId;
          if (!wasAudited(agent.actor)) await audit(ctx, agent.actor, `api.${def.name}`, typeof pairId === "string" ? pairId : agent.actor.teamId);
          return result;
        }),
    }),
  };
}

type RunDef<Args extends PropertyValidators, Ctx, R> = {
  /** Public name, `module.function`, such as `joined.take`. Also the HTTP name. */
  name: string;
  description: string;
  args: Args;
  argDocs?: { [K in keyof Args & string]?: ArgDoc };
  handler: (ctx: Ctx, joined: JoinedRun, args: ObjectType<Args>) => Promise<R>;
};

/** A run function that reads (ADR 0032): as one joined run, with its run token. Live watches can run it. */
export function joinedRunQuery<Args extends PropertyValidators, R>(def: RunDef<Args, QueryCtx, R>) {
  registerFunction({ ...def, kind: "query", realm: "run", scope: "run" });
  return {
    run: internalQuery({
      args: { runTokenHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerQuery(async () => {
          checkIds(ctx, def.args, args);
          const { runTokenHash, ...rest } = args as { runTokenHash: string };
          return def.handler(ctx, await joinedRunForToken(ctx, runTokenHash), rest as ObjectType<Args>);
        }),
    }),
  };
}

/** A run function that changes things (ADR 0032): as one joined run, with its run token. */
export function joinedRunMutation<Args extends PropertyValidators, R>(def: RunDef<Args, MutationCtx, R>) {
  registerFunction({ ...def, kind: "mutation", realm: "run", scope: "run" });
  return {
    run: internalMutation({
      args: { runTokenHash: v.string(), ...looseIds(def.args) },
      handler: async (ctx, args): Promise<R | RoomRefusal> =>
        answerMutation(ctx, async () => {
          checkIds(ctx, def.args, args);
          const { runTokenHash, ...rest } = args as { runTokenHash: string };
          return def.handler(ctx, await joinedRunForToken(ctx, runTokenHash), rest as ObjectType<Args>);
        }),
    }),
  };
}

/** A call's id arguments (`messageId`, `channelId` and the like), by name. */
function idArgs(def: { args: PropertyValidators }, args: Record<string, unknown>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const key of Object.keys(def.args)) {
    const value = args[key];
    if (key.endsWith("Id") && typeof value === "string") ids[key] = value;
  }
  return ids;
}

/** Logs an agent's call. Its target is the document it created, else its first id argument, else the team. */
async function auditAgentCall(
  ctx: MutationCtx,
  actor: Actor,
  def: { name: string; args: PropertyValidators },
  args: Record<string, unknown>,
  result: unknown,
  channelId: Id<"channels"> | undefined,
) {
  const ids = idArgs(def, args);
  // Only a document id is used from the result, never another string, which could be a secret.
  // channels.openDirect returns its channel's id with the direct message's warnings.
  const id =
    typeof result === "object" && result !== null && "channelId" in result ? (result as { channelId: unknown }).channelId : result;
  const created =
    typeof id === "string" &&
    (Object.keys(schema.tables) as TableNames[]).some(
      (table) => ctx.db.normalizeId(table, id) !== null,
    )
      ? id
      : undefined;
  const target = created ?? Object.values(ids)[0] ?? actor.teamId;
  await audit(ctx, actor, `api.${def.name}`, target, Object.keys(ids).length ? ids : undefined, channelId ? { channelId } : {});
}
